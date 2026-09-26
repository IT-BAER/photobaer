import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync } from './engine-pkg/photobaer_engine.js';
import { Autosave } from './autosave.ts';
import { FakeDir, fs } from './fake-opfs.ts';

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
function call(op: string, ...args: unknown[]) {
  const id = ++nextId;
  const p = new Promise<{ result?: unknown; error?: string }>(r => replies.set(id, r));
  g.onmessage!({ data: { id, op, args } });
  return p;
}
const settle = () => new Promise(r => setTimeout(r, 200));

test('a new document has one Background pixel layer', async () => {
  await call('init');
  const r = await call('newDoc', 64, 64, 8, null);
  const doc = r.result as { layers: { id: number; name: string; kind: string }[] };
  assert.deepEqual(doc.layers, [{ id: 1, name: 'Background', kind: 'pixel', visible: true, opacity: 1, fill: 1, blend: 'normal', clipping: false, locks: { transparency: false, pixels: false, position: false }, mask: null }]);
});

test('addLayer picks the next free default name and reports the created id', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  const a = await call('addLayer', 0);
  assert.equal((a.result as { created: number }).created, 2);
  assert.equal((a.result as { layers: { name: string }[] }).layers.at(-1)!.name, 'Layer 1');
  const b = await call('addLayer', 0);
  assert.equal((b.result as { layers: { name: string }[] }).layers.at(-1)!.name, 'Layer 2');
});

test('undo removes the new layer and updates labels', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  const a = await call('addLayer', 0);
  assert.equal((a.result as { undoLabel: string }).undoLabel, 'New Layer');
  const u = await call('undo');
  assert.equal((u.result as { layers: unknown[] }).layers.length, 1);
  assert.equal((u.result as { undoLabel: string | null; redoLabel: string | null }).undoLabel, null);
  assert.equal((u.result as { redoLabel: string | null }).redoLabel, 'New Layer');
});

test('setProps single-key labels and updates the tree', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  const blended = await call('setProps', 1, { blend: 'multiply' });
  assert.equal((blended.result as { undoLabel: string }).undoLabel, 'Blend Mode');
  assert.equal((blended.result as { layers: { blend: string }[] }).layers[0].blend, 'multiply');
  const hidden = await call('setProps', 1, { visible: false });
  assert.equal((hidden.result as { undoLabel: string }).undoLabel, 'Hide Layer');
  assert.equal((hidden.result as { layers: { visible: boolean }[] }).layers[0].visible, false);
  const shown = await call('setProps', 1, { visible: true });
  assert.equal((shown.result as { undoLabel: string }).undoLabel, 'Show Layer');
});

test('groupNodes and ungroup round trip keeps order', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  const l = await call('addLayer', 0);
  const id = (l.result as { created: number }).created;
  const g = await call('groupNodes', [1, id]);
  const gr = g.result as { created: number; layers: { id: number; kind: string; children: { id: number }[] }[] };
  assert.equal(gr.layers.length, 1);
  assert.equal(gr.layers[0].kind, 'group');
  assert.deepEqual(gr.layers[0].children.map(c => c.id), [1, id]);
  const u = await call('ungroup', gr.created);
  const ur = u.result as { layers: { id: number }[] };
  assert.deepEqual(ur.layers.map(n => n.id), [1, id]);
});

test('deleteNode on the only root node errors without a history step', async () => {
  await call('init');
  const n = await call('newDoc', 64, 64, 8, null);
  const before = n.result as { version: number; undoLabel: string | null };
  const r = await call('deleteNode', 1);
  assert.ok(r.error);
  const after = await call('undo');
  assert.equal((after.result as { undoLabel: string | null }).undoLabel, before.undoLabel);
  const info = (await call('addLayer', 0)).result as { version: number; undoLabel: string };
  assert.equal(info.version, before.version + 1);
  assert.equal(info.undoLabel, 'New Layer');
});

test('command fill on a group errors with no history step', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  const g = await call('addGroup', 0);
  const id = (g.result as { created: number }).created;
  const before = g.result as { version: number };
  const r = await call('command', 'fill', id, 'pixels', [255, 0, 0, 255]);
  assert.ok(r.error);
  const after = await call('setProps', id, { name: 'x' });
  assert.equal((after.result as { version: number }).version, before.version + 1);
});

test('addMask then invert with target mask flips default', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  await call('addMask', 1, true);
  const before = (await call('setProps', 1, { name: 'Background' })).result as { layers: { mask: { default: number } }[] };
  const inverted = await call('command', 'invert', 1, 'mask');
  const after = (inverted.result as { layers: { mask: { default: number } }[] });
  assert.notEqual(after.layers[0].mask.default, before.layers[0].mask.default);
});

