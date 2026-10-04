import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, Engine } from './engine-pkg/photobaer_engine.js';
import { exportPsd } from './psd.ts';
import { Autosave } from './autosave.ts';
import { tileIds } from './project.ts';
import { loadEngine } from './worker/helpers.ts';
import { FakeDir, fs } from './fake-opfs.ts';
import { engineMesh, identityMesh } from './transform/warp.ts';
import { croppedSize } from './crop/geometry.ts';
import { ADJUSTMENT_KINDS, DESTRUCTIVE_KINDS, DESTRUCTIVE_LABEL, MENU_LABEL, defaultAdjustment, defaultDestructive } from './adjustments.ts';
import { defaultBlending, defaultEffect, emptyStyle, type LayerStyle } from './layerStyle.ts';
import type { LayerNode } from './worker/types.ts';

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

// The active document as the next start restores it from the autosave.
async function restored() {
  await new Promise(r => setTimeout(r, 1300));
  const s = (await (await Autosave.fromRoot(root as unknown as FileSystemDirectoryHandle)).load())!;
  const d = s.docs.find(x => x.key === s.active)!;
  const tiles = new Map<number, Uint8Array>();
  for (const id of tileIds(d.manifest)) tiles.set(id, await d.tile(id));
  return { manifest: JSON.parse(d.manifest), tiles, e: loadEngine(d.manifest, id => tiles.get(id)!) };
}

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

type ArrDoc = { layers: { id: number; locks: { transparency: boolean; pixels: boolean; position: boolean }; children?: ArrDoc['layers'] }[]; undoLabel: string | null };
async function fourLayers() {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  const ids = [1];
  for (let i = 0; i < 3; i++) ids.push(((await call('addLayer', ids[i])).result as { created: number }).created);
  return ids; // A,B,C,D bottom to top
}

test('arrangeNodes moves one layer and one history step per command', async () => {
  const [a, b, c, d] = await fourLayers();
  const r = (await call('arrangeNodes', [b], 'forward')).result as ArrDoc;
  assert.deepEqual(r.layers.map(n => n.id), [a, c, b, d]);
  assert.equal(r.undoLabel, 'Bring Forward');
  assert.deepEqual(((await call('undo')).result as ArrDoc).layers.map(n => n.id), [a, b, c, d]);
  assert.deepEqual(((await call('arrangeNodes', [d], 'back')).result as ArrDoc).layers.map(n => n.id), [d, a, b, c]);
  assert.deepEqual(((await call('undo')).result as ArrDoc).layers.map(n => n.id), [a, b, c, d]);
});

test('arrangeNodes at the bounds is a no-op without a history step', async () => {
  const [a, , , d] = await fourLayers();
  for (const [id, mode] of [[d, 'front'], [d, 'forward'], [a, 'back'], [a, 'backward']] as const) {
    const r = (await call('arrangeNodes', [id], mode)).result as ArrDoc;
    assert.equal(r.undoLabel, 'New Layer');
  }
});

test('arrangeNodes moves a selection as a block keeping its order', async () => {
  const [a, b, c, d] = await fourLayers();
  assert.deepEqual(((await call('arrangeNodes', [b, a], 'front')).result as ArrDoc).layers.map(n => n.id), [c, d, a, b]);
  assert.deepEqual(((await call('arrangeNodes', [a, b], 'back')).result as ArrDoc).layers.map(n => n.id), [a, b, c, d]);
  assert.deepEqual(((await call('arrangeNodes', [a, c], 'forward')).result as ArrDoc).layers.map(n => n.id), [b, a, d, c]);
});

const bounds = async (id: number) => (await call('movingBounds', id)).result as number[];
async function alignDoc() {
  await call('init');
  await call('newDoc', 64, 64, 8, [255, 255, 255, 255]);
  const a = await rectLayer(1, 4, 4, 10, 10, [255, 0, 0, 255]);
  const b = await rectLayer(a, 20, 10, 6, 20, [0, 255, 0, 255]);
  const c = await rectLayer(b, 40, 30, 8, 4, [0, 0, 255, 255]);
  return [a, b, c];
}
const origins = async (ids: number[]) => Promise.all(ids.map(async id => (await bounds(id)).slice(0, 2)));

test('alignLayers aligns each edge and center to the union of the layers', async () => {
  const ids = await alignDoc();
  const want: Record<string, number[][]> = {
    'align-top': [[4, 4], [20, 4], [40, 4]], 'align-bottom': [[4, 24], [20, 14], [40, 30]], 'align-vcenter': [[4, 14], [20, 9], [40, 17]],
    'align-left': [[4, 4], [4, 10], [4, 30]], 'align-right': [[38, 4], [42, 10], [40, 30]], 'align-hcenter': [[21, 4], [23, 10], [22, 30]],
  };
  for (const [mode, expected] of Object.entries(want)) {
    await call('alignLayers', ids, mode);
    assert.deepEqual(await origins(ids), expected, mode);
    await call('undo');
  }
});

test('alignLayers is one undo step and a no-op makes none', async () => {
  const ids = await alignDoc();
  const r = (await call('alignLayers', ids, 'align-left')).result as ArrDoc;
  assert.equal(r.undoLabel, 'Align Left Edges');
  assert.deepEqual(await origins(ids), [[4, 4], [4, 10], [4, 30]]);
  const again = (await call('alignLayers', ids, 'align-left')).result as ArrDoc;
  assert.equal(again.undoLabel, 'Align Left Edges');
  const u = (await call('undo')).result as ArrDoc;
  assert.notEqual(u.undoLabel, 'Align Left Edges', 'the repeat moved nothing and added no step');
  assert.deepEqual(await origins(ids), [[4, 4], [20, 10], [40, 30]], 'one undo restores every layer');
});

test('alignLayers aligns to the selection, and a single layer to the canvas', async () => {
  const [a, b, c] = await alignDoc();
  await call('select', { kind: 'rect', x: 10, y: 5, w: 30, h: 30 }, 'new', false, 0, 'Rectangular Marquee');
  await call('alignLayers', [a, b, c], 'align-left');
  assert.deepEqual(await origins([a, b, c]), [[10, 4], [10, 10], [10, 30]]);
  await call('selectCommand', 'deselect');
  await call('alignLayers', [a], 'align-hcenter');
  await call('alignLayers', [a], 'align-bottom');
  assert.deepEqual(await bounds(a), [27, 54, 10, 10]);
});

test('alignLayers moves a group subtree and skips position-locked layers', async () => {
  const [a, b, c] = await alignDoc();
  const g = ((await call('groupNodes', [b])).result as { created: number }).created;
  await call('setLocks', [c], { transparency: false, pixels: false, position: true });
  await call('alignLayers', [a, g, c], 'align-right');
  assert.deepEqual(await origins([a, b, c]), [[16, 4], [20, 10], [40, 30]], 'the group is bounded by its child; the locked layer stays and is not a target');
});

test('distributeLayers spaces the middle layers evenly and keeps the outer two', async () => {
  const [a, b, c] = await alignDoc();
  const want: Record<string, number[][]> = {
    'distribute-left': [[4, 4], [22, 10], [40, 30]], 'distribute-top': [[4, 4], [20, 17], [40, 30]], 'distribute-bottom': [[4, 4], [20, 4], [40, 30]],
    'distribute-right': [[4, 4], [25, 10], [40, 30]], 'distribute-hcenter': [[4, 4], [24, 10], [40, 30]],
  };
  for (const [mode, expected] of Object.entries(want)) {
    const r = (await call('alignLayers', [c, a, b], mode)).result as ArrDoc;
    assert.equal(r.undoLabel?.startsWith('Distribute'), true, mode);
    assert.deepEqual(await origins([a, b, c]), expected, mode);
    await call('undo');
  }
  const before = (await call('alignLayers', [a], 'align-left')).result as ArrDoc;
  assert.equal(((await call('alignLayers', [a, b], 'distribute-left')).result as ArrDoc).undoLabel, before.undoLabel, 'fewer than three layers is a no-op');
});

test('setLocks locks every listed layer in one history step', async () => {
  const [, b, c, d] = await fourLayers();
  const all = { transparency: true, pixels: true, position: true };
  const r = (await call('setLocks', [b, c, d], all)).result as ArrDoc;
  assert.deepEqual(r.layers.filter(n => n.id !== 1).map(n => n.locks), [all, all, all]);
  assert.equal(r.undoLabel, 'Lock All Layers in Group');
  const u = (await call('undo')).result as ArrDoc;
  assert.ok(u.layers.every(n => !n.locks.pixels && !n.locks.position && !n.locks.transparency));
});

type MergeNode = { id: number; name: string; kind: string; visible: boolean; blend: string; opacity: number; children?: MergeNode[] };
type MergeDoc = { layers: MergeNode[]; undoLabel: string | null };
const composite = async () => new Uint8Array(((await call('copy', 1, true, false)).result as { clip: { data: ArrayBuffer } }).clip.data);
const maxDiff = (a: Uint8Array, b: Uint8Array) => { assert.equal(a.length, b.length); return a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0); };
async function rectLayer(above: number, x: number, y: number, w: number, h: number, rgba: number[]) {
  const id = ((await call('addLayer', above)).result as { created: number }).created;
  await call('select', { kind: 'rect', x, y, w, h }, 'new', false, 0, 'Rectangular Marquee');
  await call('command', 'fill', id, 'pixels', rgba);
  await call('selectCommand', 'deselect');
  return id;
}
async function mergeDoc() {
  await call('init');
  await call('newDoc', 64, 64, 8, [255, 255, 255, 255]);
  const a = await rectLayer(1, 4, 4, 30, 30, [255, 0, 0, 255]);
  const b = await rectLayer(a, 20, 20, 30, 30, [0, 0, 255, 255]);
  return [a, b];
}

test('mergeNodes down bakes blend and opacity into the bottom layer, one undo step', async () => {
  const [a, b] = await mergeDoc();
  await call('setProps', b, { blend: 'multiply', opacity: 0.5 });
  const before = await composite();
  const r = (await call('mergeNodes', [b], 'down')).result as MergeDoc;
  assert.deepEqual(r.layers.map(n => n.name), ['Background', 'Layer 1']);
  assert.equal(r.undoLabel, 'Merge Down');
  assert.deepEqual([r.layers[1].kind, r.layers[1].blend, r.layers[1].opacity], ['pixel', 'normal', 1]);
  assert.ok(maxDiff(before, await composite()) <= 1);
  const u = (await call('undo')).result as MergeDoc;
  assert.deepEqual(u.layers.map(n => n.id), [1, a, b]);
  assert.deepEqual([u.layers[2].blend, u.layers[2].opacity], ['multiply', 0.5]);
  assert.equal(((await call('mergeNodes', [1], 'down')).error ?? '').length > 0, true);
});

test('mergeNodes merges selected siblings with a mask and a drop shadow', async () => {
  const [a, b] = await mergeDoc();
  const c = await rectLayer(b, 30, 2, 20, 20, [0, 255, 0, 255]);
  await call('addMask', b, false);
  await call('setLayerStyle', c, { ...emptyStyle(), drop_shadows: [defaultEffect('drop_shadows')] }, defaultBlending(), 1, null);
  const before = await composite();
  const r = (await call('mergeNodes', [a, b, c], 'layers')).result as MergeDoc;
  assert.deepEqual(r.layers.map(n => n.name), ['Background', 'Layer 1']);
  assert.equal(r.undoLabel, 'Merge Layers');
  assert.ok(maxDiff(before, await composite()) <= 1);
});

test('mergeNodes refuses nodes with different parents without a history step', async () => {
  const [a, b] = await mergeDoc();
  await call('groupNodes', [b]);
  const r = await call('mergeNodes', [a, b], 'layers');
  assert.match(r.error ?? '', /same/);
  assert.equal(((await call('setProps', a, { name: 'x' })).result as MergeDoc & { history: { labels: string[] } }).history.labels.includes('Merge Layers'), false);
});

test('mergeNodes visible keeps hidden layers in place, stamp adds a top layer, flatten fills white', async () => {
  const [a, b] = await mergeDoc();
  const c = await rectLayer(b, 0, 0, 10, 10, [0, 255, 0, 255]);
  await call('setProps', 1, { visible: false });
  await call('setProps', c, { visible: false });
  const before = await composite();
  const v = (await call('mergeNodes', [], 'visible')).result as MergeDoc;
  assert.deepEqual(v.layers.map(n => [n.id, n.visible]), [[1, false], [v.layers[1].id, true], [c, false]]);
  assert.equal(v.layers[1].name, 'Layer 1');
  assert.ok(maxDiff(before, await composite()) <= 1);
  await call('undo');
  const s = (await call('mergeNodes', [], 'stamp')).result as MergeDoc;
  assert.deepEqual(s.layers.slice(0, 4).map(n => n.id), [1, a, b, c]);
  assert.equal(s.layers.length, 5);
  assert.equal(s.undoLabel, 'Stamp Visible');
  assert.ok(maxDiff(before, await composite()) <= 1);
  await call('undo');
  const f = (await call('mergeNodes', [], 'flatten')).result as MergeDoc;
  assert.deepEqual(f.layers.map(n => [n.name, n.kind]), [['Background', 'pixel']]);
  assert.equal(f.undoLabel, 'Flatten Image');
  const flat = await composite();
  assert.ok(flat.every((v, i) => i % 4 !== 3 || v === 255));
  assert.deepEqual([...flat.subarray(0, 4)], [255, 255, 255, 255]);
  assert.ok(maxDiff(flat.subarray((25 * 64 + 4) * 4, (25 * 64 + 50) * 4), before.subarray((25 * 64 + 4) * 4, (25 * 64 + 50) * 4)) <= 1);
});

test('mergeNodes down keeps a merged clipped stack clipped', async () => {
  const [a, b] = await mergeDoc();
  const c = await rectLayer(b, 0, 40, 64, 10, [0, 255, 0, 255]);
  await call('setProps', b, { clipping: true });
  await call('setProps', c, { clipping: true });
  const before = await composite();
  const r = (await call('mergeNodes', [c], 'down')).result as MergeDoc;
  assert.deepEqual(r.layers.slice(0, 2).map(n => n.id), [1, a]);
  assert.equal(r.layers.length, 3);
  assert.ok(maxDiff(before, await composite()) <= 1);
});

test('mergeNodes visible, stamp and flatten skip layers clipped to a hidden base', async () => {
  const [a, b] = await mergeDoc();
  await call('setProps', b, { clipping: true });
  await call('setProps', a, { visible: false });
  const before = await composite();
  for (const mode of ['visible', 'stamp']) {
    await call('mergeNodes', [], mode);
    assert.ok(maxDiff(before, await composite()) <= 1, mode);
    await call('undo');
  }
  const f = (await call('mergeNodes', [], 'flatten')).result as MergeDoc;
  assert.deepEqual(f.layers.map(n => n.name), ['Background']);
  assert.ok(maxDiff(before, await composite()) <= 1);
});

test('mergeNodes down on a group merges its subtree into one layer named after the group', async () => {
  const [a, b] = await mergeDoc();
  const c = await rectLayer(b, 30, 2, 20, 20, [0, 255, 0, 255]);
  const g = ((await call('groupNodes', [b, c])).result as { created: number }).created;
  const name = ((await call('setProps', g, { opacity: 0.7 })).result as MergeDoc).layers[2].name;
  const before = await composite();
  const r = (await call('mergeNodes', [g], 'down')).result as MergeDoc;
  assert.deepEqual(r.layers.slice(0, 2).map(n => n.id), [1, a]);
  assert.deepEqual([r.layers[2].name, r.layers[2].kind, r.layers.length], [name, 'pixel', 3]);
  assert.ok(maxDiff(before, await composite()) <= 1);
});

