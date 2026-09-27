// Uploaded fonts: bytes in OPFS `fonts/<sha-256>` (stored once per content), index rows in IndexedDB.
// Worker only (OPFS sync access handles). Fonts never enter documents (M4 D4).
import { writeFile } from '../autosave.ts';

export interface FontRecord { hash: string; name: string; size: number; added: number }
export interface FontIndex { all(): Promise<FontRecord[]>; put(r: FontRecord): Promise<void> }

export function idbIndex(): Promise<FontIndex> {
  return new Promise((res, rej) => {
    const open = indexedDB.open('photobaer-fonts', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('uploads', { keyPath: 'hash' });
    open.onerror = () => rej(open.error);
    open.onsuccess = () => {
      const db = open.result;
      // Settles when the transaction commits, so a put is durable once awaited.
      const run = <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) => new Promise<T>((ok, no) => {
        const tx = db.transaction('uploads', mode);
        const r = f(tx.objectStore('uploads'));
        tx.oncomplete = () => ok(r.result);
        tx.onerror = tx.onabort = () => no(tx.error);
      });
      res({ all: () => run('readonly', s => s.getAll() as IDBRequest<FontRecord[]>), put: async r => { await run('readwrite', s => s.put(r)); } });
    };
  });
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');

export class FontStore {
  #dir: FileSystemDirectoryHandle;
  #index: FontIndex;

  private constructor(dir: FileSystemDirectoryHandle, index: FontIndex) {
    this.#dir = dir;
    this.#index = index;
  }

  // Null without OPFS or IndexedDB (uploads then last for the session only).
  static async open(): Promise<FontStore | null> {
    if (!navigator.storage?.getDirectory || typeof indexedDB === 'undefined') return null;
    // Blocked storage (private mode, quota, policy) keeps uploads for the session only.
    try { return await FontStore.fromRoot(await navigator.storage.getDirectory(), await idbIndex()); } catch { return null; }
  }

  static async fromRoot(opfs: FileSystemDirectoryHandle, index: FontIndex) {
    return new FontStore(await opfs.getDirectoryHandle('fonts', { create: true }), index);
  }

  // The file is written before its index row, so a row never names a missing file after a crash.
  async put(name: string, bytes: Uint8Array): Promise<{ record: FontRecord; fresh: boolean }> {
    const hash = hex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
    const known = (await this.#index.all()).find(r => r.hash === hash);
    if (known) return { record: known, fresh: false };
    await writeFile(this.#dir, hash, bytes);
    const record = { hash, name, size: bytes.length, added: Date.now() };
    await this.#index.put(record);
    return { record, fresh: true };
  }

  // Every indexed upload with its bytes; rows whose file is gone (storage cleared) are skipped.
  async all(): Promise<{ record: FontRecord; bytes: Uint8Array }[]> {
    const out = [];
    for (const record of await this.#index.all()) {
      try {
        out.push({ record, bytes: new Uint8Array(await (await (await this.#dir.getFileHandle(record.hash)).getFile()).arrayBuffer()) });
      } catch { /* missing file: skipped */ }
    }
    return out;
  }
}