test('moveNode moves a layer into a group', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  const l = await call('addLayer', 0);
  const id = (l.result as { created: number }).created;
  const g = await call('addGroup', 0);
  const gid = (g.result as { created: number }).created;
  const m = await call('moveNode', id, gid, 0);
  const r = m.result as { layers: { id: number; children?: { id: number }[] }[] };
  const group = r.layers.find(n => n.id === gid)!;
  assert.deepEqual(group.children!.map(c => c.id), [id]);
});

test('closing a document and creating the next one right away keeps the new autosave', async () => {
  await call('init');
  await call('newDoc', 256, 256, 8, null);
  await settle();
  fs.slow = true;
  const closed = call('closeDoc');
  const created = call('newDoc', 512, 256, 8, null);
  await Promise.all([closed, created]);
  await settle();
  fs.slow = false;
  const r = await (await Autosave.fromRoot(root as unknown as FileSystemDirectoryHandle)).load();
  assert.ok(r, 'the new document must be restorable');
  assert.equal(JSON.parse(r.manifest).width, 512);
});

test('select with feather is one history step, and undo clears the selection', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  const r = await call('select', { kind: 'rect', x: 10, y: 10, w: 20, h: 20 }, 'new', false, 5, 'Rectangular Marquee');
  const sel = r.result as { undoLabel: string; history: { labels: string[] }; selection: { bounds: number[] } | null };
  assert.equal(sel.undoLabel, 'Rectangular Marquee');
  assert.equal(sel.history.labels.length, 1);
  assert.ok(sel.selection);
  const u = await call('undo');
  assert.equal((u.result as { selection: unknown }).selection, null);
});

test('a zero-size marquee in add mode is a no-op with no history step', async () => {
  await call('init');
  const before = (await call('newDoc', 64, 64, 8, null)).result as { version: number };
  const r = await call('select', { kind: 'rect', x: 10, y: 10, w: 0, h: 0 }, 'add', false, 0, 'Rectangular Marquee');
  assert.equal((r.result as { version: number }).version, before.version);
});

test('selectionMask assembles tiles at a level, filling missing tiles with the default', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  await call('select', { kind: 'rect', x: 0, y: 0, w: 64, h: 64 }, 'new', false, 0, 'Rectangular Marquee');
  const m = await call('selectionMask', 0);
  const r = m.result as { w: number; h: number; data: ArrayBuffer | null };
  assert.equal(r.w, 64);
  assert.equal(r.h, 64);
  assert.ok(r.data);
  assert.equal(new Uint8Array(r.data!)[0], 255);
  await call('selectCommand', 'deselect');
  const empty = (await call('selectionMask', 0)).result as { data: ArrayBuffer | null };
  assert.equal(empty.data, null);
});

test('clearSelected only clears with a selection and labels the step', async () => {
  await call('init');
  const before = (await call('newDoc', 64, 64, 8, null)).result as { version: number };
  const noop = await call('clearSelected', 1, 'pixels');
  assert.equal((noop.result as { version: number }).version, before.version);
  await call('selectCommand', 'all');
  const cleared = await call('clearSelected', 1, 'pixels');
  assert.equal((cleared.result as { undoLabel: string }).undoLabel, 'Clear');
});

test('history lists every step and historyGoto jumps back and forward', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  await call('addLayer', 0);
  await call('setProps', 1, { blend: 'multiply' });
  const back = (await call('historyGoto', 0)).result as { layers: unknown[]; history: { labels: string[]; current: number } };
  assert.deepEqual(back.history, { labels: ['New Layer', 'Blend Mode'], current: 0 });
  assert.equal(back.layers.length, 1);
  const fwd = (await call('historyGoto', 2)).result as { layers: { blend: string }[]; history: { current: number } };
  assert.equal(fwd.history.current, 2);
  assert.equal(fwd.layers[0].blend, 'multiply');
});

const tipParams = (tipId: number) => ({ rgba: [0, 0, 0, 255], mode: 'normal', size: 12, tip: 'sampled', tipId });
const alphaOf = (r: { result?: unknown }) => {
  const d = new Uint8Array((r.result as { data: ArrayBuffer }).data);
  let sum = 0;
  for (let i = 3; i < d.length; i += 4) sum += d[i];
  return { length: d.length, sum };
};