test('mergeNodes flatten with only hidden layers gives a white Background', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, [255, 0, 0, 255]);
  await call('setProps', 1, { visible: false });
  const f = (await call('mergeNodes', [], 'flatten')).result as MergeDoc;
  assert.deepEqual(f.layers.map(n => [n.name, n.visible]), [['Background', true]]);
  assert.ok((await composite()).every(v => v === 255));
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
  assert.equal(JSON.parse(r.docs.find(d => d.key === r.active)!.manifest).width, 512);
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
  assert.ok(JSON.parse(r.docs.find(d => d.key === r.active)!.manifest).layers[0].tiles.length > 0, 'the saved layer keeps its pixels');
});

test('an autosave due during an open filter preview never stores the preview pixels', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, [255, 0, 0, 255]);
  await new Promise(r => setTimeout(r, 1300));
  const tiles = async () => {
    const r = await (await Autosave.fromRoot(root as unknown as FileSystemDirectoryHandle)).load();
    return JSON.stringify(JSON.parse(r!.docs.find(d => d.key === r!.active)!.manifest).layers[0].tiles);
  };
  await call('setProps', 1, { name: 'Renamed' });
  await call('adjust', 1, invertAdj, 'Invert', true);
  await new Promise(r => setTimeout(r, 1300));
  const during = await tiles();
  await call('previewEnd', false);
  await new Promise(r => setTimeout(r, 1300));
  assert.equal(during, await tiles());
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

test('channel ops: new, rename, duplicate, delete and channelMask, one history step each', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  type Ch = { channels: { id: number; name: string }[]; history: { labels: string[] }; created: number };
  const a = (await call('newChannel')).result as Ch;
  assert.deepEqual(a.channels.map(c => c.name), ['Alpha 1']);
  assert.equal(new Uint8Array(((await call('channelMask', a.created, 0)).result as { data: ArrayBuffer }).data)[0], 0);
  await call('select', { kind: 'rect', x: 0, y: 0, w: 32, h: 64 }, 'new', false, 0, 'Rectangular Marquee');
  await call('saveSelection', 'left', null, 'new');
  const left = ((await call('newChannel')).result as Ch).channels.find(c => c.name === 'left')!;
  await call('renameChannel', left.id, 'half');
  const d = (await call('duplicateChannel', left.id)).result as Ch;
  assert.deepEqual(d.channels.map(c => c.name), ['Alpha 1', 'half', 'Alpha 2', 'half copy']);
  const m = (await call('channelMask', d.created, 1)).result as { w: number; h: number; data: ArrayBuffer };
  const px = new Uint8Array(m.data);
  assert.equal(m.w, 32);
  assert.deepEqual([px[0], px[31]], [255, 0]);
  const del = (await call('deleteChannel', a.created)).result as Ch;
  assert.equal(del.channels.length, 3);
  assert.deepEqual(del.history.labels.slice(-4), ['New Channel', 'Rename Channel', 'Duplicate Channel', 'Delete Channel']);
  assert.ok((await call('channelMask', 999, 0)).error);
});

test('setChannelTarget: a fill changes only the targeted color channel, or fills the targeted saved channel', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  await call('command', 'fill', 1, 'pixels', [10, 20, 30, 255]);
  await call('setChannelTarget', [false, true, false], null);
  await call('command', 'fill', 1, 'pixels', [200, 200, 200, 255]);
  assert.deepEqual((await call('sample', 5, 5, 1, null)).result, [10, 200, 30, 255]);
  const ch = ((await call('newChannel')).result as { created: number }).created;
  await call('setChannelTarget', [true, true, true], ch);
  const r = (await call('command', 'fill', 1, 'selection', [255, 255, 255, 255])).result as { history: { labels: string[] } };
  assert.equal(r.history.labels.at(-1), 'Fill');
  assert.equal(new Uint8Array(((await call('channelMask', ch, 0)).result as { data: ArrayBuffer }).data)[0], 255);
  assert.equal(((await call('selectionMask', 0)).result as { data: ArrayBuffer | null }).data, null, 'the selection is untouched');
  assert.deepEqual((await call('sample', 5, 5, 1, null)).result, [10, 200, 30, 255], 'the layer is untouched');
});

test('spot channels: new with no ink, options, duplicate keeps the ink, one step each', async () => {
  await call('init');
  await call('newDoc', 32, 32, 8, null);
  type Ch = { channels: { id: number; name: string; spot: { color: number[]; solidity: number } | null }[]; history: { labels: string[] }; created: number };
  const a = (await call('newSpotChannel', { color: [0, 153, 230], solidity: 0 })).result as Ch;
  assert.deepEqual(a.channels.map(c => [c.name, c.spot]), [['Spot Color 1', { color: [0, 153, 230], solidity: 0 }]]);
  assert.equal(new Uint8Array(((await call('channelMask', a.created, 0)).result as { data: ArrayBuffer }).data)[0], 255, 'no ink');
  await call('spotChannelOptions', a.created, 'Gold', { color: [200, 160, 40], solidity: 0.5 });
  const d = (await call('duplicateChannel', a.created)).result as Ch;
  assert.deepEqual(d.channels.map(c => [c.name, c.spot?.color]), [['Gold', [200, 160, 40]], ['Gold copy', [200, 160, 40]]]);
  assert.deepEqual(d.history.labels.slice(-3), ['New Spot Channel', 'Channel Options', 'Duplicate Channel']);
  assert.ok((await call('spotChannelOptions', a.created, 'x', { color: [0, 0, 0], solidity: 2 })).error);
});

test('layerMask reads the layer mask like channelMask and errors without one', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  assert.ok((await call('layerMask', 1, 0)).error);
  await call('addMask', 1, true);
  await call('select', { kind: 'rect', x: 0, y: 0, w: 32, h: 64 }, 'new', false, 0, 'Rectangular Marquee');
  await call('command', 'fill', 1, 'mask', [0, 0, 0, 255]);
  const m = (await call('layerMask', 1, 0)).result as { w: number; data: ArrayBuffer };
  const px = new Uint8Array(m.data);
  assert.deepEqual([m.w, px[0], px[40]], [64, 0, 255]);
});

const calcOpts = (mode: string) => ({ mode, opacity: 1, scale: 1, offset: 0, mask: null });

test('applyImage previews inside a session and calculations writes a channel or the selection', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  await call('command', 'fill', 1, 'pixels', [200, 50, 10, 255]);
  const src = { layer: null, channel: 'red', invert: true };
  for (let i = 0; i < 2; i++) assert.equal((await call('applyImage', 1, src, { ...calcOpts('normal'), preserve: true }, true)).error, undefined);
  const pe = await call('previewEnd', true);
  assert.equal(pe.error, undefined);
  const done = pe.result as { history: { labels: string[] } };
  assert.equal(done.history.labels.filter(l => l === 'Apply Image').length, 1);
  assert.deepEqual((await call('sample', 5, 5, 1, 1)).result, [55, 55, 55, 255]);
  const c = (await call('calculations', { layer: null, channel: 'red', invert: false }, { layer: null, channel: 'green', invert: false }, calcOpts('multiply'), 'channel')).result as { channels: { name: string }[] };
  assert.deepEqual(c.channels.map(x => x.name), ['Alpha 1']);
  const s = (await call('calculations', { layer: null, channel: 'gray', invert: false }, { layer: null, channel: 'alpha', invert: false }, calcOpts('normal'), 'selection')).result as { channels: unknown[]; selection: unknown };
  assert.equal(s.channels.length, 1);
  assert.ok(s.selection);
  assert.ok((await call('calculations', { layer: null, channel: 'rgb', invert: false }, src, calcOpts('normal'), 'channel')).error);
});

test('Apply Image reads another open document and a mask; Calculations can open a new document', async () => {
  type D = { key: string; docs: { key: string }[]; mode: { kind: string } | null; gray: boolean; history: { labels: string[] } };
  await call('init');
  await closeAll();
  const other = (await call('newDoc', 64, 64, 8, [0, 0, 0, 255])).result as D;
  const small = (await call('newDoc', 32, 32, 8, [0, 0, 0, 255])).result as D;
  const d = (await call('newDoc', 64, 64, 8, [255, 255, 255, 255])).result as D;
  const m = await rectLayer(1, 0, 0, 32, 64, [255, 255, 255, 255]);
  await call('setProps', m, { visible: false });
  const mask = { layer: m, channel: 'gray', invert: false };
  const r = await call('applyImage', 1, { doc: other.key, layer: null, channel: 'rgb', invert: false }, { ...calcOpts('normal'), mask, preserve: true });
  assert.equal(r.error, undefined);
  assert.deepEqual([(await call('sample', 5, 5, 1, 1)).result, (await call('sample', 50, 5, 1, 1)).result], [[0, 0, 0, 255], [255, 255, 255, 255]]);
  assert.equal((await call('applyImage', 1, { doc: small.key, layer: null, channel: 'rgb', invert: false }, { ...calcOpts('normal'), preserve: true })).error, 'The source document must have the same pixel size.');
  assert.equal((await call('applyImage', 1, { doc: 'gone', layer: null, channel: 'rgb', invert: false }, { ...calcOpts('normal'), preserve: true })).error, 'The source document is no longer open.');
  const add = await call('applyImage', 1, { layer: null, channel: 'rgb', invert: false }, { mode: 'add', opacity: 1, scale: 2, offset: 0, mask: null, preserve: true });
  assert.equal(add.error, undefined);
  assert.deepEqual((await call('sample', 50, 5, 1, 1)).result, [255, 255, 255, 255], '(255 + 255) / 2');
  const n = (await call('calculations', { layer: null, channel: 'red', invert: false }, { doc: other.key, layer: null, channel: 'red', invert: true }, calcOpts('multiply'), 'document')).result as D;
  assert.equal(n.docs.length, 4);
  assert.ok(n.gray || n.mode?.kind === 'gray');
  assert.deepEqual((await call('sample', 50, 5, 1, null)).result, [255, 255, 255, 255]);
  assert.deepEqual((await call('sample', 5, 5, 1, null)).result, [0, 0, 0, 255]);
});

test('Auto-Align, Auto-Blend and Photomerge are one step each; Merge to HDR Pro opens a 32-bit tab', async () => {
  type D = { layers: { id: number; mask: unknown }[]; history: { labels: string[] }; depth: number; name: string; docs: unknown[] };
  await call('init');
  await closeAll();
  await call('newDoc', 64, 32, 8, null);
  const a = await rectLayer(1, 0, 0, 40, 32, [255, 0, 0, 255]);
  const b = await rectLayer(a, 24, 0, 40, 32, [0, 0, 255, 255]);
  assert.equal((await call('autoAlign', [a, b], false)).error, 'No layer could be aligned.');
  const blended = (await call('autoBlend', [a, b], false, true)).result as D;
  assert.ok(blended.layers.filter(l => l.id === a || l.id === b).every(l => l.mask));
  assert.equal(blended.history.labels.at(-1), 'Auto-Blend Layers');
  assert.equal((await call('photomerge', false)).error, 'No layer could be aligned.');
  const pm = (await call('photomerge', true)).result as D;
  assert.equal(pm.history.labels.at(-1), 'Photomerge');
  await closeAll();
  assert.match((await call('mergeHdr', 1)).error ?? '', /at least two open documents/);
  await call('newDoc', 300, 8, 8, [64, 64, 64, 255]);
  await call('newDoc', 300, 8, 8, [128, 128, 128, 255]);
  const hdr = (await call('mergeHdr', 1)).result as D;
  assert.equal(hdr.depth, 32);
  assert.equal(hdr.name, 'Untitled HDR');
  assert.equal(hdr.docs.length, 3);
  const [v] = (await call('sample', 290, 4, 1, null)).result as number[];
  assert.ok(Math.abs(v - 64) <= 1, `merged value ${v}`);
});

test('Image > Mode: depth and grayscale conversions are one step each and show in the tab', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  await call('command', 'fill', 1, 'pixels', [200, 50, 10, 255]);
  type I = { depth: number; gray: boolean; history: { labels: string[] }; docs: { active: boolean; mode: string; depth: number }[] };
  const d16 = (await call('convertDepth', 16)).result as I;
  assert.equal(d16.depth, 16);
  const g = (await call('setColorMode', { mode: 'gray' })).result as I;
  assert.equal(g.gray, true);
  assert.deepEqual(g.docs.filter(t => t.active).map(t => [t.mode, t.depth]), [['Gray', 16]]);
  assert.deepEqual((await call('sample', 5, 5, 1, null)).result, [91, 91, 91, 255]);
  const same = (await call('setColorMode', { mode: 'gray' })).result as I;
  assert.deepEqual(same.history.labels.slice(-2), ['16 Bits/Channel', 'Grayscale']);
  const u = (await call('undo')).result as I;
  assert.equal(u.gray, false);
  const d32 = (await call('convertDepth', 32)).result as I;
  assert.deepEqual(d32.docs.filter(t => t.active).map(t => [t.mode, t.depth]), [['RGB', 32]]);
  assert.deepEqual((await call('sample', 5, 5, 1, null)).result, [200, 50, 10, 255]);
  assert.match((await call('setColorMode', { mode: 'cmyk' })).error ?? '', /RGB or Grayscale only/);
});

test('Edit > Assign/Convert to Profile: tag only vs. new numbers, one step each', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  await call('command', 'fill', 1, 'pixels', [200, 50, 10, 255]);
  type I = { profile: { name: string } | null; layers: unknown[]; history: { labels: string[] } };
  const list = (await call('iccProfiles')).result as { name: string; space: string }[];
  assert.ok(list.some(p => p.name === 'Adobe RGB (1998)' && p.space === 'rgb'));
  const a = (await call('assignProfile', 'Adobe RGB (1998)')).result as I;
  assert.equal(a.profile?.name, 'Adobe RGB (1998)');
  assert.deepEqual((await call('sample', 5, 5, 1, null)).result, [200, 50, 10, 255]);
  const same = (await call('assignProfile', 'Adobe RGB (1998)')).result as I;
  assert.equal(same.history.labels.filter(l => l === 'Assign Profile').length, 1);
  await call('addLayer', 1);
  const opts = { intent: 'relativeColorimetric', blackPointCompensation: false, dither: false, flatten: true };
  const c = (await call('convertToProfile', 'sRGB IEC61966-2.1', opts)).result as I;
  assert.equal(c.profile?.name, 'sRGB IEC61966-2.1');
  assert.equal(c.layers.length, 1, 'flattened in the same step');
  assert.deepEqual(c.history.labels.slice(-1), ['Convert to Profile']);
  const px = (await call('sample', 5, 5, 1, null)).result as number[];
  assert.ok(Math.abs(px[0] - 232) <= 1 && Math.abs(px[1] - 46) <= 1 && px[2] <= 1, `got ${px}`);
  const u = (await call('undo')).result as I;
  assert.equal(u.profile?.name, 'Adobe RGB (1998)');
  assert.equal(((await call('assignProfile', null)).result as I).profile, null);
  assert.match((await call('loadProfile', new Uint8Array(8))).error ?? '', /./);
});

