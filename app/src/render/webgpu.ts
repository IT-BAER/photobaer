import { BACKGROUND, FLOATS_PER_INSTANCE, MAX_ARRAY_LAYERS, slotOrigin, type Frame, type Renderer, type TileCompositor } from './renderer.ts';
import { GpuCompositor } from './composite.ts';
import type { Program } from './program.ts';

const WGSL = /* wgsl */ `
struct U { r0: vec4f, r1: vec4f, px: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d_array<f32>;
@group(0) @binding(2) var smp: sampler;

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) slot: i32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) rect: vec4f, @location(1) uvr: vec4f, @location(2) slot: f32) -> VO {
  let c = vec2f(f32(vi & 1u), f32(vi >> 1u));
  let d = vec3f(mix(rect.xy, rect.zw, c), 1.0);
  var o: VO;
  o.pos = vec4f(dot(u.r0.xyz, d), dot(u.r1.xyz, d), 0.0, 1.0);
  o.uv = mix(uvr.xy, uvr.zw, c);
  o.slot = i32(slot);
  return o;
}

@fragment fn fs(i: VO) -> @location(0) vec4f {
  let cell = floor(i.pos.xy / u.px.x);
  let chk = select(1.0, 0.8, (i32(cell.x + cell.y) & 1) == 1);
  var col = vec4f(0.0);
  if (i.slot >= 0) {
    let t = clamp(i.uv, vec2f(0.5 / 256.0), vec2f(1.0 - 0.5 / 256.0));
    let off = vec2f(f32(i.slot & 1), f32((i.slot >> 1) & 1)) * 0.5;
    col = textureSampleLevel(tex, smp, off + t * 0.5, i.slot >> 2, 0.0);
  }
  return vec4f(col.rgb + chk * (1.0 - col.a), 1.0);
}
`;

export class WebGpuRenderer implements Renderer {
  readonly kind = 'webgpu';
  readonly slots: number;
  #device: GPUDevice;
  #ctx: GPUCanvasContext;
  #pipeline: GPURenderPipeline;
  #tex: GPUTexture;
  #uniform: GPUBuffer;
  #groups: { linear: GPUBindGroup; nearest: GPUBindGroup };
  #inst: GPUBuffer | null = null;
  #comp: GpuCompositor | null = null;
  #api: TileCompositor | null = null;
  #lost = false;

  static async create(canvas: HTMLCanvasElement, adapter: GPUAdapter) {
    const device = await adapter.requestDevice();
    const r = new WebGpuRenderer(canvas, device);
    device.lost.then(i => {
      r.#lost = true;
      r.#comp?.dispose();
      r.#comp = null;
      console.error('WebGPU device lost:', i.message);
    });
    return r;
  }

  // Null until the compositor is built, and again once the device is lost: the caller then
  // falls back to CPU display tiles.
  get gpu(): TileCompositor | null {
    if (this.#lost) return null;
    const comp = (this.#comp ??= new GpuCompositor(this.#device));
    this.#api ??= {
      keys: () => comp.keys(),
      missing: (p: Program) => comp.missing(p),
      reset: () => comp.reset(),
      run: (slot: number, p: Program) => {
        const [x, y, z] = slotOrigin(slot);
        return comp.run(p, this.#tex, { x, y, z });
      },
    };
    return this.#api;
  }

  /// Parity test only: a smaller GPU payload budget, to force evictions.
  set payloadLimit(bytes: number) {
    (this.#comp ??= new GpuCompositor(this.#device)).limit = bytes;
  }

  /// The composited tile as RGBA8, for the WebGPU parity test only.
  readback(p: Program) {
    this.#comp ??= new GpuCompositor(this.#device);
    return this.#comp.readback(p);
  }

  private constructor(canvas: HTMLCanvasElement, device: GPUDevice) {
    this.#device = device;
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('WebGPU canvas context unavailable');
    this.#ctx = ctx;
    const format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: 'opaque' });
    const layers = Math.min(MAX_ARRAY_LAYERS, device.limits.maxTextureArrayLayers);
    this.slots = layers * 4;
    this.#tex = device.createTexture({ size: [512, 512, layers], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.#uniform = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ code: WGSL });
    this.#pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module, entryPoint: 'vs',
        buffers: [{
          arrayStride: FLOATS_PER_INSTANCE * 4, stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x4' },
            { shaderLocation: 1, offset: 16, format: 'float32x4' },
            { shaderLocation: 2, offset: 32, format: 'float32' },
          ],
        }],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-strip' },
    });
    const view = this.#tex.createView({ dimension: '2d-array' });
    const group = (filter: GPUFilterMode) => device.createBindGroup({
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.#uniform } },
        { binding: 1, resource: view },
        { binding: 2, resource: device.createSampler({ magFilter: filter, minFilter: filter }) },
      ],
    });
    this.#groups = { linear: group('linear'), nearest: group('nearest') };
  }

  upload(slot: number, data: Uint8Array) {
    this.#device.queue.writeTexture({ texture: this.#tex, origin: slotOrigin(slot) }, data as Uint8Array<ArrayBuffer>, { bytesPerRow: 1024, rowsPerImage: 256 }, [256, 256, 1]);
  }

  draw(f: Frame) {
    const d = this.#device;
    const bytes = f.count * FLOATS_PER_INSTANCE * 4;
    if (bytes > 0 && (!this.#inst || this.#inst.size < bytes)) {
      this.#inst?.destroy();
      this.#inst = d.createBuffer({ size: Math.max(bytes, 64 * 1024), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    const m = f.matrix;
    d.queue.writeBuffer(this.#uniform, 0, new Float32Array([m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, f.checker, 0, 0, 0]));
    if (bytes > 0) d.queue.writeBuffer(this.#inst!, 0, f.instances as Float32Array<ArrayBuffer>, 0, f.count * FLOATS_PER_INSTANCE);
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.#ctx.getCurrentTexture().createView(),
        clearValue: { r: BACKGROUND[0], g: BACKGROUND[1], b: BACKGROUND[2], a: 1 },
        loadOp: 'clear', storeOp: 'store',
      }],
    });
    if (bytes > 0) {
      pass.setPipeline(this.#pipeline);
      pass.setBindGroup(0, f.nearest ? this.#groups.nearest : this.#groups.linear);
      pass.setVertexBuffer(0, this.#inst!);
      pass.draw(4, f.count);
    }
    pass.end();
    d.queue.submit([enc.finish()]);
  }
}