test('brushPreview renders RGBA8 of the requested size, also with no document open', async () => {
  await call('init');
  await call('closeDoc');
  const r = await call('brushPreview', { rgba: [0, 0, 0, 255], mode: 'normal', size: 10 }, 64, 32);
  assert.equal(r.error, undefined);
  const a = alphaOf(r);
  assert.equal(a.length, 64 * 32 * 4);
  assert.ok(a.sum > 0);
});

test('a registered tip paints in previews and strokes across documents until removed', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  const t = await call('tipAdd', 3, 3, new Uint8Array(9).fill(255));
  const id = t.result as number;
  assert.equal(typeof id, 'number');
  assert.ok(alphaOf(await call('brushPreview', tipParams(id), 64, 32)).sum > 0);
  await call('newDoc', 64, 64, 8, null);
  const b = await call('strokeBegin', 1, 'pixels', tipParams(id), 'Brush');
  assert.equal(b.error, undefined);
  await call('strokeTo', Float64Array.from([10, 10, 1, 30, 30, 1]));
  await call('strokeEnd');
  await call('tipRemove', id);
  assert.ok((await call('brushPreview', tipParams(id), 64, 32)).error);
  assert.ok((await call('tipAdd', 0, 3, new Uint8Array(0))).error);
});

test('a registered pattern textures previews until removed', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  const p = await call('patternAdd', 2, 2, Uint8Array.from([0, 255, 255, 0]), 1);
  const id = p.result as number;
  const tex = (patternId: number) => ({ rgba: [0, 0, 0, 255], mode: 'normal', size: 10, texture: { enabled: true, patternId, mode: 'multiply', depth: 1 } });
  const plain = alphaOf(await call('brushPreview', { rgba: [0, 0, 0, 255], mode: 'normal', size: 10 }, 64, 32)).sum;
  assert.ok(alphaOf(await call('brushPreview', tex(id), 64, 32)).sum < plain);
  await call('patternRemove', id);
  assert.ok((await call('brushPreview', tex(id), 64, 32)).error);
  assert.ok((await call('patternAdd', 2, 2, new Uint8Array(3), 1)).error);
});

const px = async (x: number, y: number) => (await call('sample', x, y, 1, 1)).result as number[];
const solid = (rgba: number[]) => ({ source: 'solid', rgba, mode: 'normal', opacity: 1, preserveTransparency: false });

test('fillEx paints a solid source under its own undo label', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, [255, 255, 255, 255]);
  const r = await call('fillEx', 1, 'pixels', solid([255, 0, 0, 255]), 'Fill with Foreground Color');
  assert.equal((r.result as { undoLabel: string }).undoLabel, 'Fill with Foreground Color');
  assert.deepEqual(await px(3, 3), [255, 0, 0, 255]);
});

test('fillEx pattern uses the worker pattern id and history needs a snapshot', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, [255, 255, 255, 255]);
  const none = await call('fillEx', 1, 'pixels', { source: 'history', mode: 'normal', opacity: 1, preserveTransparency: false }, 'Fill');
  assert.equal(none.error, 'Fill needs a pixel layer.');
  const id = (await call('patternAdd', 2, 2, Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]), 4)).result as number;
  await call('fillEx', 1, 'pixels', { source: 'pattern', patternId: id, mode: 'normal', opacity: 1, preserveTransparency: false }, 'Fill');
  assert.deepEqual([await px(0, 0), await px(1, 0)], [[0, 0, 0, 255], [255, 255, 255, 255]]);
  const h = await call('fillEx', 1, 'pixels', { source: 'history', mode: 'normal', opacity: 1, preserveTransparency: false }, 'Fill');
  assert.equal(h.error, undefined);
  assert.deepEqual(await px(0, 0), [255, 255, 255, 255]);
});

test('a preview session reruns from the same base, cancels without a step and commits as one', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, [255, 255, 255, 255]);
  await call('fillEx', 1, 'pixels', solid([255, 0, 0, 255]), 'Fill', true);
  await call('fillEx', 1, 'pixels', { ...solid([0, 0, 255, 255]), opacity: 0.5 }, 'Fill', true);
  assert.deepEqual(await px(1, 1), [128, 128, 255, 255]);
  const c = await call('previewEnd', false);
  assert.equal((c.result as { undoLabel: string | null }).undoLabel, null);
  assert.deepEqual(await px(1, 1), [255, 255, 255, 255]);
  await call('fillEx', 1, 'pixels', solid([0, 255, 0, 255]), 'Fill', true);
  const ok = await call('previewEnd', true);
  assert.deepEqual((ok.result as { history: { labels: string[] } }).history.labels, ['Fill']);
  assert.deepEqual(await px(1, 1), [0, 255, 0, 255]);
});