test('View > Proof Colors, Gamut Warning and Proof Setup change display tiles only, no history step', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  type I = { version: number; history: { labels: string[] }; view: { proofColors: boolean; gamutWarning: boolean; setup: { id: string } } };
  const before = (await call('command', 'fill', 1, 'pixels', [0, 0, 255, 255])).result as I;
  const tile = async () => new Uint8Array(((await call('displayTile', 0, 0, 0)).result as { data: ArrayBuffer }).data).slice(0, 3);
  assert.deepEqual([...await tile()], [0, 0, 255]);
  const on = (await call('setView', { setup: { id: 'workingCmyk', intent: 'relativeColorimetric', bpc: true, preserveNumbers: false, simulatePaper: false, simulateBlackInk: false }, proofColors: true })).result as I;
  assert.ok(on.version > before.version && on.view.proofColors && on.view.setup.id === 'workingCmyk');
  assert.deepEqual(on.history.labels, before.history.labels, 'no history step');
  const p = await tile();
  assert.ok(p[2] < 230 && p[0] > 20, `printed blue: ${p}`);
  assert.match((await call('displayProgram', 0, 0, 0, new BigUint64Array())).error ?? '', /CPU tiles/);
  await call('setView', { proofColors: false, gamutWarning: true });
  assert.deepEqual([...await tile()], [128, 128, 128], 'out of gamut');
  await call('setView', { gamutWarning: false });
  assert.deepEqual([...await tile()], [0, 0, 255]);
  assert.match((await call('setView', { setup: { id: 'custom', profile: 'No Such Profile', intent: 'relativeColorimetric', bpc: true, preserveNumbers: false, simulatePaper: false, simulateBlackInk: false }, proofColors: true })).error ?? '', /unknown proof profile/);
});

test('Color Settings: new documents get the working RGB, PSD saves embed it, open applies the policy', async () => {
  await call('init');
  const s = { rgb: 'sRGB IEC61966-2.1', gray: 'Dot Gain 20%', rgbPolicy: 'preserveEmbedded', grayPolicy: 'preserveEmbedded', askWhenOpening: false, askWhenMissing: false, intent: 'relativeColorimetric', bpc: false, dither: false };
  await call('setColorSettings', s);
  type I = { profile: { name: string } | null; history: { labels: string[] } };
  const n = (await call('newDoc', 64, 64, 8, [200, 50, 10, 255])).result as I;
  assert.equal(n.profile?.name, 'sRGB IEC61966-2.1');
  assert.deepEqual(n.history.labels.filter(l => l === 'Assign Profile'), [], 'no history step');
  await call('assignProfile', 'Adobe RGB (1998)');
  const file = new File([((await call('savePsd')).result as { blob: Blob }).blob], 'tagged.psd');
  assert.deepEqual((await call('openProfileQuestion', file)).result, { embedded: 'Adobe RGB (1998)', action: 'keep' });
  assert.equal(((await call('openFile', file)).result as I).profile?.name, 'Adobe RGB (1998)');
  await call('setColorSettings', { ...s, askWhenOpening: true });
  assert.deepEqual((await call('openProfileQuestion', file)).result, { embedded: 'Adobe RGB (1998)', action: 'ask' });
  const c = (await call('openFile', file, 'convert')).result as I;
  assert.equal(c.profile?.name, 'sRGB IEC61966-2.1');
  const px = (await call('sample', 5, 5, 1, null)).result as number[];
  assert.ok(Math.abs(px[0] - 232) <= 1 && Math.abs(px[1] - 46) <= 1, `got ${px}`);
  assert.equal(((await call('openFile', file, 'discard')).result as I).profile, null);
  await call('setColorSettings', { ...s, rgbPolicy: 'off' });
  assert.equal(((await call('newDoc', 8, 8, 8, null)).result as I).profile, null);
  // The version bump reaches the app, so keyed reads stay in step with the shown document.
  const shown = (await call('setColorSettings', null)).result as { key: string; version: number };
  const read = (await call('documentSample', shown.key, 1, 1, 1, null)).result as { version: number };
  assert.equal(read.version, shown.version);
});

test('Image > Mode: Indexed Color flattens in one step, Color Table remaps, Duotone needs Grayscale', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  await call('command', 'fill', 1, 'pixels', [200, 50, 10, 255]);
  await call('addLayer', 1);
  type I = { mode: { kind: string; table?: number[][] } | null; layers: unknown[]; history: { labels: string[] }; docs: { active: boolean; mode: string }[] };
  assert.match((await call('setColorMode', { mode: 'duotone', inks: [[0, 0, 0]] })).error ?? '', /Grayscale/);
  const spec = { mode: 'indexed', palette: 'exact', colors: 256, forced: 'none', transparency: false, dither: 'none', amount: 0.75 };
  const ix = (await call('setColorMode', spec)).result as I;
  assert.equal(ix.mode?.kind, 'indexed');
  assert.deepEqual(ix.mode?.table, [[200, 50, 10]]);
  assert.equal(ix.layers.length, 1, 'flattened');
  assert.deepEqual(ix.history.labels.slice(-1), ['Indexed Color']);
  assert.deepEqual(ix.docs.filter(t => t.active).map(t => t.mode), ['Index']);
  const ct = (await call('setColorTable', [[0, 0, 255]])).result as I;
  assert.deepEqual(ct.history.labels.slice(-1), ['Color Table']);
  assert.deepEqual((await call('sample', 5, 5, 1, null)).result, [0, 0, 255, 255]);
  const back = (await call('setColorMode', { mode: 'rgb' })).result as I;
  assert.equal(back.mode, null);
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

test('contentAwareFill fills the selection as one step and reports an empty result', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, [90, 90, 90, 255]);
  const args = (deselect: boolean, label: string) => [1, 4, 5, null, deselect, label];
  await call('select', { kind: 'rect', x: 24, y: 24, w: 16, h: 16 }, 'new', false, 0, 'Rectangular Marquee');
  const before = (await call('fillEx', 1, 'pixels', solid([0, 0, 0, 255]), 'Fill')).result as { selGen: number };
  const r = await call('contentAwareFill', ...args(true, 'Delete and Fill Selection'));
  const d = r.result as { undoLabel: string; selection: unknown; selGen: number };
  assert.equal(d.undoLabel, 'Delete and Fill Selection');
  assert.equal(d.selection, null);
  assert.notEqual(d.selGen, before.selGen, 'the ants redraw after the deselect');
  assert.deepEqual(await px(30, 30), [90, 90, 90, 255]);
  await call('newDoc', 16, 16, 8, [0, 0, 0, 0]);
  await call('select', { kind: 'rect', x: 4, y: 4, w: 8, h: 8 }, 'new', false, 0, 'Rectangular Marquee');
  const none = await call('contentAwareFill', ...args(false, 'Content-Aware Fill'));
  assert.equal(none.error, 'Content-Aware Fill produced no pixels.');
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

test('moveFloat returns the layer image, hides the layer until a step, and a release without a step restores it', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, [255, 0, 0, 255]);
  await call('moveLayerBegin', 1, false, 'Move');
  const f = (await call('moveFloat')).result as { image: { w: number; h: number; f: number }; data: ArrayBuffer };
  assert.deepEqual([f.image.w, f.image.h, f.image.f], [16, 16, 1]);
  assert.deepEqual([...new Uint8Array(f.data).slice(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual((await call('sample', 5, 5, 1, null)).result, [0, 0, 0, 0], 'the composite shows the layer hidden');
  const c = await call('moveLayerCommit');
  assert.equal((c.result as { undoLabel: string | null }).undoLabel, null);
  assert.deepEqual(await px(5, 5), [255, 0, 0, 255]);
});

test('moveFloat on a big layer caps the whole image and adds a sharp image of the view', async () => {
  await call('init');
  await call('newDoc', 4096, 2048, 8, [255, 0, 0, 255]);
  await call('moveLayerBegin', 1, false, 'Move');
  type Img = { image: { x: number; y: number; w: number; h: number; f: number }; data: ArrayBuffer };
  const f = (await call('moveFloat', 1, [1000, 500, 400, 200])).result as Img & { over: Img | null };
  assert.deepEqual([f.image.w, f.image.h, f.image.f], [2048, 1024, 0.5]);
  assert.deepEqual([f.over!.image.x, f.over!.image.y, f.over!.image.w, f.over!.image.h, f.over!.image.f], [800, 400, 800, 400, 1]);
  assert.equal(f.over!.data.byteLength, 800 * 400 * 4);
  await call('moveLayerCancel');
  await call('newDoc', 16, 16, 8, [255, 0, 0, 255]);
  await call('moveLayerBegin', 1, false, 'Move');
  assert.equal(((await call('moveFloat', 1, [0, 0, 16, 16])).result as { over: unknown }).over, null);
  await call('moveLayerCancel');
});

test('a floated move lands with its step as one Move', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, [255, 0, 0, 255]);
  await call('moveLayerBegin', 1, false, 'Move');
  await call('moveFloat');
  await call('moveLayerStep', 3, 0);
  assert.deepEqual(await px(1, 5), [0, 0, 0, 0]);
  assert.deepEqual(await px(5, 5), [255, 0, 0, 255]);
  assert.equal(((await call('moveLayerCommit')).result as { undoLabel: string }).undoLabel, 'Move');
});

test('moveFloat refuses a layer with a visible layer above it and leaves the document as is', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, [255, 0, 0, 255]);
  await call('addLayer', 0);
  await call('moveLayerBegin', 1, false, 'Move');
  assert.equal((await call('moveFloat')).result, null);
  assert.deepEqual(await px(5, 5), [255, 0, 0, 255]);
  await call('moveLayerCancel');
});

test('moveFloat on selected pixels clears them until a step; the release without a step restores them', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, [255, 0, 0, 255]);
  await call('select', { kind: 'rect', x: 2, y: 2, w: 4, h: 4 }, 'new', false, 0, 'Rectangular Marquee');
  await call('movePixelsBegin', 1, 'Move Selection', false);
  const f = (await call('moveFloat')).result as { image: { x: number; y: number; w: number; h: number } };
  assert.deepEqual([f.image.x, f.image.y, f.image.w, f.image.h], [2, 2, 4, 4]);
  assert.deepEqual(await px(3, 3), [0, 0, 0, 0]);
  assert.deepEqual(await px(8, 8), [255, 0, 0, 255]);
  assert.equal(((await call('movePixelsCommit')).result as { undoLabel: string | null }).undoLabel, 'Rectangular Marquee');
  assert.deepEqual(await px(3, 3), [255, 0, 0, 255]);
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

type Doc = { width: number; height: number; resolution: number; undoLabel: string | null; history: { labels: string[] }; selection: { bounds: number[] | null } | null };
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

test('Canvas Size anchors the old pixels, fills the new area on the bottom layer, and undoes', async () => {
  await call('init');
  await call('newDoc', 100, 50, 8, null);
  await call('fillEx', 1, 'pixels', solid([255, 0, 0, 255]), 'Fill');
  const d = docOf(await call('canvasSize', 120, 50, -1, 0, [1, 1, 1, 1]));
  assert.deepEqual([d.width, d.height, d.undoLabel, count(d, 'Canvas Size')], [120, 50, 'Canvas Size', 1]);
  assert.deepEqual([await px(0, 0), await px(110, 10)], [RED, [255, 255, 255, 255]]);
  assert.equal(count(docOf(await call('canvasSize', 120, 50, 0, 0, null)), 'Canvas Size'), 1, 'unchanged makes no step');
  const u = docOf(await call('undo'));
  assert.deepEqual([u.width, u.height], [100, 50]);
});

