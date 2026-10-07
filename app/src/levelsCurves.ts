// Levels and Curves body logic (docs/M3.md section 3 kinds 2 and 3, items 23-25 for Auto): Auto
// methods on a 4 x 256 histogram (luminosity, R, G, B), eyedroppers, presets, curve point rules.
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { i18n } from './i18n/index.ts';
import type { Adjustment, LevelsRecord } from './engine.worker.ts';

export type LevelsParams = Extract<Adjustment, { kind: 'levels' }>['params'];
export type CurvesParams = Extract<Adjustment, { kind: 'curves' }>['params'];
export type Channel = 'composite' | 'red' | 'green' | 'blue';
export type Point = [number, number];
export type AutoMethod = 'contrast' | 'tone' | 'color' | 'brightness';

export const CHANNELS: [Channel, string][] = [['composite', 'RGB'], ['red', 'Red'], ['green', 'Green'], ['blue', 'Blue']];
export const AUTO_METHODS: [AutoMethod, string][] = [
  ['contrast', 'Enhance Monochromatic Contrast'], ['tone', 'Enhance Per Channel Contrast'],
  ['color', 'Find Dark & Light Colors'], ['brightness', 'Enhance Brightness and Contrast'],
];
export const MAX_POINTS = 16;
const CLIP = 0.001;
const MIDTONE = 128;

export const neutralRecord = (): LevelsRecord => ({ input_black: 0, input_white: 255, gamma: 1, output_black: 0, output_white: 255 });
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

/** The 256 bins of one channel; the composite reads luminosity. */
export function channelBins(h: Uint32Array, ch: Channel): Uint32Array {
  const i = CHANNELS.findIndex(([c]) => c === ch);
  return h.subarray(i * 256, i * 256 + 256);
}

/** A channel's record, neutral when the channel has none yet. */
export const levelsRecord = (p: LevelsParams, ch: Channel): LevelsRecord => p[ch] ?? neutralRecord();

/** Sets one field with the handle constraints: black < white by 1, gamma 0.01..9.99, others 0..255. */
export function setLevelsInput(r: LevelsRecord, key: keyof LevelsRecord, v: number): LevelsRecord {
  if (key === 'gamma') return { ...r, gamma: round2(clamp(v, 0.01, 9.99)) };
  const n = Math.round(v);
  if (key === 'input_black') return { ...r, input_black: clamp(n, 0, r.input_white - 1) };
  if (key === 'input_white') return { ...r, input_white: clamp(n, r.input_black + 1, 255) };
  return { ...r, [key]: clamp(n, 0, 255) };
}

// First bin from the bottom (or top) whose cumulative count reaches `share` of the total.
function percentile(bins: Uint32Array, share: number, fromTop = false): number {
  const total = bins.reduce((a, b) => a + b, 0);
  let sum = 0;
  for (let k = 0; k < 256; k++) {
    const i = fromTop ? 255 - k : k;
    sum += bins[i];
    if (sum >= share * total) return i;
  }
  return fromTop ? 255 : 0;
}

// Levels record from clipped percentiles; with `gamma`, the median maps to the midtone target.
function autoRecord(bins: Uint32Array, gamma: boolean): LevelsRecord {
  const r = neutralRecord();
  if (!bins.some(n => n > 0)) return r;
  const lo = percentile(bins, CLIP), hi = percentile(bins, CLIP, true);
  if (hi <= lo) return r;
  r.input_black = lo;
  r.input_white = hi;
  if (gamma) {
    const p = (percentile(bins, 0.5) - lo) / (hi - lo);
    if (p > 0 && p < 1) r.gamma = round2(clamp(Math.log(p) / Math.log(MIDTONE / 255), 0.01, 9.99));
  }
  return r;
}

/** One of the four Auto methods run on a histogram, as a whole Levels params value. */
export function autoLevels(h: Uint32Array, method: AutoMethod): LevelsParams {
  if (method === 'contrast' || method === 'brightness') {
    return { composite: autoRecord(channelBins(h, 'composite'), method === 'brightness'), red: null, green: null, blue: null };
  }
  const per = (ch: Channel) => autoRecord(channelBins(h, ch), method === 'color');
  return { composite: neutralRecord(), red: per('red'), green: per('green'), blue: per('blue') };
}

