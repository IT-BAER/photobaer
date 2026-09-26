import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuildUp, inputFields, strideFor, strokeSeed } from './strokeInput.ts';

const ev = (pointerType: string, pressure: number, tiltX = 0, tiltY = 0, twist = 0) => ({ pointerType, pressure, tiltX, tiltY, twist });

test('pen strokes use stride 6 with tilt and twist; mouse and touch use stride 3 at pressure 0.5', () => {
  assert.equal(strideFor('pen'), 6);
  assert.equal(strideFor('mouse'), 3);
  assert.equal(strideFor('touch'), 3);
  assert.deepEqual(inputFields(ev('pen', 0.8, 30, -20, 45), 6), [0.8, 30, -20, 45]);
  assert.deepEqual(inputFields(ev('pen', 1.5), 6), [1, 0, 0, 0]);
  assert.deepEqual(inputFields(ev('pen', 0.25, 30, 0, 0), 3), [0.25]);
  assert.deepEqual(inputFields(ev('mouse', 1), 3), [0.5]);
  assert.deepEqual(inputFields(ev('touch', 0.9), 3), [0.5]);
  assert.deepEqual(inputFields(ev('mouse', 0, 10, 10, 10), 6), [0.5, 10, 10, 10]);
  assert.deepEqual(inputFields(ev('pen', Number.NaN), 3), [0.5]);
});

test('strokeSeed is a deterministic unsigned 32-bit hash of layer and counter', () => {
  const a = strokeSeed(1, 1);
  assert.equal(a, strokeSeed(1, 1));
  assert.ok(Number.isInteger(a) && a >= 0 && a <= 0xffffffff);
  const seen = new Set<number>();
  for (let l = 1; l <= 8; l++) for (let c = 0; c < 64; c++) seen.add(strokeSeed(l, c));
  assert.equal(seen.size, 8 * 64);
});

test('BuildUp emits 60 dabs per second of standing still and nothing for time spent moving', () => {
  const b = new BuildUp(0);
  let n = 0;
  for (let t = 16; t <= 1000; t += 16) n += b.tick(t);
  // 992 ms elapsed at 60/s is 59.52 dabs.
  assert.equal(n, 59);
  const m = new BuildUp(0);
  let moving = 0;
  for (let t = 16; t <= 1000; t += 16) { m.moved(t); moving += m.tick(t); }
  assert.equal(moving, 0);
});

test('BuildUp caps the debt of one long gap so a stalled tab does not burst', () => {
  const b = new BuildUp(0);
  assert.equal(b.tick(5000), 6);
  assert.equal(b.tick(5000), 0);
  assert.equal(b.tick(4000), 0);
});