test('Image Size resamples in one step, re-renders text layers, sets resolution, and undoes', async () => {
  await call('init');
  await call('newDoc', 200, 100, 8, null);
  await call('fontAdd', readFileSync(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)), 'bundled');
  const { newText } = await import('./shell/typesession.ts');
  const opts = { family: 'Noto Sans', style: 'Regular', size: 28, color: [0, 0, 0] as [number, number, number], alignment: 'left' as const, orientation: 'horizontal' as const };
  const t0 = newText(opts, { type: 'point' }, [10, 60]);
  const id = ((await call('typeBegin', { text: t0, above: 0 })).result as { id: number }).id;
  await call('typeUpdate', { ...t0, text: 'Hi', runs: [{ ...t0.runs[0], length: 2 }], paragraphs: [{ ...t0.paragraphs[0], length: 2 }] }, 'Hi');
  await call('typeCommit');
  // Rightmost x with ink on a few rows through the glyphs (y scales with the canvas).
  const extent = async (w: number, k: number) => {
    let right = 0;
    for (let x = 0; x < w; x++) for (const y of [45, 50, 55]) if (((await call('sample', x, y * k, 1, null)).result as number[])[3] > 0) right = x;
    return right;
  };
  const before = await extent(200, 1);
  assert.ok(before > 10);
  const d = docOf(await call('imageSize', 400, 200, 'bicubic', true, 144));
  assert.deepEqual([d.width, d.height, d.undoLabel, count(d, 'Image Size')], [400, 200, 'Image Size', 1]);
  assert.equal(d.resolution, 144);
  const after = await extent(400, 2);
  assert.ok(after > before * 1.8 && after < before * 2.2, `${before} -> ${after}`);
  const u = docOf(await call('undo'));
  assert.deepEqual([u.width, u.height, u.resolution], [200, 100, 72]);
  // Resolution alone keeps the pixel size of text (the point size drops).
  const r = docOf(await call('imageSize', 200, 100, 'bicubic', true, 144));
  assert.deepEqual([r.width, r.resolution, r.undoLabel, count(r, 'Image Size')], [200, 144, 'Image Size', 1]);
  assert.ok(Math.abs(await extent(200, 1) - before) <= 2, `${before} -> ${await extent(200, 1)}`);
  assert.equal(docOf(await call('undo')).resolution, 72);
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

test('a placed smart object survives an autosave restore with its source', async () => {
  await call('init');
  await call('newDoc', 10, 10, 8, null);
  const p = (await call('placeSmart', 1, png(), false)).result as SmartDoc;
  const { manifest, tiles, e } = await restored();
  const n = manifest.layers.find((l: { id: number }) => l.id === p.created);
  assert.equal(n.kind, 'smart');
  assert.equal(tiles.get(n.smart.source.blob)!.byteLength, 7, 'the source bytes come back');
  e.free();
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
  const named = (await call('rasterizeLayers', 'vectorMask', [b], 'Rasterize Type Layer')).result as Info;
  assert.equal(named.history.labels.at(-1), 'Rasterize Type Layer', 'a passed label names the step');
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

test('type commands: conversions keep the text in place, work path, convert to shape, set many and update all are one step each', async () => {
  await call('init');
  await call('newDoc', 300, 200, 8, null);
  await call('fontAdd', readFileSync(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)), 'bundled');
  const { newText } = await import('./shell/typesession.ts');
  type Node = { id: number; name: string; kind: string; opacity: number; text?: { shape: { type: string; box?: number[] }; runs: { size: number }[] } };
  type Info = { history: { labels: string[] }; layers: Node[]; paths: { work: boolean }[] };
  type Layout = { transform: number[]; lines: { x: number; y: number; width: number }[] };
  const opts = { family: 'Noto Sans', style: 'Regular', size: 28, color: [200, 0, 0] as [number, number, number], alignment: 'center' as const, orientation: 'horizontal' as const };
  const make = async (shape: object, s: string) => {
    const t0 = newText(opts, shape, [20, 30]);
    const id = ((await call('typeBegin', { text: t0, above: 0 })).result as { id: number }).id;
    await call('typeUpdate', { ...t0, text: s, runs: [{ ...t0.runs[0], length: s.length }], paragraphs: [{ ...t0.paragraphs[0], length: s.length }] }, s);
    await call('typeCommit');
    return id;
  };
  const anchor = async (id: number) => {
    const l = JSON.parse((await call('typeLayout', id)).result as string) as Layout, n = l.lines[0], m = l.transform;
    const x = n.x + n.width / 2, y = n.y;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  };
  const box = await make({ type: 'paragraph', box: [0, 0, 200, 80] }, 'Hello there');
  const before = await anchor(box);
  const p = (await call('typeConvert', [box], 'point')).result as Info;
  assert.equal(p.history.labels.at(-1), 'Convert to Point Text');
  assert.equal(p.layers.find(l => l.id === box)!.text!.shape.type, 'point');
  const after = await anchor(box);
  assert.ok(Math.abs(after[0] - before[0]) < 0.01 && Math.abs(after[1] - before[1]) < 0.01, `${before} -> ${after}`);
  const q = (await call('typeConvert', [box], 'paragraph')).result as Info;
  assert.equal(q.history.labels.at(-1), 'Convert to Paragraph Text');
  assert.equal(q.layers.find(l => l.id === box)!.text!.shape.type, 'paragraph');

  const w = (await call('typeWorkPath', box)).result as Info;
  assert.equal(w.history.labels.at(-1), 'Create Work Path');
  assert.ok(w.paths.some(x => x.work));

  const two = await make({ type: 'point' }, 'Two');
  const n0 = q.history.labels.length;
  const cur = (w.layers.find(l => l.id === box)!.text)!;
  const big = (t: typeof cur) => ({ ...t, runs: t.runs.map(r => ({ ...r, size: 40 })) });
  const twoText = ((await call('typeBegin', { id: two })).result as { doc: Info }).doc.layers.find(l => l.id === two)!.text!;
  await call('typeCancel');
  const m = (await call('typeSetMany', [[box, big(cur)], [two, big(twoText)]], 'Font Size')).result as Info;
  assert.equal(m.history.labels.at(-1), 'Font Size');
  assert.deepEqual([box, two].map(id => m.layers.find(l => l.id === id)!.text!.runs[0].size), [40, 40]);

  const u = (await call('typeRenderAll')).result as Info;
  assert.equal(u.history.labels.at(-1), 'Update All Text Layers');
  const s = (await call('typeToShape', [two])).result as Info;
  assert.equal(s.history.labels.at(-1), 'Convert to Shape');
  const shape = s.layers.find(l => l.id === two)!;
  assert.deepEqual([shape.kind, shape.name], ['shape', 'Two']);
  assert.ok(s.history.labels.length > n0);
});

test('glyphCells is app scope: it survives newDoc/closeDoc and rasterizes an ASCII range', async () => {
  await call('init');
  await call('fontAdd', readFileSync(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)), 'bundled');
  await call('newDoc', 64, 64, 8, null);
  await call('closeDoc');
  type Cells = { missing: boolean; size: number; cells: { gid: number; cp: number | null; name: string }[]; data: ArrayBuffer };
  const r = await call('glyphCells', 'Noto Sans', 'Regular', { from: 32, to: 126 });
  const c = r.result as Cells;
  assert.equal(c.missing, false);
  assert.equal(c.size, 30);
  assert.ok(c.cells.some(cell => cell.cp === 65 && cell.name === 'A'));
  assert.equal(c.data.byteLength, c.cells.length * 900);
});

test('text styles, Insert Glyph and missing-font replacement land as one step each through typeSetMany', async () => {
  await call('init');
  await call('newDoc', 300, 200, 8, null);
  for (const f of ['NotoSans-Regular', 'NotoSans-Bold', 'NotoSerif-Regular']) await call('fontAdd', readFileSync(new URL(`../public/fonts/${f}.ttf`, import.meta.url)), 'bundled');
  const { newText } = await import('./shell/typesession.ts');
  const { newStyle, appendText, substituteFonts } = await import('./shell/typecommands.ts');
  type Run = { family: string; style: string; size: number; length: number };
  type Text = { text: string; runs: Run[]; paragraphs: Run[] };
  type Info = { history: { labels: string[] }; layers: { id: number; text?: Text }[] };
  const make = async (family: string, style: string, size: number, s: string) => {
    const t0 = newText({ family, style, size, color: [0, 0, 0], alignment: 'left', orientation: 'horizontal' }, { type: 'point' }, [20, 60]);
    const id = ((await call('typeBegin', { text: t0, above: 0 })).result as { id: number }).id;
    await call('typeUpdate', { ...t0, text: s, runs: [{ ...t0.runs[0], length: s.length }], paragraphs: [{ ...t0.paragraphs[0], length: s.length }] }, s);
    return ((await call('typeCommit')).result as Info).layers.find(l => l.id === id)!.text! as Text & { id?: never };
  };
  const src = await make('Noto Sans', 'Bold', 40, 'Src');
  const a = await make('Noto Sans', 'Regular', 20, 'One'), b = await make('Noto Sans', 'Regular', 20, 'Two');
  const info = (await call('typeRenderAll')).result as Info;
  const [ia, ib] = info.layers.filter(l => l.text && ['One', 'Two'].includes(l.text.text)).map(l => l.id);

  // A character style saved from run 0 applies to every run of both layers in one step.
  const st = newStyle([], 'character', 'Head', src.runs[0] as never, src.paragraphs[0] as never);
  const put = (t: Text) => ({ ...t, runs: t.runs.map(r => ({ ...r, ...st.character, length: r.length })) });
  const n0 = info.history.labels.length;
  const s = (await call('typeSetMany', [[ia, put(a)], [ib, put(b)]], 'Apply Head')).result as Info;
  assert.deepEqual(s.history.labels.slice(n0), ['Apply Head']);
  assert.deepEqual([ia, ib].map(id => { const r = s.layers.find(l => l.id === id)!.text!.runs[0]; return [r.style, r.size]; }), [['Bold', 40], ['Bold', 40]]);

  // Insert Glyph with no session grows the text at its end.
  const one = s.layers.find(l => l.id === ia)!.text!;
  const g = (await call('typeSetMany', [[ia, appendText(one as never, 'é')]], 'Insert Glyph')).result as Info;
  assert.equal(g.history.labels.at(-1), 'Insert Glyph');
  const grown = g.layers.find(l => l.id === ia)!.text!;
  assert.deepEqual([grown.text, grown.runs.at(-1)!.length, grown.paragraphs.at(-1)!.length], ['Oneé', 4, 4]);

  // A layer set in a missing face re-renders in the replacement face.
  const m = await make('Missing Sans', 'Regular', 28, 'Hello');
  const mid = ((await call('typeRenderAll')).result as Info).layers.find(l => l.text?.text === 'Hello')!.id;
  assert.deepEqual((await call('fontMissing', [['Missing Sans', 'Regular']])).result, [['Missing Sans', 'Regular']]);
  const ink = async (id: number) => { const row = []; for (let x = 20; x < 110; x++) row.push(((await call('sample', x, 50, 1, id)).result as number[])[3]); return row.join(); };
  await make('Noto Serif', 'Regular', 28, 'Hello');
  const sid = ((await call('typeRenderAll')).result as Info).layers.find(l => l.text?.text === 'Hello' && l.text.runs[0].family === 'Noto Serif')!.id;
  const w0 = await ink(mid);
  const r = (await call('typeSetMany', [[mid, substituteFonts(m as never, [{ source: { family: 'Missing Sans', style: 'Regular' }, target: { family: 'Noto Serif', style: 'Regular' } }])]], 'Resolve Missing Fonts')).result as Info;
  assert.equal(r.history.labels.at(-1), 'Resolve Missing Fonts');
  assert.equal(r.layers.find(l => l.id === mid)!.text!.runs[0].family, 'Noto Serif');
  const w1 = await ink(mid);
  assert.notEqual(w1, w0, 'the fallback face pixels are gone');
  assert.equal(w1, await ink(sid));
});

test('applyFilter runs a registry filter as one step, previews in a session, and Fade mixes it back', async () => {
  await call('init');
  const schema = (await call('filterSchema')).result as { id: string; label: string }[];
  assert.ok(schema.some(s => s.id === 'gaussian_blur' && s.label === 'Gaussian Blur'));
  await call('newDoc', 8, 8, 8, [200, 100, 50, 255]);
  const none = await call('fade', 1, { opacity: 50, mode: 'normal' });
  assert.equal(none.error, 'There is nothing to fade.');
  await call('applyFilter', 1, 'pixels', { kind: 'stylize.solarize', params: {} }, 'Solarize', true, [0, 0, 4, 4], 1);
  assert.deepEqual(await px(1, 1), [110, 200, 100, 255], 'the preview filters inside the view rect');
  assert.deepEqual(await px(6, 6), [200, 100, 50, 255], 'and leaves the rest');
  await call('previewEnd', false);
  const r = await call('applyFilter', 1, 'pixels', { kind: 'stylize.solarize', params: {} }, 'Solarize');
  assert.equal((r.result as { undoLabel: string }).undoLabel, 'Solarize');
  assert.deepEqual(await px(6, 6), [110, 200, 100, 255]);
  const f = await call('fade', 1, { opacity: 50, mode: 'normal' });
  assert.equal((f.result as { undoLabel: string }).undoLabel, 'Fade');
  const [red, green, blue] = await px(6, 6);
  assert.ok(Math.abs(red! - 155) <= 1 && Math.abs(green! - 150) <= 1 && Math.abs(blue! - 75) <= 1, `half faded, got ${[red, green, blue]}`);
});

test('moving a large layer stays fast while undo snapshots grow the wasm heap', () => {
  const e = new Engine(4000, 3000, 8);
  const id = e.add_layer('L', 0);
  e.fill(id, 'pixels', 255, 255, 255, 255);
  let ms = 0;
  for (let i = 0; i < 4; i++) {
    e.snapshot();
    const t0 = performance.now();
    e.offset_layer(id, 60, 40);
    ms = performance.now() - t0;
  }
  e.free();
  assert.ok(ms < 200, `4th move took ${Math.round(ms)} ms`);
});

type Thumb = { id: number; key: string; w: number; h: number; data: ArrayBuffer };
const thumbs = async (ids: number[], size: number) => (await call('layerThumbs', ids, size)).result as Thumb[];

test('layerThumbs renders the layer over the whole canvas; the key changes only with the layer', async () => {
  await call('init');
  await call('newDoc', 200, 100, 8, null);
  await call('fillEx', 1, 'pixels', solid([255, 0, 0, 255]), 'Fill');
  const [a] = await thumbs([1], 26);
  assert.deepEqual([a.w, a.h, a.data.byteLength], [26, 13, 26 * 13 * 4]);
  assert.deepEqual([...new Uint8Array(a.data, (6 * 26 + 13) * 4, 4)], [255, 0, 0, 255]);
  assert.equal((await thumbs([1], 26))[0].key, a.key);
  await call('fillEx', 1, 'pixels', solid([0, 0, 255, 255]), 'Fill');
  assert.notEqual((await thumbs([1], 26))[0].key, a.key);
});

test('layerThumbs keys change when a smart object is moved or a type layer is edited', async () => {
  await call('init');
  await call('newDoc', 200, 100, 8, [255, 255, 255, 255]);
  await call('fontAdd', readFileSync(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)), 'bundled');
  const s = ((await call('placeSmart', 1, png(), false)).result as { created: number }).created;
  const k1 = (await thumbs([s], 26))[0].key;
  await call('moveLayerBegin', s, false, 'Move');
  await call('moveLayerStep', 5, 0);
  await call('moveLayerCommit');
  assert.notEqual((await thumbs([s], 26))[0].key, k1);

  const { newText } = await import('./shell/typesession.ts');
  const opts = { family: 'Noto Sans', style: 'Regular', size: 28, color: [0, 0, 0] as [number, number, number], alignment: 'left' as const, orientation: 'horizontal' as const };
  const t0 = newText(opts, { type: 'point' }, [10, 60]);
  const id = ((await call('typeBegin', { text: t0, above: 0 })).result as { id: number }).id;
  const t1 = { ...t0, text: 'Hi', runs: [{ ...t0.runs[0], length: 2 }], paragraphs: [{ ...t0.paragraphs[0], length: 2 }] };
  await call('typeUpdate', t1, 'Hi');
  await call('typeCommit');
  const k2 = (await thumbs([id], 26))[0];
  assert.ok(new Uint8Array(k2.data).some(v => v), 'the text layer renders pixels');
  await call('typeBegin', { id });
  await call('typeUpdate', { ...t1, text: 'Ho' }, 'Ho');
  await call('typeCommit');
  assert.notEqual((await thumbs([id], 26))[0].key, k2.key);
});

test('layerThumbs timing: one 8000x6000 layer at size 52', async () => {
  await call('init');
  await call('newDoc', 8000, 6000, 8, null);
  await call('fillEx', 1, 'pixels', solid([255, 0, 0, 255]), 'Fill');
  const t = performance.now();
  const [a] = await thumbs([1], 52);
  console.log(`layerThumbs 8000x6000 size 52: ${(performance.now() - t).toFixed(1)} ms`);
  assert.deepEqual([a.w, a.h], [52, 39]);
});

type Clip = { w: number; h: number; data: ArrayBuffer };
type Pasted = { created: number; undoLabel: string; selection: unknown; layers: { id: number; name: string; mask: unknown }[] };
const at1 = async (x: number, y: number, id: number | null) => (await call('sample', x, y, 1, id)).result as number[];

test('Copy then Paste adds a layer above with the pixels centred; Paste in Place keeps the origin', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  await call('command', 'fill', 1, 'pixels', RED);
  await call('select', { kind: 'rect', x: 4, y: 4, w: 8, h: 8 }, 'new', false, 0, 'Rectangular Marquee');
  const c = (await call('copy', 1, false, false)).result as { clip: Clip; undoLabel: string };
  assert.deepEqual([c.clip.w, c.clip.h, c.undoLabel], [8, 8, 'Rectangular Marquee']);
  const p = (await call('paste', 1, 'paste', null)).result as Pasted;
  assert.deepEqual([p.undoLabel, p.layers.length, p.layers.at(-1)!.id, p.layers.at(-1)!.name], ['Paste', 2, p.created, 'Layer 1']);
  assert.deepEqual((await call('movingBounds', p.created)).result, [28, 28, 8, 8]);
  assert.deepEqual(await at1(28, 28, p.created), RED);
  assert.deepEqual(await at1(27, 28, p.created), [0, 0, 0, 0]);
  const q = (await call('paste', p.created, 'inPlace', null)).result as Pasted;
  assert.deepEqual((await call('movingBounds', q.created)).result, [4, 4, 8, 8]);
  assert.equal(q.layers.at(-1)!.id, q.created);
});

test('Cut clears the selected pixels in one Cut step that undo restores', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  await call('command', 'fill', 1, 'pixels', RED);
  await call('select', { kind: 'rect', x: 4, y: 4, w: 8, h: 8 }, 'new', false, 0, 'Rectangular Marquee');
  const r = (await call('copy', 1, false, true)).result as { clip: Clip; history: { labels: string[] } };
  assert.deepEqual(r.history.labels, ['Fill', 'Rectangular Marquee', 'Cut']);
  assert.deepEqual([r.clip.w, r.clip.h, new Uint8Array(r.clip.data).slice(0, 4).join()], [8, 8, RED.join()]);
  assert.equal((await at1(5, 5, 1))[3], 0);
  assert.deepEqual(await at1(20, 20, 1), RED);
  await call('undo');
  assert.deepEqual(await at1(5, 5, 1), RED);
});

