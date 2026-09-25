// In-memory stand-in for the OPFS directory API, for tests. `hold` parks the next sync-handle open
// until released; `slow` makes every call wait one timer turn, like real OPFS I/O.
export const fs: { hold: Promise<void> | null; slow: boolean } = { hold: null, slow: false };
const io = () => fs.slow ? new Promise(r => setTimeout(r, 0)) : undefined;

export class FakeFile {
  data = new Uint8Array();
  async getFile() { await io(); const d = this.data; return { text: async () => new TextDecoder().decode(d), arrayBuffer: async () => d.slice().buffer }; }
  async createSyncAccessHandle() {
    await io();
    if (fs.hold) await fs.hold;
    return {
      truncate: () => { this.data = new Uint8Array(); },
      write: (d: Uint8Array) => { this.data = d.slice(); return d.length; },
      flush() {}, close() {},
    };
  }
}
export class FakeDir {
  entries = new Map<string, FakeDir | FakeFile>();
  async getDirectoryHandle(n: string, o?: { create?: boolean }) { await io(); return this.#get(n, o, () => new FakeDir()) as FakeDir; }
  async getFileHandle(n: string, o?: { create?: boolean }) { await io(); return this.#get(n, o, () => new FakeFile()) as FakeFile; }
  async removeEntry(n: string) { await io(); if (!this.entries.delete(n)) throw new Error('NotFound'); }
  async *keys() { await io(); yield* [...this.entries.keys()]; }
  #get(n: string, o: { create?: boolean } | undefined, make: () => FakeDir | FakeFile) {
    let e = this.entries.get(n);
    if (!e) { if (!o?.create) throw new Error(`NotFound ${n}`); e = make(); this.entries.set(n, e); }
    return e;
  }
}
