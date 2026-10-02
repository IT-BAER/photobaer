import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenMenus, searchCommands } from './commandSearch.ts';

const noop = () => {};
const menus = {
  Layer: [
    { label: 'Arrange', keys: '›', run: noop, sub: [{ label: 'Bring Forward', keys: 'Ctrl+]', run: noop }, { label: 'Send Backward', run: noop, off: true }] },
    { label: '', run: noop },
    { label: 'Duplicate Layer', sep: true, run: noop },
  ],
  Edit: [{ label: 'Layer Mask', run: noop }, { label: 'Fill', run: noop }, { label: 'Backfill', run: noop }],
};

test('flatten builds paths for nested submenus and skips empty labels', () => {
  const all = flattenMenus(menus);
  assert.deepEqual(all.map(c => c.path), [
    'Layer > Arrange > Bring Forward', 'Layer > Arrange > Send Backward', 'Layer > Duplicate Layer',
    'Edit > Layer Mask', 'Edit > Fill', 'Edit > Backfill',
  ]);
  assert.equal(all[0].keys, 'Ctrl+]');
  assert.equal(all[1].off, true);
  assert.equal(all[2].off, false);
});

test('search ranks label prefix, word start, substring, then path only', () => {
  const all = flattenMenus(menus);
  assert.deepEqual(searchCommands(all, 'fill').map(c => c.label), ['Fill', 'Backfill']);
  assert.deepEqual(searchCommands(all, 'layer').map(c => c.path), [
    'Edit > Layer Mask', 'Layer > Duplicate Layer', 'Layer > Arrange > Bring Forward', 'Layer > Arrange > Send Backward',
  ]);
});

test('all words must occur in path or label, case-insensitive', () => {
  const all = flattenMenus(menus);
  assert.deepEqual(searchCommands(all, 'ARRANGE forward').map(c => c.label), ['Bring Forward']);
  assert.deepEqual(searchCommands(all, 'arrange nothing'), []);
  assert.equal(searchCommands(all, 'send')[0].off, true);
});

test('empty query keeps menu order and results are capped at 50', () => {
  const many = { M: Array.from({ length: 80 }, (_, i) => ({ label: `Item ${i}`, run: noop })) };
  const r = searchCommands(flattenMenus(many), '');
  assert.equal(r.length, 50);
  assert.equal(r[0].label, 'Item 0');
  assert.equal(r[49].label, 'Item 49');
});
