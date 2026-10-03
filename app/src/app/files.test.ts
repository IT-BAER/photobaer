import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addRecent, kindOf, saveFormat, saveRoute, type Recent } from './files.ts';

// A fake handle: entries with the same path are the same file.
const h = (path: string) => ({ name: path.split('/').at(-1)!, isSameEntry: async (o: { path?: string }) => o.path === path, path }) as unknown as FileSystemFileHandle;
const rec = (path: string, time: number): Recent => ({ name: path.split('/').at(-1)!, kind: kindOf(path), handle: h(path), time });

test('kindOf and saveFormat follow the extension, case-insensitive', () => {
  assert.equal(kindOf('a.psd'), 'psd');
  assert.equal(kindOf('a.png'), 'image');
  assert.equal(kindOf('a.PSB'), 'psd');
  assert.equal(saveFormat('x.PSD'), 'psd');
  assert.equal(saveFormat('x.Exr'), 'exr');
  for (const f of ['psb', 'hdr', 'ico'] as const) assert.equal(saveFormat(`x.${f}`), f);
  assert.equal(saveFormat('x'), null);
  assert.equal(saveFormat('x.png'), null);
});

test('saveRoute writes back only to a cleanly opened .psd outside Edit Contents', () => {
  assert.equal(saveRoute(undefined, false), 'saveAs');
  assert.equal(saveRoute({ kind: 'psd', warned: false }, false), 'write');
  assert.equal(saveRoute({ kind: 'psd', warned: true }, false), 'saveAs');
  assert.equal(saveRoute({ kind: 'image', warned: false }, false), 'saveAs');
  assert.equal(saveRoute({ kind: 'psd', warned: false }, true), 'saveAs');
});

test('addRecent puts the entry first, drops the same file, caps at 10', async () => {
  let list: Recent[] = [];
  for (let i = 0; i < 12; i++) list = await addRecent(list, rec(`/d/f${i}.png`, i));
  assert.equal(list.length, 10);
  assert.deepEqual(list.map(r => r.time), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  list = await addRecent(list, rec('/d/f5.png', 99));
  assert.equal(list.length, 10);
  assert.deepEqual(list.slice(0, 3).map(r => r.time), [99, 11, 10]);
  assert.equal(list.filter(r => r.name === 'f5.png').length, 1);
  list = await addRecent(list, rec('/e/f5.png', 100));
  assert.equal(list.filter(r => r.name === 'f5.png').length, 2, 'same name, other folder is another file');
});

test('addRecent keeps the list when a stored handle cannot compare', async () => {
  const broken = { ...rec('/d/x.png', 1), handle: { name: 'x.png', isSameEntry: async () => { throw new Error('gone'); } } as unknown as FileSystemFileHandle };
  const list = await addRecent([broken], rec('/d/y.png', 2));
  assert.deepEqual(list.map(r => r.name), ['y.png', 'x.png']);
});
