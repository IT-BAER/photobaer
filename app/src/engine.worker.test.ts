import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, Engine } from './engine-pkg/photobaer_engine.js';
import { exportPsd } from './psd.ts';
import { Autosave } from './autosave.ts';
import { FakeDir, fs } from './fake-opfs.ts';
import { engineMesh, identityMesh } from './transform/warp.ts';
import { croppedSize } from './crop/geometry.ts';
import { ADJUSTMENT_KINDS, DESTRUCTIVE_KINDS, DESTRUCTIVE_LABEL, MENU_LABEL, defaultAdjustment, defaultDestructive } from './adjustments.ts';
import { defaultBlending, defaultEffect, emptyStyle, type LayerStyle } from './layerStyle.ts';

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
// A call stamped with the document id the UI saw when it issued the call.
function callAt(doc: number, op: string, ...args: unknown[]) {
  const id = ++nextId;
  const p = new Promise<{ result?: unknown; error?: string }>(r => replies.set(id, r));
  g.onmessage!({ data: { id, op, args, doc } });
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
  assert.deepEqual(doc.layers, [{ id: 1, name: 'Background', kind: 'pixel', visible: true, opacity: 1, fill: 1, blend: 'normal', clipping: false, locks: { transparency: false, pixels: false, position: false }, mask: null, style: null, blending, vector_mask: null }]);
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

// M3.md section 3 / B5: adjustment layers, destructive apply and B5-5 undo labels.
const invertAdj = { kind: 'invert', params: {} };

test('newAdjustmentLayer names and undoes under the kind\'s plain menu label', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, null);
  const r = await call('newAdjustmentLayer', 1, invertAdj, 'Invert');
  const info = r.result as { created: number; undoLabel: string; layers: { id: number; name: string; kind: string; adjustment?: unknown }[] };
  assert.equal(info.undoLabel, 'Invert');
  const node = info.layers.find(l => l.id === info.created)!;
  assert.equal(node.kind, 'adjustment');
  assert.equal(node.name, 'Invert');
  assert.deepEqual(node.adjustment, invertAdj);
});

test('newAdjustmentLayer then a Properties edit are two undo steps with the create/edit label split (B5-5)', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, null);
  const hueSat = { kind: 'hue_saturation', params: { master: { hue: 0, saturation: 0, lightness: 0 }, ranges: Array.from({ length: 6 }, () => ({ bands: [0, 0, 0, 0], hue: 0, saturation: 0, lightness: 0 })), colorize: false, colorize_values: { hue: 0, saturation: 25, lightness: 0 } } };
  const created = await call('newAdjustmentLayer', 1, hueSat, 'Hue/Saturation');
  const id = (created.result as { created: number }).created;
  const edited = { ...hueSat, params: { ...hueSat.params, master: { hue: 10, saturation: 0, lightness: 0 } } };
  const e = await call('setAdjustment', id, edited, 'Hue / Saturation');
  const info = e.result as { undoLabel: string; history: { labels: string[] } };
  assert.equal(info.undoLabel, 'Hue / Saturation');
  assert.deepEqual(info.history.labels, ['Hue/Saturation', 'Hue / Saturation']);
});

test('setAdjustment validates each kind\'s ranges, naming the out-of-range field', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, null);
  const layer = (await call('newAdjustmentLayer', 1, invertAdj, 'Invert')).result as { created: number };
  const id = layer.created;
  const cases: [string, Record<string, unknown>, string][] = [
    ['brightness_contrast', { brightness: 200, contrast: 0, legacy: false }, 'brightness'],
    ['levels', { composite: { input_black: 0, input_white: 255, gamma: 10, output_black: 0, output_white: 255 }, red: null, green: null, blue: null }, 'gamma'],
    ['curves', { mode: 'point', composite: [], red: null, green: null, blue: null }, 'curves.composite'],
    ['exposure', { exposure: 100, offset: 0, gamma: 1 }, 'exposure'],
    ['vibrance', { vibrance: 200, saturation: 0 }, 'vibrance'],
    ['color_balance', { shadows: [200, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserve_luminosity: true }, 'shadows'],
    ['black_white', { reds: 1000, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tint_color: [206, 185, 155] }, 'reds'],
    ['photo_filter', { color: [236, 138, 0], density: 200, preserve_luminosity: true }, 'density'],
    ['channel_mixer', { red: [1000, 0, 0, 0], green: [0, 100, 0, 0], blue: [0, 0, 100, 0], gray: [40, 40, 20, 0], monochrome: false }, 'red'],
    ['posterize', { levels: 1 }, 'levels'],
    ['threshold', { level: 0 }, 'level'],
    ['selective_color', { mode: 'relative', reds: [200, 0, 0, 0], yellows: [0, 0, 0, 0], greens: [0, 0, 0, 0], cyans: [0, 0, 0, 0], blues: [0, 0, 0, 0], magentas: [0, 0, 0, 0], whites: [0, 0, 0, 0], neutrals: [0, 0, 0, 0], blacks: [0, 0, 0, 0] }, 'reds'],
  ];
  for (const [kind, params, field] of cases) {
    const r = await call('setAdjustment', id, { kind, params }, 'Adjustment');
    assert.ok(r.error?.includes(field), `${kind}: expected an error naming ${field}, got ${r.error}`);
  }
  // hue_saturation needs its full [6] ranges tuple to deserialize; validated separately.
  const badHue = { kind: 'hue_saturation', params: { master: { hue: 999, saturation: 0, lightness: 0 }, ranges: Array.from({ length: 6 }, () => ({ bands: [0, 0, 0, 0], hue: 0, saturation: 0, lightness: 0 })), colorize: false, colorize_values: { hue: 0, saturation: 25, lightness: 0 } } };
  const rh = await call('setAdjustment', id, badHue, 'Adjustment');
  assert.ok(rh.error?.includes('master.hue'), `expected an error naming master.hue, got ${rh.error}`);
  // invert, gradient_map and color_lookup have no rejectable numeric range (gap b5-a: gradient
  // stops are clamped by compile, not rejected; color lookup's bound is its LUT-size check).
  const gradientMap = { kind: 'gradient_map', params: { gradient: { method: 'classic', color_stops: [{ position: 2, color: [0, 0, 0], midpoint: 0.5 }, { position: 1, color: [255, 255, 255], midpoint: 0.5 }], opacity_stops: [{ position: 0, opacity: 1, midpoint: 0.5 }, { position: 1, opacity: 1, midpoint: 0.5 }] }, reverse: false, dither: false } };
  assert.equal((await call('setAdjustment', id, gradientMap, 'Adjustment')).error, undefined);
});

test('adjust applies destructively, mixes by selection coverage, and a preview cancel restores the tiles', async () => {
  await call('init');
  await call('newDoc', 8, 8, 8, [200, 200, 200, 255]);
  await call('fillEx', 1, 'selection', { source: 'solid', rgba: [128, 128, 128, 255], mode: 'normal', opacity: 1, preserveTransparency: false }, 'Fill');
  const r = await call('adjust', 1, invertAdj, 'Invert');
  assert.equal((r.result as { undoLabel: string }).undoLabel, 'Invert');
  assert.deepEqual(await px(3, 3), [127, 127, 127, 255], '200 and its invert 55 average to the midpoint at ~50% coverage');

  const u = await call('undo');
  assert.equal((u.result as { undoLabel: string }).undoLabel, 'Fill', 'one undo pops just the destructive Invert step');
  await call('adjust', 1, invertAdj, 'Invert', true);
  assert.deepEqual(await px(3, 3), [127, 127, 127, 255], 'the preview shows the same result live');
  const cancelled = await call('previewEnd', false);
  assert.equal((cancelled.result as { undoLabel: string | null }).undoLabel, 'Fill', 'the preview session drops, leaving the last committed step');
  assert.deepEqual(await px(3, 3), [200, 200, 200, 255], 'cancel restores the untouched tile');
});

