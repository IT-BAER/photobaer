import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leashPx, pullPoint, Smoother } from './smoothing.ts';

test('leashPx is 1.2 screen px per smoothing percent and only divides by zoom when adjusting', () => {
  assert.equal(leashPx(10, 2, false), 12);
  assert.equal(leashPx(10, 2, true), 6);
  assert.equal(leashPx(100, 1, true), 120);
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
  assert.equal(moved[0], 40);
  assert.deepEqual(s.end([100, 0]), [100, 0]);
});

test('Smoother without catch up on end keeps trailing behind at release', () => {
  const s = new Smoother({ smoothing: 50, adjustForZoom: false, catchUpOnEnd: false }, 1);
  s.start([0, 0]);
  s.move([100, 0]);
  const ended = s.end([100, 0]);
  assert.equal(ended[0], 40);
});

test('without pulled string the paint point lags the pointer by a time constant of 80a + 200a^2 ms', () => {
  // a = 0.5: tc = 90 ms. Over 10 ms the lag filter follows a target moving linearly from 0 to 100.
  const s = new Smoother({ smoothing: 50, adjustForZoom: false, catchUpOnEnd: false, pulledString: false, catchUp: false }, 1);
  s.start([0, 0], 0);
  const e = -Math.expm1(-10 / 90), k = 1 - 90 * e / 10;
  const p = s.move([100, 0], 10);
  assert.ok(Math.abs(p[0] - 100 * k) < 1e-9);
  assert.ok(p[0] > 0 && p[0] < 100);
  assert.equal(s.catchUp(1000), null, 'catch-up off never moves the point between events');
});

test('stroke catch-up pulls the paint point to the resting pointer over time and snaps when close', () => {
  const s = new Smoother({ smoothing: 50, adjustForZoom: false, catchUpOnEnd: false, pulledString: false, catchUp: true }, 1);
  s.start([0, 0], 0);
  const p = s.move([100, 0], 10);
  const q = s.catchUp(26)!;
  assert.ok(Math.abs(q[0] - (p[0] + (100 - p[0]) * -Math.expm1(-16 / 90))) < 1e-9);
  assert.deepEqual(s.catchUp(5000), [100, 0]);
  assert.equal(s.catchUp(6000), null, 'nothing to catch up once settled');
});

test('catch-up and pulled string: catch-up is ignored, the leash still holds', () => {
  const s = new Smoother({ smoothing: 50, adjustForZoom: false, catchUpOnEnd: false, pulledString: true, catchUp: true }, 1);
  s.start([0, 0], 0);
  assert.equal(s.move([100, 0], 10)[0], 40);
  assert.equal(s.catchUp(1000), null);
});

test('zero smoothing without pulled string passes the pointer through', () => {
  const s = new Smoother({ smoothing: 0, adjustForZoom: true, catchUpOnEnd: false, pulledString: false, catchUp: true }, 2);
  s.start([0, 0], 0);
  assert.deepEqual(s.move([7, 3], 5), [7, 3]);
});

test('adjust for zoom scales the time constant by 1 / zoom', () => {
  const s = new Smoother({ smoothing: 50, adjustForZoom: true, catchUpOnEnd: true, pulledString: false, catchUp: false }, 2);
  s.start([0, 0], 0);
  const e = -Math.expm1(-10 / 45), k = 1 - 45 * e / 10;
  assert.ok(Math.abs(s.move([100, 0], 10)[0] - 100 * k) < 1e-9);
  assert.deepEqual(s.end([100, 0], 20), [100, 0]);
});
