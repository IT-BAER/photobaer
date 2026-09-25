import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbToHsb, hsbToRgb, rgbToLab, labToRgb, rgbToHex, hexToRgb, isWebSafe, snapWebSafe } from './color.ts';

const close = (a: number, b: number, eps = 0.5) => assert.ok(Math.abs(a - b) <= eps, `${a} ~ ${b}`);

test('rgb <-> hsb round-trips and matches known values', () => {
  assert.deepEqual(rgbToHsb([255, 0, 0]), [0, 100, 100]);
  assert.deepEqual(rgbToHsb([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(rgbToHsb([255, 255, 255]), [0, 0, 100]);
  assert.deepEqual(hsbToRgb([0, 100, 100]), [255, 0, 0]);
  assert.deepEqual(hsbToRgb([120, 100, 100]), [0, 255, 0]);
});

test('rgb -> Lab matches the reference value for pure red', () => {
  const [l, a, b] = rgbToLab([255, 0, 0]);
  close(l, 53.24, 0.1);
  close(a, 80.09, 0.1);
  close(b, 67.20, 0.1);
});

test('Lab -> rgb round-trips within 1 unit', () => {
  for (const rgb of [[255, 0, 0], [10, 200, 30], [128, 128, 128], [0, 0, 0], [255, 255, 255]] as [number, number, number][]) {
    const back = labToRgb(rgbToLab(rgb));
    for (let i = 0; i < 3; i++) close(back[i], rgb[i], 1);
  }
});

test('hex parse and format round-trip', () => {
  assert.deepEqual(hexToRgb('#e8a23a'), [0xe8, 0xa2, 0x3a]);
  assert.equal(hexToRgb('nope'), null);
  assert.equal(rgbToHex([0xe8, 0xa2, 0x3a]), '#e8a23a');
});

test('web-safe detection and snapping', () => {
  assert.equal(isWebSafe([0, 51, 255]), true);
  assert.equal(isWebSafe([1, 51, 255]), false);
  assert.deepEqual(snapWebSafe([10, 40, 250]), [0, 51, 255]);
});
