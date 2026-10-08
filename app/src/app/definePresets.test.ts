import test from 'node:test';
import assert from 'node:assert/strict';
import { BrushLibrary, MemoryStore } from '../brushes/store.ts';
import { ShapeLibrary } from '../shell/customShapes.ts';
import type { DocInfo, LayerNode, VectorPath } from '../worker/types.ts';
import { addBrushPreset, addCustomShape, addPattern, customShapeSource } from './definePresets.ts';

test('addBrushPreset adds one sampled preset with its tip', async () => {
  const lib = await BrushLibrary.open(new MemoryStore());
  const before = lib.list().length;
  const p = addBrushPreset(lib, 'Sampled Brush 1', { width: 30, height: 20, alpha: new Uint8Array(600).fill(255) })!;
  assert.equal(lib.list().length, before + 1);
  assert.equal(p.name, 'Sampled Brush 1');
  assert.ok(p.tip.kind === 'sampled');
  const tip = lib.tip(p.tip.tipRef)!;
  assert.deepEqual([tip.width, tip.height, p.tip.diameter], [30, 20, 30]);
});

test('addPattern adds one RGBA pattern', async () => {
  const lib = await BrushLibrary.open(new MemoryStore());
  const before = lib.patterns().length;
  const id = addPattern(lib, 'Untitled', { width: 4, height: 3, data: new Uint8Array(48) });
  assert.equal(lib.patterns().length, before + 1);
  const r = lib.pattern(id)!;
  assert.deepEqual([r.name, r.width, r.height, r.channels], ['Untitled', 4, 3, 4]);
});

const square = (x: number): VectorPath => ({ fill_rule: 'nonzero', subpaths: [{ closed: true, op: 'combine', points: [[x, 0, x, 0, x, 0], [x + 10, 0, x + 10, 0, x + 10, 0], [x + 10, 20, x + 10, 20, x + 10, 20]] }] });

test('customShapeSource prefers the shape layer, then the vector mask, then the selected path', () => {
  const doc = { paths: [{ id: 7, name: 'Path 1', work: false, path: square(3) }] } as unknown as DocInfo;
  const shape = { shape: { path: square(1) }, vector_mask: { path: square(2) } } as unknown as LayerNode;
  const masked = { vector_mask: { path: square(2) } } as unknown as LayerNode;
  assert.equal(customShapeSource(doc, shape, 7), shape.shape!.path);
  assert.equal(customShapeSource(doc, masked, 7), masked.vector_mask!.path);
  assert.deepEqual(customShapeSource(doc, {} as LayerNode, 7), square(3));
  assert.equal(customShapeSource(doc, {} as LayerNode, null), null);
});

test('addCustomShape appends one shape fitted to the unit square', () => {
  const mem = new Map<string, string>();
  const lib = new ShapeLibrary({ getItem: k => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); } });
  const before = lib.list().length;
  addCustomShape(lib, 'Mine', square(5));
  const s = lib.list().at(-1)!;
  assert.equal(lib.list().length, before + 1);
  assert.equal(s.name, 'Mine');
  const xs = s.path.subpaths[0].points.map(p => p[0]), ys = s.path.subpaths[0].points.map(p => p[1]);
  assert.deepEqual([Math.min(...ys), Math.max(...ys), Math.max(...xs) - Math.min(...xs)], [0, 1, 0.5]);
});
