import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Autosave } from './autosave.ts';

// In-memory stand-in for the OPFS directory API. `hold` parks the next sync-handle open until released.
class FakeFile {
  data = new Uint8Array();
  async getFile() { const d = this.data; return { text: async () => new TextDecoder().decode(d), arrayBuffer: async () => d.slice().buffer }; }
  async createSyncAccessHandle() {
    if (fs.hold) await fs.hold;
    return {
      truncate: () => { this.data = new Uint8Array(); },
      write: (d: Uint8Array) => { this.data = d.slice(); return d.length; },
      flush() {}, close() {},
    };
  }
}
class FakeDir {
  entries = new Map<string, FakeDir | FakeFile>();
  async getDirectoryHandle(n: string, o?: { create?: boolean }) { return this.#get(n, o, () => new FakeDir()) as FakeDir; }
  async getFileHandle(n: string, o?: { create?: boolean }) { return this.#get(n, o, () => new FakeFile()) as FakeFile; }
  async removeEntry(n: string) { if (!this.entries.delete(n)) throw new Error('NotFound'); }
  async *keys() { yield* [...this.entries.keys()]; }
  #get(n: string, o: { create?: boolean } | undefined, make: () => FakeDir | FakeFile) {
    let e = this.entries.get(n);
    if (!e) { if (!o?.create) throw new Error(`NotFound ${n}`); e = make(); this.entries.set(n, e); }
    return e;
  }
}
const fs: { hold: Promise<void> | null } = { hold: null };

const manifest = (...ids: number[]) => JSON.stringify({ layers: [{ tiles: ids }] });
const bytes = (tag: number) => () => new Uint8Array([tag]);
const open = (root: FakeDir) => Autosave.fromRoot(root as unknown as FileSystemDirectoryHandle);
const tick = () => new Promise(r => setTimeout(r, 0));

test('a document replaced during a save does not hide tiles of the next document', async () => {
  const root = new FakeDir();
  const a = await open(root);
  a.startDocument();
  let aliveA = true;
  let release!: () => void;
  fs.hold = new Promise(r => { release = r; });
  const pa = a.save('A', manifest(1, 2), bytes(0xa), () => aliveA);
  await tick();
  a.startDocument();
  aliveA = false;
  fs.hold = null;
  release();
  assert.equal(await pa, false);
  assert.equal(await a.save('B', manifest(1), bytes(0xb), () => true), true);
  const r = await (await open(root)).load();
  assert.ok(r, 'session B must be loadable');
  assert.equal(r.name, 'B');
  assert.deepEqual([...await r.tile(1)], [0xb]);
});

test('falling back to an older session never overwrites it and drops the newer broken one', async () => {
  const root = new FakeDir();
  const s = await open(root);
  s.startDocument();
  await s.save('old', manifest(3), bytes(3), () => true);                    // seq 1 -> session-1.json
  // A newer session (seq 2) whose tile never reached disk.
  const auto = await root.getDirectoryHandle('autosave');
  const s1 = JSON.parse(new TextDecoder().decode((await auto.getFileHandle('session-1.json')).data));
  (await auto.getFileHandle('session-0.json', { create: true })).data = new TextEncoder().encode(JSON.stringify({ ...s1, seq: 2, name: 'broken', manifest: manifest(5) }));
  const t = await open(root);
  const r = await t.load();
  assert.equal(r?.name, 'old');
  assert.equal(auto.entries.has('session-0.json'), false, 'the unusable newer session is removed');
  await t.save('next', manifest(3, 6), bytes(6), () => true);
  const kept = JSON.parse(new TextDecoder().decode((await auto.getFileHandle('session-1.json')).data));
  assert.equal(kept.name, 'old', 'the commit must go to the other slot');
  assert.equal((await (await open(root)).load())?.name, 'next');
});