test('Copy multiplies by a feathered selection and refuses non-pixel layers and empty areas', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  await call('command', 'fill', 1, 'pixels', RED);
  await call('select', { kind: 'rect', x: 10, y: 10, w: 20, h: 20 }, 'new', false, 5, 'Rectangular Marquee');
  const c = (await call('copy', 1, false, false)).result as { clip: Clip };
  const a = new Uint8Array(c.clip.data).filter((_, i) => i % 4 === 3);
  assert.ok(a.some(v => v > 0 && v < 255), 'partial alpha at the feathered edge');
  assert.equal(a[Math.floor(c.clip.h / 2) * c.clip.w + Math.floor(c.clip.w / 2)], 255);
  const grp = (await call('addGroup', 1)).result as { created: number };
  assert.match((await call('copy', grp.created, false, false)).error ?? '', /pixel layer/);
  const l = (await call('addLayer', 1)).result as { created: number };
  assert.match((await call('copy', l.created, false, false)).error ?? '', /empty/);
});

test('Copy Merged takes the visible composite; Copy without a selection takes the layer content', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  await call('command', 'fill', 1, 'pixels', RED);
  const l = (await call('addLayer', 1)).result as { created: number };
  await call('select', { kind: 'rect', x: 0, y: 0, w: 32, h: 64 }, 'new', false, 0, 'Rectangular Marquee');
  await call('command', 'fill', l.created, 'pixels', [0, 0, 255, 255]);
  await call('selectCommand', 'deselect');
  const m = ((await call('copy', l.created, true, false)).result as { clip: Clip }).clip;
  const d = new Uint8Array(m.data);
  assert.deepEqual([m.w, m.h, d.slice(0, 4).join(), d.slice(40 * 4, 40 * 4 + 4).join()], [64, 64, '0,0,255,255', RED.join()]);
  const own = ((await call('copy', l.created, false, false)).result as { clip: Clip }).clip;
  assert.deepEqual([own.w, own.h], [32, 64]);
});

test('Paste Into masks the new layer to the selection and deselects', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  await call('command', 'fill', 1, 'pixels', RED);
  await call('select', { kind: 'rect', x: 4, y: 4, w: 8, h: 8 }, 'new', false, 0, 'Rectangular Marquee');
  await call('copy', 1, false, false);
  await call('select', { kind: 'rect', x: 22, y: 22, w: 4, h: 4 }, 'new', false, 0, 'Rectangular Marquee');
  const p = (await call('paste', 1, 'into', null)).result as Pasted;
  assert.deepEqual([p.undoLabel, p.selection, !!p.layers.at(-1)!.mask], ['Paste Into', null, true]);
  assert.deepEqual((await call('movingBounds', p.created)).result, [20, 20, 8, 8]);
  await call('setProps', 1, { visible: false });
  assert.equal((await at1(21, 21, null))[3], 0, 'masked outside the selection');
  assert.deepEqual(await at1(23, 23, null), RED);
  assert.deepEqual(await at1(21, 21, p.created), RED);
});

test('Layer via Copy adds the selected pixels in place as one step and leaves the clipboard alone', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  await call('command', 'fill', 1, 'pixels', RED);
  await call('select', { kind: 'rect', x: 0, y: 0, w: 4, h: 4 }, 'new', false, 0, 'Rectangular Marquee');
  await call('copy', 1, false, false);
  await call('select', { kind: 'rect', x: 4, y: 4, w: 8, h: 8 }, 'new', false, 0, 'Rectangular Marquee');
  const v = (await call('layerViaCopy', 1)).result as Pasted;
  assert.deepEqual([v.undoLabel, v.layers.length, v.layers.at(-1)!.id, v.layers.at(-1)!.name], ['Layer via Copy', 2, v.created, 'Layer 1']);
  assert.deepEqual((await call('movingBounds', v.created)).result, [4, 4, 8, 8]);
  const p = (await call('paste', 1, 'inPlace', null)).result as Pasted;
  assert.deepEqual((await call('movingBounds', p.created)).result, [0, 0, 4, 4]);
  await call('undo');
  assert.equal(((await call('undo')).result as Pasted).layers.length, 1);
});

test('Paste of an external image keeps its full size; one sized like the internal clipboard pastes the internal one', async () => {
  const psd = (w: number, h: number, rgba: number[]) => {
    const src = new Engine(w, h, 8);
    for (let tx = 0; tx < Math.ceil(w / 256); tx++) for (let ty = 0; ty < Math.ceil(h / 256); ty++) {
      const t = new Uint8Array(256 * 256 * 4);
      for (let i = 0; i < t.length; i += 4) t.set(rgba, i);
      src.set_tile_rgba8(1, tx, ty, t);
    }
    try { return exportPsd(src).bytes; } finally { src.free(); }
  };
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  const big = (await call('paste', 1, 'paste', psd(300, 200, [0, 255, 0, 255]))).result as Pasted;
  assert.deepEqual((await call('movingBounds', big.created)).result, [-118, -68, 300, 200]);
  assert.deepEqual(await at1(0, 0, big.created), [0, 255, 0, 255]);
  await call('command', 'fill', 1, 'pixels', RED);
  await call('select', { kind: 'rect', x: 4, y: 4, w: 8, h: 8 }, 'new', false, 0, 'Rectangular Marquee');
  await call('copy', 1, false, false);
  const same = (await call('paste', 1, 'inPlace', psd(8, 8, [0, 0, 255, 255]))).result as Pasted;
  assert.deepEqual((await call('movingBounds', same.created)).result, [4, 4, 8, 8]);
  assert.deepEqual(await at1(4, 4, same.created), RED);
});

type Tab = { key: string; docId: number; width: number; parents: string[]; layers: { id: number }[]; undoLabel: string | null; redoLabel: string | null; docs: { key: string; name: string; active: boolean }[]; created: number };
const res = async (p: Promise<{ result?: unknown; error?: string }>) => { const r = await p; assert.equal(r.error, undefined); return r.result as Tab; };
const activeKeys = (t: Tab) => t.docs.filter(d => d.active).map(d => d.key);
// Closes every open tab so the document tab tests see only their own documents.
async function closeAll() {
  for (let i = 0; i < 1000 && (await call('closeDoc')).result; i++);
}

test('new documents open as tabs; the newest is active and the others stay open', async () => {
  await call('init');
  await closeAll();
  const a = await res(call('newDoc', 16, 16, 8, null));
  const b = await res(call('newDoc', 32, 16, 8, null));
  assert.notEqual(a.key, b.key);
  assert.deepEqual(b.docs.map(d => d.key), [a.key, b.key]);
  assert.deepEqual(activeKeys(b), [b.key]);
  assert.equal(b.width, 32);
});

test('documentDisplayTile reads an inactive document without switching or settling active sessions', async () => {
  await call('init');
  await closeAll();
  const red = await res(call('newDoc', 12, 10, 8, [255, 0, 0, 255]));
  const blue = await res(call('newDoc', 8, 6, 8, [0, 0, 255, 255]));
  const read = (await call('documentDisplayTile', red.key, 0, 0, 0)).result as {
    key: string; version: number; width: number; height: number; depth: number; maxLevel: number; data: ArrayBuffer | null;
  };
  assert.deepEqual({ key: read.key, width: read.width, height: read.height, depth: read.depth }, { key: red.key, width: 12, height: 10, depth: 8 });
  assert.equal(typeof read.version, 'number');
  assert.equal(typeof read.maxLevel, 'number');
  assert.deepEqual([...new Uint8Array(read.data!).subarray(0, 4)], [255, 0, 0, 255]);

  const tip = (await call('tipAdd', 3, 3, new Uint8Array(9).fill(255))).result as number;
  assert.equal((await call('strokeBegin', 1, 'pixels', tipParams(tip), 'Brush')).error, undefined);
  assert.equal((await call('documentDisplayTile', red.key, 0, 0, 0)).error, undefined);
  assert.equal((await call('strokeTo', Float64Array.from([4, 4, 1]))).error, undefined, 'the background read leaves the stroke open');
  const stroked = await res(call('strokeEnd'));
  assert.equal(stroked.key, blue.key);
  assert.equal(stroked.undoLabel, 'Brush');

  assert.equal((await call('fillEx', 1, 'pixels', solid([0, 255, 0, 255]), 'Fill', true)).error, undefined);
  assert.equal((await call('documentDisplayTile', red.key, 0, 0, 0)).error, undefined);
  assert.equal((await call('fillEx', 1, 'pixels', solid([255, 255, 0, 255]), 'Fill', true)).error, undefined, 'the background read leaves the preview open');
  const cancelled = await res(call('previewEnd', false));
  assert.equal(cancelled.key, blue.key);
  assert.equal(cancelled.undoLabel, 'Brush');

  for (const tile of [[-1, 0, 0], [0, -1, 0], [0, 0, -1]]) {
    const activeTile = await call('displayTile', ...tile);
    const backgroundTile = await call('documentDisplayTile', red.key, ...tile);
    assert.equal(!!backgroundTile.error, !!activeTile.error, `validation matches displayTile for ${tile.join('/')}`);
    if (!activeTile.error) {
      assert.equal((activeTile.result as { data: ArrayBuffer | null }).data, null);
      assert.equal((backgroundTile.result as { data: ArrayBuffer | null }).data, null);
    }
  }
  await res(call('closeDoc', red.key));
  assert.match((await call('documentDisplayTile', red.key, 0, 0, 0)).error ?? '', /no longer open/i);
});

test('keyed inspection reads inactive native pixels without switching or settling active sessions', async () => {
  await call('init');
  await closeAll();
  const red = await res(call('newDoc', 12, 10, 8, [255, 0, 0, 255]));
  const blue = await res(call('newDoc', 8, 6, 8, [0, 0, 255, 255]));
  const histogram = (await call('documentHistogram', red.key, null)).result as { key: string; version: number; histogram: Uint32Array };
  assert.equal(histogram.key, red.key);
  assert.equal(histogram.histogram.length, 1024);
  assert.equal(histogram.histogram[256 + 255], 120);
  assert.equal(histogram.histogram[512], 120);
  assert.equal(histogram.histogram[768], 120);
  const sample = (await call('documentSample', red.key, 4, 4, 3, null)).result as { key: string; version: number; color: number[] };
  assert.deepEqual(sample.color, [255, 0, 0, 255]);

  const tip = (await call('tipAdd', 3, 3, new Uint8Array(9).fill(255))).result as number;
  assert.equal((await call('strokeBegin', 1, 'pixels', tipParams(tip), 'Brush')).error, undefined);
  assert.equal((await call('documentHistogram', red.key, null)).error, undefined);
  assert.equal((await call('documentSample', red.key, 4, 4, 1, null)).error, undefined);
  assert.equal((await call('strokeTo', Float64Array.from([4, 4, 1]))).error, undefined);
  const stroked = await res(call('strokeEnd'));
  assert.equal(stroked.key, blue.key);
  assert.equal(stroked.undoLabel, 'Brush');

  assert.equal((await call('fillEx', 1, 'pixels', solid([0, 255, 0, 255]), 'Fill', true)).error, undefined);
  assert.equal((await call('documentHistogram', red.key, null)).error, undefined);
  assert.equal((await call('documentSample', red.key, 4, 4, 5, null)).error, undefined);
  const cancelled = await res(call('previewEnd', false));
  assert.equal(cancelled.key, blue.key);
  assert.equal(cancelled.undoLabel, 'Brush');

  assert.match((await call('documentSample', red.key, NaN, 0, 1, null)).error ?? '', /coordinate/i);
  assert.match((await call('documentSample', red.key, 0, 0, 7, null)).error ?? '', /sample size/i);
  assert.match((await call('documentHistogram', red.key, 9999)).error ?? '', /pixel layer/i);
  await res(call('closeDoc', red.key));
  assert.match((await call('documentHistogram', red.key, null)).error ?? '', /no longer open/i);
  assert.match((await call('documentSample', red.key, 0, 0, 1, null)).error ?? '', /no longer open/i);
});

test('switchDoc keeps each document its own layers and undo/redo history, with a new docId each time', async () => {
  await call('init');
  await closeAll();
  const a0 = await res(call('newDoc', 16, 16, 8, null));
  await res(call('addLayer', 0));
  const b0 = await res(call('newDoc', 32, 32, 8, null));
  await res(call('addLayer', 0));
  const b1 = await res(call('addLayer', 0));
  const a1 = await res(call('switchDoc', a0.key));
  assert.equal(a1.key, a0.key);
  assert.deepEqual(activeKeys(a1), [a0.key]);
  assert.equal(a1.width, 16);
  assert.equal(a1.layers.length, 2);
  assert.equal(a1.undoLabel, 'New Layer');
  assert.ok(a1.docId > b1.docId);
  const a2 = await res(call('undo'));
  assert.equal(a2.layers.length, 1);
  assert.equal(a2.redoLabel, 'New Layer');
  const b2 = await res(call('switchDoc', b0.key));
  assert.ok(b2.docId > a2.docId);
  assert.equal(b2.layers.length, 3);
  assert.equal(b2.redoLabel, null);
  await res(call('undo'));
  const a3 = await res(call('switchDoc', a0.key));
  assert.ok(a3.docId > b2.docId);
  assert.equal(a3.layers.length, 1);
  assert.equal(a3.redoLabel, 'New Layer');
  assert.equal((await res(call('redo'))).layers.length, 2);
  const b3 = await res(call('switchDoc', b0.key));
  assert.equal(b3.layers.length, 2);
  assert.equal(b3.redoLabel, 'New Layer');
  const again = await res(call('switchDoc', b0.key));
  assert.ok(again.docId > b3.docId, 'even a switch to the active document renumbers it');
  assert.match((await callAt(b3.docId, 'addLayer', 0)).error ?? '', /document changed/);
  assert.ok((await call('switchDoc', 'nope')).error);
});

test('closeDoc activates the right neighbour, else the left one; closing the last gives no document', async () => {
  await call('init');
  await closeAll();
  const a = await res(call('newDoc', 8, 8, 8, null));
  const b = await res(call('newDoc', 8, 8, 8, null));
  const c = await res(call('newDoc', 8, 8, 8, null));
  await res(call('switchDoc', b.key));
  const r1 = await res(call('closeDoc'));
  assert.deepEqual(r1.docs.map(d => d.key), [a.key, c.key]);
  assert.deepEqual(activeKeys(r1), [c.key]);
  const r2 = await res(call('closeDoc', a.key));
  assert.deepEqual(r2.docs.map(d => d.key), [c.key]);
  assert.equal(r2.key, c.key);
  assert.equal(r2.docId, r1.docId, 'closing another tab keeps the active document id');
  const d = await res(call('newDoc', 8, 8, 8, null));
  const r3 = await res(call('closeDoc', d.key));
  assert.deepEqual(activeKeys(r3), [c.key], 'the rightmost tab closes to its left neighbour');
  assert.equal((await call('closeDoc')).result, null);
  assert.equal((await call('closeDoc')).result, null);
  assert.ok((await call('closeDoc', c.key)).error);
});