test('strokeSelection needs a selection and lands as Stroke', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, [255, 255, 255, 255]);
  const p = { width: 2, rgba: [0, 0, 0, 255], location: 'inside', mode: 'normal', opacity: 1, preserveTransparency: false };
  assert.equal((await call('strokeSelection', 1, p)).error, 'Make a selection to stroke.');
  await call('select', { kind: 'rect', x: 4, y: 4, w: 8, h: 8 }, 'new', false, 0, 'Rectangular Marquee');
  const r = await call('strokeSelection', 1, p);
  assert.equal((r.result as { undoLabel: string }).undoLabel, 'Stroke');
  assert.deepEqual([await px(4, 4), await px(7, 7)], [[0, 0, 0, 255], [255, 255, 255, 255]]);
});

test('gradient renders a black to white row as one Gradient step', async () => {
  await call('init');
  await call('newDoc', 16, 4, 8, [255, 0, 0, 255]);
  const r = await call('gradient', 1, 'pixels', {
    stops: [{ position: 0, rgb: [0, 0, 0], midpoint: 0.5 }, { position: 1, rgb: [255, 255, 255], midpoint: 0.5 }],
    opacityStops: [], method: 'classic', style: 'linear', start: { x: 0, y: 2 }, end: { x: 16, y: 2 },
    reverse: false, dither: false, transparency: true, opacity: 1,
  });
  assert.equal((r.result as { undoLabel: string }).undoLabel, 'Gradient');
  const row = await Promise.all(Array.from({ length: 16 }, (_, x) => px(x, 1)));
  assert.ok(row.every((p, i) => i === 0 || p[0] >= row[i - 1][0]));
  assert.ok(row[0][0] < 16 && row[15][0] > 239);
});

test('moveLayerBegin/Step/Commit previews from the same base and lands as one Move step', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, [255, 0, 0, 255]);
  await call('moveLayerBegin', 1, false, 'Move');
  await call('moveLayerStep', 3, 0);
  assert.deepEqual(await px(1, 5), [0, 0, 0, 0], 'the edge revealed by the shift is transparent');
  await call('moveLayerStep', 5, 5);
  assert.deepEqual(await px(7, 5), [255, 0, 0, 255], 'each step previews (5,5) from the pre-drag base, not (3,0)+(5,5)');
  const c = await call('moveLayerCommit');
  assert.equal((c.result as { undoLabel: string }).undoLabel, 'Move');
  assert.deepEqual(await px(5, 6), [255, 0, 0, 255]);
});

test('moveLayerCommit with a zero net offset makes no history step', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, null);
  await call('moveLayerBegin', 1, false, 'Move');
  await call('moveLayerStep', 4, 4);
  await call('moveLayerStep', 0, 0);
  const c = await call('moveLayerCommit');
  assert.equal((c.result as { undoLabel: string | null }).undoLabel, null);
});

test('moveLayerBegin duplicate=true adds a layer and commits as Move Copy even with no drag', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, [0, 255, 0, 255]);
  const b = await call('moveLayerBegin', 1, true, 'Move Copy');
  const dupId = (b.result as { activeId: number }).activeId;
  assert.notEqual(dupId, 1);
  const c = await call('moveLayerCommit');
  const doc = c.result as { undoLabel: string; layers: unknown[] };
  assert.equal(doc.undoLabel, 'Move Copy');
  assert.equal(doc.layers.length, 2);
});

test('moveLayerCancel restores the pre-drag document with no history step', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, [255, 0, 0, 255]);
  await call('moveLayerBegin', 1, false, 'Move');
  await call('moveLayerStep', 8, 0);
  const c = await call('moveLayerCancel');
  assert.equal((c.result as { undoLabel: string | null }).undoLabel, null);
  assert.deepEqual(await px(1, 1), [255, 0, 0, 255]);
});

test('movePixels moves the selected pixels, leaves a hole and lands as one Move Selection step', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, [255, 0, 0, 255]);
  await call('select', { kind: 'rect', x: 0, y: 0, w: 4, h: 4 }, 'new', false, 0, 'Rectangular Marquee');
  await call('movePixelsBegin', 1, 'Move Selection');
  await call('movePixelsStep', 8, 8);
  assert.deepEqual(await px(9, 9), [255, 0, 0, 255], 'the moved pixels landed at the offset');
  assert.deepEqual(await px(1, 1), [0, 0, 0, 0], 'the source area is a hole');
  const c = await call('movePixelsCommit');
  assert.equal((c.result as { undoLabel: string }).undoLabel, 'Move Selection');
});

