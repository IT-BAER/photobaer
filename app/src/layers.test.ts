import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LayerNode } from './engine.worker.ts';
import { dropTarget } from './layers.ts';
import { defaultBlending } from './layerStyle.ts';

const node = (id: number, children?: LayerNode[]): LayerNode => ({
  id, name: `n${id}`, kind: children ? 'group' : 'pixel', visible: true, opacity: 1, fill: 1,
  blend: children ? 'pass through' : 'normal', clipping: false,
  locks: { transparency: false, pixels: false, position: false }, mask: null, style: null, blending: defaultBlending(), ...(children ? { children } : {}),
});
// Root bottom to top: 1, group 2 [3, 4], 5.
const tree = () => [node(1), node(2, [node(3), node(4)]), node(5)];

test('above and below in the same list use the index after removal', () => {
  assert.deepEqual(dropTarget(tree(), 1, 5, 'above'), { parent: 0, index: 2 });
  assert.deepEqual(dropTarget(tree(), 5, 1, 'below'), { parent: 0, index: 0 });
  assert.deepEqual(dropTarget(tree(), 5, 2, 'above'), null);
  assert.deepEqual(dropTarget(tree(), 1, 2, 'below'), null);
});

test('moves across lists and into a group at its top', () => {
  assert.deepEqual(dropTarget(tree(), 5, 3, 'above'), { parent: 2, index: 1 });
  assert.deepEqual(dropTarget(tree(), 3, 5, 'below'), { parent: 0, index: 2 });
  assert.deepEqual(dropTarget(tree(), 1, 2, 'into'), { parent: 2, index: 2 });
  assert.deepEqual(dropTarget(tree(), 3, 2, 'into'), { parent: 2, index: 1 });
});

test('rejects drops onto itself, into its own subtree, and into a pixel layer', () => {
  assert.equal(dropTarget(tree(), 2, 2, 'above'), null);
  assert.equal(dropTarget(tree(), 2, 3, 'above'), null);
  assert.equal(dropTarget(tree(), 2, 2, 'into'), null);
  assert.equal(dropTarget(tree(), 1, 5, 'into'), null);
  assert.equal(dropTarget(tree(), 9, 5, 'above'), null);
});
