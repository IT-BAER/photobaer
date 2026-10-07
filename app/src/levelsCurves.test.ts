import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_METHODS, CHANNELS, CURVES_PRESETS, LEVELS_PRESETS, NAME_LABELS, nameLabel, MAX_POINTS, addPoint, autoLevels, curveSamples, draggedOut, levelsEyedropper,
  movePoint, pencilDraw, pencilToPoints, pointsToPencil, removePoint, setLevelsInput,
} from './levelsCurves.ts';

// 4 x 256 bins (luminosity, R, G, B); each channel gets 1000 pixels spread by `fill(ch)`.
function hist(fill: (ch: number, bins: number[]) => void): Uint32Array {
  const h = new Uint32Array(1024);
  for (let ch = 0; ch < 4; ch++) {
    const bins = new Array(256).fill(0);
    fill(ch, bins);
    bins.forEach((n, i) => { h[ch * 256 + i] = n; });
  }
  return h;
}
const rec = (input_black: number, input_white: number, gamma = 1) => ({ input_black, input_white, gamma, output_black: 0, output_white: 255 });

// Channel ch holds 5 pixels at 0 and 5 at 255 (under the 0.1 % clip of 10000), 9990 spread evenly
// from 20+10ch to 200+10ch, so the median sits at 110+10ch.
const spread = hist((ch, b) => {
  b[0] = 5; b[255] = 5;
  const lo = 20 + 10 * ch, hi = 200 + 10 * ch;
  for (let i = 0; i < 9990; i++) b[lo + Math.floor(i * (hi - lo + 1) / 9990)]++;
});

test('auto contrast: one composite record from luminosity percentiles, clip 0.1 %', () => {
  assert.deepEqual(autoLevels(spread, 'contrast'), { composite: rec(20, 200), red: null, green: null, blue: null });
});

test('auto tone: per-channel records from each channel, composite neutral', () => {
  assert.deepEqual(autoLevels(spread, 'tone'), { composite: rec(0, 255), red: rec(30, 210), green: rec(40, 220), blue: rec(50, 230) });
});

test('auto color: per-channel records plus gamma from the normalized median toward 128', () => {
  const r = autoLevels(spread, 'color');
  // Red median sits mid-spread at 120: (120 - 30)/180 = 0.5 -> log(0.5)/log(128/255).
  const g = Math.round(Math.log(0.5) / Math.log(128 / 255) * 100) / 100;
  assert.deepEqual(r.red, rec(30, 210, g));
  assert.equal(r.composite.gamma, 1);
});

test('auto brightness/contrast: composite record with the luminosity median gamma', () => {
  const r = autoLevels(spread, 'brightness');
  assert.equal(r.red, null);
  assert.deepEqual({ ...r.composite, gamma: 0 }, { ...rec(20, 200), gamma: 0 });
  assert.equal(r.composite.gamma, Math.round(Math.log(90 / 180) / Math.log(128 / 255) * 100) / 100);
});

test('auto on a single-value channel keeps the full range and gamma 1', () => {
  const flat = hist((_, b) => { b[77] = 500; });
  assert.deepEqual(autoLevels(flat, 'color').red, rec(0, 255));
  assert.deepEqual(autoLevels(new Uint32Array(1024), 'contrast').composite, rec(0, 255));
});

test('input handles keep black below white and gamma in 0.01..9.99', () => {
  assert.deepEqual(setLevelsInput(rec(0, 255), 'input_black', 300), rec(254, 255));
  assert.deepEqual(setLevelsInput(rec(100, 255), 'input_white', 50), rec(100, 101));
  assert.equal(setLevelsInput(rec(0, 255), 'gamma', 20).gamma, 9.99);
  assert.equal(setLevelsInput(rec(0, 255), 'output_black', -4).output_black, 0);
});

test('eyedroppers set per-channel records from the sampled color', () => {
  const p = { composite: rec(0, 255) };
  assert.deepEqual(levelsEyedropper(p, 'black', [10, 20, 30]), { composite: rec(0, 255), red: rec(10, 255), green: rec(20, 255), blue: rec(30, 255) });
  const w = levelsEyedropper(p, 'white', [200, 210, 220]);
  assert.deepEqual([w.red, w.green, w.blue], [rec(0, 200), rec(0, 210), rec(0, 220)]);
  const g = levelsEyedropper(p, 'gray', [128, 64, 200]);
  assert.equal(g.red!.gamma, 1);
  assert.ok(g.green!.gamma > 1 && g.blue!.gamma < 1, 'a dark channel brightens, a bright one darkens');
});

