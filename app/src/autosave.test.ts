import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Autosave, type DocSave } from './autosave.ts';
import { FakeDir, FakeFile, fs } from './fake-opfs.ts';

const manifest = (...ids: number[]) => JSON.stringify({ layers: [{ tiles: ids }] });
const bytes = (tag: number) => () => new Uint8Array([tag]);
const open = (root: FakeDir) => Autosave.fromRoot(root as unknown as FileSystemDirectoryHandle);
const tick = () => new Promise(r => setTimeout(r, 0));
const doc = (key: string, name: string, m: string, tile: (id: number) => Uint8Array, dirty = false): DocSave => ({ key, name, manifest: m, dirty, tile });
const yes = () => true;
const docDirs = async (root: FakeDir) => [...(await (await root.getDirectoryHandle('autosave')).getDirectoryHandle('docs')).entries.keys()];

test('a document replaced during a save does not hide tiles of the next document', async () => {
  const root = new FakeDir();
  const a = await open(root);
  let aliveA = true;
  let release!: () => void;
  fs.hold = new Promise(r => { release = r; });
  const pa = a.save([doc('ka', 'A', manifest(1, 2), bytes(0xa))], 'ka', () => aliveA);
  await tick();
  aliveA = false;
  fs.hold = null;
  release();
  assert.equal(await pa, false);
  assert.equal(await a.save([doc('kb', 'B', manifest(1), bytes(0xb))], 'kb', yes), true);
  const r = await (await open(root)).load();
  assert.ok(r, 'session B must be loadable');
  assert.deepEqual(r.docs.map(d => d.name), ['B']);
  assert.deepEqual([...await r.docs[0].tile(1)], [0xb]);
});

test('falling back to an older session never overwrites it and drops the newer broken one', async () => {
  const root = new FakeDir();
  const s = await open(root);
  await s.save([doc('k', 'old', manifest(3), bytes(3))], 'k', yes);              // seq 1 -> session-1.json
  // A newer session (seq 2) whose tile never reached disk.
  const auto = await root.getDirectoryHandle('autosave');
  const s1 = JSON.parse(new TextDecoder().decode((await auto.getFileHandle('session-1.json')).data));
  (await auto.getFileHandle('session-0.json', { create: true })).data = new TextEncoder().encode(JSON.stringify({ ...s1, seq: 2, docs: [{ ...s1.docs[0], name: 'broken', manifest: manifest(5) }] }));
  const t = await open(root);
  const r = await t.load();
  assert.deepEqual(r?.docs.map(d => d.name), ['old']);
  assert.equal(auto.entries.has('session-0.json'), false, 'the unusable newer session is removed');
  await t.save([doc('k', 'next', manifest(3, 6), bytes(6))], 'k', yes);
  const kept = JSON.parse(new TextDecoder().decode((await auto.getFileHandle('session-1.json')).data));
  assert.equal(kept.docs[0].name, 'old', 'the commit must go to the other slot');
  assert.deepEqual((await (await open(root)).load())?.docs.map(d => d.name), ['next']);
});

test('autosave writes a blob exactly once across saves', async () => {
  const root = new FakeDir();
  const s = await open(root);
  const m = (...tiles: number[]) => JSON.stringify({ layers: [{ tiles }], blobs: [9] });
  const calls: number[] = [];
  const data = (id: number) => { calls.push(id); return id === 9 ? new Uint8Array([1, 2, 3]) : new Uint8Array([id]); };
  assert.equal(await s.save([doc('k', 'a', m(1), data)], 'k', yes), true);
  assert.equal(await s.save([doc('k', 'a', m(1, 2), data)], 'k', yes), true);
  assert.deepEqual(calls.filter(id => id === 9), [9]);
  const r = await (await open(root)).load();
  assert.deepEqual([...await r!.docs[0].tile(9)], [1, 2, 3]);
});

test('every open document is saved and restored in tab order with the active key, names, content and dirty flags', async () => {
  const root = new FakeDir();
  const s = await open(root);
  await s.save([doc('ka', 'A', manifest(1, 2), id => new Uint8Array([0xa0 + id]), true), doc('kb', 'B', manifest(1), bytes(0xb))], 'kb', yes);
  const r = await (await open(root)).load();
  assert.ok(r);
  assert.equal(r.active, 'kb');
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.docs.map(d => [d.key, d.name, d.dirty]), [['ka', 'A', true], ['kb', 'B', false]]);
  assert.deepEqual([...await r.docs[0].tile(2)], [0xa2]);
  assert.deepEqual([...await r.docs[1].tile(1)], [0xb]);
});

test('only changed documents write tiles; a new active key alone writes none', async () => {
  const root = new FakeDir();
  const s = await open(root);
  const calls: string[] = [];
  const tile = (k: string) => (id: number) => { calls.push(`${k}${id}`); return new Uint8Array([id]); };
  await s.save([doc('ka', 'A', manifest(1), tile('a')), doc('kb', 'B', manifest(1), tile('b'))], 'kb', yes);
  assert.deepEqual(calls.splice(0), ['a1', 'b1']);
  await s.save([doc('ka', 'A', manifest(1), tile('a')), doc('kb', 'B', manifest(1), tile('b'))], 'ka', yes);
  assert.deepEqual(calls.splice(0), [], 'switching writes no tiles');
  await s.save([doc('ka', 'A', manifest(1, 2), tile('a')), doc('kb', 'B', manifest(1), tile('b'))], 'ka', yes);
  assert.deepEqual(calls.splice(0), ['a2'], 'an edit writes only its own new tiles');
  // The same holds for a fresh instance after restore.
  const t = await open(root);
  await t.load();
  await t.save([doc('ka', 'A', manifest(1, 2), tile('a')), doc('kb', 'B', manifest(1, 3), tile('b'))], 'kb', yes);
  assert.deepEqual(calls.splice(0), ['b3']);
});

