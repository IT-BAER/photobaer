// Geometry for the Ruler, Count, Color Sampler, Note, Slice, Artboard and Frame tools and the
// Measurement Log. Document pixels throughout; angles in degrees, counter-clockwise on screen.
import { contour } from '../shell/selecttools.ts';
import type { Mat3 } from '../transform/matrix.ts';
import type { Guide, VectorPath } from '../worker/types.ts';
import type { MeasureScale } from './analysis.ts';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
// The worker reaches this module: the @lingui/core singleton keeps the catalog loader (i18n/index.ts) out of it.
import { i18n } from '@lingui/core';

export type Pt = [number, number];
export type Bounds = [number, number, number, number];
export interface Note { id: number; x: number; y: number; author: string; color: [number, number, number]; text: string }
export interface Slice { id: number; name: string; rect: Bounds }
export interface CountGroup { name: string; color: [number, number, number]; visible: boolean; marks: Pt[] }
export interface Annotations { notes: Note[]; slices: Slice[]; counts: CountGroup[]; samplers: Pt[]; scale?: MeasureScale }
export const emptyAnnotations = (): Annotations => ({ notes: [], slices: [], counts: [], samplers: [] });
export const MAX_SAMPLERS = 10;

export function rulerMeasure(a: Pt, b: Pt) {
  const w = b[0] - a[0], h = b[1] - a[1];
  return { x: a[0], y: a[1], w, h, length: Math.hypot(w, h), angle: Math.atan2(a[1] - b[1], w) * 180 / Math.PI };
}

// The clockwise-on-screen rotation that puts a line at `angle` onto the nearest axis.
export function straightenAngle(angle: number): number {
  return angle - Math.round(angle / 90) * 90;
}

// Row-major forward matrix rotating `deg` clockwise on screen about (cx, cy).
export function rotationAbout(deg: number, cx: number, cy: number): Mat3 {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy, 0, 0, 1];
}

export function framePath(r: { x: number; y: number; w: number; h: number }, shape: 'rectangle' | 'ellipse'): VectorPath {
  const { x, y, w, h } = r;
  if (shape === 'rectangle') {
    const c = (px: number, py: number): [number, number, number, number, number, number] => [px, py, px, py, px, py];
    return { fill_rule: 'nonzero', subpaths: [{ closed: true, op: 'combine', points: [c(x, y), c(x + w, y), c(x + w, y + h), c(x, y + h)] }] };
  }
  const k = 0.5522847498, rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry, kx = k * rx, ky = k * ry;
  return {
    fill_rule: 'nonzero',
    subpaths: [{
      closed: true, op: 'combine', points: [
        [cx, y, cx - kx, y, cx + kx, y],
        [x + w, cy, x + w, cy - ky, x + w, cy + ky],
        [cx, y + h, cx + kx, y + h, cx - kx, y + h],
        [x, cy, x, cy + ky, x, cy - ky],
      ],
    }],
  };
}

export function nearestMark(marks: Pt[], x: number, y: number, radius: number): number {
  let best = -1, dist = radius;
  marks.forEach(([mx, my], i) => {
    const d = Math.hypot(mx - x, my - y);
    if (d <= dist) { dist = d; best = i; }
  });
  return best;
}

export const inRect = (r: Bounds, x: number, y: number) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

