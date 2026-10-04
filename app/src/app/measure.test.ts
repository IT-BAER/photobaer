import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  framePath, measureRow, measureSelection, nearestMark, resizeRect, rotationAbout, rulerMeasure, sliceAt, sliceHandle,
  slicesFromGuides, straightenAngle, toCsv,
} from './measure.ts';
import { apply } from '../transform/matrix.ts';

test('rulerMeasure: angle is counter-clockwise from the x axis with y pointing down', () => {
  const m = rulerMeasure([10, 20], [20, 10]);
  assert.equal(m.w, 10);
  assert.equal(m.h, -10);
  assert.ok(Math.abs(m.angle - 45) < 1e-9);
  assert.ok(Math.abs(m.length - Math.hypot(10, 10)) < 1e-9);
  assert.ok(Math.abs(rulerMeasure([0, 0], [-5, 0]).angle - 180) < 1e-9);
});

test('straightenAngle turns the line onto the nearest axis', () => {
  assert.ok(Math.abs(straightenAngle(10) - 10) < 1e-9);
  assert.ok(Math.abs(straightenAngle(-30) + 30) < 1e-9);
  assert.ok(Math.abs(straightenAngle(80) + 10) < 1e-9, 'a near-vertical line becomes vertical');
  assert.ok(Math.abs(straightenAngle(175) + 5) < 1e-9);
});

test('rotationAbout by the straighten angle levels the measured line', () => {
  const a = [10, 50] as [number, number], b = [90, 30] as [number, number];
  const m = rotationAbout(straightenAngle(rulerMeasure(a, b).angle), 50, 40);
  const [p, q] = [apply(m, ...a), apply(m, ...b)];
  assert.ok(Math.abs(p[1] - q[1]) < 1e-9, `level: ${p[1]} vs ${q[1]}`);
  const c = apply(m, 50, 40);
  assert.ok(Math.abs(c[0] - 50) < 1e-9 && Math.abs(c[1] - 40) < 1e-9, 'the center stays');
});

test('framePath: a rectangle has four corners, an ellipse four smooth anchors on its box', () => {
  const r = framePath({ x: 2, y: 3, w: 10, h: 6 }, 'rectangle');
  assert.deepEqual(r.subpaths[0].points.map(p => [p[0], p[1]]), [[2, 3], [12, 3], [12, 9], [2, 9]]);
  const e = framePath({ x: 0, y: 0, w: 20, h: 10 }, 'ellipse').subpaths[0].points;
  assert.deepEqual(e.map(p => [p[0], p[1]]), [[10, 0], [20, 5], [10, 10], [0, 5]]);
  assert.ok(e[0][4] > 10 && e[0][2] < 10, 'the top anchor has handles left and right');
});

test('nearestMark finds the closest mark within the radius', () => {
  const marks: [number, number][] = [[0, 0], [10, 10], [11, 11]];
  assert.equal(nearestMark(marks, 10.6, 10.6, 3), 2);
  assert.equal(nearestMark(marks, 50, 50, 3), -1);
});

test('sliceAt picks the topmost (last) slice; sliceHandle and resizeRect move one side', () => {
  const slices = [{ id: 1, name: 'a', rect: [0, 0, 50, 50] as [number, number, number, number] }, { id: 2, name: 'b', rect: [20, 20, 80, 80] as [number, number, number, number] }];
  assert.equal(sliceAt(slices, 30, 30)?.id, 2);
  assert.equal(sliceAt(slices, 5, 5)?.id, 1);
  assert.equal(sliceAt(slices, 90, 90), null);
  assert.equal(sliceHandle([20, 20, 80, 80], 80, 50, 4), 'e');
  assert.equal(sliceHandle([20, 20, 80, 80], 21, 21, 4), 'nw');
  assert.equal(sliceHandle([20, 20, 80, 80], 50, 50, 4), null);
  assert.deepEqual(resizeRect([20, 20, 80, 80], 'e', 100, 0), [20, 20, 100, 80]);
  assert.deepEqual(resizeRect([20, 20, 80, 80], 'nw', 90, 95), [80, 80, 90, 95], 'dragging past the far side flips');
});

test('slicesFromGuides cuts the canvas at sorted inner guides', () => {
  const s = slicesFromGuides([{ id: 1, axis: 'x', pos: 30 }, { id: 2, axis: 'y', pos: 40 }, { id: 3, axis: 'x', pos: 200 }], 100, 60);
  assert.deepEqual(s, [[0, 0, 30, 40], [30, 0, 100, 40], [0, 40, 30, 60], [30, 40, 100, 60]]);
});

test('measureSelection: area counts partial coverage, perimeter follows the outline', () => {
  const w = 10, h = 10, mask = new Uint8Array(w * h);
  for (let y = 2; y < 6; y++) for (let x = 3; x < 8; x++) mask[y * w + x] = 255;
  mask[0] = 128;
  const m = measureSelection(mask, w, h);
  assert.ok(Math.abs(m.area - (20 + 128 / 255)) < 1e-9);
  assert.deepEqual(m.bounds, [0, 0, 8, 6]);
  assert.ok(m.perimeter >= 18, `perimeter ${m.perimeter}`);
});

test('measureRow and toCsv write one quoted row per measurement', () => {
  const row = measureRow(1, 'Doc "A"', { source: 'Ruler', length: 12.5, angle: 30 }, new Date(Date.UTC(2026, 9, 4, 10, 0, 0)));
  assert.equal(row.label, 'Measurement 1');
  const csv = toCsv([row]);
  const [head, line] = csv.split('\n');
  assert.ok(head.startsWith('Label,Date and Time,Document,Source'));
  assert.ok(line.includes('"Doc ""A"""'));
  assert.ok(line.includes('12.5'));
});
