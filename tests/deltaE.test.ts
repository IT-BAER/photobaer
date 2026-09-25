import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deltaE2000, srgbToLab } from './deltaE.ts';

// Reference pairs from Sharma, Wu, Dalal (2005), "The CIEDE2000 color-difference formula", Table 1.
const pairs: [number[], number[], number][] = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
  [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
  [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
];

test('CIEDE2000 matches the published reference pairs', () => {
  for (const [a, b, want] of pairs) {
    const got = deltaE2000(a[0], a[1], a[2], b[0], b[1], b[2]);
    assert.ok(Math.abs(got - want) < 1e-4, `${a} vs ${b}: ${got} != ${want}`);
  }
});

test('identical colors have zero difference', () => {
  assert.equal(deltaE2000(40, 10, -20, 40, 10, -20), 0);
});

test('sRGB white and black map to L* 100 and 0', () => {
  const w = srgbToLab(255, 255, 255), k = srgbToLab(0, 0, 0);
  assert.ok(Math.abs(w[0] - 100) < 0.01 && Math.abs(w[1]) < 0.01 && Math.abs(w[2]) < 0.01, `${w}`);
  assert.ok(Math.abs(k[0]) < 1e-9, `${k}`);
});
