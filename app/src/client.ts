import type { Api, WorkerEvent } from './engine.worker.ts';

type Result<K extends keyof Api> = Awaited<ReturnType<Api[K]>>;

// Promise RPC over the engine worker. One worker owns the engine, history, codecs and autosave.
export class EngineClient {
  onEvent: (e: WorkerEvent) => void = () => {};
  #w = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
  #next = 1;
  #pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();

  constructor() {
    this.#w.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      if ('event' in m) return this.onEvent(m as WorkerEvent);
      const p = this.#pending.get(m.id);
      if (!p) return;
      this.#pending.delete(m.id);
      if ('error' in m) p.rej(new Error(m.error));
      else p.res(m.result);
    };
    this.#w.onerror = ev => {
      const err = new Error(`engine worker failed: ${ev.message}`);
      for (const p of this.#pending.values()) p.rej(err);
      this.#pending.clear();
    };
  }

  // Every other call waits until init has settled, so nothing reaches an engine that has not booted
  // and a late init result never replaces a document opened during boot.
  call<K extends keyof Api>(op: K, ...args: Parameters<Api[K]>): Promise<Result<K>> {
    if (op !== 'init') return this.#booted.then(() => this.#send(op, ...args));
    const p = this.#send(op, ...args);
    p.then(this.#boot, this.#boot);
    return p;
  }

  #boot!: () => void;
  #booted = new Promise<void>(r => { this.#boot = r; });

  #send<K extends keyof Api>(op: K, ...args: Parameters<Api[K]>): Promise<Result<K>> {
    const id = this.#next++;
    return new Promise((res, rej) => {
      this.#pending.set(id, { res: res as (v: unknown) => void, rej });
      this.#w.postMessage({ id, op, args });
    });
  }
}

// One worker per page; kept out of App.tsx so a hot reload of the UI does not start a second engine.
export const client = new EngineClient();