test('each destructive-only command is one undo step under its menu label', async () => {
  await call('init');
  const doc = (await call('newDoc', 8, 8, 8, [200, 100, 50, 255])).result as { history: { labels: string[] } };
  let steps = doc.history.labels.length;
  for (const kind of DESTRUCTIVE_KINDS) {
    const r = await call('adjust', 1, defaultDestructive(kind), DESTRUCTIVE_LABEL[kind]);
    assert.equal(r.error, undefined, `${kind}: ${r.error}`);
    const info = r.result as { undoLabel: string; history: { labels: string[] } };
    assert.equal(info.undoLabel, DESTRUCTIVE_LABEL[kind]);
    assert.equal(info.history.labels.length, ++steps, `${kind} adds exactly one step`);
  }
  // A dialog kind previews live and commits once.
  const sh = defaultDestructive('shadows_highlights');
  await call('adjust', 1, sh, 'Shadows/Highlights', true);
  await call('adjust', 1, sh, 'Shadows/Highlights', true);
  const done = (await call('previewEnd', true)).result as { undoLabel: string; history: { labels: string[] } };
  assert.equal(done.undoLabel, 'Shadows/Highlights');
  assert.equal(done.history.labels.length, steps + 1);
  const bad = await call('adjust', 1, { kind: 'match_color', params: { luminance: 500, color_intensity: 100, fade: 0, neutralize: false } }, 'Match Color');
  assert.ok(bad.error?.includes('luminance'), `expected an error naming luminance, got ${bad.error}`);
});

test('every kind\'s default params create an adjustment layer under its menu label', async () => {
  await call('init');
  await call('newDoc', 8, 8, 8, null);
  for (const kind of ADJUSTMENT_KINDS) {
    const r = await call('newAdjustmentLayer', 1, defaultAdjustment(kind), MENU_LABEL[kind]);
    assert.equal(r.error, undefined, `${kind}: ${r.error}`);
    const info = r.result as { created: number; layers: { id: number; name: string; adjustment?: { kind: string } }[] };
    const node = info.layers.find(l => l.id === info.created)!;
    assert.equal(node.name, MENU_LABEL[kind]);
    assert.equal(node.adjustment?.kind, kind);
  }
});

