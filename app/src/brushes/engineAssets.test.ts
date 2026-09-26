import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineAssets } from './engineAssets.ts';
import { computedTip, defaultDynamics, type BrushPreset, type PatternRecord, type TipRecord } from './preset.ts';

function fake() {
  const calls: string[] = [];
  let next = 10;
  const api = {
    async tipAdd(w: number, h: number, alpha: Uint8Array) { calls.push(`tip ${w}x${h}:${alpha.length}`); if (w === 0) throw new Error('bad tip'); return next++; },
    async patternAdd(w: number, h: number, data: Uint8Array, channels: number) { calls.push(`pattern ${w}x${h}:${channels}`); return next++; },
  };
  return { api, calls };
}
const tips = new Map<string, TipRecord>([
  ['t1', { id: 't1', name: 'a', width: 2, height: 1, alpha: Uint8Array.from([1, 2]) }],
  ['t2', { id: 't2', name: 'b', width: 1, height: 1, alpha: Uint8Array.from([3]) }],
  ['bad', { id: 'bad', name: 'c', width: 0, height: 1, alpha: new Uint8Array(0) }],
]);
const patterns = new Map<string, PatternRecord>([['p1', { id: 'p1', name: 'p', width: 1, height: 1, channels: 1, data: Uint8Array.from([9]) }]]);
const lib = { tip: (id: string) => tips.get(id), pattern: (id: string) => patterns.get(id) };

function preset(tipRef: string | null, dualRef: string | null, patternRef: string | null): BrushPreset {
  const d = defaultDynamics();
  const geo = computedTip();
  if (dualRef) { d.dualBrush.enabled = true; d.dualBrush.tip = { ...geo, kind: 'sampled', tipRef: dualRef }; }
  if (patternRef) { d.texture.enabled = true; d.texture.patternRef = patternRef; }
  return { id: 'x', name: 'x', tip: tipRef ? { ...geo, kind: 'sampled', tipRef } : geo, dynamics: d };
}

test('prepare registers tip, dual tip and pattern once and resolve returns their engine ids', async () => {
  const { api, calls } = fake();
  const a = new EngineAssets(api, lib);
  assert.equal(a.resolve('tip', 't1'), undefined);
  await Promise.all([a.prepare(preset('t1', 't2', 'p1')), a.prepare(preset('t1', null, 'p1'))]);
  assert.deepEqual(calls, ['tip 2x1:2', 'tip 1x1:1', 'pattern 1x1:1']);
  assert.equal(a.resolve('tip', 't1'), 10);
  assert.equal(a.resolve('tip', 't2'), 11);
  assert.equal(a.resolve('pattern', 'p1'), 12);
  await a.prepare(preset('t2', null, null));
  assert.equal(calls.length, 3);
});

test('prepare skips computed tips, disabled sections and missing records, and survives a rejected tip', async () => {
  const { api, calls } = fake();
  const a = new EngineAssets(api, lib);
  const p = preset(null, null, 'p1');
  p.dynamics.texture.enabled = false;
  await a.prepare(p);
  await a.prepare(preset('missing', null, null));
  assert.deepEqual(calls, []);
  await a.prepare(preset('bad', null, null));
  assert.equal(a.resolve('tip', 'bad'), undefined);
  // A failed registration is retried on the next use.
  await a.prepare(preset('bad', null, null));
  assert.equal(calls.length, 2);
});
