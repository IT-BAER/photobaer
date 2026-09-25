import { COMPOSITE_WGSL, QUANTIZE_WGSL } from './composite.wgsl.ts';
import { OP, PayloadCache, referencedKeys, type Payload, type Program } from './program.ts';

const TILE = 256;
const WG = TILE / 8;
const UNIFORM_BYTES = 64;
// Tiles are 256 KiB (RGBA8) or 64 KiB (mask); the bound is what the GPU keeps of one document.
const PAYLOAD_BYTES = 64 << 20;

/// Runs one draw program per display tile: a stack of premultiplied f32 RGBA tiles, one compute
/// dispatch per step, then a quantize pass into the RGBA8 tile the viewer draws from.
export class GpuCompositor {
  #d: GPUDevice;
  #stepPipe: GPUComputePipeline;
  #quantPipe: GPUComputePipeline;
  #stepLayout: GPUBindGroupLayout;
  #quantLayout: GPUBindGroupLayout;
  #pool: GPUTexture[] = [];
  #zero: GPUTexture;
  #dummy8: GPUTextureView;
  #dummyMask: GPUTextureView;
  #out8: GPUTexture;
  #uniform: GPUBuffer | null = null;
  #stride: number;
  #cache = new PayloadCache<GPUTexture>(PAYLOAD_BYTES, t => t.destroy());
  #readback: GPUBuffer | null = null;

