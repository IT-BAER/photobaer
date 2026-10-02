// Blur Gallery handle geometry (docs/M5.md section 5), in document px. Params store positions as
// fractions of the layer bounds and sizes as fractions of its short side, like the engine.
import type { ParamValue, PathPoint, Pin } from './lastFilter.ts';
import type { FilterParam } from './schema.ts';

export type Box = [number, number, number, number];
export type Pt = [number, number];
type Params = Record<string, ParamValue>;
export interface Handle { id: string; at: Pt }
export interface Outline { solid: Pt[][]; dashed: Pt[][] }

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const num = (p: Params, k: string) => Number(p[k] ?? 0);
const short = (b: Box) => Math.min(b[2], b[3]);
const toDoc = (b: Box, f: PathPoint): Pt => [b[0] + f.x * b[2], b[1] + f.y * b[3]];
const toFrac = (b: Box, at: Pt): PathPoint => ({ x: r4(clamp((at[0] - b[0]) / b[2], 0, 1)), y: r4(clamp((at[1] - b[1]) / b[3], 0, 1)) });
const deg = (dx: number, dy: number) => r4((Math.atan2(dy, dx) * 180) / Math.PI);
const center = (p: Params, b: Box) => toDoc(b, (p.center as PathPoint | undefined) ?? { x: 0.5, y: 0.5 });
const pins = (p: Params) => (p.pins as Pin[] | undefined) ?? [];
const paths = (p: Params) => (p.paths as PathPoint[][] | undefined) ?? [];

// The ellipse frame of Iris and Spin: center, axis directions, axis lengths and size in px.
function ellipse(kind: string, p: Params, b: Box) {
  const c = center(p, b), size = num(p, 'radius') * short(b);
  const a = kind === 'iris_blur' ? (num(p, 'rotation') * Math.PI) / 180 : 0;
  const u: Pt = [Math.cos(a), Math.sin(a)], v: Pt = [-Math.sin(a), Math.cos(a)];
  return { c, u, v, ax: size * Math.max(0.01, num(p, 'aspect')), ay: size, size };
}

// The tilt-shift frame: center, line direction l, normal n, focus and feather in px.
function tilt(p: Params, b: Box) {
  const a = (num(p, 'rotation') * Math.PI) / 180, s = short(b);
  return { c: center(p, b), l: [Math.cos(a), Math.sin(a)] as Pt, n: [-Math.sin(a), Math.cos(a)] as Pt, focus: num(p, 'focusWidth') * s, feather: num(p, 'featherWidth') * s, s };
}

const along = (c: Pt, d: Pt, k: number): Pt => [c[0] + d[0] * k, c[1] + d[1] * k];

export function handles(kind: string, p: Params, b: Box): Handle[] {
  if (kind === 'field_blur') return pins(p).map((q, i) => ({ id: `pin:${i}`, at: toDoc(b, q) }));
  if (kind === 'path_blur') return paths(p).flatMap((q, j) => q.map((pt, k) => ({ id: `pt:${j}:${k}`, at: toDoc(b, pt) })));
  if (kind === 'tilt_shift') {
    const t = tilt(p, b);
    return [{ id: 'center', at: t.c }, { id: 'rotate', at: along(t.c, t.l, t.s * 0.3) }, { id: 'focus', at: along(t.c, t.n, t.focus) }, { id: 'feather', at: along(t.c, t.n, t.focus + t.feather) }];
  }
  const e = ellipse(kind, p, b);
  return [{ id: 'center', at: e.c }, { id: 'axisX', at: along(e.c, e.u, e.ax) }, { id: 'axisY', at: along(e.c, e.v, e.ay) },
    { id: 'feather', at: along(e.c, e.u, e.ax * (1 - num(p, 'feather'))) }];
}

// The params changed by dragging handle `id` to `at`.
export function drag(kind: string, p: Params, id: string, at: Pt, b: Box): Params {
  if (id === 'center') return { center: toFrac(b, at) };
  const [what, i, k] = id.split(':');
  if (what === 'pin') return { pins: pins(p).map((q, n) => (n === Number(i) ? { ...q, ...toFrac(b, at) } : q)) };
  if (what === 'pt') return { paths: paths(p).map((q, j) => (j !== Number(i) ? q : q.map((pt, n) => (n === Number(k) ? toFrac(b, at) : pt)))) };
  if (kind === 'tilt_shift') {
    const t = tilt(p, b), d: Pt = [at[0] - t.c[0], at[1] - t.c[1]], off = Math.abs(d[0] * t.n[0] + d[1] * t.n[1]) / t.s;
    if (id === 'rotate') return { rotation: deg(d[0], d[1]) };
    if (id === 'focus') return { focusWidth: r4(clamp(off, 0, 1)) };
    return { featherWidth: r4(clamp(off - t.focus / t.s, 0, 2)) };
  }
  const e = ellipse(kind, p, b), d: Pt = [at[0] - e.c[0], at[1] - e.c[1]];
  if (id === 'axisY') return { radius: r4(clamp(Math.abs(d[0] * e.v[0] + d[1] * e.v[1]) / short(b), 0.01, 2)) };
  const proj = d[0] * e.u[0] + d[1] * e.u[1];
  if (id === 'feather') return { feather: r4(clamp(1 - proj / e.ax, 0, 1)) };
  if (kind === 'iris_blur') return { rotation: deg(d[0], d[1]), aspect: r4(clamp(Math.hypot(d[0], d[1]) / e.size, 0.1, 10)) };
  return { aspect: r4(clamp(Math.abs(proj) / e.size, 0.1, 10)) };
}