test('switching documents commits an open move session on the document it belongs to', async () => {
  await call('init');
  await closeAll();
  const a = await res(call('newDoc', 16, 16, 8, [255, 0, 0, 255]));
  const b = await res(call('newDoc', 16, 16, 8, null));
  await res(call('switchDoc', a.key));
  await res(call('moveLayerBegin', 1, false, 'Move'));
  await res(call('moveLayerStep', 3, 0));
  const sb = await res(call('switchDoc', b.key));
  assert.equal(sb.undoLabel, null, 'the move never lands on the other document');
  const sa = await res(call('switchDoc', a.key));
  assert.equal(sa.undoLabel, 'Move');
});

test('Edit Contents stays open in its tab across switches', async () => {
  await call('init');
  await closeAll();
  const a = await res(call('newDoc', 8, 8, 8, [255, 255, 255, 255]));
  const l = await res(call('addLayer', 1));
  await res(call('command', 'fill', l.created, 'pixels', [0, 128, 0, 255]));
  const c = await res(call('convertToSmart', [l.created]));
  await res(call('editContents', c.created));
  const b = await res(call('newDoc', 8, 8, 8, null));
  assert.deepEqual(b.parents, []);
  assert.deepEqual(b.docs.map(d => d.name), ['Untitled', 'Untitled']);
  const back = await res(call('switchDoc', a.key));
  assert.deepEqual(back.parents, ['Untitled']);
  const closed = await res(call('smartEditClose', 'discard'));
  assert.deepEqual(closed.parents, []);
  assert.equal(closed.undoLabel, 'Convert to Smart Object');
});

test('moveDoc reorders tabs and keeps the active document and its layers', async () => {
  await call('init');
  await closeAll();
  const a = await res(call('newDoc', 8, 8, 8, null));
  const b = await res(call('newDoc', 16, 8, 8, null));
  const c = await res(call('newDoc', 24, 8, 8, null));
  await res(call('switchDoc', b.key));
  const m = await res(call('moveDoc', c.key, 0));
  assert.deepEqual(m.docs.map(d => d.key), [c.key, a.key, b.key]);
  assert.equal(m.key, b.key);
  assert.equal(m.width, 16);
  const end = await res(call('moveDoc', c.key, 9));
  assert.deepEqual(end.docs.map(d => d.key), [a.key, b.key, c.key]);
  assert.deepEqual(activeKeys(end), [b.key]);
  const next = await res(call('closeDoc'));
  assert.equal(next.key, c.key);
  assert.ok((await call('moveDoc', 'nope', 0)).error);
});

test('a failing open or new document keeps every tab and the active one', async () => {
  await call('init');
  await closeAll();
  const a = await res(call('newDoc', 8, 8, 8, null));
  const b = await res(call('newDoc', 8, 8, 8, null));
  await res(call('switchDoc', a.key));
  assert.ok((await call('openFile', new File([new Uint8Array([1, 2, 3])], 'bad.psd'))).error);
  assert.ok((await call('newDoc', 0, 0, 8, null)).error);
  const now = await res(call('redo'));
  assert.deepEqual(now.docs.map(d => d.key), [a.key, b.key]);
  assert.equal(now.key, a.key);
});

type DirtyTab = Omit<Tab, 'docs'> & { dirty: boolean; docs: { key: string; name: string; active: boolean; dirty: boolean }[] };
const dirtyOf = async (op: string, ...args: unknown[]) => (await res(call(op, ...args))) as DirtyTab;

test('dirty: new and opened documents are clean; a history step dirties; undo to the saved state cleans again', async () => {
  await call('init');
  await closeAll();
  const n = await dirtyOf('newDoc', 16, 16, 8, null);
  assert.equal(n.dirty, false);
  assert.equal((await dirtyOf('addLayer', 0)).dirty, true);
  assert.equal((await dirtyOf('undo')).dirty, false);
  assert.equal((await dirtyOf('redo')).dirty, true);
  await dirtyOf('undo');
  await dirtyOf('addLayer', 0);
  assert.equal((await dirtyOf('undo')).dirty, false, 'undo of the one new step is the original state');
  await dirtyOf('redo');
  const { blob } = (await call('savePsd')).result as { blob: Blob };
  const o = await dirtyOf('openFile', new File([blob], 'x.psd'));
  assert.equal(o.dirty, false);
  assert.equal(o.docs.find(d => d.active)!.dirty, false);
});

test('dirty: savePsd cleans the document, export does not, saveEnd(false) restores', async () => {
  await call('init');
  await closeAll();
  await dirtyOf('newDoc', 16, 16, 8, null);
  await dirtyOf('addLayer', 0);
  await call('exportImage', 'image/png');
  assert.equal((await dirtyOf('saveEnd', true)).dirty, true, 'export leaves it dirty');
  await call('savePsd');
  assert.equal((await dirtyOf('saveEnd', true)).dirty, false);
  const edited = await dirtyOf('addLayer', 0);
  assert.equal(edited.dirty, true);
  await call('savePsd');
  assert.equal((await dirtyOf('saveEnd', true)).dirty, false);
  assert.equal((await dirtyOf('undo')).dirty, true, 'one step before the saved state');
  assert.equal((await dirtyOf('redo')).dirty, false, 'back to exactly the saved state');
  await dirtyOf('addLayer', 0);
  await call('savePsd');
  assert.equal((await dirtyOf('saveEnd', false)).dirty, true, 'a cancelled picker puts the previous state back');
});

test('dirty: a background tab keeps its own flag across switches', async () => {
  await call('init');
  await closeAll();
  const a = await dirtyOf('newDoc', 8, 8, 8, null);
  await dirtyOf('addLayer', 0);
  const b = await dirtyOf('newDoc', 8, 8, 8, null);
  assert.deepEqual(b.docs.map(d => d.dirty), [true, false]);
  const a2 = await dirtyOf('switchDoc', a.key);
  assert.equal(a2.dirty, true);
  assert.deepEqual(a2.docs.map(d => d.dirty), [true, false]);
  await dirtyOf('undo');
  const b2 = await dirtyOf('switchDoc', b.key);
  assert.deepEqual(b2.docs.map(d => d.dirty), [false, false]);
});

// Tile files per autosave folder, by object identity of their data (a rewrite replaces it).
async function tileFiles() {
  const docs = await (await root.getDirectoryHandle('autosave')).getDirectoryHandle('docs');
  return new Map([...docs.entries].map(([k, d]) => [k, new Map([...(d as FakeDir).entries].map(([n, f]) => [n, (f as { data: Uint8Array }).data]))]));
}

test('autosave keeps every tab: switching writes no tiles, an edit rewrites only its own document, a closed tab leaves after the next commit', async () => {
  await call('init');
  await closeAll();
  const a = await res(call('newDoc', 300, 16, 8, [255, 0, 0, 255]));
  const b = await res(call('newDoc', 16, 300, 8, [0, 0, 255, 255]));
  await settle();
  const before = await tileFiles();
  assert.deepEqual([...before.keys()].sort(), [a.key, b.key].sort());
  assert.ok(before.get(a.key)!.size > 0 && before.get(b.key)!.size > 0);
  await res(call('switchDoc', a.key));
  await settle();
  const switched = await tileFiles();
  for (const k of [a.key, b.key]) assert.deepEqual(switched.get(k), before.get(k), 'switching rewrites no tile');
  const session = (await (await Autosave.fromRoot(root as unknown as FileSystemDirectoryHandle)).load())!;
  assert.equal(session.active, a.key);
  assert.deepEqual(session.docs.map(d => d.key), [a.key, b.key]);
  assert.equal((await call('command', 'fill', 1, 'pixels', [0, 255, 0, 255])).error, undefined);
  await new Promise(r => setTimeout(r, 1300));
  const edited = await tileFiles();
  assert.deepEqual(edited.get(b.key), before.get(b.key), 'the background tab is not rewritten');
  assert.ok([...edited.get(a.key)!].some(([n, d]) => before.get(a.key)!.get(n) !== d), 'the edited tab wrote new tiles');
  await res(call('closeDoc', b.key));
  await settle();
  assert.deepEqual([...(await tileFiles()).keys()], [a.key]);
  assert.deepEqual((await (await Autosave.fromRoot(root as unknown as FileSystemDirectoryHandle)).load())!.docs.map(d => d.key), [a.key]);
});

test('removing a tip after Edit Contents closed in a tab that was switched away and back skips the freed contents engine', async () => {
  await call('init');
  await closeAll();
  const a = await res(call('newDoc', 8, 8, 8, [255, 255, 255, 255]));
  const l = await res(call('addLayer', 1));
  await call('command', 'fill', l.created, 'pixels', [0, 128, 0, 255]);
  const c = await res(call('convertToSmart', [l.created]));
  await res(call('editContents', c.created));
  const id = (await call('tipAdd', 3, 3, new Uint8Array(9).fill(255))).result as number;
  const b = await res(call('newDoc', 8, 8, 8, null));
  await res(call('switchDoc', a.key));
  await res(call('smartEditClose', 'discard'));
  assert.equal((await call('tipRemove', id)).error, undefined);
  assert.ok((await call('brushPreview', tipParams(id), 64, 32)).error, 'the tip is gone');
  await res(call('switchDoc', b.key));
});

test('Layer via Cut moves the selected pixels to a new layer and clears only the selection, one step', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  await call('command', 'fill', 1, 'pixels', RED);
  await call('select', { kind: 'rect', x: 4, y: 4, w: 8, h: 8 }, 'new', false, 0, 'Rectangular Marquee');
  const v = (await call('layerViaCut', 1)).result as Pasted;
  assert.deepEqual([v.undoLabel, v.layers.length, v.layers.at(-1)!.id], ['Layer via Cut', 2, v.created]);
  assert.deepEqual((await call('movingBounds', v.created)).result, [4, 4, 8, 8]);
  assert.deepEqual(await at1(5, 5, v.created), RED);
  assert.deepEqual(await at1(5, 5, 1), CLEAR);
  assert.deepEqual(await at1(20, 20, 1), RED);
  const u = (await call('undo')).result as Pasted;
  assert.equal(u.layers.length, 1);
  assert.deepEqual(await at1(5, 5, 1), RED);
});

test('Layer via Cut without a selection errors and adds no step', async () => {
  await call('init');
  const n = (await call('newDoc', 64, 64, 8, null)).result as { version: number; undoLabel: string | null };
  assert.ok((await call('layerViaCut', 1)).error);
  assert.equal(((await call('undo')).result as { undoLabel: string | null }).undoLabel, n.undoLabel);
});

test('deleteHiddenLayers removes hidden layers and groups anywhere in one step; undo restores them', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  const a = ((await call('addLayer', 1)).result as { created: number }).created;
  const g = ((await call('addGroup', a)).result as { created: number }).created;
  const inner = ((await call('addLayer', g)).result as { created: number }).created;
  await call('moveNode', inner, g, 0);
  const b = ((await call('addLayer', g)).result as { created: number }).created;
  await call('moveNode', b, g, 1);
  await call('setProps', a, { visible: false });
  await call('setProps', b, { visible: false });
  const ids = (l: { id: number; children?: unknown[] }[]): number[] => l.flatMap(x => [x.id, ...ids((x.children ?? []) as { id: number; children?: unknown[] }[])]);
  const r = (await call('deleteHiddenLayers')).result as Pasted;
  assert.equal(r.undoLabel, 'Delete Hidden Layers');
  assert.deepEqual(ids(r.layers), [1, g, inner]);
  const u = (await call('undo')).result as Pasted;
  assert.deepEqual(ids(u.layers).sort(), [1, a, g, inner, b].sort());
});

test('deleteHiddenLayers without hidden layers adds no step', async () => {
  await call('init');
  const n = (await call('newDoc', 64, 64, 8, null)).result as { undoLabel: string | null };
  const r = (await call('deleteHiddenLayers')).result as { undoLabel: string | null };
  assert.equal(r.undoLabel, n.undoLabel);
});

test('every tab reports its mode and depth', async () => {
  await call('init');
  await call('newDoc', 64, 64, 8, null);
  const d = (await call('newDoc', 32, 32, 16, null)).result as { docs: { mode: string; depth: number }[] };
  assert.deepEqual(d.docs.slice(-2).map(t => [t.mode, t.depth]), [['RGB', 8], ['RGB', 16]]);
});

type Named = DirtyTab & { name: string };
test('setDocName renames the tab without a history step and keeps the dirty state', async () => {
  await call('init');
  await closeAll();
  await dirtyOf('newDoc', 8, 8, 8, null);
  const r = await dirtyOf('setDocName', 'photo') as Named;
  assert.equal(r.name, 'photo');
  assert.equal(r.docs.find(d => d.active)!.name, 'photo');
  assert.equal(r.dirty, false);
  assert.equal(r.undoLabel, null);
  await dirtyOf('addLayer', 0);
  const d = await dirtyOf('setDocName', 'other');
  assert.equal(d.dirty, true);
  assert.equal(d.undoLabel, 'New Layer');
});

test('revertDoc replaces the active tab with the file under a new key at the same place: same name, history cleared, clean', async () => {
  await call('init');
  await closeAll();
  const n = await dirtyOf('newDoc', 8, 8, 8, null);
  const { blob } = (await call('savePsd')).result as { blob: Blob };
  await call('saveEnd', true);
  await dirtyOf('addLayer', 0);
  const edited = await dirtyOf('addLayer', 0);
  assert.equal(edited.layers.length, 3);
  await dirtyOf('newDoc', 8, 8, 8, null);
  await dirtyOf('switchDoc', n.key);
  assert.ok((await call('revertDoc', new File([blob], 'x.psd'), 'other')).error, 'another tab became active');
  const r = (await res(call('revertDoc', new File([blob], 'x.psd'), n.key))) as Named & { warnings: string[] };
  assert.notEqual(r.key, n.key, 'a new key: the autosave folder of the old key holds other pixels under the same tile ids');
  assert.equal(r.docs[0].key, r.key);
  assert.ok(!r.docs.some(d => d.key === n.key));
  assert.equal(r.docs.length, 2);
  assert.equal(r.name, 'Untitled');
  assert.equal(r.layers.length, 1);
  assert.equal(r.dirty, false);
  assert.equal(r.undoLabel, null);
  assert.notEqual(r.docId, edited.docId);
  assert.deepEqual(r.warnings, []);
  assert.ok((await call('revertDoc', new File([new Uint8Array([1, 2, 3])], 'bad.psd'), r.key)).error);
  const after = await dirtyOf('addLayer', 0);
  assert.equal(after.layers.length, 2, 'a failed revert keeps the reverted document');
});

test('saveEnd(false) restores only the tab whose save it ends; a save under Edit Contents changes nothing', async () => {
  await call('init');
  await closeAll();
  const a = await dirtyOf('newDoc', 8, 8, 8, null);
  await dirtyOf('addLayer', 0);
  await call('savePsd');
  await dirtyOf('saveEnd', true);
  await dirtyOf('addLayer', 0);
  await call('savePsd');
  const b = await dirtyOf('newDoc', 8, 8, 8, null);
  assert.equal((await dirtyOf('saveEnd', false)).dirty, false, 'B keeps its own clean state');
  assert.equal((await dirtyOf('switchDoc', a.key)).dirty, true, "A's failed save leaves A dirty");
  await call('savePsd');
  assert.equal((await dirtyOf('saveEnd', true)).dirty, false);
  await call('command', 'fill', 1, 'pixels', [0, 128, 0, 255]);
  const c = (await call('convertToSmart', [1])).result as SmartDoc;
  await call('savePsd');
  await dirtyOf('saveEnd', true);
  const opened = await dirtyOf('editContents', c.created);
  assert.equal(opened.dirty, false);
  await call('savePsd');
  assert.equal((await dirtyOf('saveEnd', false)).dirty, false, 'a nested save leaves the outer state as it was');
  await call('smartEditClose', 'discard');
  void b;
});

