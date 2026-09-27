import { tileIds } from './project.ts';

// OPFS layout: autosave/session-0.json, session-1.json (alternating, highest valid seq wins),
// autosave/docs/<key>/<tileId>. Tile files are immutable (copy-on-write ids), so only new tiles are written.
interface Session { seq: number; key: string; name: string; manifest: string }
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

async function readSession(dir: FileSystemDirectoryHandle, name: string): Promise<Session | null> {
  try {
    const s = JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()) as Session;
    return typeof s.seq === 'number' && typeof s.manifest === 'string' ? s : null;
  } catch {
    return null;
  }
}

const SESSIONS = ['session-0.json', 'session-1.json'];

export interface Restored { name: string; manifest: string; tile(id: number): Promise<Uint8Array> }

export class Autosave {
  #root: FileSystemDirectoryHandle;
  #docs: FileSystemDirectoryHandle;
  #seq = 0;
  #key = '';
  #written = new Set<number>();

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

  // Newest session whose tiles are all present, or null. Newer unusable sessions are deleted, because
  // new tiles may reuse their ids with different pixels and make them look complete but wrong.
  async load(): Promise<Restored | null> {
    const found = (await Promise.all(SESSIONS.map(async n => ({ n, s: await readSession(this.#root, n) }))))
      .filter((x): x is { n: string; s: Session } => !!x.s).sort((a, b) => b.s.seq - a.s.seq);
    for (const [i, { s }] of found.entries()) {
      try {
        const dir = await this.#docs.getDirectoryHandle(s.key);
        const names = new Set(await keys(dir));
        const ids = tileIds(s.manifest);
        if (![...ids].every(id => names.has(String(id)))) continue;
        for (const newer of found.slice(0, i)) await this.#root.removeEntry(newer.n);
        this.#seq = s.seq;
        this.#key = s.key;
        this.#written = ids;
        return { name: s.name, manifest: s.manifest, tile: async id => new Uint8Array(await (await (await dir.getFileHandle(String(id))).getFile()).arrayBuffer()) };
      } catch {
        continue;
      }
    }
    return null;
  }

  // A new document gets a new tile directory, because tile ids restart per engine instance.
  startDocument() {
    this.#key = crypto.randomUUID();
    this.#written = new Set();
  }

  // alive() turns false when the document was replaced mid-save; the save then stops without committing.
  async save(name: string, manifest: string, tileBytes: (id: number) => Uint8Array, alive: () => boolean) {
    // Captured once: startDocument() may swap key and set while this save waits on OPFS.
    const key = this.#key, written = this.#written;
    const dir = await this.#docs.getDirectoryHandle(key, { create: true });
    const ids = tileIds(manifest);
    for (const id of ids) {
      if (written.has(id)) continue;
      if (!alive()) return false;
      await writeFile(dir, String(id), tileBytes(id));
      written.add(id);
    }
    if (!alive()) return false;
    const seq = ++this.#seq;
    await writeFile(this.#root, `session-${seq % 2}.json`, new TextEncoder().encode(JSON.stringify({ seq, key, name, manifest } satisfies Session)));
    // Garbage: tiles the committed manifest no longer references, and directories of older documents.
    for (const n of await keys(dir)) {
      if (!ids.has(Number(n))) { await dir.removeEntry(n); written.delete(Number(n)); }
    }
    for (const k of await keys(this.#docs)) if (k !== key) await this.#docs.removeEntry(k, { recursive: true });
    return true;
  }

  async clear() {
    for (const n of SESSIONS) await this.#root.removeEntry(n).catch(() => {});
    for (const k of await keys(this.#docs)) await this.#docs.removeEntry(k, { recursive: true });
    this.#written = new Set();
  }
}
