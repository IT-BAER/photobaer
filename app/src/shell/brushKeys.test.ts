import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digitOption, dragResize, showCrosshair, stepHardness, stepSize } from './brushKeys.ts';

test('stepSize steps scale with the current size and never go below 1', () => {
  assert.equal(stepSize(5, true), 6); // small size: step 1
  assert.equal(stepSize(1, false), 1); // clamps at the minimum
  assert.equal(stepSize(50, true), 55); // medium size: step 5
  assert.equal(stepSize(50, false), 45);
  assert.equal(stepSize(200, true), 210); // large size: step 10
  assert.equal(stepSize(200, false), 190);
});

test('stepHardness moves to the next or previous 25% grid line and clamps 0-100', () => {
  assert.equal(stepHardness(0, true), 25);
  assert.equal(stepHardness(90, true), 100); // snaps up to the next line above the current value
  assert.equal(stepHardness(90, false), 75); // snaps down to the next line below
  assert.equal(stepHardness(100, true), 100); // clamped at the top
  assert.equal(stepHardness(0, false), 0); // clamped at the bottom
  assert.equal(stepHardness(50, true), 75);
  assert.equal(stepHardness(50, false), 25);
});

test('digitOption: a single digit sets 10x (0 = 100), remembered for a follow-up digit', () => {
  const r1 = digitOption(null, '1', 1000);
  assert.equal(r1.value, 10);
  const r0 = digitOption(null, '0', 1000);
  assert.equal(r0.value, 100);
});

test('digitOption: two digits within 0.8s combine into the exact value', () => {
  const r1 = digitOption(null, '7', 1000);
  const r2 = digitOption(r1.state, '5', 1700); // 0.7s later
  assert.equal(r2.value, 75);
  assert.equal(r2.state, null); // combo consumed, no further chaining
});

test('digitOption: a second digit after 0.8s starts a fresh single-digit value', () => {
  const r1 = digitOption(null, '7', 1000);
  const r2 = digitOption(r1.state, '5', 1900); // 0.9s later
  assert.equal(r2.value, 50);
});

test('digitOption: "0" as the second digit combines to an exact 10s multiple', () => {
  const r1 = digitOption(null, '3', 1000);
  const r2 = digitOption(r1.state, '0', 1300);
  assert.equal(r2.value, 30);
});

test('showCrosshair when the outline would draw under 6 screen px or Caps Lock is on', () => {
  assert.equal(showCrosshair(5.9, false), true);
  assert.equal(showCrosshair(6, false), false);
  assert.equal(showCrosshair(40, true), true);
});

test('dragResize: horizontal drag resizes, vertical drag changes hardness, both clamped', () => {
  const r = dragResize(30, 50, 10, -20);
  assert.equal(r.size, 40);
  assert.equal(r.hardness, 70); // up = harder
  const clamped = dragResize(5, 5, -100, 200);
  assert.equal(clamped.size, 1);
  assert.equal(clamped.hardness, 0);
});
