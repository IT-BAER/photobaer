// Brush library persistence: IndexedDB `photobaer-brushes` (presets, tips, patterns, meta) with a memory fallback.
// Built-ins are not stored until edited; deleting one records its id in meta.deletedIds. Writes are debounced.
import { builtinPatterns, builtinPresets, BUILTIN_REVISION } from './builtin.ts';
import type { BrushPreset, PatternRecord, TipRecord } from './preset.ts';

export const PRESET_CAP = 20000;
export const WRITE_DELAY_MS = 250;

export interface Meta { defaultsRevision: number; deletedIds: string[] }
type Stored = BrushPreset & { seq: number };
export interface BrushData { presets: Stored[]; tips: TipRecord[]; patterns: PatternRecord[]; meta: Meta }
export interface Changes { putPresets: Stored[]; deletePresets: string[]; putTips: TipRecord[]; putPatterns: PatternRecord[]; meta: Meta }
export interface BrushBackend { load(): Promise<BrushData>; save(c: Changes): Promise<void> }

const emptyMeta = (): Meta => ({ defaultsRevision: BUILTIN_REVISION, deletedIds: [] });

export class MemoryStore implements BrushBackend {
  #presets = new Map<string, Stored>();
  #tips = new Map<string, TipRecord>();
  #patterns = new Map<string, PatternRecord>();
  #meta = emptyMeta();
  saves = 0;
  async load() { return structuredClone(this.dump()); }
  async save(c: Changes) {
    this.saves++;
    for (const id of c.deletePresets) this.#presets.delete(id);
    for (const p of structuredClone(c.putPresets)) this.#presets.set(p.id, p);
    for (const t of structuredClone(c.putTips)) this.#tips.set(t.id, t);
    for (const p of structuredClone(c.putPatterns)) this.#patterns.set(p.id, p);
    this.#meta = structuredClone(c.meta);
  }
  dump(): BrushData { return { presets: [...this.#presets.values()], tips: [...this.#tips.values()], patterns: [...this.#patterns.values()], meta: this.#meta }; }
}

const STORES = ['presets', 'tips', 'patterns', 'meta'] as const;
const req = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

class IdbStore implements BrushBackend {
  #db: IDBDatabase;
  constructor(db: IDBDatabase) { this.#db = db; }
  async load(): Promise<BrushData> {
    const tx = this.#db.transaction([...STORES], 'readonly');
    const [presets, tips, patterns, meta] = await Promise.all([
      req(tx.objectStore('presets').getAll()), req(tx.objectStore('tips').getAll()), req(tx.objectStore('patterns').getAll()), req(tx.objectStore('meta').get('meta')),
    ]);
    return { presets, tips, patterns, meta: (meta as Meta | undefined) ?? emptyMeta() };
  }
  save(c: Changes): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction([...STORES], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
      for (const id of c.deletePresets) tx.objectStore('presets').delete(id);
      for (const p of c.putPresets) tx.objectStore('presets').put(p);
      for (const t of c.putTips) tx.objectStore('tips').put(t);
      for (const p of c.putPatterns) tx.objectStore('patterns').put(p);
      tx.objectStore('meta').put(c.meta, 'meta');
    });
  }
}

export async function openBrushStore(): Promise<BrushBackend> {
  if (typeof indexedDB === 'undefined') return new MemoryStore();
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('photobaer-brushes', 1);
      r.onupgradeneeded = () => {
        for (const s of ['presets', 'tips', 'patterns'] as const) r.result.createObjectStore(s, { keyPath: 'id' });
        r.result.createObjectStore('meta');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return new IdbStore(db);
  } catch {
    return new MemoryStore();
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameTip = (a: TipRecord, b: TipRecord) => a.width === b.width && a.height === b.height && sameBytes(a.alpha, b.alpha);
const samePattern = (a: PatternRecord, b: PatternRecord) => a.width === b.width && a.height === b.height && a.channels === b.channels && sameBytes(a.data, b.data);

function unique(taken: (id: string) => boolean, id: string) {
  let out = id;
  for (let n = 2; taken(out); n++) out = `${id}#${n}`;
  return out;
}

export class BrushLibrary {
  #backend: BrushBackend;
  #builtins = builtinPresets();
  #builtinIds = new Set(this.#builtins.map(p => p.id));
  #builtinPatterns = new Map(builtinPatterns().map(p => [p.id, p]));
  #stored = new Map<string, Stored>();
  #tips = new Map<string, TipRecord>();
  #patterns = new Map<string, PatternRecord>();
  #deleted = new Set<string>();
  #seq = 0;
  #dirty = { presets: new Set<string>(), removed: new Set<string>(), tips: new Set<string>(), patterns: new Set<string>(), meta: false };
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending: Promise<void> = Promise.resolve();
  lastError: unknown = null;

  private constructor(backend: BrushBackend) { this.#backend = backend; }

  static async open(backend?: BrushBackend): Promise<BrushLibrary> {
    const lib = new BrushLibrary(backend ?? await openBrushStore());
    const data = await lib.#backend.load();
    for (const p of data.presets) { lib.#stored.set(p.id, p); lib.#seq = Math.max(lib.#seq, p.seq + 1); }
    for (const t of data.tips) lib.#tips.set(t.id, t);
    for (const p of data.patterns) lib.#patterns.set(p.id, p);
    for (const id of data.meta.deletedIds) lib.#deleted.add(id);
    return lib;
  }

  // Built-ins in their fixed order (edited copies in place), then stored user presets in insertion order.
  list(): BrushPreset[] {
    const strip = ({ seq: _seq, ...p }: Stored): BrushPreset => p;
    const out = this.#builtins.filter(p => !this.#deleted.has(p.id)).map(p => { const s = this.#stored.get(p.id); return s ? strip(s) : p; });
    const user = [...this.#stored.values()].filter(p => !this.#builtinIds.has(p.id)).sort((a, b) => a.seq - b.seq);
    return out.concat(user.map(strip));
  }

  tip(id: string) { return this.#tips.get(id); }
  pattern(id: string) { return this.#builtinPatterns.get(id) ?? this.#patterns.get(id); }

  #userCount() { let n = 0; for (const id of this.#stored.keys()) if (!this.#builtinIds.has(id)) n++; return n; }

  // Adds or replaces a preset; returns false when a new user preset would exceed PRESET_CAP.
  save(preset: BrushPreset): boolean {
    const old = this.#stored.get(preset.id);
    if (!old && !this.#builtinIds.has(preset.id) && this.#userCount() >= PRESET_CAP) return false;
    this.#stored.set(preset.id, { ...structuredClone(preset), seq: old?.seq ?? this.#seq++ });
    if (this.#deleted.delete(preset.id)) this.#dirty.meta = true;
    this.#dirty.presets.add(preset.id);
    this.#dirty.removed.delete(preset.id);
    this.#schedule();
    return true;
  }

  // ponytail: tips/patterns of deleted presets stay stored; add a reference sweep if the store grows.
  delete(id: string) {
    if (this.#stored.delete(id)) { this.#dirty.removed.add(id); this.#dirty.presets.delete(id); }
    if (this.#builtinIds.has(id)) { this.#deleted.add(id); this.#dirty.meta = true; }
    this.#schedule();
  }

  // Imports a parsed set: identical tips/patterns are shared, id clashes are renamed and references remapped.
  import(set: { presets: BrushPreset[]; tips: TipRecord[]; patterns: PatternRecord[] }): { added: number; warnings: string[] } {
    const tipMap = new Map<string, string>(), patMap = new Map<string, string>();
    for (const t of set.tips) {
      const have = this.#tips.get(t.id);
      if (have && sameTip(have, t)) { tipMap.set(t.id, t.id); continue; }
      const id = have ? unique(x => this.#tips.has(x), t.id) : t.id;
      this.#tips.set(id, { ...t, id });
      this.#dirty.tips.add(id);
      tipMap.set(t.id, id);
    }
    for (const p of set.patterns) {
      const have = this.pattern(p.id);
      if (have && samePattern(have, p)) { patMap.set(p.id, p.id); continue; }
      const id = have ? unique(x => this.pattern(x) !== undefined, p.id) : p.id;
      this.#patterns.set(id, { ...p, id });
      this.#dirty.patterns.add(id);
      patMap.set(p.id, id);
    }
    const warnings: string[] = [];
    let added = 0;
    for (const src of set.presets) {
      const p = structuredClone(src);
      p.id = unique(x => this.#stored.has(x) || this.#builtinIds.has(x), p.id);
      if (p.tip.kind === 'sampled') p.tip.tipRef = tipMap.get(p.tip.tipRef) ?? p.tip.tipRef;
      const dt = p.dynamics.dualBrush.tip;
      if (dt?.kind === 'sampled') dt.tipRef = tipMap.get(dt.tipRef) ?? dt.tipRef;
      const pr = p.dynamics.texture.patternRef;
      if (pr !== null) p.dynamics.texture.patternRef = patMap.get(pr) ?? pr;
      if (!this.save(p)) { warnings.push(`library holds ${PRESET_CAP} presets; ${set.presets.length - added} not imported`); break; }
      added++;
    }
    this.#schedule();
    return { added, warnings };
  }

  #schedule() {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#timer = null; void this.flush().catch(() => {}); }, WRITE_DELAY_MS);
  }

  // Resolves once every write started so far has finished.
  idle() { return this.#pending; }

  // Writes pending changes now. On failure the changes stay pending for the next write and the error is rethrown.
  flush(): Promise<void> {
    if (this.#timer !== null) { clearTimeout(this.#timer); this.#timer = null; }
    const d = this.#dirty;
    this.#dirty = { presets: new Set(), removed: new Set(), tips: new Set(), patterns: new Set(), meta: false };
    const changes: Changes = {
      putPresets: [...d.presets].flatMap(id => this.#stored.get(id) ?? []),
      deletePresets: [...d.removed],
      putTips: [...d.tips].flatMap(id => this.#tips.get(id) ?? []),
      putPatterns: [...d.patterns].flatMap(id => this.#patterns.get(id) ?? []),
      meta: { defaultsRevision: BUILTIN_REVISION, deletedIds: [...this.#deleted] },
    };
    const run = this.#pending.catch(() => {}).then(() => this.#backend.save(changes)).then(
      () => { this.lastError = null; },
      e => {
        this.lastError = e;
        for (const id of d.presets) if (!this.#dirty.removed.has(id)) this.#dirty.presets.add(id);
        for (const id of d.removed) if (!this.#dirty.presets.has(id)) this.#dirty.removed.add(id);
        for (const id of d.tips) this.#dirty.tips.add(id);
        for (const id of d.patterns) this.#dirty.patterns.add(id);
        this.#dirty.meta ||= d.meta;
        throw e;
      },
    );
    this.#pending = run.catch(() => {});
    return run;
  }
}
