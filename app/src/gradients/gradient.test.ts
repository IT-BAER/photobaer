import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultNoise, evaluate, largestGapMid, noiseStops, normalize, prng, reverse, type Gradient } from './gradient.ts';

const g = (over: Partial<Gradient>): Gradient => ({ stops: [], opacityStops: [], kind: 'solid', interpolation: 'classic', ...over });

test('normalize fills empty rails, duplicates a single stop and clamps/sorts', () => {
  const e = normalize(g({}));
  assert.deepEqual(e.stops, [{ position: 0, color: [0, 0, 0], midpoint: 0.5 }, { position: 1, color: [0, 0, 0], midpoint: 0.5 }]);
  assert.deepEqual(e.opacityStops, [{ position: 0, opacity: 1, midpoint: 0.5 }, { position: 1, opacity: 1, midpoint: 0.5 }]);
  const one = normalize(g({ stops: [{ position: 0.3, color: [9, 8, 7], midpoint: 0.4 }], opacityStops: [{ position: 0.2, opacity: 0.6, midpoint: 0.5 }] }));
  assert.deepEqual(one.stops[1], { position: 1, color: [9, 8, 7], midpoint: 0.5 });
  assert.deepEqual(one.opacityStops[1], { position: 1, opacity: 0.6, midpoint: 0.5 });
  const odd = normalize(g({ stops: [{ position: 2, color: [1, 1, 1], midpoint: 0 }, { position: -1, color: [2, 2, 2], midpoint: 5 }] }));
  assert.deepEqual(odd.stops.map(s => [s.position, s.midpoint]), [[0, 0.999], [1, 0.001]]);
});

test('reverse flips positions and gives stop i one minus the old midpoint of stop i - 1', () => {
  const r = reverse(g({
    stops: [{ position: 0, color: [1, 1, 1], midpoint: 0.3 }, { position: 0.4, color: [2, 2, 2], midpoint: 0.8 }, { position: 1, color: [3, 3, 3], midpoint: 0.5 }],
    opacityStops: [{ position: 0, opacity: 1, midpoint: 0.25 }, { position: 1, opacity: 0, midpoint: 0.5 }],
  }));
  assert.deepEqual(r.stops.map(s => [s.position, s.color[0]]), [[0, 3], [0.6, 2], [1, 1]]);
  assert.deepEqual(r.stops.map(s => Math.round(s.midpoint * 1000) / 1000), [0.2, 0.7, 0.5]);
  assert.deepEqual(r.opacityStops.map(s => [s.position, s.opacity, s.midpoint]), [[0, 0, 0.75], [1, 1, 0.5]]);
});

test('a midpoint of .25 puts the 50 % point at a quarter of the segment', () => {
  const bw = normalize(g({ stops: [{ position: 0, color: [0, 0, 0], midpoint: 0.25 }, { position: 1, color: [255, 255, 255], midpoint: 0.5 }] }));
  assert.equal(Math.round(evaluate(bw, 0.25)[0] * 100) / 100, 127.5);
  assert.equal(evaluate(bw, 0.5)[0] > 127.5, true);
  assert.deepEqual(evaluate(bw, 0), [0, 0, 0, 1]);
});

test('perceptual and linear mixes differ from classic at the middle of black to white', () => {
  const bw = normalize(g({ stops: [{ position: 0, color: [0, 0, 0], midpoint: 0.5 }, { position: 1, color: [255, 255, 255], midpoint: 0.5 }] }));
  assert.equal(Math.round(evaluate(bw, 0.5, 'classic')[0]), 128);
  assert.equal(Math.round(evaluate(bw, 0.5, 'linear')[0]), 188);
  assert.equal(Math.round(evaluate(bw, 0.5, 'perceptual')[0]), 99);
});

test('the prng is deterministic and the noise generator golden holds for seed 1', () => {
  const a = prng(7), b = prng(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  const n = noiseStops(defaultNoise());
  assert.equal(n.stops.length, 32);
  assert.deepEqual(n.stops.slice(0, 4).map(s => s.color), GOLDEN);
  assert.equal(n.stops[31].position, 1);
  assert.ok(n.opacityStops.every(s => s.opacity === 1));
  assert.deepEqual(noiseStops({ ...defaultNoise(), seed: 2 }).stops[0].color === n.stops[0].color, false);
  const t = noiseStops({ ...defaultNoise(), addTransparency: true });
  assert.ok(t.opacityStops.some(s => s.opacity < 1));
  const restricted = noiseStops({ ...defaultNoise(), restrictColors: true, minimum: [1, 1, 1] });
  assert.deepEqual(restricted.stops[0].color, [230, 230, 230]);
});

// Cross-checked against the reference build's generator for seed 1 (rgb, roughness .5, 32 samples).
const GOLDEN = [[181, 53, 139], [164, 93, 130], [130, 123, 112], [101, 110, 89]];

test('the widest gap wins for a new stop, including the ends', () => {
  assert.equal(largestGapMid([0, 1]), 0.5);
  assert.equal(largestGapMid([0, 0.2, 1]), 0.6);
  assert.equal(largestGapMid([0.5, 1]), 0.25);
});
