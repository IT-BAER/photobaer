import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Autosave } from './autosave.ts';
import { FakeDir, fs } from './fake-opfs.ts';

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

test('autosave writes a blob exactly once across saves', async () => {
  const root = new FakeDir();
  const s = await open(root);
  s.startDocument();
  const m = (...tiles: number[]) => JSON.stringify({ layers: [{ tiles }], blobs: [9] });
  const calls: number[] = [];
  const data = (id: number) => { calls.push(id); return id === 9 ? new Uint8Array([1, 2, 3]) : new Uint8Array([id]); };
  assert.equal(await s.save('a', m(1), data, () => true), true);
  assert.equal(await s.save('a', m(1, 2), data, () => true), true);
  assert.deepEqual(calls.filter(id => id === 9), [9]);
  const r = await (await open(root)).load();
  assert.deepEqual([...await r!.tile(9)], [1, 2, 3]);
});
