import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hitGuide, rulerDragToDoc, tickStep, ticksFor } from './rulers.ts';

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

test('rulerDragToDoc converts a ruler-drag screen position to a document coordinate at zoom 2 and pan', () => {
  const view = { zoom: 2, rot: 0, cx: 100, cy: 50 };
  assert.equal(rulerDragToDoc(view, 'x', 500, 800, 600), 150);
  assert.equal(rulerDragToDoc(view, 'y', 400, 800, 600), 100);
});

test('hitGuide finds the nearest guide within 4 screen px on its own axis, else null', () => {
  const view = { zoom: 2, rot: 0, cx: 0, cy: 0 };
  const guides = [{ id: 1, axis: 'x' as const, pos: 100 }, { id: 2, axis: 'y' as const, pos: 50 }];
  // Guide 1 (axis x, doc pos 100) sits at screen x = 800/2 + 2*100 = 600.
  assert.equal(hitGuide(guides, view, 604, 0, 800, 600), 1);
  assert.equal(hitGuide(guides, view, 607, 0, 800, 600), null);
  // Guide 2 (axis y, doc pos 50) sits at screen y = 600/2 + 2*50 = 400.
  assert.equal(hitGuide(guides, view, 0, 396, 800, 600), 2);
});

test('a flipped view runs the ruler right to left and keeps guides and ruler drags mirrored', () => {
  // pxPerUnit < 0: unit 0 at the right, values grow toward the left; the visible span is still covered.
  const ticks = ticksFor(-1, 500, 500, 50);
  assert.ok(ticks.length > 0);
  assert.ok(Math.min(...ticks.map(t => t.pos)) <= 0 && Math.max(...ticks.map(t => t.pos)) >= 500);
  for (const t of ticks) assert.equal(t.pos, 500 - t.value);
  const view = { zoom: 2, rot: 0, cx: 100, cy: 50, flip: true };
  assert.equal(rulerDragToDoc(view, 'x', 500, 800, 600), 50);
  assert.equal(rulerDragToDoc(view, 'y', 400, 800, 600), 100);
  // Guide at doc x 150 sits at screen x = 400 - 2*(150-100) = 300.
  assert.equal(hitGuide([{ id: 1, axis: 'x' as const, pos: 150 }], view, 302, 0, 800, 600), 1);
});
