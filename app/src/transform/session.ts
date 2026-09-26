import { affine, apply, identityParams, invert, linear, rectQuad, transformMatrix, type Mat3, type Params, type Pt, type Quad, type Rect } from './matrix.ts';

export type Mode = 'free' | 'scale' | 'rotate' | 'skew' | 'distort' | 'perspective' | 'warp';
export type Op = 'move' | 'rotate' | 'ref' | 'scale' | 'skew' | 'distort' | 'perspective';
export type Hit = { kind: 'ref' } | { kind: 'handle'; i: number } | { kind: 'body' } | { kind: 'rotate' } | null;
export interface Mods { shift: boolean; alt: boolean; ctrl: boolean }
// `ref` and `quad` live in pre-affine source space: the quad distorts the bounds, then the params apply.
export interface TState { bounds: Rect; p: Params; ref: Pt; quad: Quad | null }
export interface DragOpts {
  linked: boolean;
  // Snaps a dragged handle's dest position.
  snapPoint?: (p: Pt) => Pt;
  // Snaps a move offset for the dest bounding box.
  snapMove?: (box: Rect, dx: number, dy: number) => [number, number];
}
export type NumericField = 'x' | 'y' | 'w' | 'h' | 'angle' | 'skewX' | 'skewY';
export const NUMERIC_FIELDS: NumericField[] = ['x', 'y', 'w', 'h', 'angle', 'skewX', 'skewY'];
export type Command = '180' | 'cw' | 'ccw' | 'flipH' | 'flipV';

const DEG = Math.PI / 180;
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

export function initialState(bounds: Rect): TState {
  return { bounds, p: identityParams(), ref: [bounds.x + bounds.w / 2, bounds.y + bounds.h / 2], quad: null };
}

export const matrixOf = (s: TState): Mat3 => transformMatrix(s.p, s.ref, s.bounds, s.quad);
const affineOf = (s: TState) => affine(s.p, s.ref);

// The 8 handles in pre-affine space, clockwise from the top-left corner (corners at even indexes).
function srcHandles(s: TState): Pt[] {
  const q = s.quad ?? rectQuad(s.bounds);
  return q.flatMap((c, k) => [c, mid(c, q[(k + 1) % 4])]);
}

export function handlePoints(s: TState): Pt[] {
  const a = affineOf(s);
  return srcHandles(s).map(p => apply(a, p[0], p[1]));
}

export const refPoint = (s: TState): Pt => [s.ref[0] + s.p.tx, s.ref[1] + s.p.ty];

function segDist(p: Pt, a: Pt, b: Pt): number {
  const [dx, dy] = sub(b, a), len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function inside(p: Pt, poly: Pt[]): boolean {
  let n = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) n = !n;
  }
  return n;
}

// `screen` and the radius are screen px; `toScreen` maps document px to screen px.
export function hitTest(s: TState, toScreen: (p: Pt) => Pt, screen: Pt, radius = 8): Hit {
  const near = (p: Pt) => Math.hypot(p[0] - screen[0], p[1] - screen[1]) <= radius;
  if (near(toScreen(refPoint(s)))) return { kind: 'ref' };
  const hs = handlePoints(s).map(toScreen);
  for (const i of [0, 2, 4, 6, 1, 3, 5, 7]) if (near(hs[i])) return { kind: 'handle', i };
  const quad = [hs[0], hs[2], hs[4], hs[6]];
  const centre = mid(mid(quad[0], quad[1]), mid(quad[2], quad[3]));
  const top = hs[1];
  if (near([top[0] + (top[0] - centre[0]) / 4, top[1] + (top[1] - centre[1]) / 4])) return { kind: 'rotate' };
  if (inside(screen, quad)) return { kind: 'body' };
  return quad.some((a, k) => segDist(screen, a, quad[(k + 1) % 4]) <= radius * 4) ? { kind: 'rotate' } : null;
}

export function opFor(hit: Exclude<Hit, null>, m: Mods, mode: Mode): Op {
  if (hit.kind === 'body') return 'move';
  if (hit.kind === 'rotate') return 'rotate';
  if (hit.kind === 'ref') return 'ref';
  const corner = hit.i % 2 === 0;
  if (m.ctrl && m.alt && m.shift && corner) return 'perspective';
  if (m.ctrl && m.shift) return 'skew';
  if (m.ctrl) return 'distort';
  if (mode === 'rotate') return 'rotate';
  if (mode === 'skew') return 'skew';
  if (mode === 'distort') return 'distort';
  if (mode === 'perspective' && corner) return 'perspective';
  return 'scale';
}

const inv2 = ([a, b, c, d]: number[]): [number, number, number, number] => {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det];
};
const mul2 = (m: number[], v: Pt): Pt => [m[0] * v[0] + m[1] * v[1], m[2] * v[0] + m[3] * v[1]];

