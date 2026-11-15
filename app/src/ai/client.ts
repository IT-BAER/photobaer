// Promise RPC over the model worker, started on first use so the runtimes never load for users who do not use
// the model features.
import type { AiReply, AiRequest, FacesResult } from './ai.worker.ts';
import type { Model } from './models.ts';

type Body<R> = R extends { id: number } ? Omit<R, 'id'> : never;

export class AiClient {
  #w: Worker | null = null;
  #next = 1;
  #pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  // The backend of the loaded segmentation session ('webgpu' or 'wasm'), null before load.
  backend: string | null = null;
  faceLoaded = false;

  get busy() { return this.#pending.size > 0; }
  get loaded() { return this.backend !== null; }
  isLoaded(m: Model) { return m.kind === 'face' ? this.faceLoaded : this.loaded; }

  #worker() {
    if (this.#w) return this.#w;
    const w = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<AiReply>) => {
      const p = this.#pending.get(ev.data.id);
      if (!p) return;
      this.#pending.delete(ev.data.id);
      if (ev.data.error !== undefined) p.rej(new Error(ev.data.error)); else p.res(ev.data.result);
    };
    w.onerror = ev => {
      const err = new Error(`model worker failed:${ev.message}`);
      for (const p of this.#pending.values()) p.rej(err);
      this.#pending.clear();
      this.#w = null;
      this.backend = null;
      this.faceLoaded = false;
    };
    return (this.#w = w);
  }

  #call<T>(body: Body<AiRequest>, transfer: Transferable[]): Promise<T> {
    const id = this.#next++;
    return new Promise((res, rej) => {
      this.#pending.set(id, { res: res as (v: unknown) => void, rej });
      this.#worker().postMessage({ id, ...body }, { transfer });
    });
  }

  // Hands the model's bytes to the worker (they are moved, not copied).
  async load(model: ArrayBuffer) {
    this.backend = await this.#call<string>({ op: 'load', model }, [model]);
  }

  // The 0..255 mask of a side x side RGBA8 image.
  async segment(rgba: ArrayBuffer, side: number) {
    return new Uint8Array(await this.#call<ArrayBuffer>({ op: 'segment', rgba, side }, [rgba]));
  }

  // Loads model `m`'s bytes (moved, not copied) into its runtime.
  async loadModel(m: Model, bytes: ArrayBuffer) {
    if (m.kind === 'segmentation') return this.load(bytes);
    await this.#call<string>({ op: 'loadFace', model: bytes }, [bytes]);
    this.faceLoaded = true;
  }

  // Face landmarks of a w x h RGBA8 image (moved, not copied).
  async faces(rgba: ArrayBuffer, w: number, h: number) {
    const r = await this.#call<FacesResult>({ op: 'faces', rgba, w, h }, [rgba]);
    return { points: new Float32Array(r.points), count: r.count, oval: r.oval };
  }
}

export const ai = new AiClient();
