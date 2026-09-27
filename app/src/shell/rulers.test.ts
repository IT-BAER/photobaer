import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tickStep, ticksFor } from './rulers.ts';

test('tickStep picks the smallest 1-2-5 step that keeps labels >= minPx apart', () => {
  assert.equal(tickStep(1, 50), 50);
  assert.equal(tickStep(10, 50), 5);
  assert.equal(tickStep(100, 50), 0.5);
  assert.equal(tickStep(0.5, 50), 100);
});

test('ticksFor covers the visible span and marks every 5th tick major', () => {
  const ticks = ticksFor(1, 0, 500, 50);
  assert.ok(ticks[0].pos <= 0);
  assert.ok(ticks.at(-1)!.pos >= 500);
  for (const t of ticks) assert.equal(t.major, Math.round(t.value / 50) % 5 === 0);
});
