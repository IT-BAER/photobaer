import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constrainedSnap, rectAnchors, snapAxis, snapOffset, type SnapAxes } from './snapping.ts';

test('rectAnchors gives start, center, end per axis', () => {
  assert.deepEqual(rectAnchors({ x: 10, y: 20, w: 40, h: 10 }, 'x'), [10, 30, 50]);
  assert.deepEqual(rectAnchors({ x: 10, y: 20, w: 40, h: 10 }, 'y'), [20, 25, 30]);
});

test('snapAxis picks the anchor/target pair with the smallest distance inside the catch threshold', () => {
  // anchors 0, 50, 100 (a 100-wide rect at offset 0); targets 3 and 52: 52 beats 3 for the center anchor.
  const lock = snapAxis([0, 50, 100], [3, 52], 0, null, 6, 10);
  assert.deepEqual(lock, { anchor: 50, target: 52 });
});

test('snapAxis returns null outside the catch threshold', () => {
  assert.equal(snapAxis([0], [10], 0, null, 6, 10), null);
});

test('snapAxis hysteresis: a locked pair stays locked past the catch threshold, up to the release threshold', () => {
  const prev = { anchor: 0, target: 0 };
  // offset 8: distance 8 > catch(6) but <= release(10), so the lock holds.
  const held = snapAxis([0], [100], 8, prev, 6, 10);
  assert.deepEqual(held, prev);
  // offset 11: distance 11 > release(10), so the lock is dropped (and nothing else is in catch range).
  const dropped = snapAxis([0], [100], 11, prev, 6, 10);
  assert.equal(dropped, null);
});

test('snapOffset scales catch/release by zoom (screen px / zoom = doc px)', () => {
  const moving = { x: 0, y: 0, w: 0, h: 0 };
  const prev: SnapAxes = { x: null, y: null };
  // At zoom 2, a 6 screen-px catch is 3 doc px; an anchor 4 px off the target is out of range.
  const far = snapOffset(moving, [4], [], 0, 0, prev, 2, 6, 10);
  assert.equal(far.lock.x, null);
  // At zoom 0.5, the same 4 doc-px gap is only 2 screen px, well inside the 6 px catch.
  const near = snapOffset(moving, [4], [], 0, 0, prev, 0.5, 6, 10);
  assert.deepEqual(near.lock.x, { anchor: 0, target: 4 });
  assert.equal(near.dx, 4);
});

test('snapOffset leaves an axis unsnapped at its raw offset when nothing is in range', () => {
  const moving = { x: 0, y: 0, w: 10, h: 10 };
  const r = snapOffset(moving, [], [], 7, -3, { x: null, y: null }, 1);
  assert.equal(r.dx, 7);
  assert.equal(r.dy, -3);
  assert.equal(r.lock.x, null);
  assert.equal(r.lock.y, null);
});

test('constrainedSnap: without Shift it is snapOffset', () => {
  const moving = { x: 0, y: 0, w: 10, h: 10 };
  const r = constrainedSnap(moving, [50], [], 38, 7, { x: null, y: null }, 1, false);
  assert.deepEqual([r.dx, r.dy], [40, 7]);
});

test('constrainedSnap: Shift projects the drag onto the nearest 45 degree direction', () => {
  const r = constrainedSnap({ x: 0, y: 0, w: 10, h: 10 }, [], [], 20, 3, { x: null, y: null }, 1, true);
  assert.deepEqual([r.dx, r.dy], [20, 0]);
});

test('constrainedSnap: on a diagonal the snapped axis leads and the other follows', () => {
  const r = constrainedSnap({ x: 0, y: 0, w: 10, h: 10 }, [50], [], 48, 45, { x: null, y: null }, 1, true);
  assert.deepEqual([r.dx, r.dy], [45, 45]);
  assert.deepEqual(r.lock, { x: { anchor: 5, target: 50 }, y: null });
});

test('constrainedSnap: a horizontal constraint ignores a y snap', () => {
  const r = constrainedSnap({ x: 0, y: 0, w: 10, h: 10 }, [], [2], 30, 1, { x: null, y: null }, 1, true);
  assert.deepEqual([r.dx, r.dy], [30, 0]);
  assert.deepEqual(r.lock, { x: null, y: null });
});
