import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, fieldSpecs, menuLabel, previewScale, type FilterSpec } from './schema.ts';

const spec = (params: FilterSpec['params']): FilterSpec => ({ id: 'x.y', label: 'Thing', group: 'noise', params, exec: 'local', alpha: 'kept', preview: true, rgb_only: false });
const p = (key: string, kind: FilterSpec['params'][number]['kind'], extra: Partial<FilterSpec['params'][number]> = {}) =>
  ({ key, label: key, kind, min: 0, max: 10, step: 1, unit: '', default: 1, ...extra });

test('menu label, fields and defaults follow the schema; blob and seed stay hidden', () => {
  assert.equal(menuLabel(spec([])), 'Thing');
  assert.equal(menuLabel(spec([p('s', 'seed'), p('b', 'blob', { default: null })])), 'Thing', 'hidden params alone take no dialog');
  const s = spec([p('radius', 'number', { unit: 'px' }), p('mode', 'select', { default: 'gaussianBlur', choices: ['gaussianBlur', 'motion'] }), p('on', 'bool', { default: true }), p('seed', 'seed', { min: 1, max: 1 })]);
  assert.equal(menuLabel(s), 'Thing…');
  assert.deepEqual(fieldSpecs(s), [
    { type: 'number', label: 'radius (px)', path: 'radius', min: 0, max: 10, step: 1 },
    { type: 'select', label: 'mode', path: 'mode', options: [['gaussianBlur', 'Gaussian Blur'], ['motion', 'Motion']] },
    { type: 'checkbox', label: 'on', path: 'on' },
  ]);
  assert.deepEqual(defaults(s), { radius: 1, mode: 'gaussianBlur', on: true, seed: 1 });
});

test('preview proxy scale keeps the visible area at or under 512 x 512', () => {
  assert.equal(previewScale(400, 300), 1);
  assert.equal(previewScale(1024, 1024), 0.5);
});