/** Black/white eyedroppers set each channel's input point to the sample; gray sets each channel's
 * gamma so the sample lands on the midtone target. */
export function levelsEyedropper(p: LevelsParams, which: 'black' | 'gray' | 'white', rgb: [number, number, number]): LevelsParams {
  const out: LevelsParams = { ...p };
  (['red', 'green', 'blue'] as const).forEach((ch, i) => {
    const r = levelsRecord(p, ch), v = rgb[i];
    if (which === 'black') out[ch] = setLevelsInput(r, 'input_black', Math.min(v, 254));
    else if (which === 'white') out[ch] = setLevelsInput(r, 'input_white', Math.max(v, 1));
    else {
      const n = (v - r.input_black) / (r.input_white - r.input_black);
      out[ch] = n > 0 && n < 1 ? setLevelsInput(r, 'gamma', Math.log(n) / Math.log(MIDTONE / 255)) : r;
    }
  });
  return out;
}

const preset = (input_black: number, gamma: number, input_white: number): LevelsRecord => ({ ...neutralRecord(), input_black, gamma, input_white });
export const LEVELS_PRESETS: [string, LevelsRecord][] = [
  ['Darker', preset(15, 1, 255)], ['Increase Contrast 1', preset(10, 1, 245)], ['Increase Contrast 2', preset(20, 1, 235)],
  ['Increase Contrast 3', preset(30, 1, 225)], ['Lighten Shadows', preset(0, 1.6, 255)], ['Lighter', preset(0, 1, 230)],
  ['Midtones Brighter', preset(0, 1.25, 255)], ['Midtones Darker', preset(0, 0.75, 255)],
];

export const CURVES_PRESETS: [string, Point[]][] = [
  ['Lighter', [[0, 0], [96, 136], [192, 218], [255, 255]]],
  ['Darker', [[0, 0], [64, 40], [160, 120], [255, 255]]],
  ['Increase Contrast', [[0, 0], [64, 46], [192, 210], [255, 255]]],
  ['Matte', [[0, 24], [64, 68], [192, 196], [255, 242]]],
  ['Negative', [[0, 255], [255, 0]]],
];

// Display text of the channel, Auto method and preset names; the English names stay the compared select values.
export const NAME_LABELS: Record<string, MessageDescriptor> = {
  RGB: msg`RGB`, Red: msg`Red`, Green: msg`Green`, Blue: msg`Blue`,
  'Enhance Monochromatic Contrast': msg`Enhance Monochromatic Contrast`, 'Enhance Per Channel Contrast': msg`Enhance Per Channel Contrast`,
  'Find Dark & Light Colors': msg`Find Dark & Light Colors`, 'Enhance Brightness and Contrast': msg`Enhance Brightness and Contrast`,
  Default: msg`Default`, Custom: msg`Custom`, Darker: msg`Darker`, Lighter: msg`Lighter`,
  'Increase Contrast': msg`Increase Contrast`, 'Increase Contrast 1': msg`Increase Contrast 1`, 'Increase Contrast 2': msg`Increase Contrast 2`,
  'Increase Contrast 3': msg`Increase Contrast 3`, 'Lighten Shadows': msg`Lighten Shadows`, 'Midtones Brighter': msg`Midtones Brighter`,
  'Midtones Darker': msg`Midtones Darker`, Matte: msg`Matte`, Negative: msg`Negative`,
};
/** A channel, Auto method or preset name in the UI language; an unknown name is shown as is. */
export const nameLabel = (name: string) => (Object.hasOwn(NAME_LABELS, name) ? i18n._(NAME_LABELS[name]) : name);

/** A click at (input, output): the index of an existing point within `tol` input units, else a new
 * sorted point; index -1 when 16 points already exist. */
export function addPoint(points: Point[], input: number, output: number, tol = 4): { points: Point[]; index: number } {
  const near = points.findIndex(([x]) => Math.abs(x - input) <= tol);
  if (near >= 0) return { points, index: near };
  if (points.length >= MAX_POINTS) return { points, index: -1 };
  const pt: Point = [clamp(Math.round(input), 0, 255), clamp(Math.round(output), 0, 255)];
  const next = [...points, pt].sort((a, b) => a[0] - b[0]);
  return { points: next, index: next.indexOf(pt) };
}