test('setAdjustment live preview reruns land as one undo step on commit', async () => {
  await call('init');
  await call('newDoc', 8, 8, 8, null);
  const id = ((await call('newAdjustmentLayer', 1, defaultAdjustment('posterize'), 'Posterize')).result as { created: number }).created;
  for (const levels of [5, 6, 7]) await call('setAdjustment', id, { kind: 'posterize', params: { levels } }, 'Posterize', true);
  const r = await call('previewEnd', true);
  const info = r.result as { history: { labels: string[] }; layers: { id: number; adjustment?: { params: { levels: number } } }[] };
  assert.deepEqual(info.history.labels, ['Posterize', 'Posterize']);
  assert.equal(info.layers.find(l => l.id === id)!.adjustment!.params.levels, 7);
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

test('a move step or commit after another op auto-committed the session is a no-op, not an error', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, [255, 0, 0, 255]);
  await call('moveLayerBegin', 1, false, 'Move');
  await call('moveLayerStep', 3, 0);
  await call('addLayer', 0);
  for (const op of ['moveLayerStep', 'moveLayerCommit', 'movePixelsStep', 'movePixelsCommit']) {
    const r = await call(op, 2, 2);
    assert.equal(r.error, undefined, op);
  }
  const u = await call('undo');
  assert.equal((u.result as { redoLabel: string }).redoLabel, 'New Layer');
  assert.equal(((await call('undo')).result as { redoLabel: string }).redoLabel, 'Move');
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

test('snapTargets adds guide positions on their own axis, and categories gate each target group', async () => {
  await call('init');
  await call('newDoc', 100, 50, 8, null);
  await call('addGuide', 'x', 40);
  await call('addGuide', 'y', 15);
  const withGuides = (await call('snapTargets', 0)).result as { x: number[]; y: number[] };
  assert.ok(withGuides.x.includes(40));
  assert.ok(withGuides.y.includes(15));
  const noGuides = (await call('snapTargets', 0, { guides: false })).result as { x: number[]; y: number[] };
  assert.ok(!noGuides.x.includes(40));
  assert.ok(!noGuides.y.includes(15));
  const noBounds = (await call('snapTargets', 0, { documentBounds: false, layers: false })).result as { x: number[]; y: number[] };
  assert.deepEqual(noBounds.x, [40]);
  assert.deepEqual(noBounds.y, [15]);
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

// Layer styles (B9): an opaque 30x30 red square at (20, 20) on layer 2 over a white Background.
async function styledDoc() {
  await call('init');
  await call('newDoc', 80, 80, 8, [255, 255, 255, 255]);
  await call('addLayer', 1);
  await call('select', { kind: 'rect', x: 20, y: 20, w: 30, h: 30 }, 'new', false, 0, 'Rectangular Marquee');
  await call('command', 'fill', 2, 'pixels', [255, 0, 0, 255]);
  await call('selectCommand', 'deselect');
}
type DocWithStyles = {
  layers: { id: number; name: string; style: LayerStyle | null; blend: string; opacity: number; fill: number; blending: { knockout: string } }[];
  globalLight: { angle: number; altitude: number };
};
type StyledDoc = DocWithStyles & { undoLabel: string; history: { labels: string[] } };
const layer = (d: unknown, id: number) => (d as DocWithStyles).layers.find(l => l.id === id)!;
const blueStroke = (size: number) => ({ ...defaultEffect('strokes'), size, fill: { type: 'solid', color: [0, 0, 255] } });
const samples = (points: number[][]) => Promise.all(points.map(([x, y]) => call('sample', x, y, 1, null).then(r => r.result as number[])));

test('paste layer style deep-copies onto several layers and never carries blending options', async () => {
  await styledDoc();
  await call('addLayer', 2);
  const style = { ...emptyStyle(), strokes: [blueStroke(3)] };
  await call('setLayerStyle', 2, style, { ...defaultBlending(), knockout: 'shallow' }, 0.5, null);
  await call('copyLayerStyle', 2);
  const p = await call('pasteLayerStyle', [1, 3]);
  assert.equal((p.result as StyledDoc).undoLabel, 'Paste Layer Style');
  for (const id of [1, 3]) {
    assert.deepEqual(layer(p.result, id).style, layer(p.result, 2).style);
    assert.equal(layer(p.result, id).blending.knockout, 'none');
    assert.equal(layer(p.result, id).fill, 1);
  }
  const s = await call('scaleEffects', 1, 200);
  assert.equal((s.result as StyledDoc).undoLabel, 'Scale Effects');
  assert.equal(layer(s.result, 1).style!.scale, 2);
  assert.equal(layer(s.result, 3).style!.scale, 1, 'the other pasted copy is untouched');
  const c = await call('clearLayerStyle', [3]);
  assert.equal(layer(c.result, 3).style, null);
  assert.equal((c.result as StyledDoc).undoLabel, 'Clear Layer Style');
});

test('scale 200 % renders stroke 3 like stroke 6 at 100 %', async () => {
  const render = async (size: number, percent: number) => {
    await styledDoc();
    await call('setLayerStyle', 2, { ...emptyStyle(), strokes: [blueStroke(size)] }, defaultBlending(), 1, null);
    await call('scaleEffects', 2, percent);
    return samples([[13, 35], [14, 35], [15, 35], [19, 35], [35, 13], [56, 56]]);
  };
  const a = await render(3, 200);
  const b = await render(6, 100);
  assert.deepEqual(a, b);
  assert.deepEqual(a.slice(0, 3), [[255, 255, 255, 255], [0, 0, 255, 255], [0, 0, 255, 255]]);
});

test('Create Layers makes one layer per behind plane and keeps the flattened result', async () => {
  await styledDoc();
  const style = {
    ...emptyStyle(), strokes: [blueStroke(2)],
    drop_shadows: [defaultEffect('drop_shadows'), { ...defaultEffect('drop_shadows'), angle: 30, use_global_light: false }],
    outer_glow: defaultEffect('outer_glow'),
  };
  await call('setLayerStyle', 2, style, defaultBlending(), 0.7, null);
  const points = [[10, 10], [18, 30], [30, 30], [52, 40], [55, 55], [60, 60], [45, 18], [53, 16]];
  const before = await samples(points);
  const r = await call('createLayersFromStyle', 2);
  const d = r.result as StyledDoc & { created: number[] };
  assert.equal(d.undoLabel, 'Create Layers');
  assert.deepEqual(d.created.map(id => layer(d, id).name), ["Layer 1's Drop Shadow", "Layer 1's Drop Shadow 2", "Layer 1's Outer Glow"]);
  assert.equal(layer(d, 2).style, null);
  assert.equal(layer(d, 2).fill, 1);
  const after = await samples(points);
  before.forEach((p, i) => p.forEach((v, k) => assert.ok(Math.abs(v - after[i][k]) <= 1, `point ${points[i]} channel ${k}: ${v} vs ${after[i][k]}`)));
});

test('the Layer Style dialog previews and commits one step; global light and hide all', async () => {
  await styledDoc();
  const style = { ...emptyStyle(), drop_shadows: [defaultEffect('drop_shadows')] };
  await call('setLayerStyle', 2, style, defaultBlending(), 1, { angle: 400, altitude: 120 }, true);
  await call('setLayerStyle', 2, { ...style, scale: 2 }, defaultBlending(), 1, { angle: -30, altitude: 40 }, true);
  const d = (await call('previewEnd', true)).result as StyledDoc;
  assert.equal(d.undoLabel, 'Layer Style');
  assert.equal(d.history.labels.filter(l => l === 'Layer Style').length, 1);
  assert.deepEqual(d.globalLight, { angle: 330, altitude: 40 });
  assert.equal(layer(d, 2).style!.scale, 2);
  const g = await call('setGlobalLight', { angle: 725, altitude: -5 });
  assert.deepEqual((g.result as StyledDoc).globalLight, { angle: 5, altitude: 0 });
  assert.equal((g.result as StyledDoc).undoLabel, 'Global Light');
  const h = await call('hideAllEffects');
  assert.equal(layer(h.result, 2).style!.enabled, false);
  assert.equal((h.result as StyledDoc).undoLabel, 'Hide All Effects');
  // Cancel restores.
  await call('setLayerStyle', 2, emptyStyle(), defaultBlending(), 0.2, null, true);
  const c = await call('previewEnd', false);
  assert.equal(layer(c.result, 2).style!.drop_shadows.length, 1);
  assert.equal(layer(c.result, 2).fill, 1);
});

test('style commands on a fully locked layer fail naming the reason, with no step', async () => {
  await styledDoc();
  await call('setLayerStyle', 2, emptyStyle(), defaultBlending(), 1, null);
  const locked = await call('setProps', 2, { locks: { transparency: true, pixels: true, position: true } });
  const steps = (locked.result as StyledDoc).history.labels.length;
  const r = await call('setLayerStyle', 2, emptyStyle(), defaultBlending(), 1, null);
  assert.match(r.error!, /fully locked/);
  const m = await call('dragLayerStyle', 2, 1, false);
  assert.match(m.error!, /fully locked/);
  const d = (await call('hideAllEffects')).result as StyledDoc;
  assert.equal(d.history.labels.length, steps + 1, 'only Hide All Effects added a step');
});

test('dragging effects moves them, Alt copies them', async () => {
  await styledDoc();
  await call('setLayerStyle', 2, { ...emptyStyle(), strokes: [blueStroke(2)] }, defaultBlending(), 1, null);
  const c = await call('dragLayerStyle', 2, 1, true);
  assert.equal((c.result as StyledDoc).undoLabel, 'Copy Layer Style');
  assert.ok(layer(c.result, 1).style && layer(c.result, 2).style);
  await call('clearLayerStyle', [1]);
  const m = await call('dragLayerStyle', 2, 1, false);
  assert.equal((m.result as StyledDoc).undoLabel, 'Move Layer Style');
  assert.ok(layer(m.result, 1).style);
  assert.equal(layer(m.result, 2).style, null);
});

// ---------- smart objects (docs/M3.md section 6) ----------

// Any image file decodes to this 4 x 2 image: red top row, blue bottom row (Node has no image decoder).
const PLACED = new Uint8ClampedArray([...Array(4).fill([255, 0, 0, 255]).flat(), ...Array(4).fill([0, 0, 255, 255]).flat()]);
Object.assign(globalThis, {
  createImageBitmap: async () => ({ width: 4, height: 2, close() {} }),
  OffscreenCanvas: class {
    getContext() { return { drawImage() {}, getImageData: () => ({ data: PLACED }) }; }
  },
});
type SmartDoc = { layers: { id: number; name: string; kind: string; smart?: { link: { type: string; id?: string }; source: { blob: number | null }; source_size: number[]; transform: number[]; warp?: unknown } }[]; undoLabel: string; created: number; history: { labels: string[] }; parents: string[] };
const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'photo.png');
const pixelAt = async (x: number, y: number, id: number | null = null) => (await call('sample', x, y, 1, id)).result as number[];

test('Place Embedded of a PNG makes one centred smart layer in one undo step', async () => {
  await call('init');
  await call('newDoc', 10, 10, 8, [255, 255, 255, 255]);
  const r = (await call('placeSmart', 1, png(), false)).result as SmartDoc;
  assert.equal(r.undoLabel, 'Place Embedded');
  const n = r.layers.find(l => l.id === r.created)!;
  assert.equal(n.kind, 'smart');
  assert.equal(n.name, 'photo');
  assert.deepEqual(n.smart!.source_size, [4, 2]);
  assert.deepEqual(n.smart!.transform, [1, 0, 3, 0, 1, 4, 0, 0, 1]);
  assert.equal(n.smart!.link.type, 'embedded');
  assert.deepEqual(await pixelAt(3, 4), [255, 0, 0, 255]);
  assert.deepEqual(await pixelAt(6, 5), [0, 0, 255, 255]);
  assert.deepEqual(await pixelAt(2, 4), [255, 255, 255, 255]);
  const ex = (await call('exportContents', r.created)).result as { name: string; blob: Blob };
  assert.equal(ex.name, 'photo.png');
  assert.deepEqual(new Uint8Array(await ex.blob.arrayBuffer()), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), 'the placed bytes, unmodified');
  const u = (await call('undo')).result as SmartDoc;
  assert.equal(u.layers.length, 1);
});

test('a placement larger than the canvas fits down, never up', async () => {
  await call('init');
  await call('newDoc', 2, 2, 8, null);
  const r = (await call('placeSmart', 1, png(), false)).result as SmartDoc;
  assert.deepEqual(r.layers.find(l => l.id === r.created)!.smart!.transform, [0.5, 0, 0, 0, 0.5, 1, 0, 0, 1], "a half-pixel centre offset rounds");
  const l = await call('placeSmart', 1, png(), true, null);
  assert.match(l.error!, /file picker/);
});

test('Convert to Smart Object, Edit Contents, change, close writes back to the parent', async () => {
  await call('init');
  await call('newDoc', 8, 8, 8, [255, 255, 255, 255]);
  const a = (await call('addLayer', 1)).result as SmartDoc;
  await call('select', { kind: 'rect', x: 2, y: 2, w: 3, h: 2 }, 'new', false, 0, 'Rectangular Marquee');
  await call('command', 'fill', a.created, 'pixels', [0, 128, 0, 255]);
  await call('selectCommand', 'deselect');
  const c = (await call('convertToSmart', [a.created])).result as SmartDoc;
  assert.equal(c.undoLabel, 'Convert to Smart Object');
  const s = c.layers.find(l => l.id === c.created)!;
  assert.equal(s.name, 'Layer 1');
  assert.deepEqual(s.smart!.source_size, [3, 2]);
  assert.notEqual(s.smart!.source.blob, null, 'the source bytes are a PSB');
  const copy = (await call('duplicateNode', c.created)).result as SmartDoc;
  const opened = (await call('editContents', c.created)).result as SmartDoc;
  assert.deepEqual(opened.parents, ['Untitled']);
  assert.deepEqual(await pixelAt(0, 0), [0, 128, 0, 255]);
  await call('command', 'fill', opened.layers[0].id, 'pixels', [200, 0, 0, 255]);
  const back = (await call('smartEditClose')).result as SmartDoc;
  assert.deepEqual(back.parents, []);
  assert.equal(back.undoLabel, 'Update Smart Object Contents');
  assert.deepEqual(await pixelAt(3, 3), [200, 0, 0, 255], 'the parent shows the edited contents');
  assert.deepEqual(await pixelAt(3, 3, copy.created), [200, 0, 0, 255], 'a layer sharing the source updates too');
  await call('undo');
  assert.deepEqual(await pixelAt(3, 3), [0, 128, 0, 255], 'the parent history kept its steps');
});

test('a command stamped with the parent document is refused once Edit Contents replaced it', async () => {
  await call('init');
  await call('newDoc', 8, 8, 8, [255, 255, 255, 255]);
  const a = (await call('addLayer', 1)).result as SmartDoc;
  await call('command', 'fill', a.created, 'pixels', [0, 128, 0, 255]);
  const c = (await call('convertToSmart', [a.created])).result as SmartDoc & { docId: number };
  const opening = call('editContents', c.created);
  const late = callAt(c.docId, 'command', 'fill', 1, 'pixels', [255, 0, 0, 255]);
  const opened = (await opening).result as SmartDoc & { docId: number };
  assert.match((await late).error ?? '', /document changed/);
  assert.deepEqual(await pixelAt(0, 0), [0, 128, 0, 255], 'the nested document is untouched');
  const ok = await callAt(opened.docId, 'command', 'fill', opened.layers[0].id, 'pixels', [255, 0, 0, 255]);
  assert.equal(ok.error, undefined);
  await call('smartEditClose', 'discard');
});

test('font calls are app scope and are not refused after the document changes', async () => {
  await call('init');
  const old = (await call('newDoc', 8, 8, 8, [255, 255, 255, 255])).result as { docId: number };
  await call('newDoc', 8, 8, 8, [255, 255, 255, 255]);
  const bytes = readFileSync(new URL('../public/fonts/NotoSans-Bold.ttf', import.meta.url));
  const added = await callAt(old.docId, 'fontAdd', bytes, 'bundled');
  assert.equal(added.error, undefined);
  assert.deepEqual((added.result as { family: string; style: string }[]).map(f => [f.family, f.style]), [['Noto Sans', 'Bold']]);
  const fam = await callAt(old.docId, 'fontFamilies');
  assert.ok((fam.result as string[]).includes('Noto Sans'));
  assert.deepEqual((await call('fontMissing', [['Noto Sans', 'Regular'], ['Helvetica', 'Bold']])).result, [['Helvetica', 'Bold']]);
  const up = await call('fontUpload', 'x.txt', new Uint8Array([1, 2, 3]));
  assert.match(up.error ?? '', /not a supported font/);
  const big = await call('fontUpload', 'huge.ttf', new Uint8Array((64 << 20) + 1));
  assert.match(big.error ?? '', /64 MB/, 'refused before the bytes reach the engine');
  assert.match((await callAt(old.docId, 'command', 'fill', 1, 'pixels', [0, 0, 0, 255])).error ?? '', /document changed/);
});

test('Edit Contents save returns export warnings and writes back only when accepted; close can discard', async () => {
  const src = new Engine(4, 4, 8);
  src.set_tile_rgba8(1, 0, 0, new Uint8Array(256 * 256 * 4).fill(200));
  const pat = src.blob_add(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]));
  src.set_document_m3(JSON.stringify({ patterns: [{ id: 'pat-1', name: 'P', width: 2, height: 2, blob: Number(pat) }] }));
  const psb = exportPsd(src, { psb: true }).bytes;
  src.free();
  await call('init');
  await call('newDoc', 8, 8, 8, null);
  const p = (await call('placeSmart', 1, new File([psb], 'src.psb'), false)).result as SmartDoc;
  const opened = (await call('editContents', p.created)).result as SmartDoc & { warnings: string[] };
  assert.deepEqual(opened.warnings, []);
  const overlay = defaultEffect('pattern_overlays', 'pat-1');
  await call('setLayerStyle', opened.layers[0].id, { ...emptyStyle(), pattern_overlays: [overlay, overlay] }, defaultBlending(), 1, null);
  const warn = 'only the first pattern overlay is stored in PSD';
  const asked = (await call('smartEditSave')).result as SmartDoc & { warnings: string[]; written: boolean };
  assert.deepEqual([asked.written, asked.warnings.includes(warn)], [false, true]);
  const closing = (await call('smartEditClose')).result as SmartDoc & { warnings: string[]; closed: boolean };
  assert.deepEqual([closing.closed, closing.warnings.includes(warn), closing.parents], [false, true, ['Untitled']]);
  const saved = (await call('smartEditSave', true)).result as SmartDoc & { written: boolean };
  assert.equal(saved.written, true);
  await call('command', 'fill', opened.layers[0].id, 'pixels', [0, 0, 255, 255]);
  const back = (await call('smartEditClose', 'discard')).result as SmartDoc & { closed: boolean };
  assert.deepEqual([back.closed, back.parents, back.undoLabel], [true, [], 'Update Smart Object Contents']);
});

