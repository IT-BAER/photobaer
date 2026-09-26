import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectMode, marqueeRect, snap45, PolygonLasso, contour, antsLevel } from './selecttools.ts';

test('selectMode combines modifiers, shift+alt wins', () => {
  assert.equal(selectMode('new', false, false), 'new');
  assert.equal(selectMode('new', true, false), 'add');
  assert.equal(selectMode('new', false, true), 'subtract');
  assert.equal(selectMode('new', true, true), 'intersect');
});

const OPTS = { constrain: false, fromCenter: false, style: 'normal' as const, ratioW: 1, ratioH: 1, fixedW: 100, fixedH: 50 };

test('marqueeRect normal spans start..cur regardless of drag direction', () => {
  assert.deepEqual(marqueeRect([10, 10], [30, 40], OPTS), { x: 10, y: 10, w: 20, h: 30 });
  assert.deepEqual(marqueeRect([30, 40], [10, 10], OPTS), { x: 10, y: 10, w: 20, h: 30 });
});

test('marqueeRect constrain makes a square keeping drag direction signs', () => {
  const r = marqueeRect([10, 10], [30, 5], { ...OPTS, constrain: true });
  assert.deepEqual(r, { x: 10, y: -10, w: 20, h: 20 });
});

test('marqueeRect fixed ratio derives h from w and keeps direction signs, ignoring constrain', () => {
  const r = marqueeRect([10, 10], [30, -100], { ...OPTS, style: 'fixed ratio', ratioW: 2, ratioH: 1, constrain: true });
  assert.deepEqual(r, { x: 10, y: 0, w: 20, h: 10 });
});

test('marqueeRect fixed size ignores drag, top-left at cur', () => {
  const r = marqueeRect([10, 10], [50, 60], { ...OPTS, style: 'fixed size' });
  assert.deepEqual(r, { x: 50, y: 60, w: 100, h: 50 });
});

test('marqueeRect fixed size fromCenter centers on cur', () => {
  const r = marqueeRect([10, 10], [50, 60], { ...OPTS, style: 'fixed size', fromCenter: true });
  assert.deepEqual(r, { x: 0, y: 35, w: 100, h: 50 });
});

test('marqueeRect fromCenter doubles size around start', () => {
  const r = marqueeRect([50, 50], [70, 60], { ...OPTS, fromCenter: true });
  assert.deepEqual(r, { x: 30, y: 40, w: 40, h: 20 });
});

test('snap45 projects onto the nearest 8-way direction keeping projected length', () => {
  assert.deepEqual(snap45([0, 0], [10, 1]), [10, 0]);
  const diag = snap45([0, 0], [5, 5]);
  assert.ok(Math.abs(diag[0] - 5) < 1e-9 && Math.abs(diag[1] - 5) < 1e-9);
  const [x, y] = snap45([0, 0], [0, 10]);
  assert.ok(Math.abs(x) < 1e-9 && Math.abs(y - 10) < 1e-9);
});

test('PolygonLasso tracks points and closesAt only with 3+ points near the first', () => {
  const p = new PolygonLasso();
  p.add([0, 0]);
  p.add([10, 0]);
  assert.equal(p.closesAt([0.1, 0.1], 1), false);
  p.add([10, 10]);
  assert.equal(p.closesAt([0.1, 0.1], 1), true);
  assert.equal(p.closesAt([5, 5], 1), false);
  p.removeLast();
  assert.deepEqual(p.flat(), [0, 0, 10, 0]);
});

test('contour: 2x2 block in a 4x4 mask gives 4 segments totalling length 8', () => {
  const w = 4, h = 4;
  const mask = new Uint8Array(w * h);
  mask[1 * w + 1] = 255; mask[1 * w + 2] = 255;
  mask[2 * w + 1] = 255; mask[2 * w + 2] = 255;
  const segs = contour(mask, w, h);
  assert.equal(segs.length / 4, 4);
  let total = 0;
  for (let i = 0; i < segs.length; i += 4) total += Math.abs(segs[i + 2] - segs[i]) + Math.abs(segs[i + 3] - segs[i + 1]);
  assert.equal(total, 8);
});

test('contour: full mask gives 4 border segments', () => {
  const w = 4, h = 4;
  const mask = new Uint8Array(w * h).fill(255);
  const segs = contour(mask, w, h);
  assert.equal(segs.length / 4, 4);
});

test('contour: empty mask has no segments', () => {
  const w = 4, h = 4;
  const mask = new Uint8Array(w * h);
  assert.equal(contour(mask, w, h).length, 0);
});

test('contour: 2x2 checkerboard total length equals the edge count', () => {
  const w = 2, h = 2;
  const mask = new Uint8Array([255, 0, 0, 255]);
  const segs = contour(mask, w, h);
  let total = 0;
  for (let i = 0; i < segs.length; i += 4) total += Math.abs(segs[i + 2] - segs[i]) + Math.abs(segs[i + 3] - segs[i + 1]);
  assert.equal(total, 8);
});

test('antsLevel picks the smallest level that keeps the tile within cap, clamped to maxLevel and 8', () => {
  assert.equal(antsLevel(0, 8000, 8000, 8), 1);
  assert.equal(antsLevel(2, 8000, 8000, 8), 2);
  assert.equal(antsLevel(0, 100, 100, 8), 0);
  assert.equal(antsLevel(0, 1000000, 1000000, 3), 3);
});
