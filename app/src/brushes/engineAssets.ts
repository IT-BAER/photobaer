// Registers a preset's sampled tips and texture pattern in the engine worker on first use and remembers
// library ref -> engine id, so toStrokeParams can resolve them synchronously. One instance per engine client.
import type { BrushPreset, PatternRecord, TipRecord } from './preset.ts';

export interface AssetApi {
  tipAdd(w: number, h: number, alpha: Uint8Array): Promise<number>;
  patternAdd(w: number, h: number, data: Uint8Array, channels: number): Promise<number>;
}
export interface AssetSource { tip(id: string): TipRecord | undefined; pattern(id: string): PatternRecord | undefined }
type Kind = 'tip' | 'pattern';

export class EngineAssets {
  #api: AssetApi;
  #lib: AssetSource;
  #ids = new Map<string, number>();
  #pending = new Map<string, Promise<void>>();

  constructor(api: AssetApi, lib: AssetSource) { this.#api = api; this.#lib = lib; }

  resolve = (kind: Kind, ref: string): number | undefined => this.#ids.get(`${kind}:${ref}`);

  // Resolves once every referenced record is registered; missing records and rejected bitmaps stay unresolved
  // (toStrokeParams then falls back to a round tip / no texture) and are retried on the next prepare.
  async prepare(preset: BrushPreset): Promise<void> {
    const d = preset.dynamics;
    const refs: [Kind, string][] = [];
    if (preset.tip.kind === 'sampled') refs.push(['tip', preset.tip.tipRef]);
    if (d.dualBrush.enabled && d.dualBrush.tip?.kind === 'sampled') refs.push(['tip', d.dualBrush.tip.tipRef]);
    if (d.texture.enabled && d.texture.patternRef !== null) refs.push(['pattern', d.texture.patternRef]);
    await Promise.all(refs.map(([kind, ref]) => this.#register(kind, ref)));
  }

  // Worker id of a library pattern (Edit > Fill), registering it on first use; undefined when it cannot be.
  async pattern(ref: string): Promise<number | undefined> {
    await this.#register('pattern', ref);
    return this.resolve('pattern', ref);
  }

  #register(kind: Kind, ref: string): Promise<void> {
    const key = `${kind}:${ref}`;
    if (this.#ids.has(key)) return Promise.resolve();
    let p = this.#pending.get(key);
    if (p) return p;
    const add = async () => {
      if (kind === 'tip') {
        const t = this.#lib.tip(ref);
        return t && this.#api.tipAdd(t.width, t.height, t.alpha);
      }
      const r = this.#lib.pattern(ref);
      return r && this.#api.patternAdd(r.width, r.height, r.data, r.channels);
    };
    p = add().then(
      id => { if (id !== undefined) this.#ids.set(key, id); },
      err => console.warn(`brush ${kind} ${ref} not registered:`, err),
    ).finally(() => this.#pending.delete(key));
    this.#pending.set(key, p);
    return p;
  }
}