test('two layers convert to a smart object named Group', async () => {
  await call('init');
  await call('newDoc', 8, 8, 8, null);
  const a = (await call('addLayer', 1)).result as SmartDoc;
  const c = (await call('convertToSmart', [1, a.created])).result as SmartDoc;
  assert.equal(c.layers.length, 1);
  assert.equal(c.layers[0].name, 'Group');
});

test('via copy, rasterize, stack mode and relink refusals', async () => {
  await call('init');
  await call('newDoc', 10, 10, 8, null);
  const p = (await call('placeSmart', 1, png(), false)).result as SmartDoc;
  const v = (await call('smartViaCopy', p.created)).result as SmartDoc;
  assert.equal(v.undoLabel, 'New Smart Object via Copy');
  const [x, y] = [p.created, v.created].map(id => v.layers.find(l => l.id === id)!.smart!.link.id);
  assert.notEqual(x, y);
  const m = (await call('setStackMode', p.created, 'median')).result as SmartDoc;
  assert.equal(m.undoLabel, 'Stack Mode');
  const r = (await call('rasterizeSmart', v.created, 'Rasterize')).result as SmartDoc;
  assert.equal(r.layers.find(l => l.id === v.created)!.kind, 'pixel');
  assert.match((await call('convertToEmbedded', p.created)).error!, /already embedded/);
  assert.match((await call('updateModified', null)).error!, /no linked smart objects/);
  assert.match((await call('editContents', 1)).error!, /smart object/);
});