test('navigatorThumb returns the flattened composite at the long side, keeping the aspect', async () => {
  await call('init');
  await call('newDoc', 1000, 500, 8, null);
  await call('fillEx', 1, 'pixels', solid([255, 0, 0, 255]), 'Fill');
  const r = (await call('navigatorThumb', 200)).result as { w: number; h: number; data: ArrayBuffer };
  assert.deepEqual([r.w, r.h, r.data.byteLength], [200, 100, 200 * 100 * 4]);
  assert.deepEqual([...new Uint8Array(r.data, (50 * 200 + 100) * 4, 4)], [255, 0, 0, 255]);
  await call('newDoc', 60, 40, 8, [0, 255, 0, 255]);
  const s = (await call('navigatorThumb', 200)).result as { w: number; h: number };
  assert.deepEqual([s.w, s.h], [60, 40]);
});

test('a Filter Gallery smart filter keeps its stack and pixels through an autosave restore', async () => {
  await call('init');
  await call('newDoc', 24, 24, 8, [40, 160, 220, 255]);
  await call('convertForSmartFilters', 1);
  const stack = [
    { kind: 'gallery.texture.grain', enabled: true, params: { intensity: 60, contrast: 50, grainType: 'speckle' } },
    { kind: 'gallery.artistic.cutout', enabled: false, params: { levels: 3, edgeSimplicity: 4, edgeFidelity: 2 } },
  ];
  const d = (await call('applyFilter', 1, 'pixels', { kind: 'gallery.filter_gallery', params: { stack, seed: 7 } }, 'Filter Gallery')).result as FilterDoc & { layers: { smart?: { filters: { filter: { params: { stack: unknown } } }[] } }[] };
  const before = await Promise.all([[3, 4], [17, 9], [20, 20]].map(([x, y]) => pixelAt(x, y)));
  assert.deepEqual(filtersOf(d, 1).map(f => f.filter.kind), ['gallery.filter_gallery']);
  const { manifest, e } = await restored();
  assert.deepEqual(manifest.layers.find((l: { id: number }) => l.id === 1).smart.filters[0].filter.params.stack, stack);
  const t = e.flatten_tile_rgba8(0, 0)!;
  const at = ([x, y]: number[]) => [...t.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)];
  assert.deepEqual([[3, 4], [17, 9], [20, 20]].map(at), before, 'the restored smart filter renders the same pixels');
  e.free();
});

test('Liquify commits one step, then a smart filter that re-edits and survives an autosave restore', async () => {
  await call('init');
  await call('newDoc', 32, 32, 8, [255, 255, 255, 255]);
  await call('select', { kind: 'rect', x: 0, y: 0, w: 16, h: 32 }, 'new', false, 0, 'Rectangular Marquee');
  await call('fillEx', 1, 'pixels', solid([255, 0, 0, 255]), 'Fill');
  await call('selectCommand', 'deselect');
  const brush = { tool: 'forwardWarp', size: 24, density: 50, pressure: 100, rate: 80, mode: 'revert' };
  const warp = [{ op: 'begin', brush, x: 10, y: 16 }, { op: 'to', x: 16, y: 16 }, { op: 'to', x: 22, y: 16 }, { op: 'end' }];
  const v = (await call('liquifyBegin', 1, 64, 4, null)).result as { w: number; h: number; scale: number; cols: number; disp: Float32Array };
  assert.deepEqual([v.w, v.h, v.scale, v.cols], [32, 32, 1, 9]);
  assert.ok(v.disp.every(n => n === 0));
  const after = (await call('liquifyEdit', 1, warp, true)).result as { data: ArrayBuffer; disp: Float32Array };
  assert.deepEqual([...new Uint8Array(after.data, (16 * 32 + 18) * 4, 4)], [255, 0, 0, 255], 'the preview shows red pushed right');
  const d = (await call('liquifyCommit', 1, null)).result as FilterDoc;
  assert.equal(d.undoLabel, 'Liquify');
  assert.deepEqual(await pixelAt(18, 16), [255, 0, 0, 255]);
  await call('undo');
  assert.deepEqual(await pixelAt(18, 16), [255, 255, 255, 255]);

  await call('convertForSmartFilters', 1);
  await call('liquifyBegin', 1, 64, 4, null);
  await call('liquifyEdit', 1, warp, false);
  const s = (await call('liquifyCommit', 1, null)).result as FilterDoc;
  const [f] = filtersOf(s, 1);
  assert.equal(f.filter.kind, 'liquify');
  await call('liquifyBegin', 1, 64, 8, f.id);
  await call('liquifyEdit', 1, [{ op: 'begin', brush: { ...brush, tool: 'bloat' }, x: 8, y: 8 }, { op: 'end' }], false);
  const s2 = (await call('liquifyCommit', 1, f.id)).result as FilterDoc;
  assert.deepEqual(filtersOf(s2, 1).map(f => f.filter.kind), ['liquify'], 're-editing replaces the mesh in place');
  const pts = [[18, 16], [8, 8], [25, 3]];
  const before = await Promise.all(pts.map(([x, y]) => pixelAt(x, y)));
  assert.deepEqual(before[0], [255, 0, 0, 255]);
  const { manifest, e } = await restored();
  const mesh = manifest.layers.find((l: { id: number }) => l.id === 1).smart.filters[0].filter.params.mesh;
  assert.ok(manifest.blobs.includes(mesh), 'the mesh blob is saved');
  const t = e.flatten_tile_rgba8(0, 0)!;
  const at = ([x, y]: number[]) => [...t.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)];
  assert.deepEqual(pts.map(at), before, 'the restored smart filter renders the same pixels');
  e.free();
});

test('Puppet Warp and Perspective Warp preview over the whole document and commit one step; a smart object gets the smart filter', async () => {
  await call('init');
  await call('newDoc', 32, 32, 8, [255, 255, 255, 255]);
  await call('select', { kind: 'rect', x: 0, y: 0, w: 16, h: 32 }, 'new', false, 0, 'Rectangular Marquee');
  await call('fillEx', 1, 'pixels', solid([255, 0, 0, 255]), 'Fill');
  await call('selectCommand', 'deselect');
  const mesh = (await call('puppetMesh', 1, 'normal', 2)).result as { cols: number; rows: number; step: number };
  assert.ok(mesh.cols > 0 && mesh.rows > 0 && mesh.step > 0);
  const rest = { mesh, pins: [{ x: 8, y: 16, tx: 8, ty: 16, rotation: 0, fixed: false, depth: 0 }], mode: 'normal', density: 'normal', expansion: 2 };
  const geo = (await call('puppetGeometry', rest)).result as { rest: number[]; deformed: number[]; triangles: number[] };
  assert.ok(geo.triangles.length > 0 && geo.triangles.length % 3 === 0);
  assert.deepEqual(geo.deformed, geo.rest, 'nothing moved: the mesh is at rest');
  const rig = { ...rest, pins: [{ ...rest.pins[0], tx: 18 }] };
  const puppet = { kind: 'puppet_warp', params: { rig } };
  await call('applyFilter', 1, 'pixels', puppet, 'Puppet Warp', true, [], 0.5);
  await call('applyFilter', 1, 'pixels', puppet, 'Puppet Warp', true, [], 1);
  const d = (await call('previewEnd', true)).result as FilterDoc;
  assert.equal(d.undoLabel, 'Puppet Warp');
  assert.deepEqual(await pixelAt(20, 16), [255, 0, 0, 255], 'one pin moves the layer by 10 px');
  await call('undo');
  assert.deepEqual(await pixelAt(20, 16), [255, 255, 255, 255]);

  const sq = [[0, 0], [32, 0], [32, 32], [0, 32]];
  const persp = { kind: 'perspective_warp', params: { state: { layout: sq, current: sq.map(([x, y]) => [x + 10, y]), quads: [[0, 1, 2, 3]] } } };
  await call('applyFilter', 1, 'pixels', persp, 'Perspective Warp', true, [], 1);
  const p = (await call('previewEnd', true)).result as FilterDoc;
  assert.equal(p.undoLabel, 'Perspective Warp');
  assert.deepEqual(await pixelAt(20, 16), [255, 0, 0, 255], 'the plane moved 10 px right');
  await call('undo');

  await call('convertForSmartFilters', 1);
  const s = (await call('applyFilter', 1, 'pixels', puppet, 'Puppet Warp')).result as FilterDoc;
  assert.deepEqual(filtersOf(s, 1).map(f => f.filter.kind), ['puppet_warp']);
  assert.deepEqual(await pixelAt(20, 16), [255, 0, 0, 255], 'the smart filter renders the warp');
});

test('Content-Aware Scale previews over the whole document and commits one step that halves the layer width', async () => {
  await call('init');
  await call('newDoc', 32, 32, 8, [255, 255, 255, 255]);
  const scale = { kind: 'content_aware_scale', params: { width: 50, height: 100, amount: 100, protectSkinTones: false } };
  await call('applyFilter', 1, 'pixels', scale, 'Content-Aware Scale', true, [], 0.5);
  await call('applyFilter', 1, 'pixels', scale, 'Content-Aware Scale', true, [], 1);
  const d = (await call('previewEnd', true)).result as FilterDoc;
  assert.equal(d.undoLabel, 'Content-Aware Scale');
  assert.deepEqual((await call('movingBounds', 1)).result, [0, 0, 16, 32]);
  await call('undo');
  assert.deepEqual((await call('movingBounds', 1)).result, [0, 0, 32, 32]);
});

test('Vanishing Point commits one "Vanishing Point" step with dabs and one "Vanishing Point Planes" step without', async () => {
  await call('init');
  await call('newDoc', 32, 32, 8, [255, 255, 255, 255]);
  await call('select', { kind: 'rect', x: 0, y: 0, w: 16, h: 32 }, 'new', false, 0, 'Rectangular Marquee');
  await call('fillEx', 1, 'pixels', solid([255, 0, 0, 255]), 'Fill');
  const d0 = (await call('selectCommand', 'deselect')).result as { history: { labels: string[] } };
  const v = (await call('vpBegin', 1, 64, null)).result as { w: number; h: number; scale: number; planes: unknown[]; state: unknown };
  assert.deepEqual([v.w, v.h, v.scale, v.planes, v.state], [32, 32, 1, [], null]);
  const planes = [{ id: 'p1', corners: [[0, 0], [32, 0], [32, 32], [0, 32]] }];
  const dab = { planeId: 'p1', from: [0.25, 0.5], to: [0.75, 0.5], radius: 0.125, opacity: 1, hardness: 1 };
  const state = { planes, stamps: [dab], gridSize: 10, brushHardness: 100, brushOpacity: 100 };
  const prev = new Uint8Array((await call('vpPreview', state)).result as ArrayBuffer);
  assert.deepEqual([...prev.subarray((16 * 32 + 24) * 4, (16 * 32 + 24) * 4 + 4)], [255, 0, 0, 255], 'the preview clones red into the right half');
  const steps = (d: { history: { labels: string[] } }) => d.history.labels.length;
  const d = (await call('vpCommit', 1, null, state)).result as FilterDoc & { history: { labels: string[] } };
  assert.equal(d.undoLabel, 'Vanishing Point');
  assert.equal(steps(d), steps(d0) + 1);
  assert.deepEqual(await pixelAt(24, 16), [255, 0, 0, 255]);
  assert.deepEqual(((await call('vpBegin', 1, 64, null)).result as { planes: unknown[] }).planes, planes, 'the planes are saved with the step');
  await call('vpEnd');
  await call('undo');
  assert.deepEqual(await pixelAt(24, 16), [255, 255, 255, 255]);
  assert.deepEqual(((await call('vpBegin', 1, 64, null)).result as { planes: unknown[] }).planes, [], 'undo restores the planes too');
  const p = (await call('vpCommit', 1, null, { ...state, stamps: [] })).result as FilterDoc & { history: { labels: string[] } };
  assert.equal(p.undoLabel, 'Vanishing Point Planes');
  assert.equal(steps(p), steps(d0) + 1);
  assert.deepEqual(await pixelAt(24, 16), [255, 255, 255, 255], 'a planes-only step paints nothing');
  assert.deepEqual(((await call('vpBegin', 1, 64, null)).result as { planes: unknown[] }).planes, planes);
  await call('vpEnd');
});

test('an action records steps with layer references and replays them on another document', async () => {
  await call('init');
  await call('newDoc', 32, 32, 8, [255, 255, 255, 255]);
  await call('addLayer', 1, 'Old');
  events.length = 0;
  await call('recordStart');
  const a = await call('addLayer', 1, 'Glow');
  const glow = (a.result as { created: number }).created;
  await call('layerThumbs', [glow], 16);
  await call('setProps', glow, { opacity: 0.5 });
  await call('command', 'fill', glow, 'pixels', [10, 200, 30, 255]);
  await call('setProps', 1, { visible: false });
  await call('recordStop');
  await call('addLayer', 1);
  const steps = events.filter(e => (e as { event: string }).event === 'actionStep').map(e => (e as { step: import('./actions.ts').ActionStep }).step);
  assert.deepEqual(steps.map(s => s.label), ['New Layer', 'Opacity', 'Fill', 'Hide Layer'], 'reads and calls after stop are not recorded');
  assert.deepEqual(steps[1].calls, [{ op: 'setProps', args: [{ $L: { c: 0 } }, { opacity: 0.5 }] }]);
  assert.deepEqual(steps[3].calls[0].args[0], { $L: { n: 'Background' } });

  // Another document: Background exists, "Old" does not.
  await call('newDoc', 32, 32, 8, [0, 0, 0, 255]);
  const r = await call('playAction', steps, null);
  assert.equal(r.error, undefined);
  const layers = (r.result as { layers: { name: string; opacity: number; visible: boolean }[] }).layers;
  assert.deepEqual(layers.map(l => [l.name, l.opacity, l.visible]), [['Background', 1, false], ['Glow', 0.5, true]]);
  assert.deepEqual((await call('sample', 5, 5, 1, (r.result as { layers: { id: number }[] }).layers[1].id)).result, [10, 200, 30, 255]);
  assert.equal((r.result as { undoLabel: string }).undoLabel, 'Hide Layer');

  const bad = await call('playAction', [{ id: 'x', label: 'Delete Old', enabled: true, calls: [{ op: 'deleteNode', args: [{ $L: { n: 'Nope' } }] }] }], null);
  assert.match(bad.error!, /^Delete Old: There is no layer named "Nope"/);
});

test('playAction refuses calls that are not edits', async () => {
  await call('init');
  await call('newDoc', 8, 8, 8, null);
  for (const op of ['closeDoc', 'savePsd', 'documentDisplayTile', 'documentHistogram', 'documentSample', 'fontUpload', 'toString', 'constructor']) {
    const r = await call('playAction', [{ id: 'x', label: 'Bad', enabled: true, calls: [{ op, args: [] }] }], null);
    assert.match(r.error!, /cannot run in an action/, op);
  }
});