  constructor(device: GPUDevice) {
    this.#d = device;
    this.#stride = Math.max(UNIFORM_BYTES, device.limits.minUniformBufferOffsetAlignment);
    const tex = (sampleType: GPUTextureSampleType): GPUBindGroupLayoutEntry['texture'] => ({ sampleType, viewDimension: '2d' });
    this.#stepLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: UNIFORM_BYTES } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: tex('unfilterable-float') },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: tex('unfilterable-float') },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: tex('unfilterable-float') },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: tex('float') },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: tex('float') },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba32float', viewDimension: '2d' } },
      ],
    });
    this.#quantLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: tex('unfilterable-float') },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' } },
      ],
    });
    this.#stepPipe = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.#stepLayout] }),
      compute: { module: device.createShaderModule({ code: COMPOSITE_WGSL }), entryPoint: 'step_main' },
    });
    this.#quantPipe = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.#quantLayout] }),
      compute: { module: device.createShaderModule({ code: QUANTIZE_WGSL }), entryPoint: 'quantize' },
    });
    this.#zero = this.#buffer();
    this.#out8 = device.createTexture({
      size: [TILE, TILE], format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const dummy = (format: GPUTextureFormat) =>
      device.createTexture({ size: [1, 1], format, usage: GPUTextureUsage.TEXTURE_BINDING }).createView();
    this.#dummy8 = dummy('rgba8unorm');
    this.#dummyMask = dummy('r8unorm');
  }

  /// Payload keys the GPU already holds; the worker leaves their bytes out of the next program.
  keys() { return this.#cache.keys(); }

  /// Uploads the payloads the program ships and returns the keys it still references but that
  /// the cache has evicted since they were reported as `known`.
  missing(p: Program) {
    for (const t of p.payloads) if (!this.#cache.get(t.key)) this.#upload(t);
    return referencedKeys(p).filter(k => !this.#cache.get(k));
  }

  reset() { this.#cache.clear(); }

  /// Test hook: a smaller payload budget forces evictions.
  set limit(bytes: number) { this.#cache.limit = bytes; }

  dispose() {
    this.#cache.clear();
    for (const t of [...this.#pool, this.#zero, this.#out8]) t.destroy();
    this.#pool = [];
    this.#uniform?.destroy();
    this.#readback?.destroy();
  }

  /// Composites one tile and copies it into `target` at `origin`. Returns false when a referenced
  /// payload is gone, so the caller can ask again with an empty `known` list.
  run(p: Program, target: GPUTexture, origin: GPUOrigin3DDict): boolean {
    if (this.missing(p).length) return false;
    const enc = this.#d.createCommandEncoder();
    const top = this.#encode(p, enc);
    const pass2 = enc.beginComputePass();
    pass2.setPipeline(this.#quantPipe);
    pass2.setBindGroup(0, this.#d.createBindGroup({
      layout: this.#quantLayout,
      entries: [{ binding: 0, resource: top.createView() }, { binding: 1, resource: this.#out8.createView() }],
    }));
    pass2.dispatchWorkgroups(WG, WG);
    pass2.end();
    enc.copyTextureToTexture({ texture: this.#out8 }, { texture: target, origin }, [TILE, TILE, 1]);
    this.#d.queue.submit([enc.finish()]);
    this.#release(top);
    return true;
  }

  /// The composited tile as RGBA8 bytes. Only used by the parity test; the display path never
  /// reads back.
  async readback(p: Program): Promise<Uint8Array | null> {
    if (this.missing(p).length) return null;
    if (!this.#readback) {
      this.#readback = this.#d.createBuffer({ size: TILE * TILE * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    }
    const enc = this.#d.createCommandEncoder();
    const top = this.#encode(p, enc);
    const pass = enc.beginComputePass();
    pass.setPipeline(this.#quantPipe);
    pass.setBindGroup(0, this.#d.createBindGroup({
      layout: this.#quantLayout,
      entries: [{ binding: 0, resource: top.createView() }, { binding: 1, resource: this.#out8.createView() }],
    }));
    pass.dispatchWorkgroups(WG, WG);
    pass.end();
    enc.copyTextureToBuffer({ texture: this.#out8 }, { buffer: this.#readback, bytesPerRow: TILE * 4 }, [TILE, TILE, 1]);
    this.#d.queue.submit([enc.finish()]);
    this.#release(top);
    await this.#readback.mapAsync(GPUMapMode.READ);
    const out = new Uint8Array(this.#readback.getMappedRange()).slice();
    this.#readback.unmap();
    return out;
  }

  // One compute pass, one dispatch per step; returns the texture holding the result.
  #encode(p: Program, enc: GPUCommandEncoder): GPUTexture {
    const stride = this.#stride;
    const need = Math.max(1, p.steps.length) * stride;
    if (!this.#uniform || this.#uniform.size < need) {
      this.#uniform?.destroy();
      this.#uniform = this.#d.createBuffer({ size: need, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    const words = new Uint32Array(need / 4);
    const floats = new Float32Array(words.buffer);
    const stack: GPUTexture[] = [this.#zero];
    const shapes: GPUTexture[] = [];
    const groups: { bind: GPUBindGroup; offset: number }[] = [];
    for (let i = 0; i < p.steps.length; i++) {
      const s = p.steps[i];
      if (s.op === OP.pop) { this.#release(stack.pop()!); continue; }
      if (s.op === OP.popShape) { this.#release(shapes.pop()!); continue; }
      const top = stack[stack.length - 1];
      const out = this.#acquire();
      // `aux` is the popped buffer (draw from the stack, lerp, backdrop ops) or the shape source.
      let dst = top, aux = this.#zero, srcTile = this.#dummy8, popped = 0;
      switch (s.op) {
        case OP.draw:
          if (s.src === 0n) { aux = top; dst = stack[stack.length - 2]; popped = 2; }
          else { srcTile = this.#cache.get(s.src)!.createView(); popped = 1; }
          break;
        case OP.pushTransparent: dst = this.#zero; popped = 0; break;
        case OP.pushCopy: popped = 0; break;
        case OP.popLerp: aux = top; dst = stack[stack.length - 2]; popped = 2; break;
        case OP.pushShape:
          if (s.src === 0n) aux = top;
          else srcTile = this.#cache.get(s.src)!.createView();
          popped = 0;
          break;
        case OP.subBackdrop: aux = stack[stack.length - 2]; popped = 1; break;
        case OP.popAddBackdrop: aux = top; dst = stack[stack.length - 2]; popped = 2; break;
        default: popped = 1; break; // div/mul shape
      }
      const o = (i * stride) / 4;
      words[o] = s.op;
      words[o + 1] = s.maskKind;
      words[o + 2] = s.mode;
      words[o + 3] = srcTile === this.#dummy8 ? 0 : 1;
      words[o + 4] = s.node;
      words[o + 5] = p.level;
      words[o + 6] = p.ox;
      words[o + 7] = p.oy;
      words[o + 8] = p.vw;
      words[o + 9] = p.vh;
      floats[o + 12] = s.scale;
      floats[o + 13] = s.maskConst;
      groups.push({
        offset: i * stride,
        bind: this.#d.createBindGroup({
          layout: this.#stepLayout,
          entries: [
            { binding: 0, resource: { buffer: this.#uniform, offset: 0, size: UNIFORM_BYTES } },
            { binding: 1, resource: dst.createView() },
            { binding: 2, resource: aux.createView() },
            { binding: 3, resource: (shapes[shapes.length - 1] ?? this.#zero).createView() },
            { binding: 4, resource: srcTile },
            { binding: 5, resource: s.maskKind === 2 ? this.#cache.get(s.mask)!.createView() : this.#dummyMask },
            { binding: 6, resource: out.createView() },
          ],
        }),
      });
      for (let n = 0; n < popped; n++) this.#release(stack.pop()!);
      if (s.op === OP.pushShape) shapes.push(out);
      else stack.push(out);
    }
    this.#d.queue.writeBuffer(this.#uniform, 0, words);
    const pass = enc.beginComputePass();
    pass.setPipeline(this.#stepPipe);
    for (const g of groups) {
      pass.setBindGroup(0, g.bind, [g.offset]);
      pass.dispatchWorkgroups(WG, WG);
    }
    pass.end();
    const result = stack.pop()!;
    for (const t of [...shapes, ...stack]) this.#release(t);
    return result;
  }

  // WebGPU does not report free VRAM, so the budget shrinks when an upload runs out of memory.
  // The failed payload is dropped; the next program for its tile ships it again.
  #upload(t: Payload) {
    const bytes = t.mask ? TILE * TILE : TILE * TILE * 4;
    this.#d.pushErrorScope('out-of-memory');
    const tex = this.#d.createTexture({
      size: [TILE, TILE], format: t.mask ? 'r8unorm' : 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#d.queue.writeTexture({ texture: tex }, t.bytes, { bytesPerRow: bytes / TILE, rowsPerImage: TILE }, [TILE, TILE, 1]);
    this.#cache.set(t.key, tex, bytes);
    void this.#d.popErrorScope().then(err => {
      if (!err) return;
      this.#cache.delete(t.key);
      this.#cache.limit = Math.max(TILE * TILE * 4, this.#cache.size >> 1);
      console.warn('GPU out of memory, payload budget now', this.#cache.limit, 'bytes');
    });
  }

  #buffer() {
    return this.#d.createTexture({
      size: [TILE, TILE], format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
  }

  #acquire() { return this.#pool.pop() ?? this.#buffer(); }

  #release(t: GPUTexture) { if (t !== this.#zero) this.#pool.push(t); }
}