test('a placed smart object survives a project save and open with its source', async () => {
  await call('init');
  await call('newDoc', 10, 10, 8, null);
  const p = (await call('placeSmart', 1, png(), false)).result as SmartDoc;
  const blob = (await call('saveProject')).result as Blob;
  const o = (await call('openFile', new File([blob], 'x.pbaer'))).result as SmartDoc;
  const n = o.layers.find(l => l.id === p.created)!;
  assert.equal(n.kind, 'smart');
  const t = await call('transformAgain', p.created, [2, 0, 0, 0, 2, 0, 0, 0, 1], 'bicubic');
  assert.equal(t.error, undefined, 'a reopened smart object re-renders from its source');
  const ex = (await call('exportContents', p.created)).result as { blob: Blob };
  assert.equal((await ex.blob.arrayBuffer()).byteLength, 7);
});

test('a warp on a smart object starts from its current look and commits one Warp step', async () => {
  await call('init');
  await call('newDoc', 10, 10, 8, null);
  const p = (await call('placeSmart', 1, png(), false)).result as SmartDoc;
  const b = (await call('transformBegin', p.created, 'layer', 'Warp', 2048, true)).result as { bounds: number[]; mesh: { points: [number, number][]; cols: number } };
  assert.deepEqual(b.bounds, [3, 4, 4, 2]);
  assert.equal(b.mesh.cols, 1);
  assert.deepEqual(b.mesh.points[0], [3, 4]);
  assert.deepEqual(b.mesh.points[15], [7, 6]);
  const moved = { ...b.mesh, points: b.mesh.points.map(([x, y]) => [x + 2, y] as [number, number]), columnStops: [0, 1], rowStops: [0, 1], rows: 1 };
  const c = (await call('transformCommit', JSON.stringify(moved))).result as SmartDoc;
  assert.equal(c.undoLabel, 'Warp');
  assert.ok(c.layers.find(l => l.id === p.created)!.smart!.warp, 'the mesh is stored on the smart object');
  assert.deepEqual(await pixelAt(5, 4), [255, 0, 0, 255]);
  assert.deepEqual(await pixelAt(3, 4), [0, 0, 0, 0]);
});

// ---------- smart filters (docs/M3.md section 7) ----------

type FilterDoc = { undoLabel: string; layers: { id: number; kind: string; smart?: { source: { blob: number | null }; filters: { id: number; filter: { kind: string }; enabled: boolean; opacity: number; blend: string }[] } }[] };
const filtersOf = (d: FilterDoc, id: number) => d.layers.find(l => l.id === id)!.smart!.filters;

test('Convert for Smart Filters keeps the layer id and refuses a smart object', async () => {
  await call('init');
  await call('newDoc', 8, 8, 8, null);
  await call('command', 'fill', 1, 'pixels', [200, 200, 200, 255]);
  const c = (await call('convertForSmartFilters', 1)).result as FilterDoc;
  assert.equal(c.undoLabel, 'Convert for Smart Filters');
  const n = c.layers[0];
  assert.equal(n.id, 1);
  assert.equal(n.kind, 'smart');
  assert.notEqual(n.smart!.source.blob, null, 'the source bytes are a PSB');
  assert.match((await call('convertForSmartFilters', 1)).error!, /already a smart object/);
});

test('hosted commands on a smart object add filters; the Smart Filter ops undo under their labels', async () => {
  await call('init');
  await call('newDoc', 8, 8, 8, null);
  await call('command', 'fill', 1, 'pixels', [200, 200, 200, 255]);
  await call('convertForSmartFilters', 1);
  const a = (await call('adjust', 1, { kind: 'invert', params: {} }, 'Invert')).result as FilterDoc;
  assert.equal(a.undoLabel, 'Invert');
  assert.deepEqual(filtersOf(a, 1).map(f => f.filter.kind), ['invert']);
  assert.deepEqual(await pixelAt(3, 3), [55, 55, 55, 255]);
  const i = (await call('command', 'invert', 1, 'pixels')).result as FilterDoc;
  assert.equal(filtersOf(i, 1).length, 2, 'Ctrl+I appends a filter too');
  assert.deepEqual(await pixelAt(3, 3), [200, 200, 200, 255]);
  const b = (await call('addSmartFilter', 1, { kind: 'gaussian_blur', params: { radius: 2 } }, 'Gaussian Blur')).result as FilterDoc;
  assert.equal(b.undoLabel, 'Gaussian Blur');
  const fid = filtersOf(b, 1)[0].id;
  const o = (await call('setSmartFilter', 1, fid, { opacity: 0.5 }, 'Smart Filter')).result as FilterDoc;
  assert.equal(o.undoLabel, 'Smart Filter');
  assert.equal(filtersOf(o, 1)[0].opacity, 0.5);
  const t = (await call('smartFilterCommand', 1, 'toggle', 'Disable Smart Filters')).result as FilterDoc;
  assert.equal(t.undoLabel, 'Disable Smart Filters');
  assert.ok(filtersOf(t, 1).every(f => !f.enabled));
  assert.deepEqual(await pixelAt(3, 3), [200, 200, 200, 255]);
  assert.match((await call('smartFilterCommand', 1, 'deleteMasks', 'Delete Filter Mask')).error!, /no filter mask/);
  const c = (await call('smartFilterCommand', 1, 'clear', 'Clear Smart Filters')).result as FilterDoc;
  assert.deepEqual(filtersOf(c, 1), []);
  await call('undo');
  const u = (await call('undo')).result as FilterDoc;
  assert.ok(filtersOf(u, 1).every(f => f.enabled), 'undo restores the enabled stack');
});

