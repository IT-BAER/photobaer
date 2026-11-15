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

test('Find and Replace Text: type layers top first, one step for all layers, auto-named layers follow their text', async () => {
  await fresh(200, 100);
  await call('fontAdd', readFileSync(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)), 'bundled');
  const { newText } = await import('./shell/typesession.ts');
  const opts = { family: 'Noto Sans', style: 'Regular', size: 28, color: [0, 0, 0] as [number, number, number], alignment: 'left' as const, orientation: 'horizontal' as const };
  const t0 = newText(opts, { type: 'point' }, [10, 60]);
  const make = async (s: string) => {
    const { id } = await call<{ id: number }>('typeBegin', { text: t0, above: 0 });
    await call('typeUpdate', { ...t0, text: s, runs: [{ ...t0.runs[0], length: s.length }], paragraphs: [{ ...t0.paragraphs[0], length: s.length }] }, s);
    await call('typeCommit');
    return id;
  };
  const a = await make('cat and cat'), b = await make('dog cat');
  const info = await call('setProps', b, { name: 'Pets' });
  const topFirst = info.layers.filter(n => n.kind === 'text').map(n => n.id).reverse();
  assert.deepEqual(await call('typeTexts'), topFirst.map(id => id === a ? { id, name: 'cat and cat', text: 'cat and cat' } : { id, name: 'Pets', text: 'dog cat' }));
  const d = await call('typeReplace', [{ id: a, ranges: [[0, 3], [8, 11]] }, { id: b, ranges: [[4, 7]] }], 'lion', 'Replace All Text');
  assert.equal(d.undoLabel, 'Replace All Text');
  const layer = (id: number) => d.layers.find(n => n.id === id)!;
  assert.deepEqual([layer(a).name, layer(a).text?.text], ['lion and lion', 'lion and lion']);
  assert.deepEqual([layer(b).name, layer(b).text?.text], ['Pets', 'dog lion'], 'a renamed layer keeps its name');
  await assert.rejects(call('typeReplace', [{ id: a, ranges: [[0, 99]] }], 'x', 'Replace Text'), /inside the text/);
  await assert.rejects(call('typeReplace', [{ id: a, ranges: [[0, 4], [2, 6]] }], 'x', 'Replace Text'), /overlap/);
  const u = await call('undo');
  assert.equal(u.layers.find(n => n.id === a)!.text?.text, 'cat and cat', 'one undo restores every layer');
  assert.equal(u.layers.find(n => n.id === b)!.text?.text, 'dog cat');
});

test('Link Layers: a linked layer moves along; with an unlinked mask targeted only the mask moves', async () => {
  await fresh(32, 16);
  const paint = async (x: number) => {
    const { created } = await call<DocInfo & { created: number }>('addLayer', 0);
    await call('select', { kind: 'rect', x, y: 0, w: 4, h: 4 }, 'new', false, 0, 'Rectangular Marquee');
    await call('fillEx', created, 'pixels', { source: 'solid', rgba: [0, 0, 255, 255], intensity: 1, mode: 'normal', opacity: 1, preserveTransparency: false }, 'Fill');
    await call('selectCommand', 'deselect');
    return created;
  };
  const a = await paint(0), b = await paint(10);
  const linked = await call('setPropsMany', [[a, { link: 1 }], [b, { link: 1 }]], 'Link Layers');
  assert.deepEqual([linked.undoLabel, linked.layers.find(n => n.id === b)?.link], ['Link Layers', 1]);
  const alpha = async (x: number, id: number) => (await call<number[]>('sample', x, 1, 1, id))[3];
  await call('moveLayerBegin', a, false, 'Move');
  await call('moveLayerStep', 3, 0);
  await call('moveLayerCommit');
  assert.deepEqual([await alpha(1, a), await alpha(5, a), await alpha(11, b), await alpha(15, b)], [0, 255, 0, 255], 'both layers moved 3 px');
  await call('addMask', a, true);
  await call('setProps', a, { mask_linked: false });
  await call('moveLayerBegin', a, false, 'Move', true);
  await call('moveLayerStep', 5, 0);
  const d = await call('moveLayerCommit');
  assert.equal(d.undoLabel, 'Move');
  assert.deepEqual([await alpha(5, a), await alpha(15, b)], [255, 255], 'the mask moved alone: no pixels and no linked layer moved');
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