export function sliceAt(slices: Slice[], x: number, y: number): Slice | null {
  for (let i = slices.length - 1; i >= 0; i--) if (inRect(slices[i].rect, x, y)) return slices[i];
  return null;
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function handlePoint(r: Bounds, h: Handle): Pt {
  const mx = (r[0] + r[2]) / 2, my = (r[1] + r[3]) / 2;
  const x = h.includes('w') ? r[0] : h.includes('e') ? r[2] : mx;
  const y = h.startsWith('n') ? r[1] : h.startsWith('s') ? r[3] : my;
  return [x, y];
}

export function sliceHandle(r: Bounds, x: number, y: number, tol: number): Handle | null {
  let best: Handle | null = null, dist = Infinity;
  for (const h of HANDLES) {
    const [hx, hy] = handlePoint(r, h);
    if (Math.abs(hx - x) > tol || Math.abs(hy - y) > tol) continue;
    const d = Math.hypot(hx - x, hy - y);
    if (d < dist) { dist = d; best = h; }
  }
  return best;
}

export function resizeRect(r: Bounds, h: Handle, x: number, y: number): Bounds {
  let [l, t, rr, b] = r;
  if (h.includes('w')) l = x; else if (h.includes('e')) rr = x;
  if (h.startsWith('n')) t = y; else if (h.startsWith('s')) b = y;
  return [Math.min(l, rr), Math.min(t, b), Math.max(l, rr), Math.max(t, b)];
}

// View > Slices From Guides: the canvas cut at every guide strictly inside it, rows top to bottom.
export function slicesFromGuides(guides: Guide[], w: number, h: number): Bounds[] {
  const cuts = (axis: 'x' | 'y', size: number) =>
    [0, ...[...new Set(guides.filter(g => g.axis === axis && g.pos > 0 && g.pos < size).map(g => Math.round(g.pos)))].sort((a, b) => a - b), size];
  const xs = cuts('x', w), ys = cuts('y', h), out: Bounds[] = [];
  for (let j = 0; j + 1 < ys.length; j++) for (let i = 0; i + 1 < xs.length; i++) out.push([xs[i], ys[j], xs[i + 1], ys[j + 1]]);
  return out;
}

export function measureSelection(mask: Uint8Array, w: number, h: number) {
  let area = 0, l = w, t = h, r = 0, b = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = mask[y * w + x];
    if (!v) continue;
    area += v / 255;
    l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x + 1); b = Math.max(b, y + 1);
  }
  const segs = contour(mask, w, h);
  let perimeter = 0;
  for (let i = 0; i < segs.length; i += 4) perimeter += Math.hypot(segs[i + 2] - segs[i], segs[i + 3] - segs[i + 1]);
  return { area, perimeter, bounds: (area ? [l, t, r, b] : [0, 0, 0, 0]) as Bounds };
}

export interface Measurement {
  source: 'Ruler' | 'Count' | 'Selection'; length?: number; angle?: number; count?: number; area?: number; perimeter?: number;
  width?: number; height?: number;
}
export interface MeasureRow extends Measurement { label: string; date: string; document: string; scale?: string; units?: string }

export function measureRow(n: number, document: string, m: Measurement, now = new Date()): MeasureRow {
  return { ...m, label: `Measurement ${n}`, date: now.toLocaleString(), document };
}

export const LOG_COLUMNS: [keyof MeasureRow, string][] = [
  ['label', 'Label'], ['date', 'Date and Time'], ['document', 'Document'], ['source', 'Source'], ['count', 'Count'],
  ['area', 'Area'], ['perimeter', 'Perimeter'], ['width', 'Width'], ['height', 'Height'], ['length', 'Length'], ['angle', 'Angle'],
];

// Shown column headers; the English names above stay the CSV header.
const COLUMN_TITLES: Record<string, MessageDescriptor> = {
  label: msg`Label`, date: msg`Date and Time`, document: msg`Document`, source: msg`Source`, scale: msg`Scale`, units: msg`Units`, count: msg`Count`,
  area: msg`Area`, perimeter: msg`Perimeter`, width: msg`Width`, height: msg`Height`, length: msg`Length`, angle: msg`Angle`,
};
export const columnTitle = (key: string, english: string) => (COLUMN_TITLES[key] ? i18n._(COLUMN_TITLES[key]) : english);

export const formatValue = (v: unknown) => typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : v === undefined ? '' : String(v);

export function toCsv(rows: MeasureRow[], cols = LOG_COLUMNS): string {
  // Text starting with = + - @ tab or CR gets a leading ' so spreadsheets do not run it as a formula.
  const cell = (v: unknown) => { const t = formatValue(v), s = typeof v === 'string' && /^[=+\-@\t\r]/.test(t) ? `'${t}` : t; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map(c => c[1]).join(','), ...rows.map(r => cols.map(([k]) => cell(r[k])).join(','))].join('\n');
}