test('a preset pattern copies into the document once and a pattern fill renders it', async () => {
  await call('init');
  await call('newDoc', 4, 4, 8, [128, 128, 128, 255]);
  const preset = { id: 'builtin.pattern.check', name: 'Check', width: 2, height: 2, channels: 1, data: Uint8Array.from([0, 255, 255, 0]) };
  const a = (await call('addDocumentPattern', preset)).result as { patterns: { id: string; name: string }[] };
  assert.deepEqual(a.patterns, [{ id: preset.id, name: 'Check' }]);
  const b = (await call('addDocumentPattern', preset)).result as { patterns: { id: string; name: string }[] };
  assert.deepEqual(b.patterns, a.patterns, 'a second pick reuses the id');
  const px = (await call('patternPixels', preset.id)).result as { width: number; height: number; data: ArrayBuffer };
  assert.deepEqual([px.width, px.height, ...new Uint8Array(px.data).slice(0, 8)], [2, 2, 0, 0, 0, 255, 255, 255, 255, 255]);
  const content = { type: 'pattern', pattern_id: preset.id, scale: 1, angle: 0, linked: true, offset: [0, 0] };
  const r = (await call('newFillLayer', 1, content, 'Pattern Fill', 'Pattern Fill')).result as { patterns: unknown[] };
  assert.equal(r.patterns.length, 1);
  assert.deepEqual([await pixelAt(0, 0), await pixelAt(1, 0)], [[0, 0, 0, 255], [255, 255, 255, 255]]);
  await call('undo');
  await call('undo');
  const again = (await call('newFillLayer', 1, content, 'Pattern Fill', 'Pattern Fill'));
  assert.equal(again.error, undefined, 'an undo that dropped the copy re-adds it on use');
  assert.match((await call('addDocumentPattern', { ...preset, data: new Uint8Array(3) })).error!, /pattern/);
});

test('a preset picked during a Layer Style preview survives the preview reruns and the commit', async () => {
  await call('init');
  await call('newDoc', 4, 4, 8, [128, 128, 128, 255]);
  const preset = { id: 'builtin.pattern.dot', name: 'Dot', width: 1, height: 1, channels: 4, data: Uint8Array.from([9, 8, 7, 255]) };
  await call('setLayerStyle', 1, emptyStyle(), defaultBlending(), 1, null, true);
  await call('addDocumentPattern', preset);
  const overlay = { ...defaultEffect('pattern_overlays', preset.id), present: true, enabled: true };
  const p = await call('setLayerStyle', 1, { ...emptyStyle(), pattern_overlays: [overlay] }, defaultBlending(), 1, null, true);
  assert.equal(p.error, undefined);
  const done = (await call('previewEnd', true)).result as { undoLabel: string; patterns: { id: string }[] };
  assert.deepEqual([done.undoLabel, done.patterns.map(x => x.id)], ['Layer Style', [preset.id]]);
  assert.deepEqual(await pixelAt(1, 1), [9, 8, 7, 255]);
});

test('Paths panel ops: Save Path names Path 1 then Path 2, vectorMask edits only the mask, undo labels', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  const sq = (a: number, b: number) => ({
    fill_rule: 'nonzero', subpaths: [{ closed: true, op: 'combine', points: [[a, a], [b, a], [b, b], [a, b]].map(([x, y]) => [x, y, x, y, x, y]) }],
  });
  type Info = { paths: { id: number; name: string; work: boolean }[]; history: { labels: string[] }; layers: any[]; created?: number };
  const names = (r: { result?: unknown }) => (r.result as Info).paths.map(p => [p.name, p.work]);
  const work = (await call('setPath', 'document', 0, sq(1, 5), 'Make Work Path')).result as Info & { edited: number };
  await call('savePath', work.edited);
  const w2 = (await call('setPath', 'document', 0, sq(2, 6), 'Make Work Path')).result as Info & { edited: number };
  const saved = await call('savePath', w2.edited);
  assert.deepEqual(names(saved), [['Path 1', false], ['Path 2', false]]);

  const shape = (await call('convertPathToShape', 'document', w2.edited, [255, 0, 0])).result as Info;
  const sid = shape.created!;
  assert.equal(shape.layers.at(-1).name, 'Shape');
  assert.deepEqual(shape.layers.at(-1).shape.fill, { type: 'solid', color: [255, 0, 0] });
  const vm = { path: sq(0, 4), enabled: true, linked: true, inverted: false, density: 1, feather: 0 };
  const e = await call('setVectorMask', sid, vm);
  assert.equal(e.error, undefined, String(e.error));
  const r = (await call('setPath', 'vectorMask', sid, sq(3, 7), 'Edit Path')).result as Info;
  const n = r.layers.find(l => l.id === sid);
  assert.deepEqual(n.shape.path, sq(2, 6));
  assert.deepEqual(n.vector_mask.path, sq(3, 7));

  const sel = await call('makeSelectionFromPath', 'document', work.edited, 'new');
  assert.ok((sel.result as { selection: unknown }).selection);
  const labels = (await call('makeWorkPath')).result as Info;
  assert.deepEqual(labels.history.labels.slice(-6), ['Save Path', 'Convert Path to Shape', 'Vector Mask', 'Edit Path', 'Make Selection from Path', 'Make Work Path from Selection']);
});

test('artboards: first at (0,0) with the document size, moving one moves its layers and guides', async () => {
  await call('init');
  await call('newDoc', 64, 40, 8, null);
  type Info = { layers: any[]; guides: { id: number; pos: number }[]; width: number; created: number; history: { labels: string[] } };
  const a = (await call('newArtboard', 'Artboard 1', 64, 40, { type: 'white' })).result as Info;
  const ab = a.layers.find(l => l.id === a.created);
  assert.deepEqual(ab.artboard.rect, [0, 0, 64, 40]);
  await call('select', { kind: 'rect', x: 4, y: 4, w: 8, h: 8 }, 'new', true, 0, 'Rectangular Marquee');
  await call('fillEx', 1, 'pixels', { source: 'solid', rgba: [255, 0, 0, 255], mode: 'normal', opacity: 1, preserveTransparency: false }, 'Fill');
  await call('moveNode', 1, a.created, 0);
  const g = (await call('addGuide', 'x', 20, a.created)).result as Info & { created: number };
  await call('moveLayerBegin', a.created, false, 'Move');
  await call('moveLayerStep', 10, 0);
  const m = (await call('moveLayerCommit')).result as Info;
  assert.deepEqual(m.layers.find(l => l.id === a.created).artboard.rect, [10, 0, 74, 40]);
  assert.equal(m.guides.find(x => x.id === g.created)!.pos, 30);
  assert.deepEqual((await call('movingBounds', 1)).result, [14, 4, 8, 8]);
  assert.equal(m.width, 74, 'the canvas grows to cover the artboard');
  const second = (await call('newArtboard', 'Artboard 2', 20, 20, { type: 'white' })).result as Info;
  assert.equal(second.layers.find(l => l.id === second.created).artboard.rect[0], 174);
});