test('recording: a cancelled preview leaves no calls behind, a committed preview is one step', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, [255, 255, 255, 255]);
  events.length = 0;
  await call('recordStart');
  await call('fillEx', 1, 'pixels', solid([255, 0, 0, 255]), 'Fill', true);
  await call('setProps', 1, { opacity: 0.5 });
  await call('fillEx', 1, 'pixels', solid([0, 0, 255, 255]), 'Fill', true);
  await call('fillEx', 1, 'pixels', solid([0, 255, 0, 255]), 'Fill', true);
  await call('previewEnd', true);
  await call('recordStop');
  const steps = events.filter(e => (e as { event: string }).event === 'actionStep').map(e => (e as { step: import('./actions.ts').ActionStep }).step);
  assert.deepEqual(steps.map(s => [s.label, s.calls.map(c => c.op)]), [['Opacity', ['setProps']], ['Fill', ['fillEx', 'fillEx', 'previewEnd']]]);
  await call('newDoc', 16, 16, 8, [255, 255, 255, 255]);
  const r = await call('playAction', steps, null);
  assert.equal(r.error, undefined);
  assert.deepEqual((await call('sample', 2, 2, 1, 1)).result, [0, 255, 0, 255]);
  assert.equal((r.result as { undoLabel: string }).undoLabel, 'Fill');
});

const ids = (l: { id: number; children?: unknown[] }[]): number[] => l.flatMap(x => [x.id, ...ids((x.children ?? []) as { id: number; children?: unknown[] }[])]);
const probe = [[10, 10], [18, 30], [21, 21], [30, 30], [49, 49], [52, 40], [60, 60]];

test('Delete All Empty Layers removes empty pixel layers and groups left empty in one step', async () => {
  await styledDoc();
  const empty = ((await call('addLayer', 2)).result as { created: number }).created;
  const g = ((await call('addGroup', empty)).result as { created: number }).created;
  const inner = ((await call('addLayer', g)).result as { created: number }).created;
  await call('moveNode', inner, g, 0);
  const r = (await call('deleteEmptyLayers')).result as Pasted;
  assert.equal(r.undoLabel, 'Delete All Empty Layers');
  assert.deepEqual(ids(r.layers), [1, 2]);
  const again = await call('deleteEmptyLayers');
  assert.equal(again.error, 'There were no empty layers.');
});

test('Flatten All Layer Effects bakes effects into pixels and keeps name, opacity and blend mode', async () => {
  await styledDoc();
  await call('setLayerStyle', 2, { ...emptyStyle(), strokes: [blueStroke(3)] }, defaultBlending(), 1, null);
  await call('setProps', 2, { name: 'Red', opacity: 0.5, blend: 'multiply' });
  const before = await samples(probe);
  const r = (await call('flattenAllLayerEffects')).result as StyledDoc;
  assert.equal(r.undoLabel, 'Flatten All Layer Effects');
  const n = (r.layers as unknown as LayerNode[])[1];
  assert.deepEqual([n.kind, n.name, n.opacity, n.blend, n.style], ['pixel', 'Red', 0.5, 'multiply', null]);
  assert.deepEqual(await samples(probe), before);
  assert.equal((await call('flattenAllLayerEffects')).error, 'No layer has an effect to flatten.');
});

test('Flatten All Masks applies layer masks and keeps the layer style', async () => {
  await styledDoc();
  await call('addMask', 2, false);
  await call('select', { kind: 'rect', x: 20, y: 20, w: 15, h: 30 }, 'new', false, 0, 'Rectangular Marquee');
  await call('command', 'fill', 2, 'mask', [255, 255, 255, 255]);
  await call('selectCommand', 'deselect');
  await call('setLayerStyle', 2, { ...emptyStyle(), strokes: [blueStroke(3)] }, defaultBlending(), 0.5, null);
  const before = await samples(probe);
  const r = (await call('flattenAllMasks')).result as StyledDoc;
  assert.equal((r.layers as unknown as LayerNode[])[1].fill, 0.5);
  assert.equal(r.undoLabel, 'Flatten All Masks');
  const n = (r.layers as unknown as LayerNode[])[1];
  assert.equal(n.mask, null);
  assert.notEqual(n.style, null);
  assert.deepEqual(await samples(probe), before);
  assert.equal((await pixelAt(40, 40, n.id))[3], 0);
  assert.equal((await call('flattenAllMasks')).error, 'No layer has a mask to apply.');
});

test('Load Files into Stack opens one new document with a layer per file, first file at the bottom', async () => {
  await call('init');
  const file = (n: string) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], n);
  const r = (await call('loadStack', [file('a.png'), file('b.jpg')], false, false)).result as SmartDoc & { width: number; height: number };
  assert.deepEqual(r.layers.map(l => [l.name, l.kind]), [['a', 'pixel'], ['b', 'pixel']]);
  assert.equal(r.undoLabel, null);
  assert.deepEqual(await pixelAt(0, 0), [255, 0, 0, 255]);
  assert.deepEqual(await pixelAt(3, 1), [0, 0, 255, 255]);
  const s = (await call('loadStack', [file('a.png'), file('b.jpg')], false, true)).result as SmartDoc;
  assert.deepEqual(s.layers.map(l => [l.name, l.kind]), [['a', 'smart']]);
});

test('File Info is one undoable step, saved into the PSD and read back on open', async () => {
  await call('init');
  await call('newDoc', 16, 16, 8, [255, 255, 255, 255]);
  const i = { title: 'T', author: 'A', description: 'D', keywords: ['k'], copyright: '© C', copyright_url: 'https://x' };
  const set = await call('setFileInfo', i);
  assert.equal(set.error, undefined);
  const r = set.result as { undoLabel: string; history: { labels: string[] } };
  assert.equal(r.undoLabel, 'File Info');
  assert.deepEqual((await call('fileInfo')).result, i);
  const same = (await call('setFileInfo', i)).result as { history: { labels: string[] } };
  assert.equal(same.history.labels.length, r.history.labels.length, 'no step when nothing changed');
  const { blob } = (await call('savePsd')).result as { blob: Blob };
  await call('saveEnd', true);
  await call('openFile', new File([blob], 'info.psd'));
  assert.deepEqual((await call('fileInfo')).result, i);
  await call('closeDoc');
  await call('undo');
  assert.equal((await call('fileInfo')).result, null);
  await call('setFileInfo', i);
  await call('setFileInfo', { title: '', author: '', description: '', keywords: [], copyright: '', copyright_url: '' });
  assert.equal((await call('fileInfo')).result, null, 'empty fields remove the File Info');
});

test('a file with File Info over the limits still opens, without the File Info and with a warning', async () => {
  const { embedInfo } = await import('./app/fileInfo.ts');
  const psd = exportPsd(new Engine(4, 2, 8)).bytes;
  const big = embedInfo(psd, 'image/vnd.adobe.photoshop', { title: 'T', author: '', description: '', keywords: Array.from({ length: 1001 }, (_, i) => `k${i}`), copyright: '', copyright_url: '' });
  await call('init');
  const r = await call('openFile', new File([big as Uint8Array<ArrayBuffer>], 'big.psd'));
  assert.equal(r.error, undefined);
  assert.ok((r.result as { warnings: string[] }).warnings.some(w => w.includes('File Info')));
  assert.equal((await call('fileInfo')).result, null);
});

test('Variables: Apply Data Set sets visibility and type text in one step, and Data Sets as Files leaves the document alone', async () => {
  await call('init');
  await call('newDoc', 200, 100, 8, [255, 255, 255, 255]);
  await call('fontAdd', readFileSync(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)), 'bundled');
  const { newText } = await import('./shell/typesession.ts');
  type Info = { undoLabel: string; history: { labels: string[] }; layers: { id: number; visible: boolean; kind: string; text?: { text: string } }[] };
  const t0 = newText({ family: 'Noto Sans', style: 'Regular', size: 28, color: [0, 0, 0], alignment: 'left', orientation: 'horizontal' }, { type: 'point' }, [10, 60]);
  const t1 = { ...t0, text: 'Hi', runs: [{ ...t0.runs[0], length: 2 }], paragraphs: [{ ...t0.paragraphs[0], length: 2 }] };
  const { id } = (await call('typeBegin', { text: t0, above: 0 })).result as { id: number };
  await call('typeUpdate', t1, 'Hi');
  const bg = ((await call('typeCommit')).result as Info).layers.find(l => l.kind !== 'text')!.id;
  const m = {
    variables: [{ kind: 'visibility', name: 'bg', layer: bg }, { kind: 'text', name: 'title', layer: id }, { kind: 'text', name: 'bad', layer: bg }],
    data_sets: [{ name: 'One', values: { bg: 'hidden', title: 'Grüße 😀', bad: 'x' } }, { name: 'Two', values: { bg: 'true', title: 'B' } }],
    active: null,
  };
  const sv = await call('setVariables', m, 'Define Variables');
  assert.equal(sv.error, undefined);
  assert.equal((sv.result as Info).undoLabel, 'Define Variables');
  const r = (await call('applyDataSet', 'One')).result as { doc: Info; errors: string[] };
  assert.equal(r.doc.undoLabel, 'Apply Data Set');
  assert.equal(r.errors.length, 1);
  assert.equal(r.doc.layers.find(l => l.id === bg)!.visible, false);
  assert.equal(r.doc.layers.find(l => l.id === id)!.text!.text, 'Grüße 😀');
  assert.equal(((await call('variables')).result as { active: string }).active, 'One');
  const ex = await call('exportDataSets', 'psd', 1);
  assert.equal(ex.error, undefined);
  const psd = ex.result as { name: string; blob: Blob }[];
  assert.deepEqual(psd.map(f => [f.name, f.blob.type]), [['One', 'image/vnd.adobe.photoshop'], ['Two', 'image/vnd.adobe.photoshop']]);
  const saved = (await call('savePsd')).result as { warnings: string[] };
  await call('saveEnd', false);
  assert.ok(saved.warnings.includes('variables and data sets are not stored in PSD'));
  const back = await call('openFile', new File([psd[1].blob], 'two.psd'));
  assert.equal((back.result as Info).layers.find(l => l.kind === 'text')!.text!.text, 'B', 'the second file has the second set');
  await call('closeDoc');
  const now = ((await call('undo')).result as Info);
  assert.equal(now.layers.find(l => l.id === id)!.text!.text, 'Hi', 'one undo restores the text');
  assert.equal(now.layers.find(l => l.id === bg)!.visible, true);
  await call('setVariables', { variables: [], data_sets: [], active: null }, 'Define Variables');
  assert.ok(!((await call('savePsd')).result as { warnings: string[] }).warnings.some(w => w.includes('variables')), 'an empty model is removed');
  await call('saveEnd', false);
});

test('M9 tools: annotations are one undoable step, Straighten Layer levels pixels, New Frame and artboard at a rect', async () => {
  await call('init');
  await call('newDoc', 100, 80, 8, [255, 255, 255, 255]);
  type Info = { undoLabel: string; width: number; history: { labels: string[] }; annotations: { notes: unknown[]; samplers: number[][] }; layers: { id: number; kind: string; name: string; children?: { id: number }[]; vector_mask?: { path: { subpaths: unknown[] } } | null; artboard?: { rect: number[] } | null }[] };
  const a = { notes: [{ id: 1, x: 5, y: 6, author: '', color: [255, 220, 80], text: 'hi' }], slices: [], counts: [], samplers: [[10, 10]] };
  const r = (await call('setAnnotations', a, 'New Note')).result as Info;
  assert.equal(r.undoLabel, 'New Note');
  assert.deepEqual(r.annotations.samplers, [[10, 10]]);
  const n = r.history.labels.length;
  assert.equal(((await call('setAnnotations', a, 'New Note')).result as Info).history.labels.length, n, 'an unchanged model adds no step');
  assert.equal(((await call('undo')).result as Info).annotations.notes.length, 0, 'undo removes the note');
  const bg = r.layers[0].id;
  // Rotating the opaque background about the canvas center leaves its corner transparent.
  const line = (await call('straightenLayer', bg, Math.atan2(10, 80) * 180 / Math.PI)).result as Info;
  assert.equal(line.undoLabel, 'Straighten Layer');
  assert.ok(((await call('sample', 0, 0, 1, bg)).result as number[])[3] < 255, 'the corner turned transparent');
  const bad = await call('straightenLayer', bg, Number.NaN);
  assert.ok(bad.error, 'a NaN angle is refused');
  const f = (await call('newFrame', { x: 10, y: 10, w: 30, h: 20 }, 'ellipse', bg)).result as Info & { created: number };
  assert.equal(f.undoLabel, 'New Frame');
  const frame = f.layers.find(l => l.id === f.created)!;
  assert.equal(frame.kind, 'group');
  assert.equal(frame.vector_mask!.path.subpaths.length, 1);
  const top = ((await call('addLayer', f.created)).result as Info & { created: number }).created;
  const g = (await call('newFrame', { x: 0, y: 0, w: 20, h: 20 }, 'rectangle', top, true)).result as Info & { created: number };
  assert.deepEqual(g.layers.find(l => l.id === g.created)!.children!.map(c => c.id), [top], 'the layer becomes the frame content');
  assert.equal(g.history.labels.at(-1), 'New Frame', 'one step');
  const ab = (await call('newArtboardAt', 'Artboard 1', [120, 10, 220, 90], { type: 'white' })).result as Info & { created: number };
  assert.equal(ab.undoLabel, 'New Artboard');
  assert.deepEqual(ab.layers.find(l => l.id === ab.created)!.artboard!.rect, [120, 10, 220, 90]);
  assert.equal(ab.width, 220, 'the canvas grows to hold the artboard');
});

test('R25 Analysis: a measurement scale alone persists; Place Scale Marker adds a bar and text group in one step', async () => {
  await call('init');
  await call('newDoc', 200, 100, 8, [255, 255, 255, 255]);
  await call('fontAdd', readFileSync(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)), 'bundled');
  type Info = { undoLabel: string; history: { labels: string[] }; annotations: { scale?: { pixels: number; logical: number; units: string } }; layers: { id: number; kind: string; name: string; children?: { kind: string }[] }[] };
  const scale = { pixels: 50, logical: 1, units: 'cm' };
  const s = (await call('setAnnotations', { notes: [], slices: [], counts: [], samplers: [], scale }, 'Set Measurement Scale')).result as Info;
  assert.deepEqual(s.annotations.scale, scale, 'a scale without marks is kept');
  const { newText } = await import('./shell/typesession.ts');
  const t0 = newText({ family: 'Noto Sans', style: 'Regular', size: 12, color: [0, 0, 0], alignment: 'left', orientation: 'horizontal' }, { type: 'point' }, [10, 80]);
  const text = { ...t0, text: '1 cm', runs: [{ ...t0.runs[0], length: 4 }], paragraphs: [{ ...t0.paragraphs[0], length: 4 }] };
  const before = s.history.labels.length;
  const m = (await call('placeScaleMarker', { x: 10, y: 85, w: 50, h: 4 }, [0, 0, 0], text)).result as Info & { created: number };
  assert.equal(m.undoLabel, 'Place Scale Marker');
  assert.equal(m.history.labels.length, before + 1, 'one step');
  const g = m.layers.find(l => l.id === m.created)!;
  assert.deepEqual([g.kind, g.children!.map(c => c.kind)], ['group', ['shape', 'text']]);
  assert.equal(((await call('sample', 30, 86, 1, null)).result as number[])[0], 0, 'the bar is painted');
  const u = (await call('undo')).result as Info;
  assert.equal(u.layers.some(l => l.kind === 'group'), false, 'undo removes the marker');
});
