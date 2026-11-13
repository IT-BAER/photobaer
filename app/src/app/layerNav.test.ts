import test from 'node:test';
import assert from 'node:assert/strict';
import type { LayerNode } from '../worker/types.ts';
import { layerStep, panelRows } from './layerNav.ts';

const node = (id: number, children?: LayerNode[]) => ({ id, name: `n${id}`, kind: children ? 'group' : 'pixel', children }) as LayerNode;
// Bottom to top: 1, group 2 [3, 4], 5. Panel rows: 5, 2, 4, 3, 1.
const tree = [node(1), node(2, [node(3), node(4)]), node(5)];
const none = new Set<number>();

test('panel rows run top to bottom with each group before its children', () => {
  assert.deepEqual(panelRows(tree, none), [5, 2, 4, 3, 1]);
  assert.deepEqual(panelRows(tree, new Set([2])), [5, 2, 1]);
});

test('above and below walk the rows and stop at the ends', () => {
  assert.equal(layerStep(tree, none, 5, 'below'), 2);
  assert.equal(layerStep(tree, none, 2, 'below'), 4);
  assert.equal(layerStep(tree, none, 3, 'below'), 1);
  assert.equal(layerStep(tree, none, 1, 'below'), 1);
  assert.equal(layerStep(tree, none, 4, 'above'), 2);
  assert.equal(layerStep(tree, none, 5, 'above'), 5);
});

test('top and bottom, and no active layer', () => {
  assert.equal(layerStep(tree, none, 3, 'top'), 5);
  assert.equal(layerStep(tree, none, 3, 'bottom'), 1);
  assert.equal(layerStep(tree, none, null, 'above'), 5);
  assert.equal(layerStep(tree, none, null, 'below'), 1);
  assert.equal(layerStep([], none, null, 'above'), null);
});

test('a collapsed group is one row; a hidden active layer counts as its group', () => {
  const c = new Set([2]);
  assert.equal(layerStep(tree, c, 5, 'below'), 2);
  assert.equal(layerStep(tree, c, 2, 'below'), 1);
  assert.equal(layerStep(tree, c, 3, 'below'), 1);
  assert.equal(layerStep(tree, c, 3, 'above'), 5);
});
