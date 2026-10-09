import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasItems, layerRowItems, pickItems } from './contextMenus.ts';
import type { Item } from './helpers.ts';

const it = (label: string, off = false, sub?: Item[]): Item => ({ label, run: () => {}, off, sub });
const menus = {
  Layer: [it('Layer via Copy'), it('Duplicate Layer'), it('Merge Layers'), it('Add Layer Mask', true), it('Rasterize', false, [it('Type', true), it('Shape')]), it('Layer Style', false, [it('Blending Options…')])],
  Select: [it('All'), it('Deselect'), it('Inverse'), it('Modify', false, [it('Feather…')]), it('Reselect', true)],
  Edit: [it('Free Transform'), it('Fill…'), it('Stroke…')],
};

test('pickItems: alternatives, submenus, renames, separators between groups', () => {
  const r = pickItems(menus, [['Layer/Merge Down|Merge Layers', 'Select/All=Select All'], ['Missing/X'], ['Layer/Rasterize>', 'Layer/Layer Style/Blending Options…']]);
  assert.deepEqual(r.map(i => [i.label, !!i.sep]), [['Merge Layers', false], ['Select All', false], ['Rasterize Shape', true], ['Blending Options…', false]]);
});

test('layerRowItems keeps disabled state and appends the row items after a separator', () => {
  const r = layerRowItems(menus, [it('Copy CSS'), it('Copy SVG')]);
  assert.equal(r.find(i => i.label === 'Add Layer Mask')?.off, true);
  assert.deepEqual(r.slice(-2).map(i => [i.label, !!i.sep]), [['Copy CSS', true], ['Copy SVG', false]]);
});

test('canvasItems switches on the selection', () => {
  assert.deepEqual(canvasItems(menus, true).map(i => i.label), ['Deselect', 'Select Inverse', 'Feather…', 'Layer via Copy', 'Free Transform', 'Fill…', 'Stroke…']);
  assert.deepEqual(canvasItems(menus, false).map(i => i.label), ['Select All', 'Reselect', 'Free Transform']);
});
