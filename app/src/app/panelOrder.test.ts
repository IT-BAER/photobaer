import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadOrder, moveItem, saveOrder } from './panelOrder.ts';

const mem = (init: Record<string, string> = {}) => {
  const data = { ...init };
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
};
const DEF = ['a', 'b', 'c', 'd'] as const;

test('loadOrder falls back to the defaults and keeps a stored order', () => {
  assert.deepEqual(loadOrder('k', DEF, mem()), ['a', 'b', 'c', 'd']);
  assert.deepEqual(loadOrder('k', DEF, mem({ k: 'not json' })), ['a', 'b', 'c', 'd']);
  assert.deepEqual(loadOrder('k', DEF, mem({ k: '["d","c","b","a"]' })), ['d', 'c', 'b', 'a']);
});

test('loadOrder drops unknown and repeated keys and inserts missing ones after their default predecessor', () => {
  assert.deepEqual(loadOrder('k', DEF, mem({ k: '["c","x","a","c",3]' })), ['c', 'd', 'a', 'b']);
  assert.deepEqual(loadOrder('k', DEF, mem({ k: '["d","b"]' })), ['a', 'd', 'b', 'c']);
});

test('saveOrder round-trips through loadOrder', () => {
  const s = mem();
  saveOrder('k', ['b', 'a', 'd', 'c'], s);
  assert.deepEqual(loadOrder('k', DEF, s), ['b', 'a', 'd', 'c']);
});

test('moveItem places an item before or after a target', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 'a', 'c', true), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 'd', 'a', false), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 'b', 'b', true), ['a', 'b', 'c', 'd']);
  assert.deepEqual(moveItem(['a', 'b'], 'a', 'z', true), ['a', 'b']);
});
