import type { EngineClient } from '../client.ts';
import type { TileResult, TileSource } from '../viewer.ts';
import type { Renderer } from './renderer.ts';
import { decodeProgram, type Program } from './program.ts';

const NONE = new BigUint64Array(0);

function base64(b: Uint8Array) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/// Test-only, behind `?gputest=1`: the GPU-composited tile and the engine's own CPU tile, for the
/// WebGPU parity spec. Without the query parameter the app exposes nothing extra.
export function gpuTestHook(client: EngineClient, r: Renderer) {
  if (!new URLSearchParams(location.search).has('gputest')) return {};
  const readback = (r as { readback?: (p: Program) => Promise<Uint8Array | null> }).readback?.bind(r);
  return {
    gpuParity: async (level: number, tx: number, ty: number) => {
      if (!readback) return { gpu: null, cpu: null, renderer: r.kind };
      const res = await client.call('displayProgram', level, tx, ty, NONE);
      const gpu = await readback(decodeProgram(res.data));
      const cpu = await client.call('displayTile', level, tx, ty);
      return {
        renderer: r.kind,
        gpu: gpu ? base64(gpu) : null,
        cpu: cpu.data ? base64(new Uint8Array(cpu.data)) : null,
      };
    },
  };
}

/// Display tiles for the viewer: composited on the GPU from the engine's draw program where that
/// works, else the engine's own CPU display tile (WebGL2, 16-bit documents, a lost device).
export function makeTileSource(client: EngineClient, r: Renderer): TileSource {
  // Document ids only grow. The GPU cache holds payloads of `doc` only; `off` is a document without programs (16-bit).
  let doc = 0, off = -1;
  const seen = (id: number) => {
    if (id <= doc) return;
    doc = id;
    r.gpu?.reset();
  };
  const program = async (level: number, tx: number, ty: number, known: BigUint64Array) => {
    const res = await client.call('displayProgram', level, tx, ty, known);
    seen(res.docId);
    return { res, p: decodeProgram(res.data) };
  };
  return async (level, tx, ty): Promise<TileResult> => {
    const gpu = r.gpu;
    let failed = false;
    if (gpu && off !== doc) {
      try {
        let { res, p } = await program(level, tx, ty, gpu.keys());
        // A reply for an older document: the viewer drops it, and its payloads must not enter the cache.
        if (res.docId < doc) return { docId: res.docId, version: res.version, fill: null };
        if (gpu.missing(p).length) {
          // A key reported as known was evicted, or belonged to the previous document: ask for the bytes.
          ({ res, p } = await program(level, tx, ty, NONE));
          if (res.docId < doc) return { docId: res.docId, version: res.version, fill: null };
        }
        // Still missing means the payload set alone overflows the GPU cache: that tile stays on CPU.
        if (!gpu.missing(p).length) {
          return { docId: res.docId, version: res.version, fill: p.steps.length ? slot => gpu.run(slot, p) : null };
        }
      } catch (e) {
        failed = true;
        console.warn('GPU compositor off for this document, using CPU display tiles:', e);
      }
    }
    const t = await client.call('displayTile', level, tx, ty);
    seen(t.docId);
    if (failed && t.docId === doc) off = doc;
    const data = t.data;
    return { docId: t.docId, version: t.version, fill: data ? slot => r.upload(slot, new Uint8Array(data)) : null };
  };
}