test('shape tools: Shape Layer, live edits, transforms keep or drop live, Shape Path and Fill Shape', async () => {
  await call('init');
  await call('newDoc', 200, 120, 8, null);
  type Info = { layers: any[]; paths: { work: boolean; path: { subpaths: { points: number[][] }[] } }[]; history: { labels: string[] }; created: number };
  const live = { type: 'rectangle', bounds: [10, 10, 110, 70], radii: [0, 0, 0, 0] };
  const fill = { type: 'solid', color: [255, 0, 0] };
  const a = (await call('newShape', { name: 'Rectangle', live, fill, stroke: null })).result as Info;
  const s = a.layers.at(-1);
  assert.equal(s.name, 'Rectangle');
  assert.deepEqual(s.shape.live, live);
  const radii = { ...live, radii: [20, 20, 20, 20] };
  const b = (await call('setShapes', [{ id: a.created, shape: { live: radii, fill, stroke: null } }], 'Corner Radius')).result as Info;
  assert.equal(b.layers.at(-1).shape.path.subpaths[0].points.length, 8);
  await call('transformBegin', a.created, 'layer', 'Free Transform');
  const c = (await call('transformCommit', [2, 0, -10, 0, 2, -10, 0, 0, 1])).result as Info;
  assert.deepEqual(c.layers.at(-1).shape.live.bounds, [10, 10, 210, 130], 'scale 200 % keeps live');
  const k = Math.cos(Math.PI / 18), n = Math.sin(Math.PI / 18);
  await call('transformBegin', a.created, 'layer', 'Free Transform');
  const d = (await call('transformCommit', [k, -n, 0, n, k, 0, 0, 0, 1])).result as Info;
  assert.equal(d.layers.at(-1).shape.live, null, 'rotate 10 degrees drops live');
  const p = (await call('shapePath', { type: 'ellipse', bounds: [0, 0, 20, 10] })).result as Info;
  assert.equal(p.paths.find(x => x.work)!.path.subpaths[0].points.length, 4);
  const h = (await call('fillShape', 1, { live: { type: 'rectangle', bounds: [150, 80, 160, 90], radii: [0, 0, 0, 0] }, fill: [0, 0, 255, 255], stroke: null })).result as Info;
  assert.deepEqual((await call('sample', 155, 85, 1, 1)).result, [0, 0, 255, 255]);
  assert.deepEqual(h.history.labels.slice(-6), ['Shape Layer', 'Corner Radius', 'Free Transform', 'Free Transform', 'Shape Path', 'Fill Shape']);
});

test('Combine Shapes, Pathfinder and Merge Shape Components are one undo step each', async () => {
  await call('init');
  await call('newDoc', 40, 20, 8, null);
  type Info = { layers: any[]; history: { labels: string[] }; created: number };
  const sq = (x: number) => ({ fill_rule: 'nonzero', subpaths: [{ closed: true, op: 'combine', points: [[x, 0, x, 0, x, 0], [x + 10, 0, x + 10, 0, x + 10, 0], [x + 10, 10, x + 10, 10, x + 10, 10], [x, 10, x, 10, x, 10]] }] });
  const red = { type: 'solid', color: [255, 0, 0] }, blue = { type: 'solid', color: [0, 0, 255] };
  const a = ((await call('newShape', { name: 'A', live: { type: 'rectangle', bounds: [0, 0, 10, 10], radii: [0, 0, 0, 0] }, fill: red, stroke: null })).result as Info).created;
  const b = ((await call('newShape', { name: 'B', path: sq(5), fill: blue, stroke: null })).result as Info).created;
  const u = (await call('combineShapes', [b, a], 'unite')).result as Info;
  assert.equal(u.created, a);
  assert.deepEqual(u.layers.map(l => l.name), ['Background', 'A']);
  assert.equal(u.layers[1].shape.live, null);
  assert.deepEqual(u.layers[1].shape.fill, red, 'the bottom layer keeps its fill');
  assert.equal(u.history.labels.at(-1), 'Unite Shapes');
  const undone = (await call('undo')).result as Info;
  assert.deepEqual(undone.layers.map(l => l.name), ['Background', 'A', 'B']);
  assert.match((await call('combineShapes', [a], 'unite')).error!, /two or more shape layers/);
  const two = { fill_rule: 'nonzero', subpaths: [...sq(0).subpaths, ...sq(5).subpaths] };
  const c = ((await call('newShape', { name: 'C', path: two, fill: red, stroke: null })).result as Info).created;
  const p = (await call('pathfinder', c, 'exclude')).result as Info;
  assert.equal(p.history.labels.at(-1), 'Exclude Overlapping Shapes');
  assert.equal(p.layers.at(-1).shape.path.subpaths.length, 2);
  const m = (await call('mergeShapeComponents', [c])).result as Info;
  assert.equal(m.history.labels.at(-1), 'Merge Shape Components');
});

test('vector mask edits, Rasterize Shape / Vector Mask, and Paste Shape Attributes on two layers', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  type Info = { layers: any[]; history: { labels: string[] }; created: number };
  const fill = { type: 'solid', color: [255, 0, 0] };
  const a = ((await call('newShape', { name: 'A', live: { type: 'ellipse', bounds: [4, 4, 40, 40] }, fill, stroke: null })).result as Info).created;
  const b = ((await call('newShape', { name: 'B', live: { type: 'ellipse', bounds: [20, 20, 60, 60] }, fill, stroke: null })).result as Info).created;
  const doc = [[0, 0, 0, 0, 0, 0], [64, 0, 64, 0, 64, 0], [64, 64, 64, 64, 64, 64], [0, 64, 0, 64, 0, 64]];
  const mask = { path: { fill_rule: 'nonzero', subpaths: [{ closed: true, op: 'combine', points: doc }] }, enabled: true, linked: true, inverted: true, density: 1, feather: 0 };
  const h = (await call('vectorMaskEdit', [{ id: a, mask }, { id: b, mask }], 'Hide All')).result as Info;
  assert.equal(h.history.labels.at(-1), 'Hide All', 'one step over both layers');
  assert.deepEqual(h.layers.find(l => l.id === b).vector_mask, mask);
  const r = (await call('rasterizeLayers', 'vectorMask', [a])).result as Info;
  assert.equal(r.history.labels.at(-1), 'Rasterize Vector Mask');
  const ra = r.layers.find(l => l.id === a);
  assert.equal(ra.vector_mask, null);
  assert.ok(ra.mask);
  const s = (await call('rasterizeLayers', 'shape', [a])).result as Info;
  assert.equal(s.layers.find(l => l.id === a).kind, 'pixel');
  assert.equal(s.history.labels.at(-1), 'Rasterize Shape');
  assert.match((await call('rasterizeLayers', 'shape', [a])).error!, /is not a shape layer/);
  const stroke = { enabled: true, width: 3, align: 'center', cap: 'butt', join: 'miter', miter_limit: 4, dash: [], dash_offset: 0, content: { type: 'solid', color: [0, 0, 255] }, opacity: 1, blend: 'normal' };
  const c = ((await call('newShape', { name: 'C', live: { type: 'ellipse', bounds: [1, 1, 9, 9] }, fill, stroke: null })).result as Info).created;
  const p = (await call('setShapes', [b, c].map(id => ({ id, shape: { live: s.layers.find(l => l.id === id)?.shape?.live ?? { type: 'ellipse', bounds: [1, 1, 9, 9] }, fill, stroke } })), 'Paste Shape Attributes')).result as Info;
  assert.deepEqual([b, c].map(id => p.layers.find(l => l.id === id).shape.stroke.width), [3, 3]);
  assert.equal(p.history.labels.at(-1), 'Paste Shape Attributes');
});

