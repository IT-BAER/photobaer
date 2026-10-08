import test from 'node:test';
import assert from 'node:assert/strict';
import { filterByName, filterIds, filterLayers, type KindFilter } from './layerFilter.ts';
import type { LayerNode } from '../engine.worker.ts';

const n = (id: number, kind: LayerNode['kind'], children?: LayerNode[]) => ({ id, kind, name: `${kind} ${id}`, children } as LayerNode);
const tree = [n(1, 'pixel'), n(2, 'fill'), n(3, 'group', [n(4, 'text'), n(5, 'group', [n(6, 'shape')])]), n(7, 'group', [n(8, 'pixel')]), n(9, 'smart'), n(10, 'adjustment')];
const ids = (l: LayerNode[]): number[] => l.flatMap(x => [x.id, ...ids(x.children ?? [])]);
const f = (...k: KindFilter[]) => ids(filterLayers(tree, new Set(k)));

test('no kinds shows everything', () => assert.equal(filterLayers(tree, new Set()), tree));
test('pixel keeps pixel layers and the groups holding them', () => assert.deepEqual(f('pixel'), [1, 7, 8]));
test('adjustment covers fill layers', () => assert.deepEqual(f('adjustment'), [2, 10]));
test('a group shows when any descendant matches, nested', () => assert.deepEqual(f('shape'), [3, 5, 6]));
test('several kinds combine', () => assert.deepEqual(f('type', 'smart'), [3, 4, 9]));
test('name filter matches case-insensitively and keeps the groups holding matches', () => {
  assert.deepEqual(ids(filterByName(tree, 'SHAPE')), [3, 5, 6]);
  assert.deepEqual(ids(filterByName(tree, 'group 7')), [7, 8], 'a matching group keeps its layers');
  assert.equal(filterByName(tree, '  '), tree, 'blank text shows everything');
});
test('isolate keeps the listed layers and their parent groups', () => {
  assert.deepEqual(ids(filterIds(tree, [6, 9])), [3, 5, 6, 9]);
  assert.deepEqual(ids(filterIds(tree, [])), []);
});
