import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashFor, dragLive, radiusMax, setRadius, shapeStyle, strokeStyleOf, type ShapeToolOpts } from './shapetools.ts';

const OPTS: ShapeToolOpts = { kind: 'rectangle', constrain: false, fromCenter: false, cornerRadius: 0, sides: 5, starInset: 0, width: 0, height: 0 };

test('a rectangle drag gives live bounds of the dragged box', () => {
  assert.deepEqual(dragLive([10, 10], [110, 70], OPTS), { type: 'rectangle', bounds: [10, 10, 110, 70], radii: [0, 0, 0, 0] });
  assert.deepEqual(dragLive([110, 70], [10, 10], OPTS), { type: 'rectangle', bounds: [10, 10, 110, 70], radii: [0, 0, 0, 0] }, 'any direction');
});

test('Shift draws a square, Alt draws from the center', () => {
  assert.deepEqual(dragLive([10, 10], [110, 70], { ...OPTS, kind: 'ellipse', constrain: true }), { type: 'ellipse', bounds: [10, 10, 110, 110] });
  assert.deepEqual(dragLive([50, 50], [60, 70], { ...OPTS, kind: 'ellipse', fromCenter: true }), { type: 'ellipse', bounds: [40, 30, 60, 70] });
});

test('a line runs from the press to the release; Shift snaps it to 45 degrees', () => {
  assert.deepEqual(dragLive([10, 20], [90, 22], { ...OPTS, kind: 'line', fromCenter: true }), { type: 'line', start: [10, 20], end: [90, 22] });
  const snapped = dragLive([0, 0], [10, 9], { ...OPTS, kind: 'line', constrain: true });
  assert.ok(snapped && snapped.type === 'line' && Math.abs(snapped.end[0] - snapped.end[1]) < 1e-9);
});

test('a click without drag uses the W and H options, or does nothing', () => {
  assert.equal(dragLive([5, 5], [5, 5], OPTS), null, 'W and H default to 0');
  assert.deepEqual(dragLive([5, 5], [5, 5], { ...OPTS, width: 40, height: 20 }), { type: 'rectangle', bounds: [5, 5, 45, 25], radii: [0, 0, 0, 0] });
  assert.equal(dragLive([5, 5], [5, 30], OPTS), null, 'a zero-width box draws nothing');
  assert.deepEqual(dragLive([5, 5], [5, 30], { ...OPTS, kind: 'line' }), { type: 'line', start: [5, 5], end: [5, 30] }, 'a vertical line is valid');
});

test('polygon options map to sides and a star inset fraction; corner radius goes to every corner', () => {
  assert.deepEqual(dragLive([0, 0], [100, 100], { ...OPTS, kind: 'polygon', sides: 6.4, starInset: 50, cornerRadius: 3 }),
    { type: 'polygon', bounds: [0, 0, 100, 100], sides: 6, star_inset: 0.5, radius: 3 });
  assert.deepEqual(dragLive([0, 0], [100, 100], { ...OPTS, kind: 'polygon', sides: 1, starInset: 100 }),
    { type: 'polygon', bounds: [0, 0, 100, 100], sides: 3, star_inset: 0.99, radius: 0 });
  assert.deepEqual(dragLive([0, 0], [10, 10], { ...OPTS, cornerRadius: 2 }), { type: 'rectangle', bounds: [0, 0, 10, 10], radii: [2, 2, 2, 2] });
});

test('appearance picks fill and stroke; the stroke is centered butt miter 100', () => {
  const red = { type: 'solid', color: [255, 0, 0] } as const, blue = { type: 'solid', color: [0, 0, 255] } as const;
  assert.deepEqual(shapeStyle('fill', [255, 0, 0], [0, 0, 255], 3), { fill: red, stroke: null });
  assert.deepEqual(shapeStyle('none', [255, 0, 0], [0, 0, 255], 3), { fill: null, stroke: null });
  const both = shapeStyle('both', [255, 0, 0], [0, 0, 255], 3);
  assert.deepEqual(both.fill, red);
  assert.deepEqual(both.stroke, { enabled: true, width: 3, align: 'center', cap: 'butt', join: 'miter', miter_limit: 100, dash: [], dash_offset: 0, content: blue, opacity: 1, blend: 'normal' });
  assert.equal(shapeStyle('outline', [255, 0, 0], [0, 0, 255], 0).stroke, null, 'width 0 has no stroke');
});

test('linked radius writes all four, unlinked writes one, both clamp to half the shorter side', () => {
  const b: [number, number, number, number] = [0, 0, 100, 60];
  assert.equal(radiusMax(b), 30);
  assert.deepEqual(setRadius([0, 0, 0, 0], 0, 20, true, b), [20, 20, 20, 20]);
  assert.deepEqual(setRadius([20, 20, 20, 20], 1, 5, false, b), [20, 5, 20, 20]);
  assert.deepEqual(setRadius([0, 0, 0, 0], 2, 50, false, b), [0, 0, 30, 0]);
});

test('stroke styles: dotted is [w, 1.5w] with a round cap, dashed [4w, 2w]; the shown style comes from the pattern', () => {
  assert.deepEqual(dashFor('dotted', 4), { dash: [4, 6], cap: 'round' });
  assert.deepEqual(dashFor('dashed', 2), { dash: [8, 4] });
  assert.deepEqual(dashFor('solid', 2), { dash: [] });
  assert.equal(strokeStyleOf([], 2), 'solid');
  assert.equal(strokeStyleOf([2, 3], 2), 'dotted');
  assert.equal(strokeStyleOf([8, 4], 2), 'dashed');
});
