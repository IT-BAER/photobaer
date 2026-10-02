import { tileIds } from './project.ts';

// OPFS layout: autosave/session-0.json, session-1.json (alternating, highest valid seq wins), each listing every open
// document in tab order, and autosave/docs/<key>/<tileId>. Tile files are immutable (copy-on-write ids), so only new tiles are written.
interface SessionDoc { key: string; name: string; manifest: string; dirty: boolean }
interface Session { seq: number; active: string; docs: SessionDoc[] }
interface SyncHandle { truncate(n: number): void; write(d: Uint8Array, o: { at: number }): number; flush(): void; close(): void }

export async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Uint8Array) {
  const fh = await dir.getFileHandle(name, { create: true });
  const h = await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
  try {
    h.truncate(0);
    h.write(data, { at: 0 });
    h.flush();
  } finally {
    h.close();
  }
}

async function keys(dir: FileSystemDirectoryHandle) {
  const out: string[] = [];
  for await (const k of dir.keys()) out.push(k);
  return out;
}

// Also reads the single-document format of older builds ({ seq, key, name, manifest }) as one clean tab.
async function readSession(dir: FileSystemDirectoryHandle, name: string): Promise<Session | null> {
  try {
    const s = JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
    if (typeof s?.seq !== 'number') return null;
    if (typeof s.key === 'string' && typeof s.manifest === 'string') return { seq: s.seq, active: s.key, docs: [{ key: s.key, name: String(s.name), manifest: s.manifest, dirty: false }] };
    const ok = typeof s.active === 'string' && Array.isArray(s.docs) && s.docs.every((d: SessionDoc) => typeof d?.key === 'string' && typeof d.manifest === 'string');
    return ok ? s as Session : null;
  } catch {
    return null;
  }
}

const SESSIONS = ['session-0.json', 'session-1.json'];

export interface DocSave extends SessionDoc { tile(id: number): Uint8Array }
export interface RestoredDoc extends SessionDoc { tile(id: number): Promise<Uint8Array> }
// `skipped`: names of documents whose tiles are incomplete.
export interface Restored { active: string; docs: RestoredDoc[]; skipped: string[] }

export class Autosave {
  #root: FileSystemDirectoryHandle;
  #docs: FileSystemDirectoryHandle;
  #seq = 0;
  // Per document key: tile ids on disk, and the manifest of the last committed session.
  #written = new Map<string, Set<number>>();
  #committed = new Map<string, string>();
  // Listed documents that did not restore: every later session lists them again and keeps their folders, so a
  // later reload can retry; only clear() drops them.
  #lost: SessionDoc[] = [];

  private constructor(root: FileSystemDirectoryHandle, docs: FileSystemDirectoryHandle) {
    this.#root = root;
    this.#docs = docs;
  }

  // Null when OPFS is missing or another tab owns the autosave (Web Lock held for the worker's lifetime).
  static async open(): Promise<Autosave | null> {
    if (!navigator.storage?.getDirectory || !navigator.locks) return null;
    const got = await new Promise<boolean>(res => {
      navigator.locks.request('photobaer-autosave', { ifAvailable: true }, lock => {
        res(!!lock);
        return lock ? new Promise<void>(() => {}) : undefined;
      });
    });
    if (!got) return null;
    return Autosave.fromRoot(await navigator.storage.getDirectory());
  }

  static async fromRoot(opfs: FileSystemDirectoryHandle) {
    const root = await opfs.getDirectoryHandle('autosave', { create: true });
    return new Autosave(root, await root.getDirectoryHandle('docs', { create: true }));
  }

