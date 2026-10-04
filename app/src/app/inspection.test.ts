import test from 'node:test';
import assert from 'node:assert/strict';
import { histogramStats, selectHistogramChannel } from './inspection.ts';

test('histogram statistics use exact bin counts and population deviation', () => {
  const bins = new Uint32Array(256);
  bins[0] = 1; bins[10] = 2; bins[20] = 1;
  const stats = histogramStats(bins);
  assert.deepEqual({ count: stats.count, mean: stats.mean, median: stats.median }, { count: 4, mean: 10, median: 10 });
  assert.equal(stats.standardDeviation, Math.sqrt(50));
  assert.deepEqual(histogramStats(new Uint32Array(256)), { count: 0, mean: 0, median: 0, standardDeviation: 0 });
});

test('channel selection slices the native composite, red, green, and blue blocks', () => {
  const raw = new Uint32Array(1024);
  raw[5] = 1; raw[256 + 6] = 2; raw[512 + 7] = 3; raw[768 + 8] = 4;
  assert.equal(selectHistogramChannel(raw, 'composite')[5], 1);
  assert.equal(selectHistogramChannel(raw, 'red')[6], 2);
  assert.equal(selectHistogramChannel(raw, 'green')[7], 3);
  assert.equal(selectHistogramChannel(raw, 'blue')[8], 4);
  assert.throws(() => selectHistogramChannel(new Uint32Array(7), 'red'), /1024/);
});
