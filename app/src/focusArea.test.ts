import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusView, strokeEdit } from './focusArea.ts';

const img = Uint8Array.from([100, 50, 200, 255, 100, 50, 200, 255]);
const mask = Uint8Array.from([255, 0]);

test('focusView shows the in-focus area per view, with brush edits over the mask', () => {
  const px = (v: Uint8ClampedArray, i: number) => [...v.subarray(i * 4, i * 4 + 4)];
  assert.deepEqual(px(focusView(img, mask, null, 'black', true), 1), [0, 0, 0, 255]);
  assert.deepEqual(px(focusView(img, mask, null, 'white', true), 1), [255, 255, 255, 255]);
  assert.deepEqual(px(focusView(img, mask, null, 'bw', true), 0), [255, 255, 255, 255]);
  assert.deepEqual(px(focusView(img, mask, null, 'overlay', true), 1), [178, 25, 100, 255], 'half red over the image');
  assert.deepEqual(px(focusView(img, mask, null, 'overlay', true), 0), [100, 50, 200, 255]);
  assert.deepEqual(px(focusView(img, mask, null, 'bw', false), 1), [100, 50, 200, 255], 'Preview off: the image');
  const edits = Uint8Array.from([0, 255]);
  assert.deepEqual(px(focusView(img, mask, edits, 'bw', true), 0), [0, 0, 0, 255], 'removed');
  assert.deepEqual(px(focusView(img, mask, edits, 'bw', true), 1), [255, 255, 255, 255], 'added');
  assert.deepEqual(px(focusView(img, mask, Uint8Array.from([128, 128]), 'bw', true), 1), [0, 0, 0, 255], 'kept');
});

test('strokeEdit paints discs along the stroke without gaps', () => {
  const w = 20, h = 5, e = new Uint8Array(w * h).fill(128);
  strokeEdit(e, w, h, [2.5, 2.5], [17.5, 2.5], 1, 255);
  for (let x = 2; x <= 17; x++) assert.equal(e[2 * w + x], 255, `x ${x}`);
  assert.equal(e[2 * w + 0], 128);
  assert.equal(e[0 * w + 10], 128, 'outside the radius');
  strokeEdit(e, w, h, null, [10.5, 2.5], 1.5, 0);
  assert.deepEqual([e[2 * w + 9], e[2 * w + 10], e[2 * w + 11], e[1 * w + 10], e[3 * w + 10]], [0, 0, 0, 0, 0]);
  strokeEdit(e, w, h, null, [-5, -5], 2, 0);
  assert.equal(e[0], 128, 'off the image paints nothing');
});