// Rounds handle results to their dialog field step; finer values fail the form's validation on OK.
export function snap(spec: FilterParam[], patch: Params): Params {
  const to = (v: number, step: number) => (step > 0 ? Number((Math.round(v / step) * step).toFixed((String(step).split('.')[1] ?? '').length)) : v);
  return Object.fromEntries(Object.entries(patch).map(([k, v]) => {
    const s = spec.find(q => q.key === k);
    if (!s) return [k, v];
    if (typeof v === 'number') return [k, to(v, s.step)];
    if (s.kind === 'point') { const q = v as PathPoint; return [k, { x: to(q.x, s.step), y: to(q.y, s.step) }]; }
    return [k, v];
  }));
}

// A click on empty canvas: a new pin (with `blur`) or path point, and the handle to keep dragging.
export function addAt(kind: string, p: Params, at: Pt, b: Box, alt: boolean, blur: number): { params: Params; id: string } | null {
  const f = toFrac(b, at);
  if (kind === 'field_blur') return { params: { pins: [...pins(p), { ...f, blur }] }, id: `pin:${pins(p).length}` };
  if (kind !== 'path_blur') return null;
  const ps = paths(p);
  if (alt || !ps.length) return { params: { paths: [...ps, [f, { ...f }]] }, id: `pt:${ps.length}:1` };
  const last = ps.length - 1;
  return { params: { paths: ps.map((q, j) => (j === last ? [...q, f] : q)) }, id: `pt:${last}:${ps[last].length}` };
}

// Delete on a handle: a pin, a path point, or a whole two-point path; null when the last one must stay.
export function removeHandle(kind: string, p: Params, id: string): Params | null {
  const [what, i, k] = id.split(':');
  if (kind === 'field_blur' && what === 'pin') return pins(p).length > 1 ? { pins: pins(p).filter((_, n) => n !== Number(i)) } : null;
  if (kind !== 'path_blur' || what !== 'pt') return null;
  const ps = paths(p), j = Number(i);
  if (ps[j].length > 2) return { paths: ps.map((q, n) => (n === j ? q.filter((_, m) => m !== Number(k)) : q)) };
  return ps.length > 1 ? { paths: ps.filter((_, n) => n !== j) } : null;
}

// Turning a pin's ring by `turn` radians changes its blur by 100 px per full turn.
export const ringBlur = (blur: number, turn: number) => Math.round(clamp(blur + (turn / (2 * Math.PI)) * 100, 0, 1000));

// What to draw besides the handles: the iris superellipse, the spin ellipse, tilt lines, paths.
export function outline(kind: string, p: Params, b: Box): Outline {
  if (kind === 'field_blur') return { solid: [], dashed: [] };
  if (kind === 'path_blur') return { solid: paths(p).map(q => q.map(pt => toDoc(b, pt))), dashed: [] };
  if (kind === 'tilt_shift') {
    const t = tilt(p, b), len = Math.hypot(b[2], b[3]);
    const line = (o: number): Pt[] => [along(along(t.c, t.n, o), t.l, -len), along(along(t.c, t.n, o), t.l, len)];
    return { solid: [line(t.focus), line(-t.focus)], dashed: [line(t.focus + t.feather), line(-t.focus - t.feather)] };
  }
  const e = ellipse(kind, p, b), q = kind === 'iris_blur' ? 2 + clamp(num(p, 'roundness'), 0, 1) * 4 : 2;
  const ring = (k: number): Pt[] => Array.from({ length: 73 }, (_, i) => {
    const a = (i / 72) * 2 * Math.PI, cs = Math.cos(a), sn = Math.sin(a);
    const x = Math.sign(cs) * Math.abs(cs) ** (2 / q) * e.ax * k, y = Math.sign(sn) * Math.abs(sn) ** (2 / q) * e.ay * k;
    return [e.c[0] + e.u[0] * x + e.v[0] * y, e.c[1] + e.u[1] * x + e.v[1] * y];
  });
  return { solid: [ring(1)], dashed: [ring(1 - num(p, 'feather'))] };
}
