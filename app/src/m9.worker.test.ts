// Worker tests for the M9 commands (Image > Duplicate, Trap, layer colors and links).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync } from './engine-pkg/photobaer_engine.js';
import { FakeDir } from './fake-opfs.ts';
import type { DocInfo } from './worker/types.ts';

// Runs the real worker module in Node: WASM loaded up front, worker globals and OPFS faked.
initSync({ module: readFileSync(new URL('./engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });
const root = new FakeDir();
Object.defineProperty(navigator, 'storage', { value: { getDirectory: async () => root } });
Object.defineProperty(navigator, 'locks', { value: { request: (_n: string, _o: unknown, cb: (l: object) => unknown) => cb({}) } });
const replies = new Map<number, (m: { result?: unknown; error?: string }) => void>();
const g = globalThis as unknown as { postMessage(m: { id?: number; result?: unknown; error?: string }): void; onmessage: ((e: { data: unknown }) => void) | null };
g.onmessage = null;
g.postMessage = m => { if (m.id !== undefined) replies.get(m.id)?.(m); };
await import('./engine.worker.ts');

let nextId = 0;
async function call<T = DocInfo>(op: string, ...args: unknown[]): Promise<T> {
  const id = ++nextId;
  const p = new Promise<{ result?: unknown; error?: string }>(r => replies.set(id, r));
  g.onmessage!({ data: { id, op, args } });
  const r = await p;
  if (r.error) throw new Error(r.error);
  return r.result as T;
}
const fresh = async (w = 32, h = 32) => {
  await call('init');
  for (let i = 0; i < 100 && await call<DocInfo | null>('closeDoc'); i++);
  return call('newDoc', w, h, 8, [255, 0, 0, 255]);
};

test('Image > Duplicate opens a copy with every layer as a new tab; the original stays', async () => {
  const d0 = await fresh();
  await call('addLayer', 0);
  const d = await call('duplicateDoc', 'Copy A', false);
  assert.equal(d.docs.length, 2);
  assert.equal(d.name, 'Copy A');
  assert.deepEqual(d.layers.map(n => n.name), d0.layers.map(n => n.name).concat('Layer 1'));
  assert.equal(d.undoLabel, null, 'a duplicate starts without history');
  const back = await call('switchDoc', d.docs[0].key);
  assert.equal(back.layers.length, 2);
});

test('Duplicate Merged Layers Only keeps one Background layer of the drawn layers', async () => {
  await fresh();
  const added = await call<DocInfo & { created: number }>('addLayer', 0);
  await call('setProps', added.created, { visible: false });
  await call('addLayer', 0);
  const d = await call('duplicateDoc', '', true);
  assert.deepEqual(d.layers.map(n => [n.name, n.kind, n.visible]), [['Background', 'pixel', true]]);
  assert.match(d.name, /copy$/);
  const px = await call<number[]>('sample', 5, 5, 1, null);
  assert.deepEqual(px, [255, 0, 0, 255]);
});

test('layerBoxes lists the content bounds of layers with pixels only (status bar Document Sizes)', async () => {
  await fresh(32, 16);
  await call('addLayer', 0);
  assert.deepEqual(await call('layerBoxes'), [[0, 0, 32, 16]], 'the empty new layer has no box');
});

test('New Document options: name, resolution and color mode without history steps', async () => {
  await fresh();
  const d = await call('newDoc', 40, 30, 16, [255, 255, 255, 255], { name: 'Poster', resolution: 300, mode: 'cmyk' });
  assert.deepEqual([d.name, d.resolution, d.mode?.kind, d.depth, d.undoLabel], ['Poster', 300, 'cmyk', 16, null]);
  const b = await call('newDoc', 16, 8, 8, [255, 255, 255, 255], { mode: 'bitmap' });
  assert.deepEqual([b.mode?.kind, b.undoLabel, b.history.labels.length], ['bitmap', null, 0]);
  const g = await call('newDoc', 16, 8, 8, null, { mode: 'gray' });
  assert.deepEqual([g.gray, g.mode, g.name], [true, null, 'Untitled']);
});

test('clipboardSize reports the internal copy buffer for the Clipboard preset', async () => {
  await fresh(32, 32);
  await call('purge', 'clipboard');
  assert.equal(await call('clipboardSize'), null);
  await call('select', { kind: 'rect', x: 2, y: 3, w: 10, h: 7 }, 'new', false, 0, 'Rectangular Marquee');
  await call('copy', 1, false);
  assert.deepEqual(await call('clipboardSize'), [10, 7]);
});

test('Image > Trap is one undo step in a CMYK document and refuses RGB', async () => {
  await fresh(16, 4);
  await assert.rejects(call('trap', 1, 1), /CMYK/);
  await call('setColorMode', { mode: 'cmyk' });
  await call('select', { kind: 'rect', x: 0, y: 0, w: 8, h: 4 }, 'new', false, 0, 'Rectangular Marquee');
  await call('fillEx', 1, 'pixels', { source: 'solid', rgba: [0, 174, 239, 255], intensity: 1, mode: 'normal', opacity: 1, preserveTransparency: false }, 'Fill');
  await call('selectCommand', 'deselect');
  const before = await call<number[]>('sample', 8, 1, 1, null);
  const d = await call('trap', 1, 1);
  assert.equal(d.undoLabel, 'Trap');
  assert.notDeepEqual(await call<number[]>('sample', 8, 1, 1, null), before, 'the edge pixel takes the neighbouring ink');
  await call('undo');
  assert.deepEqual(await call<number[]>('sample', 8, 1, 1, null), before, 'undo restores the edge');
});
