import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepTab } from './tabs.ts';

const tabs = (n: number, active: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, active: i === active }));

test('stepTab wraps in both directions', () => {
  assert.equal(stepTab(tabs(3, 0), 1), 'k1');
  assert.equal(stepTab(tabs(3, 2), 1), 'k0');
  assert.equal(stepTab(tabs(3, 0), -1), 'k2');
  assert.equal(stepTab(tabs(3, 1), -1), 'k0');
});

test('stepTab has nowhere to go with one tab or none', () => {
  assert.equal(stepTab(tabs(1, 0), 1), null);
  assert.equal(stepTab([], -1), null);
});