test('movePixels with copy keeps the source pixels and lands as one Move Selection Copy step', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, [255, 0, 0, 255]);
  await call('select', { kind: 'rect', x: 0, y: 0, w: 4, h: 4 }, 'new', false, 0, 'Rectangular Marquee');
  await call('movePixelsBegin', 1, 'Move Selection Copy', true);
  await call('movePixelsStep', 8, 8);
  assert.deepEqual(await px(9, 9), [255, 0, 0, 255], 'the copy landed at the offset');
  assert.deepEqual(await px(1, 1), [255, 0, 0, 255], 'the source area is untouched');
  const c = await call('movePixelsCommit');
  assert.equal((c.result as { undoLabel: string }).undoLabel, 'Move Selection Copy');
});

test('hitTestLayer picks the topmost visible layer with a pixel under the point, or its top-level group', async () => {
  await call('init');
  await call('newDoc', 8, 8, 8, null);
  await call('select', { kind: 'rect', x: 0, y: 0, w: 4, h: 4 }, 'new', false, 0, 'Rectangular Marquee');
  await call('fillEx', 1, 'pixels', solid([255, 0, 0, 255]), 'Fill');
  const { created: groupId } = (await call('addGroup', 0)).result as { created: number };
  await call('moveNode', 1, 0, 0);
  await call('addLayer', 0);
  assert.equal(await (await call('hitTestLayer', 2, 2, false)).result, 1);
  assert.equal(await (await call('hitTestLayer', 6, 6, false)).result, null);
  await call('moveNode', 1, groupId, 0);
  assert.equal((await call('hitTestLayer', 2, 2, false)).result, 1);
  assert.equal((await call('hitTestLayer', 2, 2, true)).result, groupId);
});

test('snapTargets gives document bounds plus every other visible layer, excluding the moving one', async () => {
  await call('init');
  await call('newDoc', 100, 50, 8, null);
  await call('select', { kind: 'rect', x: 10, y: 10, w: 20, h: 20 }, 'new', false, 0, 'Rectangular Marquee');
  await call('fillEx', 1, 'pixels', solid([255, 0, 0, 255]), 'Fill');
  const r = (await call('snapTargets', 1)).result as { x: number[]; y: number[] };
  assert.deepEqual(r.x, [0, 50, 100]);
  assert.deepEqual(r.y, [0, 25, 50]);
  const r2 = (await call('snapTargets', 0)).result as { x: number[]; y: number[] };
  assert.deepEqual(r2.x, [0, 50, 100, 10, 20, 30]);
  assert.deepEqual(r2.y, [0, 25, 50, 10, 20, 30]);
});

test('a locked-position layer fails moveLayerStep and the step is not left open', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, null);
  await call('setProps', 1, { locks: { position: true } });
  await call('moveLayerBegin', 1, false, 'Move');
  const s = await call('moveLayerStep', 3, 0);
  assert.equal(s.error, 'layer position is locked');
});

test('selectionAt reads the selection coverage at a point, 255 with no selection', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, null);
  assert.equal((await call('selectionAt', 3, 3)).result, 255);
  await call('select', { kind: 'rect', x: 0, y: 0, w: 4, h: 4 }, 'new', false, 0, 'Rectangular Marquee');
  assert.equal((await call('selectionAt', 3, 3)).result, 255);
  assert.equal((await call('selectionAt', 8, 8)).result, 0);
  assert.equal((await call('selectionAt', -1, 3)).result, 0);
});

test('another op while a move is open commits the move first', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, [255, 0, 0, 255]);
  await call('moveLayerBegin', 1, false, 'Move');
  await call('moveLayerStep', 3, 0);
  const u = await call('undo');
  assert.equal((u.result as { redoLabel: string }).redoLabel, 'Move');
  assert.deepEqual(await px(1, 5), [255, 0, 0, 255]);
});

test('a Move Copy duplicate gets a name no other layer has', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, null);
  await call('moveLayerBegin', 1, true, 'Move Copy');
  await call('moveLayerCommit');
  await call('moveLayerBegin', 1, true, 'Move Copy');
  const c = await call('moveLayerCommit');
  const names = (c.result as { layers: { name: string }[] }).layers.map(l => l.name);
  assert.equal(new Set(names).size, 3);
});