test('layerCode writes a plain shape layer as SVG and CSS', async () => {
  await call('init');
  await call('newDoc', 200, 120, 8, null);
  type Info = { created: number };
  const id = ((await call('newShape', { name: 'R', live: { type: 'rectangle', bounds: [10, 10, 110, 70], radii: [0, 0, 0, 0] }, fill: { type: 'solid', color: [255, 0, 0] }, stroke: null })).result as Info).created;
  const svg = (await call('layerCode', id, 'svg')).result as { text: string; rasterFallback: boolean };
  assert.equal(svg.rasterFallback, false);
  assert.match(svg.text, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="100" height="60" viewBox="10 10 100 60"><path d="M 10 10 C /);
  assert.match(svg.text, / fill="rgb\(255, 0, 0\)" /);
  const css = (await call('layerCode', id, 'css')).result as { text: string };
  assert.match(css.text, /^\.photobaer-layer \{\n {2}position: absolute;\n {2}left: 10px;\n {2}top: 10px;\n {2}width: 100px;\n {2}height: 60px;\n/);
});

test('a type edit session: New Type Layer, one Edit Type Layer on commit, empty commit and cancel remove the layer', async () => {
  await call('init');
  await call('newDoc', 200, 100, 8, null);
  await call('fontAdd', readFileSync(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)), 'bundled');
  const { newText } = await import('./shell/typesession.ts');
  type Info = { history: { labels: string[] }; layers: { id: number; name: string; kind: string; text?: { text: string } }[] };
  type Begun = { id: number; layout: string; doc: Info };
  const opts = { family: 'Noto Sans', style: 'Regular', size: 28, color: [0, 0, 0] as [number, number, number], alignment: 'left' as const, orientation: 'horizontal' as const };
  const t0 = newText(opts, { type: 'point' }, [10, 60]);
  const b = (await call('typeBegin', { text: t0, above: 0 })).result as Begun;
  assert.deepEqual(b.doc.history.labels.slice(-1), ['New Type Layer']);
  assert.equal(JSON.parse(b.layout).lines.length, 1, 'an empty layer has one caret line');
  const t1 = { ...t0, text: 'Hi', runs: [{ ...t0.runs[0], length: 2 }], paragraphs: [{ ...t0.paragraphs[0], length: 2 }] };
  const u = (await call('typeUpdate', t1, 'Hi')).result as { layout: string; doc: Info };
  assert.equal(JSON.parse(u.layout).lines[0].glyphs.length, 2);
  const c = (await call('typeCommit')).result as Info;
  assert.deepEqual(c.history.labels.slice(-2), ['New Type Layer', 'Edit Type Layer']);
  const layer = c.layers.find(l => l.id === b.id)!;
  assert.deepEqual([layer.kind, layer.name, layer.text?.text], ['text', 'Hi', 'Hi']);

  // An unchanged existing layer commits without a step; an empty commit deletes it.
  await call('typeBegin', { id: b.id });
  assert.equal(((await call('typeCommit')).result as Info).history.labels.length, c.history.labels.length);
  await call('typeBegin', { id: b.id });
  await call('typeUpdate', { ...t1, text: 'Ho' }, 'Ho', true);
  await call('typeUpdate', t1, 'Hi', false);
  const back = (await call('typeCommit')).result as Info;
  assert.equal(back.history.labels.length, c.history.labels.length, 'edits undone back to the start record no step');
  assert.equal(back.layers.find(l => l.id === b.id)?.text?.text, 'Hi');
  await call('typeBegin', { id: b.id });
  await call('typeUpdate', t0, '');
  const e = (await call('typeCommit')).result as Info;
  assert.equal(e.layers.some(l => l.id === b.id), false);
  assert.equal(e.history.labels.at(-1), 'Edit Type Layer');

  // Cancel on a new layer removes it with a Cancel Type Edit step.
  const n = (await call('typeBegin', { text: t0, above: 0 })).result as Begun;
  await call('typeUpdate', t1, 'Hi');
  const x = (await call('typeCancel')).result as Info;
  assert.equal(x.layers.some(l => l.id === n.id), false);
  assert.deepEqual(x.history.labels.slice(-2), ['New Type Layer', 'Cancel Type Edit']);

  // Any other op commits an open session first and reports it.
  const m = (await call('typeBegin', { text: t0, above: 0 })).result as Begun;
  await call('typeUpdate', t1, 'Hi');
  const before = events.length;
  const r = (await call('addLayer', 0)).result as Info;
  assert.ok(r.history.labels.includes('Edit Type Layer'));
  assert.ok(r.layers.some(l => l.id === m.id));
  assert.ok(events.slice(before).some(ev => (ev as { event: string }).event === 'typeCommitted'));
});

test('a type mask commit makes the text coverage the selection and removes the temporary layer', async () => {
  await call('init');
  await call('newDoc', 200, 100, 8, null);
  await call('fontAdd', readFileSync(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)), 'bundled');
  const { newText } = await import('./shell/typesession.ts');
  type Info = { history: { labels: string[] }; layers: { id: number }[]; selection: { bounds: number[] | null } | null };
  const opts = { family: 'Noto Sans', style: 'Regular', size: 28, color: [0, 0, 0] as [number, number, number], alignment: 'left' as const, orientation: 'horizontal' as const };
  const t0 = newText(opts, { type: 'point' }, [10, 60]);
  const t1 = { ...t0, text: 'Hi', runs: [{ ...t0.runs[0], length: 2 }], paragraphs: [{ ...t0.paragraphs[0], length: 2 }] };
  const b = (await call('typeBegin', { text: t0, above: 0, mask: true })).result as { id: number; doc: Info };
  assert.equal(b.doc.layers.length, 2, 'the temporary layer exists while typing');
  await call('typeUpdate', t1, 'Hi');
  const c = (await call('typeCommit')).result as Info;
  assert.equal(c.layers.length, 1);
  assert.equal(c.history.labels.at(-1), 'Type Mask');
  const [x, y, w, h] = c.selection!.bounds!;
  assert.ok(x >= 10 && w > 15 && y > 30 && y + h <= 62, `text-sized bounds ${c.selection!.bounds}`);

  // Whitespace-only mask text has no outline: nothing is recorded and the worker stays usable.
  await call('typeBegin', { text: t0, above: 0, mask: true });
  await call('typeUpdate', { ...t0, text: ' ', runs: [{ ...t0.runs[0], length: 1 }], paragraphs: [{ ...t0.paragraphs[0], length: 1 }] }, ' ');
  const ws = await call('addLayer', 0);
  assert.equal(ws.error, undefined);
  assert.equal((ws.result as Info).layers.length, 2, 'the temporary mask layer is gone, one new layer');
  const del = (await call('deleteNode', (ws.result as { created: number }).created)).result as Info;

  // Empty mask text records nothing.
  const n = del.history.labels.length;
  await call('typeBegin', { text: t0, above: 0, mask: true });
  const e = (await call('typeCommit')).result as Info;
  assert.equal(e.history.labels.length, n);
  assert.equal(e.layers.length, 1);
});
