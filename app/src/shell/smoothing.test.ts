import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leashPx, pullPoint, Smoother } from './smoothing.ts';

test('leashPx scales with smoothing percent and only divides by zoom when adjusting', () => {
  assert.equal(leashPx(10, 2, false), 10);
  assert.equal(leashPx(10, 2, true), 5);
  assert.equal(leashPx(100, 1, true), 100);
});

test('pullPoint holds the paint point inside the leash and pulls it along the string beyond it', () => {
  assert.deepEqual(pullPoint([0, 0], [3, 0], 10), [0, 0]);
  const p = pullPoint([0, 0], [20, 0], 10);
  assert.equal(p[0], 10);
  assert.equal(p[1], 0);
});

test('pullPoint with a zero leash snaps straight to the pointer', () => {
  assert.deepEqual(pullPoint([0, 0], [5, 5], 0), [5, 5]);
});

test('Smoother starts at the first point, trails on move, and catches up on end by default', () => {
  const s = new Smoother({ smoothing: 50, adjustForZoom: false, catchUpOnEnd: true }, 1);
  assert.deepEqual(s.start([0, 0]), [0, 0]);
  const moved = s.move([100, 0]);
  assert.equal(moved[0], 50);
  assert.deepEqual(s.end([100, 0]), [100, 0]);
});

test('Smoother without catch up on end keeps trailing behind at release', () => {
  const s = new Smoother({ smoothing: 50, adjustForZoom: false, catchUpOnEnd: false }, 1);
  s.start([0, 0]);
  s.move([100, 0]);
  const ended = s.end([100, 0]);
  assert.equal(ended[0], 50);
});
