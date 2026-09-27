import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync } from './engine-pkg/photobaer_engine.js';
import { Autosave } from './autosave.ts';
import { FakeDir, fs } from './fake-opfs.ts';
import { engineMesh, identityMesh } from './transform/warp.ts';
import { croppedSize } from './crop/geometry.ts';

// Runs the real worker module in Node: WASM loaded up front, worker globals and OPFS faked.
initSync({ module: readFileSync(new URL('./engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });
const root = new FakeDir();
Object.defineProperty(navigator, 'storage', { value: { getDirectory: async () => root } });
Object.defineProperty(navigator, 'locks', { value: { request: (_n: string, _o: unknown, cb: (l: object) => unknown) => cb({}) } });
const replies = new Map<number, (m: { result?: unknown; error?: string }) => void>();
const events: unknown[] = [];
const g = globalThis as unknown as { postMessage(m: { id?: number; result?: unknown; error?: string }): void; onmessage: ((e: { data: unknown }) => void) | null };
g.onmessage = null;
g.postMessage = m => { if (m.id !== undefined) replies.get(m.id)?.(m); else events.push(m); };
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
  const range = { source: [0, 0, 255, 255], destination: [0, 0, 255, 255] };
  const blending = {
    blend_if: { gray: range, red: range, green: range, blue: range }, channels: [true, true, true], knockout: 'none',
    blend_interior: false, blend_clipped: true, transparency_shapes: true, layer_mask_hides_effects: false, vector_mask_hides_effects: false,
  };
  assert.deepEqual(doc.layers, [{ id: 1, name: 'Background', kind: 'pixel', visible: true, opacity: 1, fill: 1, blend: 'normal', clipping: false, locks: { transparency: false, pixels: false, position: false }, mask: null, style: null, blending }]);
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

test('newFillLayer masks to the selection, drops it, and undoes under the menu label', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  await call('select', { kind: 'rect', x: 2, y: 2, w: 10, h: 10 }, 'new', false, 0, 'Rectangular Marquee');
  const solid = { type: 'solid', color: [10, 20, 30] };
  const r = await call('newFillLayer', 1, solid, 'Color Fill', 'Solid Color');
  const info = r.result as { created: number; undoLabel: string; selection: unknown; layers: { id: number; kind: string; mask: { default: number } | null }[] };
  assert.equal(info.undoLabel, 'Solid Color');
  assert.equal(info.selection, null, 'the selection is dropped');
  const node = info.layers.find(l => l.id === info.created)!;
  assert.equal(node.kind, 'fill');
  assert.ok(node.mask, 'the new fill layer is masked to the selection');
  assert.equal(node.mask!.default, 0, 'outside the selection is not revealed');
});

test('setFillContent edits every selected fill layer as one undo step', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  const original = { type: 'solid', color: [1, 2, 3] };
  const a = await call('newFillLayer', 1, original, 'Color Fill', 'Solid Color');
  const idA = (a.result as { created: number }).created;
  const b = await call('newFillLayer', idA, original, 'Color Fill', 'Solid Color');
  const idB = (b.result as { created: number }).created;
  const edited = await call('setFillContent', [idA, idB], { type: 'solid', color: [9, 8, 7] });
  const info = edited.result as { undoLabel: string; layers: { id: number; content?: { color: number[] } }[] };
  assert.equal(info.undoLabel, 'Layer Content Options');
  assert.deepEqual(info.layers.find(l => l.id === idA)!.content, { type: 'solid', color: [9, 8, 7] });
  assert.deepEqual(info.layers.find(l => l.id === idB)!.content, { type: 'solid', color: [9, 8, 7] });
  const u = await call('undo');
  const afterUndo = u.result as { layers: { id: number; content?: { color: number[] } }[] };
  assert.deepEqual(afterUndo.layers.find(l => l.id === idA)!.content, original, 'one undo step restores both layers');
  assert.deepEqual(afterUndo.layers.find(l => l.id === idB)!.content, original);
});

test('layer comps: new, apply, options and delete are undo steps with their labels', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  const n = await call('captureLayerComp');
  const info = n.result as { created: number; undoLabel: string; layerComps: { id: number; name: string; layerCount: number }[] };
  assert.equal(info.undoLabel, 'New Layer Comp');
  assert.deepEqual(info.layerComps, [{ id: info.created, name: 'Layer Comp 1', layerCount: 1 }]);
  const second = await call('captureLayerComp');
  assert.equal((second.result as { layerComps: { name: string }[] }).layerComps[1].name, 'Layer Comp 2');
  await call('setProps', 1, { visible: false });
  const applied = await call('applyLayerComp', info.created);
  const a = applied.result as { undoLabel: string; layers: { id: number; visible: boolean }[] };
  assert.equal(a.undoLabel, 'Apply Layer Comp');
  assert.equal(a.layers[0].visible, true, 'the comp restores visibility');
  const renamed = await call('updateLayerComp', info.created, { name: 'Hero' });
  assert.equal((renamed.result as { undoLabel: string }).undoLabel, 'Layer Comp Options');
  const deleted = await call('deleteLayerComp', info.created);
  const d = deleted.result as { undoLabel: string; layerComps: { name: string }[] };
  assert.equal(d.undoLabel, 'Delete Layer Comp');
  assert.deepEqual(d.layerComps.map(c => c.name), ['Layer Comp 2']);
  assert.ok((await call('applyLayerComp', info.created)).error, 'a deleted comp refuses');
  const u = await call('undo');
  assert.deepEqual((u.result as { layerComps: { name: string }[] }).layerComps.map(c => c.name), ['Hero', 'Layer Comp 2']);
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

test('an autosave never stores the hidden source of an open transform session', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, [255, 0, 0, 255]);
  await new Promise(r => setTimeout(r, 1300));
  await call('setProps', 1, { name: 'Renamed' });
  await call('transformBegin', 1, 'layer', 'Free Transform');
  await new Promise(r => setTimeout(r, 1300));
  const r = await (await Autosave.fromRoot(root as unknown as FileSystemDirectoryHandle)).load();
  await call('transformCancel');
  assert.ok(r);
  assert.ok(JSON.parse(r.manifest).layers[0].tiles.length > 0, 'the saved layer keeps its pixels');
});

test('transformCommit without an open session fails instead of reporting success', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, [255, 0, 0, 255]);
  const r = await call('transformCommit', [1, 0, 1, 0, 1, 0, 0, 0, 1]);
  assert.ok(r.error);
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

// A red 4 x 4 square at (2, 2) on layer 1 of a transparent 16 x 16 document, no selection.
async function redSquare() {
  await call('init');
  await call('newDoc', 16, 16, 8, null);
  await call('select', { kind: 'rect', x: 2, y: 2, w: 4, h: 4 }, 'new', false, 0, 'Rectangular Marquee');
  await call('fillEx', 1, 'pixels', solid([255, 0, 0, 255]), 'Fill');
  await call('selectCommand', 'deselect');
}
const translate = (dx: number, dy: number) => [1, 0, dx, 0, 1, dy, 0, 0, 1];
const RED = [255, 0, 0, 255], CLEAR = [0, 0, 0, 0];

test('a free transform session hides the layer, refines on request and commits one Free Transform step', async () => {
  await redSquare();
  const b = (await call('transformBegin', 1, 'layer', 'Free Transform')).result as { bounds: number[]; image: { x: number; y: number; w: number; h: number; f: number }; data: ArrayBuffer };
  assert.deepEqual(b.bounds, [2, 2, 4, 4]);
  assert.deepEqual(b.image, { x: 2, y: 2, w: 4, h: 4, f: 1 });
  assert.deepEqual(Array.from(new Uint8Array(b.data).subarray(0, 4)), RED, 'the preview source holds the layer pixels');
  assert.deepEqual(await px(3, 3), CLEAR, 'the live document shows the layer without its pixels');
  await call('transformRefine', translate(8, 0));
  assert.deepEqual(await px(11, 3), RED);
  await call('transformUnrefine');
  assert.deepEqual(await px(11, 3), CLEAR);
  const c = await call('transformCommit', translate(8, 8));
  const doc = c.result as { undoLabel: string; history: { labels: string[] } };
  assert.equal(doc.undoLabel, 'Free Transform');
  assert.equal(doc.history.labels.filter(l => l === 'Free Transform').length, 1);
  assert.deepEqual([await px(11, 11), await px(3, 3)], [RED, CLEAR]);
  await call('undo');
  assert.deepEqual([await px(3, 3), await px(11, 11)], [RED, CLEAR]);
});

test('cancel and an unmodified commit restore the document with no history step', async () => {
  await redSquare();
  await call('transformBegin', 1, 'layer', 'Free Transform');
  await call('transformRefine', translate(5, 0));
  const c = await call('transformCancel');
  assert.equal((c.result as { undoLabel: string }).undoLabel, 'Deselect');
  assert.deepEqual(await px(3, 3), RED);
  await call('transformBegin', 1, 'layer', 'Free Transform');
  const n = await call('transformCommit', null);
  assert.equal((n.result as { undoLabel: string }).undoLabel, 'Deselect');
  assert.deepEqual(await px(3, 3), RED);
});

test('a session on selected pixels lifts them and moves them with the selection', async () => {
  await redSquare();
  await call('select', { kind: 'rect', x: 2, y: 2, w: 2, h: 4 }, 'new', false, 0, 'Rectangular Marquee');
  const b = (await call('transformBegin', 1, 'pixels', 'Free Transform')).result as { bounds: number[] };
  assert.deepEqual(b.bounds, [2, 2, 2, 4]);
  assert.deepEqual([await px(2, 3), await px(4, 3)], [CLEAR, RED]);
  await call('transformCommit', translate(10, 0));
  assert.deepEqual([await px(12, 3), await px(2, 3), await px(4, 3)], [RED, CLEAR, RED]);
  assert.equal((await call('selectionAt', 12, 3)).result, 255);
  assert.equal((await call('selectionAt', 2, 3)).result, 0);
});

test('Transform Selection needs a selection and transforms only the selection', async () => {
  await redSquare();
  assert.equal((await call('transformBegin', 1, 'selection', 'Transform Selection')).error, 'Make a selection first.');
  await call('select', { kind: 'rect', x: 0, y: 0, w: 4, h: 4 }, 'new', false, 0, 'Rectangular Marquee');
  const b = (await call('transformBegin', 1, 'selection', 'Transform Selection')).result as { image: unknown };
  assert.equal(b.image, null);
  const c = await call('transformCommit', [2, 0, 0, 0, 2, 0, 0, 0, 1]);
  assert.equal((c.result as { undoLabel: string }).undoLabel, 'Transform Selection');
  assert.equal((c.result as { selection: { bounds: number[] } }).selection.bounds.join(), '0,0,8,8');
  assert.deepEqual(await px(3, 3), RED);
});

test('another op during a transform session cancels it, tells the UI and late session calls do nothing', async () => {
  await redSquare();
  await call('transformBegin', 1, 'layer', 'Free Transform');
  await call('transformRefine', translate(8, 0));
  events.length = 0;
  const r = await call('addLayer', 1);
  assert.equal((r.result as { undoLabel: string }).undoLabel, 'New Layer');
  const ev = events.filter(e => (e as { event: string }).event === 'transformCancelled') as { doc: { undoLabel: string } }[];
  assert.deepEqual(ev.map(e => e.doc.undoLabel), ['Deselect'], 'one event carrying the document after the cancel');
  assert.deepEqual(await px(3, 3), RED);
  for (const op of ['transformRefine', 'transformUnrefine'] as const) {
    const late = await call(op, translate(8, 0));
    assert.equal(late.error, undefined, op);
  }
  assert.equal((await call('transformCommit', translate(8, 0))).error, 'The transform was cancelled.', 'a late commit is reported, not recorded');
  assert.deepEqual([await px(3, 3), await px(11, 3)], [RED, CLEAR]);
  assert.equal((await call('transformCancel')).error, undefined);
  assert.equal(events.filter(e => (e as { event: string }).event === 'transformCancelled').length, 1, 'an explicit cancel is not reported back');
});

test('rotateExact is a single step under the given label', async () => {
  await redSquare();
  const r = await call('rotateExact', 1, 'flipH', 'Flip Horizontal');
  assert.equal((r.result as { undoLabel: string }).undoLabel, 'Flip Horizontal');
});

test('transformAgain replays a normalized transform on the layer tight bounds as one Transform Again step', async () => {
  await redSquare();
  // Scale 2 about the centre of the unit square.
  const n = [2, 0, -0.5, 0, 2, -0.5, 0, 0, 1];
  const a = await call('transformAgain', 1, n, 'nearest');
  assert.equal((a.result as { undoLabel: string }).undoLabel, 'Transform Again');
  assert.deepEqual([await px(0, 0), await px(7, 7), await px(8, 8)], [RED, RED, CLEAR]);
  assert.equal((await call('transformAgain', 1, [1, 0, 0, 0, 1, 0, 0, 0, 1], 'bicubic')).error, 'Transform Again changed nothing.');
  await call('addLayer', 1);
  assert.equal((await call('transformAgain', 2, n, 'bicubic')).error, 'Transform Again changed nothing.');
  assert.equal(((await call('undo')).result as { undoLabel: string }).undoLabel, 'Transform Again');
});

// The identity mesh of a rect, moved by (dx, dy), as the engine's mesh JSON.
const meshMoved = (x: number, y: number, w: number, h: number, dx: number, dy: number) => {
  const m = identityMesh({ x, y, w, h });
  return engineMesh({ ...m, points: m.points.map(([px, py]) => [px + dx, py + dy]) });
};

test('a warp session refines and commits a mesh as one Warp step', async () => {
  await redSquare();
  await call('transformBegin', 1, 'layer', 'Warp');
  assert.deepEqual(await px(3, 3), CLEAR);
  await call('transformRefine', meshMoved(2, 2, 4, 4, 8, 0));
  assert.deepEqual([await px(11, 3), await px(3, 3)], [RED, CLEAR]);
  await call('transformUnrefine');
  assert.deepEqual(await px(11, 3), CLEAR);
  const c = await call('transformCommit', meshMoved(2, 2, 4, 4, 8, 8));
  const doc = c.result as { undoLabel: string; history: { labels: string[] } };
  assert.equal(doc.undoLabel, 'Warp');
  assert.equal(doc.history.labels.filter(l => l === 'Warp').length, 1);
  assert.deepEqual([await px(11, 11), await px(3, 3)], [RED, CLEAR]);
  await call('undo');
  assert.deepEqual([await px(3, 3), await px(11, 11)], [RED, CLEAR]);
});

test('switching a session to warp bakes a pending matrix and labels the step Free Transform and Warp', async () => {
  await redSquare();
  await call('transformBegin', 1, 'layer', 'Free Transform');
  const w = (await call('transformWarp', translate(8, 0))).result as { bounds: number[]; image: { x: number; y: number; w: number; h: number; f: number }; data: ArrayBuffer };
  assert.deepEqual(w.bounds, [10, 2, 4, 4], 'the warp source is the transformed layer');
  assert.deepEqual(w.image, { x: 10, y: 2, w: 4, h: 4, f: 1 });
  assert.deepEqual(Array.from(new Uint8Array(w.data).subarray(0, 4)), RED);
  assert.deepEqual([await px(11, 3), await px(3, 3)], [CLEAR, CLEAR], 'the live document hides the warp source');
  await call('transformRefine', meshMoved(10, 2, 4, 4, 0, 8));
  assert.deepEqual(await px(11, 11), RED, 'the mesh applies on top of the baked matrix');
  const c = await call('transformCommit', null);
  assert.equal((c.result as { undoLabel: string }).undoLabel, 'Free Transform and Warp', 'an unmodified mesh still commits the matrix');
  assert.deepEqual([await px(11, 3), await px(11, 11), await px(3, 3)], [RED, CLEAR, CLEAR]);
  assert.equal(((await call('undo')).result as { undoLabel: string }).undoLabel, 'Deselect');
  assert.deepEqual(await px(3, 3), RED);
});

test('switching an unmodified session to warp commits as Warp, and an unmodified warp commits nothing', async () => {
  await redSquare();
  await call('transformBegin', 1, 'layer', 'Free Transform');
  assert.deepEqual(((await call('transformWarp', null)).result as { bounds: number[] }).bounds, [2, 2, 4, 4]);
  const c = await call('transformCommit', meshMoved(2, 2, 4, 4, 8, 0));
  assert.equal((c.result as { undoLabel: string }).undoLabel, 'Warp');
  await call('transformBegin', 1, 'layer', 'Warp');
  const n = await call('transformCommit', null);
  assert.equal((n.result as { undoLabel: string }).undoLabel, 'Warp', 'no second step');
  assert.equal((n.result as { history: { labels: string[] } }).history.labels.filter(l => l === 'Warp').length, 1);
});

test('warp refuses the selection outline and selected pixels, and the session stays open', async () => {
  await redSquare();
  await call('select', { kind: 'rect', x: 2, y: 2, w: 2, h: 4 }, 'new', false, 0, 'Rectangular Marquee');
  for (const kind of ['selection', 'pixels']) {
    await call('transformBegin', 1, kind, 'Free Transform');
    const r = await call('transformWarp', null);
    assert.match(r.error ?? '', /warp/i, kind);
    assert.equal((await call('transformRefine', meshMoved(2, 2, 4, 4, 8, 0))).error !== undefined, true, `${kind}: a mesh is refused`);
    assert.equal((await call('transformCancel')).error, undefined, `${kind}: the session is still open`);
  }
  assert.equal((await call('transformWarp', null)).error, 'The transform was cancelled.');
});

type Doc = { width: number; height: number; undoLabel: string | null; history: { labels: string[] }; selection: { bounds: number[] | null } | null };
const docOf = (r: { result?: unknown }) => r.result as Doc;
const count = (d: Doc, label: string) => d.history.labels.filter(l => l === label).length;

// Every pixel of the canvas, row-major, through the composite sampler.
async function pixels(w: number, h: number) {
  const out: number[][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push(await px(x, y));
  return out;
}

// redSquare on a white Background: a full-canvas layer, so Reveal All can find the old canvas again.
async function redOnWhite() {
  await call('init');
  await call('newDoc', 16, 16, 8, [255, 255, 255, 255]);
  await call('select', { kind: 'rect', x: 2, y: 2, w: 4, h: 4 }, 'new', false, 0, 'Rectangular Marquee');
  await call('fillEx', 1, 'pixels', solid([255, 0, 0, 255]), 'Fill');
  await call('selectCommand', 'deselect');
}

test('Image > Crop needs a selection and crops to it as one Crop step', async () => {
  await redSquare();
  const refused = await call('cropToSelection');
  assert.equal(refused.error, 'Make a selection to crop to.');
  await call('select', { kind: 'rect', x: 2, y: 2, w: 4, h: 4 }, 'new', false, 0, 'Rectangular Marquee');
  const d = docOf(await call('cropToSelection'));
  assert.deepEqual([d.width, d.height, d.undoLabel, count(d, 'Crop')], [4, 4, 'Crop', 1]);
  assert.deepEqual(d.selection?.bounds, [0, 0, 4, 4], 'the selection moves with the crop');
  assert.deepEqual([await px(0, 0), await px(3, 3)], [RED, RED]);
  const u = docOf(await call('undo'));
  assert.deepEqual([u.width, u.height], [16, 16]);
});

test('Reveal All after Image > Crop restores the original size and pixels, then is a no-op', async () => {
  await redOnWhite();
  const before = await pixels(16, 16);
  await call('select', { kind: 'rect', x: 2, y: 2, w: 4, h: 4 }, 'new', false, 0, 'Rectangular Marquee');
  await call('cropToSelection');
  const d = docOf(await call('revealAll'));
  assert.deepEqual([d.width, d.height, d.undoLabel, count(d, 'Reveal All')], [16, 16, 'Reveal All', 1]);
  assert.deepEqual(await pixels(16, 16), before);
  const again = docOf(await call('revealAll'));
  assert.equal(count(again, 'Reveal All'), 1, 'no step when nothing is outside the canvas');
});

test('Trim transparent and pixel-colour modes give the expected size as one Trim step', async () => {
  await redSquare();
  const t = docOf(await call('trim', 'transparent', true, true, true, true));
  assert.deepEqual([t.width, t.height, t.undoLabel, count(t, 'Trim')], [4, 4, 'Trim', 1]);
  assert.deepEqual(await px(0, 0), RED);
  const n = docOf(await call('trim', 'transparent', true, true, true, true));
  assert.equal(count(n, 'Trim'), 1, 'a trim that changes nothing makes no step');
  await call('undo');
  const r = docOf(await call('trim', 'transparent', true, true, true, false));
  assert.deepEqual([r.width, r.height], [14, 4], 'a side left off keeps the canvas edge');
  await redOnWhite();
  for (const mode of ['topLeftPixel', 'bottomRightPixel']) {
    const c = docOf(await call('trim', mode, true, true, true, true));
    assert.deepEqual([c.width, c.height], [4, 4], mode);
    await call('undo');
  }
});

test('canvas rotations and flips are one step each under their menu label', async () => {
  await redSquare();
  const labels = { '180': '180°', cw: '90° Clockwise', ccw: '90° Counter Clockwise', flipH: 'Flip Canvas Horizontal', flipV: 'Flip Canvas Vertical' };
  for (const [kind, label] of Object.entries(labels)) {
    const d = docOf(await call('rotateCanvas', kind));
    assert.deepEqual([d.undoLabel, count(d, label)], [label, 1], kind);
  }
});

test('rotating the canvas 90 CW then CCW restores identical pixels', async () => {
  await call('init');
  await call('newDoc', 8, 4, 8, null);
  await call('select', { kind: 'rect', x: 1, y: 0, w: 2, h: 1 }, 'new', false, 0, 'Rectangular Marquee');
  await call('fillEx', 1, 'pixels', solid([255, 0, 0, 255]), 'Fill');
  await call('selectCommand', 'deselect');
  const before = await pixels(8, 4);
  const cw = docOf(await call('rotateCanvas', 'cw'));
  assert.deepEqual([cw.width, cw.height], [4, 8]);
  assert.deepEqual([await px(3, 1), await px(3, 2), await px(0, 1)], [RED, RED, CLEAR], '(x, y) goes to (H-1-y, x)');
  const ccw = docOf(await call('rotateCanvas', 'ccw'));
  assert.deepEqual([ccw.width, ccw.height], [8, 4]);
  assert.deepEqual(await pixels(8, 4), before);
});

test('arbitrary canvas rotation is one Rotate Canvas step, a full turn makes none, a bad angle is reported', async () => {
  await redSquare();
  const d = docOf(await call('rotateCanvasArbitrary', 30, 'bicubic'));
  assert.deepEqual([d.undoLabel, count(d, 'Rotate Canvas')], ['Rotate Canvas', 1]);
  assert.ok(d.width > 16 && d.height > 16);
  const n = docOf(await call('rotateCanvasArbitrary', 360, 'bilinear'));
  assert.equal(count(n, 'Rotate Canvas'), 1);
  const bad = await call('rotateCanvasArbitrary', Number.NaN, 'bicubic');
  assert.equal(bad.error, 'angle must be finite');
  assert.equal(count(docOf(await call('undo')), 'Rotate Canvas'), 1, 'the refused call left no step behind');
});

test('the crop tool commits one Crop step; Delete Cropped Pixels decides what Reveal All can bring back', async () => {
  await redOnWhite();
  const before = await pixels(16, 16);
  const kept = docOf(await call('cropTool', 1.5, 1.5, 6, 6, 0, false));
  assert.deepEqual([kept.width, kept.height, kept.undoLabel, count(kept, 'Crop')], [7, 7, 'Crop', 1], 'the rect rounds out');
  assert.deepEqual([await px(0, 0), await px(1, 1)], [[255, 255, 255, 255], RED]);
  const back = docOf(await call('revealAll'));
  assert.deepEqual([back.width, back.height], [16, 16]);
  assert.deepEqual(await pixels(16, 16), before, 'hidden pixels were kept');
  await call('undo');
  await call('undo');
  const cut = docOf(await call('cropTool', 1.5, 1.5, 6, 6, 0, true));
  assert.deepEqual([cut.width, cut.height, count(cut, 'Crop')], [7, 7, 1]);
  const none = docOf(await call('revealAll'));
  assert.deepEqual([none.width, none.height, count(none, 'Reveal All')], [7, 7, 0], 'deleted pixels are gone');
  const u = docOf(await call('undo'));
  assert.deepEqual([u.width, u.height], [16, 16]);
  assert.deepEqual(await pixels(16, 16), before);
  const same = docOf(await call('cropTool', 0, 0, 16, 16, 0, true));
  assert.equal(same.undoLabel, u.undoLabel, 'the untouched canvas makes no step');
});

test('a straightened crop rotates by -angle and crops the mapped bbox in the same Crop step', async () => {
  await call('init');
  await call('newDoc', 100, 50, 8, [255, 255, 255, 255]);
  const d = docOf(await call('cropTool', 10, 10, 50, 20, 10, true));
  assert.deepEqual([d.width, d.height], croppedSize({ x: 10, y: 10, w: 50, h: 20 }, 10, 100, 50), 'the readout matches the engine');
  assert.deepEqual([d.width, d.height, d.undoLabel, count(d, 'Crop')], [53, 29, 'Crop', 1]);
  const u = docOf(await call('undo'));
  assert.deepEqual([u.width, u.height], [100, 50]);
  assert.notEqual(u.undoLabel, 'Crop');
  assert.equal((await call('cropTool', 0, 0, 10, 10, Number.NaN, true)).error, 'angle must be finite');
});

test('perspective crop is one Perspective Crop step; a collinear quad is refused and changes nothing', async () => {
  await redSquare();
  await call('select', { kind: 'rect', x: 0, y: 0, w: 3, h: 3 }, 'new', false, 0, 'Rectangular Marquee');
  const bad = await call('perspectiveCrop', [0, 0, 5, 0, 10, 0, 15, 0], 4, 4);
  assert.equal(bad.error, 'Those four corners are degenerate; move one and try again.');
  const same = docOf(await call('undo'));
  assert.deepEqual([same.width, same.height, count(same, 'Perspective Crop')], [16, 16, 0]);
  await call('redo');
  assert.deepEqual(await px(3, 3), RED, 'pixels untouched');
  const d = docOf(await call('perspectiveCrop', [2, 2, 6, 2, 6, 6, 2, 6], 4, 4));
  assert.deepEqual([d.width, d.height, d.undoLabel, count(d, 'Perspective Crop')], [4, 4, 'Perspective Crop', 1]);
  assert.equal(d.selection, null, 'the selection is cleared');
  const c = await px(1, 1);
  assert.ok(c.every((v, i) => Math.abs(v - RED[i]) <= 1), `${c}`);
});
