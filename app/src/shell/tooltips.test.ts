import test from 'node:test';
import assert from 'node:assert/strict';
import { placeTip } from './tooltips.ts';

const view = { width: 800, height: 600 };
const tip = { width: 100, height: 20 };
const rect = (left: number, top: number, width = 20, height = 20) => ({ left, top, right: left + width, bottom: top + height, width, height });

test('tooltip sits centred below its anchor', () => {
  assert.deepEqual(placeTip(rect(390, 100), tip, view), { left: 350, top: 126 });
});

test('tooltip flips above an anchor near the bottom edge', () => {
  assert.deepEqual(placeTip(rect(390, 570), tip, view), { left: 350, top: 544 });
});

test('tooltip stays inside the left and right edges', () => {
  assert.equal(placeTip(rect(0, 100), tip, view).left, 4);
  assert.equal(placeTip(rect(780, 100), tip, view).left, 696);
});