// Shifts the translation so the pre-affine point `a` lands where it did under `before`.
function keep(before: TState, after: TState, a: Pt): TState {
  const d = sub(apply(affineOf(before), a[0], a[1]), apply(affineOf(after), a[0], a[1]));
  return { ...after, p: { ...after.p, tx: after.p.tx + d[0], ty: after.p.ty + d[1] } };
}

function convex(q: Quad): boolean {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = sub(q[(k + 1) % 4], q[k]), [bx, by] = sub(q[(k + 2) % 4], q[(k + 1) % 4]);
    const c = ax * by - ay * bx;
    if (Math.abs(c) < 1e-9) return false;
    if (sign && Math.sign(c) !== sign) return false;
    sign = Math.sign(c);
  }
  return true;
}

// The state after dragging from `from` to `to` (document px), always from the drag's start state
// `s`, so a modifier change mid-drag just re-evaluates. Null when the result would be degenerate.
export function drag(s: TState, hit: Exclude<Hit, null>, op: Op, m: Mods, from: Pt, to: Pt, o: DragOpts): TState | null {
  const d = sub(to, from);
  if (op === 'move') {
    let [dx, dy] = m.shift ? (Math.abs(d[0]) >= Math.abs(d[1]) ? [d[0], 0] : [0, d[1]]) : d;
    if (o.snapMove) {
      const hs = handlePoints(s), xs = hs.map(p => p[0]), ys = hs.map(p => p[1]);
      const x0 = Math.min(...xs), y0 = Math.min(...ys);
      [dx, dy] = o.snapMove({ x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 }, dx, dy);
    }
    return { ...s, p: { ...s.p, tx: s.p.tx + dx, ty: s.p.ty + dy } };
  }
  if (op === 'ref') return setReference(s, add(refPoint(s), d));
  if (op === 'rotate') {
    const c = refPoint(s);
    let r = s.p.rotation + Math.atan2(to[1] - c[1], to[0] - c[0]) - Math.atan2(from[1] - c[1], from[0] - c[0]);
    if (m.shift) r = Math.round(r / (15 * DEG)) * 15 * DEG;
    return { ...s, p: { ...s.p, rotation: wrap(r) } };
  }
  if (hit.kind !== 'handle') return s;
  const i = hit.i, corner = i % 2 === 0, src = srcHandles(s);
  if (op === 'skew' && (corner || s.quad)) return distort(s, i, { ...m, shift: true }, d);
  if (op === 'distort') return distort(s, i, m, d);
  if (op === 'perspective') return perspective(s, i, d);
  const h = src[i], a = m.alt ? s.ref : src[(i + 4) % 8];
  if (op === 'skew') {
    const r = mul2(inv2(linear({ ...identityParams(), rotation: s.p.rotation })), d);
    const p = { ...s.p };
    if (i === 1 || i === 5) {
      if (Math.abs(h[1] - a[1]) < 1e-9) return s;
      p.skewX = Math.atan(Math.tan(s.p.skewX) + r[0] / ((h[1] - a[1]) * s.p.sy));
    } else {
      if (Math.abs(h[0] - a[0]) < 1e-9) return s;
      p.skewY = Math.atan(Math.tan(s.p.skewY) + r[1] / ((h[0] - a[0]) * s.p.sx));
    }
    return keep(s, { ...s, p }, a);
  }
  // Scale: in the local frame (rotation and skew undone, origin at the dest reference) a source
  // offset x - ref sits at S (x - ref).
  const hd = apply(affineOf(s), h[0], h[1]);
  const target = o.snapPoint ? o.snapPoint(add(hd, d)) : add(hd, d);
  const local = mul2(inv2(linear({ ...s.p, sx: 1, sy: 1 })), sub(target, refPoint(s)));
  const a0: Pt = [s.p.sx * (a[0] - s.ref[0]), s.p.sy * (a[1] - s.ref[1])];
  const useX = corner || i === 3 || i === 7, useY = corner || i === 1 || i === 5;
  let sx = useX && Math.abs(h[0] - a[0]) > 1e-9 ? (local[0] - a0[0]) / (h[0] - a[0]) : s.p.sx;
  let sy = useY && Math.abs(h[1] - a[1]) > 1e-9 ? (local[1] - a0[1]) / (h[1] - a[1]) : s.p.sy;
  if (corner ? o.linked !== m.shift : m.shift) {
    const rx = sx / s.p.sx, ry = sy / s.p.sy;
    const r = corner ? (Math.abs(rx - 1) >= Math.abs(ry - 1) ? rx : ry) : useX ? rx : ry;
    sx = s.p.sx * r;
    sy = s.p.sy * r;
  }
  if (Math.abs(sx) < 1e-6 || Math.abs(sy) < 1e-6) return null;
  return keep(s, { ...s, p: { ...s.p, sx, sy } }, a);
}