/** Removes an inner point; the first and last points stay. */
export const removePoint = (points: Point[], i: number): Point[] =>
  i <= 0 || i >= points.length - 1 ? points : points.filter((_, k) => k !== i);

/** True when a drag position (graph px, square of `size`) lies more than 18 px outside the graph. */
export const draggedOut = (x: number, y: number, size: number, margin = 18) =>
  x < -margin || y < -margin || x > size + margin || y > size + margin;

/** Moves point i, its input kept strictly between its neighbours. */
export function movePoint(points: Point[], i: number, input: number, output: number): Point[] {
  const lo = i > 0 ? points[i - 1][0] + 1 : 0, hi = i < points.length - 1 ? points[i + 1][0] - 1 : 255;
  const next = [...points];
  next[i] = [clamp(Math.round(input), lo, hi), clamp(Math.round(output), 0, 255)];
  return next;
}

/** The curve's output for inputs 0..255: natural cubic spline (pencil: linear), flat beyond the ends. */
export function curveSamples(points: Point[], pencil: boolean): number[] {
  const pts: Point[] = [];
  for (const p of [...points].sort((a, b) => a[0] - b[0])) {
    if (pts.length && pts[pts.length - 1][0] === p[0]) pts[pts.length - 1] = p; else pts.push(p);
  }
  const n = pts.length;
  if (!n) return Array.from({ length: 256 }, (_, i) => i);
  const y2 = new Array(n).fill(0), u = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const sig = (pts[i][0] - pts[i - 1][0]) / (pts[i + 1][0] - pts[i - 1][0]);
    const q = sig * y2[i - 1] + 2;
    y2[i] = (sig - 1) / q;
    const d = (pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0]) - (pts[i][1] - pts[i - 1][1]) / (pts[i][0] - pts[i - 1][0]);
    u[i] = (6 * d / (pts[i + 1][0] - pts[i - 1][0]) - sig * u[i - 1]) / q;
  }
  for (let i = n - 2; i >= 1; i--) y2[i] = y2[i] * y2[i + 1] + u[i];
  return Array.from({ length: 256 }, (_, x) => {
    if (x <= pts[0][0]) return pts[0][1];
    if (x >= pts[n - 1][0]) return pts[n - 1][1];
    const hi = pts.findIndex(p => p[0] >= x);
    const [xa, ya] = pts[hi - 1], [xb, yb] = pts[hi];
    const h = xb - xa, a = (xb - x) / h, b = (x - xa) / h;
    const y = pencil ? ya * a + yb * b : a * ya + b * yb + ((a ** 3 - a) * y2[hi - 1] + (b ** 3 - b) * y2[hi]) * h * h / 6;
    return clamp(Math.round(y), 0, 255);
  });
}

/** Point curve to the pencil form: one (input, output) sample per input value. */
export const pointsToPencil = (points: Point[], pencil: boolean): Point[] => curveSamples(points, pencil).map((y, x) => [x, y]);

/** Pencil samples to at most 16 evenly spaced points (inputs 0, 17, ..., 255). */
export function pencilToPoints(samples: Point[]): Point[] {
  const s = curveSamples(samples, true);
  return Array.from({ length: MAX_POINTS }, (_, i) => [i * 17, s[i * 17]] as Point);
}

/** Freehand stroke segment: the inputs from `a` to `b` take the line between their outputs. */
export function pencilDraw(samples: Point[], a: Point, b: Point): Point[] {
  const out = pointsToPencil(samples, true);
  const [x0, x1] = [Math.round(clamp(a[0], 0, 255)), Math.round(clamp(b[0], 0, 255))];
  const span = x1 - x0;
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
    const t = span === 0 ? 1 : (x - x0) / span;
    out[x] = [x, clamp(Math.round(a[1] + (b[1] - a[1]) * t), 0, 255)];
  }
  return out;
}

/** Value of a sampled color on a channel: luminosity for the composite. */
export const channelValue = ([r, g, b]: [number, number, number], ch: Channel) =>
  ch === 'composite' ? Math.round(0.3 * r + 0.59 * g + 0.11 * b) : { red: r, green: g, blue: b }[ch];