test('levels presets equal the notes', () => {
  assert.deepEqual(LEVELS_PRESETS.map(([n, r]) => [n, r.input_black, r.gamma, r.input_white, r.output_black, r.output_white]), [
    ['Darker', 15, 1, 255, 0, 255], ['Increase Contrast 1', 10, 1, 245, 0, 255], ['Increase Contrast 2', 20, 1, 235, 0, 255],
    ['Increase Contrast 3', 30, 1, 225, 0, 255], ['Lighten Shadows', 0, 1.6, 255, 0, 255], ['Lighter', 0, 1, 230, 0, 255],
    ['Midtones Brighter', 0, 1.25, 255, 0, 255], ['Midtones Darker', 0, 0.75, 255, 0, 255],
  ]);
});

test('curves presets equal the notes', () => {
  assert.deepEqual(CURVES_PRESETS, [
    ['Lighter', [[0, 0], [96, 136], [192, 218], [255, 255]]],
    ['Darker', [[0, 0], [64, 40], [160, 120], [255, 255]]],
    ['Increase Contrast', [[0, 0], [64, 46], [192, 210], [255, 255]]],
    ['Matte', [[0, 24], [64, 68], [192, 196], [255, 242]]],
    ['Negative', [[0, 255], [255, 0]]],
  ]);
});

test('a click adds a sorted point unless one is near or 16 exist', () => {
  const base: [number, number][] = [[0, 0], [255, 255]];
  assert.deepEqual(addPoint(base, 100, 80), { points: [[0, 0], [100, 80], [255, 255]], index: 1 });
  assert.equal(addPoint([[0, 0], [100, 80], [255, 255]], 101, 90).index, 1, 'within tolerance picks the existing point');
  const full = Array.from({ length: MAX_POINTS }, (_, i) => [i * 17, i * 17] as [number, number]);
  assert.equal(addPoint(full, 8, 50).index, -1);
  assert.equal(addPoint(full, 8, 50).points, full);
});

test('removing never drops the first or last point', () => {
  const pts: [number, number][] = [[0, 0], [100, 80], [255, 255]];
  assert.deepEqual(removePoint(pts, 1), [[0, 0], [255, 255]]);
  assert.equal(removePoint(pts, 0), pts);
  assert.equal(removePoint(pts, 2), pts);
});

test('dragging a point more than 18 px outside the graph removes it', () => {
  assert.equal(draggedOut(-19, 50, 256), true);
  assert.equal(draggedOut(-18, 50, 256), false);
  assert.equal(draggedOut(100, 256 + 19, 256), true);
  assert.equal(draggedOut(100, 100, 256), false);
});

test('a dragged point stays between its neighbours and inside 0..255', () => {
  const pts: [number, number][] = [[0, 0], [100, 80], [200, 190], [255, 255]];
  assert.deepEqual(movePoint(pts, 1, 250, 300)[1], [199, 255]);
  assert.deepEqual(movePoint(pts, 0, 150, -5)[0], [99, 0]);
});

test('curve samples follow the engine: spline through the points, flat beyond the ends', () => {
  assert.deepEqual(curveSamples([[0, 0], [255, 255]], false).slice(0, 3), [0, 1, 2]);
  const s = curveSamples([[50, 20], [200, 220]], true);
  assert.equal(s[0], 20);
  assert.equal(s[255], 220);
  assert.equal(s[125], 120);
  const neg = curveSamples([[0, 255], [255, 0]], false);
  assert.equal(neg[100], 155);
});

test('pencil conversion: 256 samples one way, at most 16 points the other', () => {
  const pencil = pointsToPencil([[0, 0], [255, 255]], false);
  assert.equal(pencil.length, 256);
  assert.deepEqual(pencil[37], [37, 37]);
  const back = pencilToPoints(pencil);
  assert.equal(back.length, MAX_POINTS);
  assert.deepEqual(back[0], [0, 0]);
  assert.deepEqual(back.at(-1), [255, 255]);
});

test('pencil drawing fills the inputs between two positions linearly', () => {
  const s = pointsToPencil([[0, 0], [255, 255]], false);
  const d = pencilDraw(s, [10, 100], [14, 60]);
  assert.deepEqual(d.slice(10, 15).map(p => p[1]), [100, 90, 80, 70, 60]);
  assert.deepEqual(d[9], [9, 9]);
  assert.equal(s[10][1], 10, 'the input is not mutated');
});

test('every channel, Auto method and preset name has a message with its English text', () => {
  const presetNames = [...LEVELS_PRESETS, ...CURVES_PRESETS].map(([n]) => n);
  const texts = new Set([...CHANNELS.map(([, n]) => n), ...AUTO_METHODS.map(([, n]) => n), ...presetNames, 'Default', 'Custom']);
  assert.deepEqual([...texts].filter(t => !Object.hasOwn(NAME_LABELS, t)), []);
  assert.deepEqual(Object.keys(NAME_LABELS).filter(t => !texts.has(t)), []);
  for (const [text, d] of Object.entries(NAME_LABELS)) assert.equal(d.message, text);
  assert.equal(nameLabel('Midtones Darker'), 'Midtones Darker');
  assert.equal(nameLabel('My Preset'), 'My Preset');
});