  // Newest session with at least one document whose tiles are all present, or null; its incomplete documents are
  // skipped. Newer unusable sessions are deleted, because new tiles may reuse their ids with different pixels.
  async load(): Promise<Restored | null> {
    const found = (await Promise.all(SESSIONS.map(async n => ({ n, s: await readSession(this.#root, n) }))))
      .filter((x): x is { n: string; s: Session } => !!x.s).sort((a, b) => b.s.seq - a.s.seq);
    for (const [i, { s }] of found.entries()) {
      const docs: { d: SessionDoc; dir: FileSystemDirectoryHandle; ids: Set<number> }[] = [], skipped: string[] = [];
      for (const d of s.docs) {
        try {
          const dir = await this.#docs.getDirectoryHandle(d.key);
          const names = new Set(await keys(dir));
          const ids = tileIds(d.manifest);
          if ([...ids].every(id => names.has(String(id)))) { docs.push({ d, dir, ids }); continue; }
        } catch { /* missing folder or bad manifest */ }
        skipped.push(d.name);
      }
      if (!docs.length) continue;
      this.#lost = s.docs.filter(d => !docs.some(x => x.d === d));
      for (const newer of found.slice(0, i)) await this.#root.removeEntry(newer.n);
      this.#seq = s.seq;
      this.#written = new Map(docs.map(x => [x.d.key, x.ids]));
      this.#committed = new Map([...docs.map(x => x.d), ...this.#lost].map(d => [d.key, d.manifest]));
      return {
        active: s.active, skipped,
        docs: docs.map(({ d, dir }) => ({ key: d.key, name: d.name, manifest: d.manifest, dirty: !!d.dirty, tile: async id => new Uint8Array(await (await (await dir.getFileHandle(String(id))).getFile()).arrayBuffer()) })),
      };
    }
    return null;
  }

  // Names of the documents that did not restore.
  get lost() { return this.#lost.map(d => d.name); }

  // Keeps a loaded document the worker could not open (corrupt data, out of memory) like an incomplete one.
  keep(d: SessionDoc) {
    this.#lost.push({ key: d.key, name: d.name, manifest: d.manifest, dirty: d.dirty });
  }

  // Commits a session listing `docs` in tab order; only documents whose manifest changed since the last commit
  // write their new tiles. alive() turns false when a listed document closed mid-save; the save then stops uncommitted.
  async save(docs: DocSave[], active: string, alive: () => boolean) {
    const changed = docs.filter(d => this.#committed.get(d.key) !== d.manifest);
    for (const d of changed) {
      let written = this.#written.get(d.key);
      if (!written) this.#written.set(d.key, written = new Set());
      const dir = await this.#docs.getDirectoryHandle(d.key, { create: true });
      for (const id of tileIds(d.manifest)) {
        if (written.has(id)) continue;
        if (!alive()) return false;
        await writeFile(dir, String(id), d.tile(id));
        written.add(id);
      }
    }
    if (!alive()) return false;
    const seq = ++this.#seq;
    const listed = [...docs.map(({ key, name, manifest, dirty }) => ({ key, name, manifest, dirty })), ...this.#lost];
    await writeFile(this.#root, `session-${seq % 2}.json`, new TextEncoder().encode(JSON.stringify({ seq, active, docs: listed } satisfies Session)));
    this.#committed = new Map(listed.map(d => [d.key, d.manifest]));
    // Garbage, only after the commit: tiles the committed manifests no longer reference, and folders of closed documents.
    for (const d of changed) {
      const ids = tileIds(d.manifest), written = this.#written.get(d.key)!;
      const dir = await this.#docs.getDirectoryHandle(d.key);
      for (const n of await keys(dir)) {
        if (!ids.has(Number(n))) { await dir.removeEntry(n); written.delete(Number(n)); }
      }
    }
    for (const k of await keys(this.#docs)) {
      if (!this.#committed.has(k)) { await this.#docs.removeEntry(k, { recursive: true }); this.#written.delete(k); }
    }
    return true;
  }

  // Documents that did not restore survive: the session then lists only them.
  async clear() {
    if (this.#lost.length) { await this.save([], '', () => true); return; }
    for (const n of SESSIONS) await this.#root.removeEntry(n).catch(() => {});
    for (const k of await keys(this.#docs)) await this.#docs.removeEntry(k, { recursive: true });
    this.#written = new Map();
    this.#committed = new Map();
    this.#lost = [];
  }
}
