import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangeGrid, clampFloatRect, displayedDocumentKeys, matchDocumentViews, reconcileFloatRects, type ArrangeMode, type TabViewState } from './arrange.ts';

const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

test('every arrangement includes the active document once and applies its capacity', () => {
  const expected: Record<ArrangeMode, string[]> = {
    tabs: ['g'], vertical: keys, horizontal: keys, '2-up': ['a', 'g'], '3-up': ['a', 'b', 'g'],
    '4-up': ['a', 'b', 'c', 'g'], '6-up': ['a', 'b', 'c', 'd', 'e', 'g'], float: keys,
  };
  for (const mode of Object.keys(expected) as ArrangeMode[]) {
    const shown = displayedDocumentKeys(mode, keys, 'g');
    assert.deepEqual(shown, expected[mode], mode);
    assert.equal(shown.filter(k => k === 'g').length, 1, mode);
  }
  assert.deepEqual(displayedDocumentKeys('4-up', ['a', 'b'], 'missing'), ['a', 'b']);
  assert.deepEqual(displayedDocumentKeys('tabs', [], null), []);
});

test('grid shapes and cells cover vertical, horizontal, and N-up layouts', () => {
  assert.deepEqual(arrangeGrid('vertical', ['a', 'b', 'c']), { rows: 1, columns: 3, cells: [
    { key: 'a', row: 1, column: 1 }, { key: 'b', row: 1, column: 2 }, { key: 'c', row: 1, column: 3 },
  ] });
  assert.deepEqual(arrangeGrid('horizontal', ['a', 'b', 'c']), { rows: 3, columns: 1, cells: [
    { key: 'a', row: 1, column: 1 }, { key: 'b', row: 2, column: 1 }, { key: 'c', row: 3, column: 1 },
  ] });
  assert.deepEqual([2, 3, 4, 6].map(n => {
    const grid = arrangeGrid(`${n}-up` as ArrangeMode, keys.slice(0, n));
    return [grid.rows, grid.columns, grid.cells.at(-1)];
  }), [
    [1, 2, { key: 'b', row: 1, column: 2 }],
    [2, 2, { key: 'c', row: 2, column: 1 }],
    [2, 2, { key: 'd', row: 2, column: 2 }],
    [2, 3, { key: 'f', row: 2, column: 3 }],
  ]);
});

test('match operations preserve unrelated view fields and tab selection state', () => {
  const states = new Map<string, TabViewState>([
    ['a', { view: { zoom: 2, rot: 0.2, cx: 10, cy: 20 }, active: { id: 9, target: 'pixels' }, picked: [9] }],
    ['b', { view: { zoom: 0.5, rot: 0.7, cx: 70, cy: 80 }, active: null, picked: [3] }],
  ]);
  const source = { zoom: 4, rot: 1.1, cx: 40, cy: 50 };
  const zoom = matchDocumentViews(states, ['a', 'b', 'c'], 'a', source, 'zoom');
  assert.deepEqual(zoom.get('b'), { view: { zoom: 4, rot: 0.7, cx: 70, cy: 80 }, active: null, picked: [3] });
  assert.deepEqual(zoom.get('c'), { view: source, active: null, picked: [] });
  const location = matchDocumentViews(states, ['a', 'b'], 'a', source, 'location');
  assert.deepEqual(location.get('b')!.view, { zoom: 0.5, rot: 0.7, cx: 40, cy: 50 });
  const all = matchDocumentViews(states, ['a', 'b'], 'a', source, 'all');
  assert.deepEqual(all.get('b'), { view: source, active: null, picked: [3] });
  assert.deepEqual(all.get('a')!.view, source, 'the active primary view stays equal to its source');
});

test('float rectangles stay inside the arrangement area', () => {
  assert.deepEqual(clampFloatRect({ x: -10, y: 90, width: 500, height: 20 }, 300, 200), { x: 0, y: 80, width: 300, height: 120 });
  assert.deepEqual(clampFloatRect({ x: 270, y: 170, width: 120, height: 100 }, 400, 300), { x: 270, y: 170, width: 120, height: 120 });
});

test('float resize materializes and clamps untouched panes using the current open keys', () => {
  assert.deepEqual(reconcileFloatRects(['a', 'b'], {}, 392, 278.6), {
    a: { x: 0, y: 0, width: 392, height: 278.6 },
    b: { x: 0, y: 0, width: 392, height: 278.6 },
  });
  assert.deepEqual(reconcileFloatRects(['b'], {
    a: { x: 1, y: 2, width: 200, height: 150 },
    b: { x: 300, y: 200, width: 200, height: 150 },
  }, 400, 300), {
    b: { x: 200, y: 150, width: 200, height: 150 },
  });
});
