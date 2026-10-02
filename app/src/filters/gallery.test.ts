import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addAt, drag, handles, removeHandle, ringBlur, snap, type Box } from './gallery.ts';
import type { FilterParam } from './schema.ts';

const box: Box = [100, 50, 200, 100]; // short side 100
const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;

test('the center handle moves the center in fractions of the layer bounds, clamped', () => {
  const p = { center: { x: 0.5, y: 0.5 }, blur: 15, radius: 0.4, aspect: 1, rotation: 0, feather: 0.5, roundness: 0 };
  assert.deepEqual(drag('iris_blur', p, 'center', [150, 75], box), { center: { x: 0.25, y: 0.25 } });
  assert.deepEqual(drag('iris_blur', p, 'center', [0, 500], box), { center: { x: 0, y: 1 } });
});

test('iris handles: the x axis sets rotation and aspect, the y axis the size, the inner ring the feather', () => {
  const p = { center: { x: 0.5, y: 0.5 }, radius: 0.4, aspect: 1, rotation: 0, feather: 0.5 };
  const h = handles('iris_blur', p, box);
  assert.deepEqual(h.find(x => x.id === 'axisX')?.at, [240, 100]);
  const a = drag('iris_blur', p, 'axisX', [200, 180], box);
  assert.ok(near(a.rotation as number, 90) && near(a.aspect as number, 2), JSON.stringify(a));
  assert.ok(near(drag('iris_blur', p, 'axisY', [200, 130], box).radius as number, 0.3));
  assert.ok(near(drag('iris_blur', p, 'feather', [230, 100], box).feather as number, 0.25));
});

test('tilt-shift handles set rotation, focus and feather widths from the distance to the center line', () => {
  const p = { center: { x: 0.5, y: 0.5 }, rotation: 0, focusWidth: 0.15, featherWidth: 0.25 };
  assert.ok(near(drag('tilt_shift', p, 'rotate', [200, 150], box).rotation as number, 90));
  assert.ok(near(drag('tilt_shift', p, 'focus', [10, 120], box).focusWidth as number, 0.2));
  assert.ok(near(drag('tilt_shift', p, 'feather', [10, 60], box).featherWidth as number, 0.25));
});

test('spin handles set aspect, size and feather', () => {
  const p = { center: { x: 0.5, y: 0.5 }, radius: 0.4, aspect: 1, feather: 0.4 };
  assert.ok(near(drag('spin_blur', p, 'axisX', [280, 100], box).aspect as number, 2));
  assert.ok(near(drag('spin_blur', p, 'axisY', [200, 120], box).radius as number, 0.2));
  assert.ok(near(drag('spin_blur', p, 'feather', [220, 100], box).feather as number, 0.5));
});

test('field pins: click adds a pin with the given blur, drag moves, delete keeps the last pin', () => {
  const p = { pins: [{ x: 0.5, y: 0.5, blur: 15 }] };
  const a = addAt('field_blur', p, [150, 75], box, false, 8)!;
  assert.deepEqual(a, { params: { pins: [{ x: 0.5, y: 0.5, blur: 15 }, { x: 0.25, y: 0.25, blur: 8 }] }, id: 'pin:1' });
  assert.deepEqual(drag('field_blur', a.params, 'pin:1', [300, 150], box), { pins: [{ x: 0.5, y: 0.5, blur: 15 }, { x: 1, y: 1, blur: 8 }] });
  assert.deepEqual(removeHandle('field_blur', a.params, 'pin:0'), { pins: [{ x: 0.25, y: 0.25, blur: 8 }] });
  assert.equal(removeHandle('field_blur', p, 'pin:0'), null);
  assert.equal(ringBlur(10, Math.PI), 60);
  assert.equal(ringBlur(10, -Math.PI), 0);
});

test('path blur: click appends to the last path, Alt-click starts a new path, delete drops points then paths', () => {
  const p = { paths: [[{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }]] };
  const a = addAt('path_blur', p, [200, 50], box, false, 0)!;
  assert.deepEqual(a, { params: { paths: [[{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }, { x: 0.5, y: 0 }]] }, id: 'pt:0:2' });
  const b = addAt('path_blur', p, [100, 50], box, true, 0)!;
  assert.deepEqual(b, { params: { paths: [p.paths[0], [{ x: 0, y: 0 }, { x: 0, y: 0 }]] }, id: 'pt:1:1' });
  assert.deepEqual(removeHandle('path_blur', a.params, 'pt:0:0'), { paths: [[{ x: 0.8, y: 0.5 }, { x: 0.5, y: 0 }]] });
  assert.deepEqual(removeHandle('path_blur', b.params, 'pt:1:0'), { paths: [p.paths[0]] });
  assert.equal(removeHandle('path_blur', p, 'pt:0:0'), null);
  assert.equal(addAt('iris_blur', {}, [0, 0], box, false, 0), null);
});

test('handle results snap to the dialog field steps so the form stays valid', () => {
  const spec = [
    { key: 'aspect', kind: 'number', step: 0.01 }, { key: 'center', kind: 'point', step: 0.001 }, { key: 'rotation', kind: 'angle', step: 1 },
  ] as FilterParam[];
  const s = snap(spec, { aspect: 0.677, center: { x: 0.3456, y: 0.1 }, rotation: -22.4999, pins: [] });
  assert.deepEqual(s, { aspect: 0.68, center: { x: 0.346, y: 0.1 }, rotation: -22, pins: [] });
});
