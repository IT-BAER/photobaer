import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toInput, toMask } from './tensor.ts';

test('toInput lays an RGBA image out as planar RGB, normalized as (v - 128) / 256, alpha ignored', () => {
  const rgba = Uint8Array.from([128, 0, 255, 255, 10, 20, 30, 0]);
  const t = toInput(rgba, 2, 1);
  assert.deepEqual([...t], [0, (10 - 128) / 256, -0.5, (20 - 128) / 256, 127 / 256, (30 - 128) / 256]);
  assert.throws(() => toInput(rgba, 2, 2), /2 x 2/);
});

test('toMask stretches the model output to 0..255 and is empty when no pixel reaches half certainty', () => {
  assert.deepEqual([...toMask(Float32Array.from([0, 0.25, 1, 0.5]))], [0, 64, 255, 128]);
  assert.deepEqual([...toMask(Float32Array.from([0.1, 0.3, 0.6]))], [0, 102, 255], 'min-max stretched');
  assert.deepEqual([...toMask(Float32Array.from([0.1, 0.2, 0.45]))], [0, 0, 0], 'no subject');
  assert.deepEqual([...toMask(Float32Array.from([0.9, 0.9]))], [255, 255], 'flat and certain');
  assert.deepEqual([...toMask(Float32Array.from([NaN, 1, 0]))], [0, 255, 0]);
});
