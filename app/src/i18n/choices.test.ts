import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLEND_MODES, HDR_BLEND_MODES } from '../layers.ts';
import { PAINT_MODES, TOOLS } from '../shell/tools.ts';
import { CHOICE_LABELS, choiceLabel } from './choices.ts';

test('every blend, paint and tool option choice id has display text', () => {
  const ids = new Set([...BLEND_MODES, ...HDR_BLEND_MODES, ...PAINT_MODES, ...Object.values(TOOLS).flatMap(t => t.options.flatMap(o => o.choices ?? []))]);
  assert.deepEqual([...ids].filter(id => !Object.hasOwn(CHOICE_LABELS, id)), []);
});

test('choiceLabel shows title case English and passes unknown ids through', () => {
  assert.equal(choiceLabel('linear burn'), 'Linear Burn');
  assert.equal(choiceLabel('backgroundSwatch'), 'Background Swatch');
  assert.equal(choiceLabel('no such id'), 'no such id');
  assert.equal(choiceLabel('toString'), 'toString');
});