test('a closed document keeps its folder until a session without it is committed', async () => {
  const root = new FakeDir();
  const s = await open(root);
  await s.save([doc('ka', 'A', manifest(1), bytes(1)), doc('kb', 'B', manifest(1), bytes(2))], 'ka', yes);
  let commit = false;
  assert.equal(await s.save([doc('ka', 'A', manifest(1), bytes(1))], 'ka', () => commit), false);
  assert.deepEqual((await docDirs(root)).sort(), ['ka', 'kb'], 'no commit, no delete');
  assert.deepEqual((await (await open(root)).load())?.docs.map(d => d.key), ['ka', 'kb']);
  commit = true;
  assert.equal(await s.save([doc('ka', 'A', manifest(1), bytes(1))], 'ka', yes), true);
  assert.deepEqual(await docDirs(root), ['ka']);
  assert.deepEqual((await (await open(root)).load())?.docs.map(d => d.key), ['ka']);
});

test('an old single-document session restores as one clean tab', async () => {
  const root = new FakeDir();
  const auto = await root.getDirectoryHandle('autosave', { create: true });
  const dir = await (await auto.getDirectoryHandle('docs', { create: true })).getDirectoryHandle('old-key', { create: true });
  (await dir.getFileHandle('4', { create: true })).data = new Uint8Array([4]);
  (await auto.getFileHandle('session-1.json', { create: true })).data = new TextEncoder().encode(JSON.stringify({ seq: 7, key: 'old-key', name: 'Legacy', manifest: manifest(4) }));
  const s = await open(root);
  const r = await s.load();
  assert.ok(r);
  assert.equal(r.active, 'old-key');
  assert.deepEqual(r.docs.map(d => [d.key, d.name, d.dirty]), [['old-key', 'Legacy', false]]);
  assert.deepEqual([...await r.docs[0].tile(4)], [4]);
  const calls: number[] = [];
  await s.save([doc('old-key', 'Legacy', manifest(4), id => { calls.push(id); return new Uint8Array([id]); })], 'old-key', yes);
  assert.deepEqual(calls, [], 'restored tiles are not rewritten');
  const next = JSON.parse(new TextDecoder().decode((auto.entries.get('session-0.json') as FakeFile).data));
  assert.equal(next.seq, 8);
});

test('a document with missing tiles is skipped and the others restore', async () => {
  const root = new FakeDir();
  const s = await open(root);
  await s.save([doc('ka', 'A', manifest(1), bytes(1)), doc('kb', 'B', manifest(1, 2), bytes(2)), doc('kc', 'C', manifest(1), bytes(3))], 'kb', yes);
  const docs = await (await root.getDirectoryHandle('autosave')).getDirectoryHandle('docs');
  await (await docs.getDirectoryHandle('kb')).removeEntry('2');
  const r = await (await open(root)).load();
  assert.ok(r);
  assert.deepEqual(r.docs.map(d => d.name), ['A', 'C']);
  assert.deepEqual(r.skipped, ['B']);
  assert.deepEqual([...await r.docs[1].tile(1)], [3]);
});

test('documents that did not restore stay listed and keep their folders across later saves', async () => {
  const root = new FakeDir();
  const s = await open(root);
  await s.save([doc('ka', 'A', manifest(1), bytes(1)), doc('kb', 'B', manifest(1, 2), bytes(2)), doc('kc', 'C', manifest(1), bytes(3), true)], 'ka', yes);
  const docs = await (await root.getDirectoryHandle('autosave')).getDirectoryHandle('docs');
  await (await docs.getDirectoryHandle('kb')).removeEntry('2');
  const t = await open(root);
  const r = await t.load();
  assert.deepEqual(r?.docs.map(d => d.key), ['ka', 'kc']);
  // C loads from disk but the engine rejects it (or runs out of memory).
  t.keep(r!.docs[1]);
  assert.deepEqual(t.lost, ['B', 'C']);
  const calls: number[] = [];
  const tile = (id: number) => { calls.push(id); return new Uint8Array([id]); };
  assert.equal(await t.save([doc('ka', 'A', manifest(1, 4), tile)], 'ka', yes), true);
  assert.equal(await t.save([doc('ka', 'A', manifest(1, 5), tile)], 'ka', yes), true);
  assert.deepEqual(calls, [4, 5], 'kept documents write no tiles');
  assert.deepEqual((await docDirs(root)).sort(), ['ka', 'kb', 'kc']);
  assert.deepEqual([...(docs.entries.get('kc') as FakeDir).entries.keys()], ['1'], 'kept documents are not garbage collected');
  const again = await (await open(root)).load();
  assert.deepEqual(again?.docs.map(d => [d.key, d.dirty]), [['ka', false], ['kc', true]]);
  assert.deepEqual(again?.skipped, ['B']);
  // Closing the last tab clears the open documents but keeps the ones that did not restore.
  await t.clear();
  assert.deepEqual(t.lost, ['B', 'C']);
  assert.deepEqual((await docDirs(root)).sort(), ['kb', 'kc']);
  const last = await (await open(root)).load();
  assert.deepEqual(last?.docs.map(d => d.key), ['kc']);
  assert.deepEqual(last?.skipped, ['B']);
});
