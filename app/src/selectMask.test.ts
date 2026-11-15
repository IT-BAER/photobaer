import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, invertEdits, parseRemembered, refineView, type RefineView } from './selectMask.ts';

const img = Uint8Array.from([100, 50, 200, 255, 100, 50, 200, 255]);
const alpha = Uint8Array.from([255, 0]), band = Uint8Array.from([0, 255]), orig = Uint8Array.from([0, 255]);
const px = (v: Uint8ClampedArray, i: number) => [...v.subarray(i * 4, i * 4 + 4)];
const show = (view: RefineView, opacity: number, o: { edits?: Uint8Array; showEdge?: boolean; showOriginal?: boolean } = {}) =>
  refineView(img, 2, alpha, band, orig, o.edits ?? null, { view, opacity, showEdge: !!o.showEdge, showOriginal: !!o.showOriginal });

test('refineView shows the refined selection per view mode and opacity', () => {
  assert.deepEqual(px(show('bw', 0.5), 0), [255, 255, 255, 255]);
  assert.deepEqual(px(show('bw', 0.5), 1), [0, 0, 0, 255]);
  assert.deepEqual(px(show('black', 1), 1), [0, 0, 0, 255]);
  assert.deepEqual(px(show('white', 1), 1), [255, 255, 255, 255]);
  assert.deepEqual(px(show('black', 0.5), 1), [50, 25, 100, 255], 'half covered');
  assert.deepEqual(px(show('overlay', 0.5), 1), [178, 25, 100, 255], 'half red');
  assert.deepEqual(px(show('overlay', 0.5), 0), [100, 50, 200, 255], 'selected: the image');
  assert.deepEqual(px(show('layers', 0.5), 1), [255, 255, 255, 255], 'transparent: the checkerboard');
  assert.deepEqual(px(show('onion', 1), 1), px(show('layers', 0.5), 1));
  assert.deepEqual(px(show('onion', 0), 1), [100, 50, 200, 255], 'no transparency: the image');
});

test('refineView: Show Original, Show Edge and the brush edits', () => {
  assert.deepEqual(px(show('bw', 1, { showOriginal: true }), 1), [255, 255, 255, 255], 'the starting selection');
  assert.deepEqual(px(show('bw', 1, { showEdge: true }), 0), [0, 0, 0, 255], 'outside the band');
  assert.deepEqual(px(show('bw', 1, { edits: Uint8Array.from([0, 255]) }), 0), [0, 0, 0, 255], 'subtracted');
  assert.deepEqual(px(show('bw', 1, { edits: Uint8Array.from([0, 255]) }), 1), [255, 255, 255, 255], 'added');
  assert.deepEqual(px(show('bw', 1, { edits: Uint8Array.from([64, 192]) }), 0), [255, 255, 255, 255], 'Refine Edge codes keep the preview');
});

test('invertEdits swaps added and subtracted strokes and keeps the Refine Edge codes', () => {
  assert.deepEqual([...invertEdits(Uint8Array.from([0, 64, 128, 192, 255]))], [255, 64, 128, 192, 0]);
});

test('parseRemembered keeps valid settings and falls back to the defaults', () => {
  assert.deepEqual(parseRemembered(null), DEFAULTS);
  assert.deepEqual(parseRemembered('not json'), DEFAULTS);
  const r = parseRemembered(JSON.stringify({ view: 'black', radius: 12, smooth: 900, output: 'bogus', decontaminate: true, amount: 40, settings: 1 }));
  assert.equal(r.view, 'black');
  assert.equal(r.settings.radius, DEFAULTS.settings.radius, 'settings come from the settings object');
  const s = parseRemembered(JSON.stringify({ settings: { radius: 12, smooth: 900, smart_radius: true }, output: 'bogus', decontaminate: true, amount: 40 }));
  assert.deepEqual([s.settings.radius, s.settings.smooth, s.settings.smart_radius], [12, 100, true], 'clamped to the ranges');
  assert.deepEqual([s.output, s.decontaminate, s.amount], [DEFAULTS.output, true, 40]);
});
