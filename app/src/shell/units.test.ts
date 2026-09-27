import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pxToUnit, unitToPx } from './units.ts';

test('unitToPx at 300 ppi matches the spec acceptance table', () => {
  assert.equal(unitToPx(1, 'in', 300), 300);
  assert.ok(Math.abs(unitToPx(1, 'cm', 300) - 118.110) < 0.001);
  assert.ok(Math.abs(unitToPx(1, 'mm', 300) - 11.811) < 0.001);
  assert.ok(Math.abs(unitToPx(1, 'pt', 300) - 4.1667) < 0.0001);
  assert.equal(unitToPx(1, 'pica', 300), 50);
  assert.equal(unitToPx(50, 'percent', 300, 1000), 500);
});

test('px passes through unchanged', () => {
  assert.equal(unitToPx(42, 'px', 300), 42);
  assert.equal(pxToUnit(42, 'px', 300), 42);
});

test('round trips px -> unit -> px exactly within 1e-9', () => {
  for (const unit of ['in', 'cm', 'mm', 'pt', 'pica'] as const) {
    const px = 237.5;
    const back = unitToPx(pxToUnit(px, unit, 300), unit, 300);
    assert.ok(Math.abs(back - px) < 1e-9, unit);
  }
  const px = 237.5, docSize = 1000;
  const back = unitToPx(pxToUnit(px, 'percent', 300, docSize), 'percent', 300, docSize);
  assert.ok(Math.abs(back - px) < 1e-9, 'percent');
});
