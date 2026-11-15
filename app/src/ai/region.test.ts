import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipMask, objectRegion } from './region.ts';

test('objectRegion pads the drawn shape by a tenth (at least 8 px) and clips it to the canvas', () => {
  assert.deepEqual(objectRegion([100, 50, 300, 50, 300, 250, 100, 250], 1000, 1000), [80, 30, 240, 240]);
  assert.deepEqual(objectRegion([10, 10, 40, 30], 1000, 1000), [2, 2, 46, 36], 'at least 8 px');
  assert.deepEqual(objectRegion([5, 5, 995, 995], 1000, 1000), [0, 0, 1000, 1000], 'clipped');
  assert.equal(objectRegion([10, 10, 11, 40], 1000, 1000), null, 'under 2 px wide');
  assert.equal(objectRegion([1200, 10, 1300, 90], 1000, 1000), null, 'off the canvas');
  assert.equal(objectRegion([], 1000, 1000), null);
});

test('clipMask keeps the mask only where pixel centres lie inside the drawn polygon', () => {
  // A 4 x 4 mask over the document rect [0, 0, 8, 8]: each mask pixel covers 2 x 2 document pixels.
  const mask = new Uint8Array(16).fill(200);
  const square = clipMask(mask, 4, [0, 0, 8, 8], [2, 2, 6, 2, 6, 6, 2, 6]);
  assert.deepEqual([...square], [0, 0, 0, 0, 0, 200, 200, 0, 0, 200, 200, 0, 0, 0, 0, 0]);
  // A triangle with its right angle at the top left: centres (1, 1), (3, 1), (1, 3) are inside.
  const tri = clipMask(mask, 4, [0, 0, 8, 8], [0, 0, 6, 0, 0, 6]);
  assert.deepEqual([...tri], [200, 200, 0, 0, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  // The rect offset in the document maps the polygon into mask space.
  const off = clipMask(Uint8Array.from([9, 9, 9, 9]), 2, [100, 100, 20, 20], [100, 100, 110, 100, 110, 120, 100, 120]);
  assert.deepEqual([...off], [9, 0, 9, 0]);
  assert.deepEqual([...clipMask(mask, 4, [0, 0, 8, 8], [1, 1, 2, 2])], new Array(16).fill(0), 'degenerate polygon');
});
