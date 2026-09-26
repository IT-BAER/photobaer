// Tiles are 256x256 premultiplied RGBA8, packed 2x2 into the layers of a 512x512 texture array.
// Instance layout (9 floats): doc rect x0 y0 x1 y1, tile uv u0 v0 u1 v1, slot (-1 = no texture, checker only).
import type { Program } from './program.ts';

export const FLOATS_PER_INSTANCE = 9;
export const MAX_ARRAY_LAYERS = 128;

export interface Frame {
  instances: Float32Array;
  count: number;
  matrix: number[]; // row-major 2x3, doc -> clip
  checker: number;  // checker cell size in device px
  nearest: boolean;
}

// Composites a display tile straight into a slot from the engine's draw program (WebGPU only).
export interface TileCompositor {
  keys(): BigUint64Array;
  missing(p: Program): bigint[];
  run(slot: number, p: Program): boolean;
  /// Drops every payload: keys are tile ids, which restart with each document.
  reset(): void;
}

export interface Renderer {
  readonly kind: 'webgpu' | 'webgl2';
  readonly slots: number;
  readonly gpu: TileCompositor | null;
  upload(slot: number, data: Uint8Array): void;
  draw(f: Frame): void;
}

export const BACKGROUND = [19 / 255, 20 / 255, 22 / 255]; // --bg (#131416)

export function slotOrigin(slot: number): [number, number, number] {
  return [(slot & 1) * 256, ((slot >> 1) & 1) * 256, slot >> 2];
}

export async function createRenderer(canvas: HTMLCanvasElement, force?: string | null): Promise<Renderer> {
  if (force !== 'webgl2' && navigator.gpu) {
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter) {
      const { WebGpuRenderer } = await import('./webgpu.ts');
      return WebGpuRenderer.create(canvas, adapter);
    }
  }
  const { WebGl2Renderer } = await import('./webgl2.ts');
  return new WebGl2Renderer(canvas);
}
