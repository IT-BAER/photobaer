import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorTargets, linkChanges, linkedIds } from './layerLinks.ts';
import type { LayerNode } from '../worker/types.ts';

const n = (id: number, link = 0, children?: LayerNode[]) => ({ id, link, kind: children ? 'group' : 'pixel', children }) as unknown as LayerNode;
// Bottom to top: 1, 2, group 3 holding 4 and 5, 6.
const tree = (links: Record<number, number> = {}) => [n(1, links[1]), n(2, links[2]), n(3, links[3], [n(4, links[4]), n(5, links[5])]), n(6, links[6])];

test('linkChanges links the selection into a new group id above every existing one', () => {
  assert.deepEqual(linkChanges(tree({ 2: 4, 6: 4 }), [1, 5]), { linked: true, changes: [[1, 5], [5, 5]] });
  assert.deepEqual(linkChanges(tree(), [2, 4, 6]), { linked: true, changes: [[2, 1], [4, 1], [6, 1]] });
});

test('linkChanges unlinks a selection that is one link group, and a group left with one layer dissolves', () => {
  assert.deepEqual(linkChanges(tree({ 1: 2, 2: 2, 6: 2 }), [1, 2, 6]), { linked: false, changes: [[1, 0], [2, 0], [6, 0]] });
  assert.deepEqual(linkChanges(tree({ 1: 2, 2: 2 }), [1]), { linked: false, changes: [[1, 0], [2, 0]] }, 'the partner alone is no link');
  assert.deepEqual(linkChanges(tree({ 1: 2, 2: 2, 6: 2 }), [6]), { linked: false, changes: [[6, 0]] });
});

test('linkChanges joins a mixed selection into one new group and dissolves the groups it emptied', () => {
  assert.deepEqual(linkChanges(tree({ 1: 3, 2: 3, 4: 7 }), [1, 4]), { linked: true, changes: [[1, 8], [4, 8], [2, 0]] });
});

test('linkChanges needs two layers or a linked one', () => {
  assert.equal(linkChanges(tree(), [2]), null);
  assert.equal(linkChanges(tree(), []), null);
});

test('linkedIds adds every layer that shares a link group, top-level and nested', () => {
  assert.deepEqual(linkedIds(tree({ 1: 2, 5: 2, 6: 9 }), [1]).sort(), [1, 5]);
  assert.deepEqual(linkedIds(tree({ 1: 2, 5: 2, 6: 9 }), [6, 2]).sort(), [2, 6]);
  assert.deepEqual(linkedIds(tree(), [4]), [4]);
});

test('colorTargets takes the selected layers and every layer inside a selected group', () => {
  assert.deepEqual(colorTargets(tree(), [3]).sort(), [3, 4, 5]);
  assert.deepEqual(colorTargets(tree(), [4, 3, 1]).sort(), [1, 3, 4, 5]);
  assert.deepEqual(colorTargets(tree(), [9]), []);
});