function preQuad(s: TState, d: Pt): { q: Quad; d: Pt } {
  const q = (s.quad ?? rectQuad(s.bounds)).map(p => [...p]) as Quad;
  return { q, d: mul2(inv2(linear(s.p)), d) };
}

function withQuad(s: TState, q: Quad): TState | null {
  return convex(q) ? { ...s, quad: q } : null;
}

function distort(s: TState, i: number, m: Mods, dd: Pt): TState | null {
  const { q } = preQuad(s, dd);
  let { d } = preQuad(s, dd);
  const move = (k: number, v: Pt) => { q[k] = add(q[k], v); };
  if (i % 2 === 0) {
    const k = i / 2;
    if (m.shift) d = Math.abs(d[0]) >= Math.abs(d[1]) ? [d[0], 0] : [0, d[1]];
    move(k, d);
    if (m.alt) move((k + 2) % 4, [-d[0], -d[1]]);
  } else {
    const k1 = (i - 1) / 2, k2 = (k1 + 1) % 4;
    if (m.shift) {
      const e = sub(q[k2], q[k1]), len = Math.hypot(...e);
      const t = len ? (d[0] * e[0] + d[1] * e[1]) / (len * len) : 0;
      d = [e[0] * t, e[1] * t];
    }
    move(k1, d);
    move(k2, d);
    if (m.alt) { move((k1 + 2) % 4, [-d[0], -d[1]]); move((k2 + 2) % 4, [-d[0], -d[1]]); }
  }
  return withQuad(s, q);
}

function perspective(s: TState, i: number, dd: Pt): TState | null {
  if (i % 2) return s;
  const { q, d } = preQuad(s, dd), k = i / 2;
  if (Math.abs(d[0]) >= Math.abs(d[1])) {
    q[k] = [q[k][0] + d[0], q[k][1]];
    const j = [1, 0, 3, 2][k];
    q[j] = [q[j][0] - d[0], q[j][1]];
  } else {
    q[k] = [q[k][0], q[k][1] + d[1]];
    const j = [3, 2, 1, 0][k];
    q[j] = [q[j][0], q[j][1] - d[1]];
  }
  return withQuad(s, q);
}

const wrap = (r: number) => Math.atan2(Math.sin(r), Math.cos(r));

// Moves the reference point to the dest point `dest` without changing the matrix.
export function setReference(s: TState, dest: Pt): TState {
  const inv = invert(affineOf(s));
  if (!inv) return s;
  const ref = apply(inv, dest[0], dest[1]);
  return { ...s, ref, p: { ...s.p, tx: dest[0] - ref[0], ty: dest[1] - ref[1] } };
}

// The 3x3 grid: u, v in {0, .5, 1} across the source bounds.
export function setReferenceNormalized(s: TState, u: number, v: number): TState {
  const b = s.bounds;
  return setReference(s, apply(matrixOf(s), b.x + u * b.w, b.y + v * b.h));
}

// X, Y (dest reference, doc px), W %, H %, angle, H skew, V skew (degrees).
export function numericValues(s: TState): number[] {
  const [x, y] = refPoint(s);
  return [x, y, s.p.sx * 100, s.p.sy * 100, s.p.rotation / DEG, s.p.skewX / DEG, s.p.skewY / DEG];
}

export function setNumeric(s: TState, f: NumericField, v: number, linked: boolean): TState {
  if (!Number.isFinite(v)) return s;
  const p = { ...s.p };
  const [x, y] = refPoint(s);
  if (f === 'x') p.tx += v - x;
  else if (f === 'y') p.ty += v - y;
  else if (f === 'w' || f === 'h') {
    if (Math.abs(v) < 1e-4) return s;
    const ratio = Math.abs(s.p.sy / s.p.sx);
    if (f === 'w') { p.sx = v / 100; if (linked) p.sy = Math.sign(s.p.sy) * Math.abs(p.sx) * ratio; }
    else { p.sy = v / 100; if (linked) p.sx = (Math.sign(s.p.sx) * Math.abs(p.sy)) / ratio; }
  } else if (f === 'angle') p.rotation = wrap(v * DEG);
  else {
    if (Math.abs(v) >= 90) return s;
    if (f === 'skewX') p.skewX = v * DEG; else p.skewY = v * DEG;
  }
  return { ...s, p };
}

// Edit > Transform rotate/flip inside a session: numeric changes about the reference point.
export function commandState(s: TState, c: Command): TState {
  const p = { ...s.p };
  if (c === 'flipH') p.sx = -p.sx;
  else if (c === 'flipV') p.sy = -p.sy;
  else p.rotation = wrap(p.rotation + (c === '180' ? Math.PI : c === 'cw' ? Math.PI / 2 : -Math.PI / 2));
  return { ...s, p };
}
