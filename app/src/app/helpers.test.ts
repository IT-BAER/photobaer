import test from 'node:test';
import assert from 'node:assert/strict';
import type { DocInfo } from '../worker/types.ts';
import { FILL_CONTENTS, needsLayer, nextActive } from './helpers.ts';

test('Fill contents list Content-Aware between Color… and Pattern', () => {
  assert.deepEqual(Object.values(FILL_CONTENTS).map(d => d.message), ['Foreground Color', 'Background Color', 'Color…', 'Content-Aware', 'Pattern', 'History', 'Black', '50% Gray', 'White']);
});

const L = (...ids: number[]) => ({ layers: ids.map(id => ({ id, children: [] })) }) as unknown as DocInfo;

test('nextActive keeps no active layer on the same document and after undo', () => {
  assert.equal(nextActive(L(1, 2), true, null, undefined), null);
});

test('nextActive keeps the active layer on the same document while it exists, else the top layer', () => {
  assert.deepEqual(nextActive(L(1, 2), true, { id: 1, target: 'mask' }, undefined), { id: 1, target: 'mask' });
  assert.deepEqual(nextActive(L(1, 2), true, { id: 9, target: 'pixels' }, undefined), { id: 2, target: 'pixels' });
});

test('nextActive selects the top layer of a new document', () => {
  assert.deepEqual(nextActive(L(1, 2), false, null, undefined), { id: 2, target: 'pixels' });
  assert.deepEqual(nextActive(L(1, 2), false, { id: 1, target: 'pixels' }, undefined), { id: 2, target: 'pixels' });
});

test('nextActive restores the saved layer of a tab, including none', () => {
  assert.deepEqual(nextActive(L(1, 2), false, null, { active: { id: 1, target: 'pixels' } }), { id: 1, target: 'pixels' });
  assert.equal(nextActive(L(1, 2), false, { id: 2, target: 'pixels' }, { active: null }), null);
  assert.deepEqual(nextActive(L(1, 2), false, null, { active: { id: 9, target: 'pixels' } }), { id: 2, target: 'pixels' });
});

test('nextActive lets selectAfter win', () => {
  assert.deepEqual(nextActive(L(1, 2, 3), true, null, undefined, () => ({ id: 3, target: 'pixels' })), { id: 3, target: 'pixels' });
});

test('needsLayer: tools that change a layer refuse to start without one', () => {
  const key = { ctrlKey: false, metaKey: false };
  for (const tool of ['brush', 'eraser', 'cloneStamp', 'move', 'magneticLasso', 'bucket', 'magicEraser', 'gradient', 'magicWand', 'quickSelection']) {
    assert.equal(needsLayer(tool, {}, key), true, tool);
  }
  for (const tool of ['marqueeRect', 'lasso', 'polygonalLasso', 'crop', 'pen', 'typeHorizontal', 'eyedropper', 'hand', 'rectangle']) {
    assert.equal(needsLayer(tool, {}, key), false, tool);
  }
  assert.equal(needsLayer('magicWand', { sampleAllLayers: true }, key), false);
  assert.equal(needsLayer('rectangle', { mode: 'pixels' }, key), true);
  assert.equal(needsLayer('move', { autoSelect: true }, key), false);
  assert.equal(needsLayer('move', { autoSelect: true }, { ctrlKey: true, metaKey: false }), true);
  assert.equal(needsLayer('move', {}, { ctrlKey: false, metaKey: true }), false);
});
