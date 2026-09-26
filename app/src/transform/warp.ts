// Warp mesh model: a cols x rows grid of bicubic Bezier patches over a source bounds rect.
import type { Pt, Rect } from './matrix.ts';

// (3 cols + 1) x (3 rows + 1) control points in document px, row-major; the stops are the patch
// boundaries in parameter space [0, 1], strictly rising.
export interface Mesh { cols: number; rows: number; points: Pt[]; columnStops: number[]; rowStops: number[]; bounds: Rect }
// 'vertical' works on column stops (a vertical split line), 'horizontal' on row stops.
export type Axis = 'vertical' | 'horizontal';
export const STYLES = ['none', 'custom', 'arc', 'arcLower', 'arcUpper', 'arch', 'bulge', 'shellLower', 'shellUpper', 'flag', 'wave', 'fish', 'rise', 'fisheye', 'inflate', 'squeeze', 'twist'] as const;
export type Style = typeof STYLES[number];
// bend and the distortions are -1..1.
export interface Preset { style: Style; bend: number; horizontalDistortion: number; verticalDistortion: number; orientation: 'horizontal' | 'vertical' }
export interface Warp { mesh: Mesh; preset: Preset }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const bernstein = (t: number) => { const s = 1 - t; return [s * s * s, 3 * t * s * s, 3 * t * t * s, t * t * t]; };
const custom = (w: Warp, mesh: Mesh): Warp => ({ mesh, preset: { ...w.preset, style: 'custom' } });

export function identityMesh(bounds: Rect): Mesh {
  const points = Array.from({ length: 16 }, (_, k): Pt => [bounds.x + (k % 4) * bounds.w / 3, bounds.y + Math.floor(k / 4) * bounds.h / 3]);
  return { cols: 1, rows: 1, points, columnStops: [0, 1], rowStops: [0, 1], bounds };
}

// The patch holding global parameter s (clamped to [0, 1]) and the local parameter within it.
function locate(stops: number[], s: number): [number, number] {
  const t = clamp(s, 0, 1);
  let i = 0;
  while (i < stops.length - 2 && t >= stops[i + 1]) i++;
  return [i, (t - stops[i]) / (stops[i + 1] - stops[i])];
}

// Bernstein cubic in u on the patch's 4 rows, then in v on the result.
export function evaluate(m: Mesh, s: number, t: number): Pt {
  const [i, u] = locate(m.columnStops, s), [j, v] = locate(m.rowStops, t);
  const bu = bernstein(u), bv = bernstein(v), stride = 3 * m.cols + 1;
  let x = 0, y = 0;
  for (let r = 0; r < 4; r++) {
    let rx = 0, ry = 0;
    for (let k = 0; k < 4; k++) {
      const p = m.points[(3 * j + r) * stride + 3 * i + k];
      rx += bu[k] * p[0];
      ry += bu[k] * p[1];
    }
    x += bv[r] * rx;
    y += bv[r] * ry;
  }
  return [x, y];
}

type Lines = { lines: Pt[][]; stops: number[] } | null;

// de Casteljau at the local parameter on every line; null on an existing stop or an edge.
function splitLines(lines: Pt[][], stops: number[], t: number): Lines {
  const [n, l] = locate(stops, t);
  if (l <= 1e-9 || l >= 1 - 1e-9) return null;
  const o = 3 * n;
  return {
    lines: lines.map(L => {
      const [a, b, c, d] = L.slice(o, o + 4);
      const ab = lerp(a, b, l), bc = lerp(b, c, l), cd = lerp(c, d, l), abc = lerp(ab, bc, l), bcd = lerp(bc, cd, l);
      return [...L.slice(0, o), a, ab, abc, lerp(abc, bcd, l), bcd, cd, d, ...L.slice(o + 4)];
    }),
    stops: [...stops.slice(0, n + 1), t, ...stops.slice(n + 1)],
  };
}

// Inverse de Casteljau across interior stop e: with ratio i, the merged handles are a + (r - a) / i and (C - i c) / (1 - i).
function mergeLines(lines: Pt[][], stops: number[], e: number): Lines {
  if (e < 1 || e > stops.length - 2) return null;
  const i = (stops[e] - stops[e - 1]) / (stops[e + 1] - stops[e - 1]);
  if (i <= 1e-9 || i >= 1 - 1e-9) return null;
  const o = 3 * (e - 1);
  return {
    lines: lines.map(L => {
      const a = L[o], r = L[o + 1], C = L[o + 5], c = L[o + 6];
      const h: Pt = [a[0] + (r[0] - a[0]) / i, a[1] + (r[1] - a[1]) / i];
      const q: Pt = [(C[0] - i * c[0]) / (1 - i), (C[1] - i * c[1]) / (1 - i)];
      return [...L.slice(0, o + 1), h, q, ...L.slice(o + 6)];
    }),
    stops: [...stops.slice(0, e), ...stops.slice(e + 1)],
  };
}

const transpose = (g: Pt[][]) => g[0].map((_, i) => g.map(r => r[i]));

// Runs f on the rows (column stops) or the columns (row stops); the mesh is returned as is when f declines.
function onAxis(m: Mesh, axis: Axis, dn: number, f: (lines: Pt[][], stops: number[]) => Lines): Mesh {
  const stride = 3 * m.cols + 1;
  const rows = Array.from({ length: 3 * m.rows + 1 }, (_, j) => m.points.slice(j * stride, (j + 1) * stride));
  if (axis === 'vertical') {
    const r = f(rows, m.columnStops);
    return r ? { ...m, cols: m.cols + dn, points: r.lines.flat(), columnStops: r.stops } : m;
  }
  const r = f(transpose(rows), m.rowStops);
  return r ? { ...m, rows: m.rows + dn, points: transpose(r.lines).flat(), rowStops: r.stops } : m;
}

// Shape-preserving split at global parameter t; inserts a stop.
export const split = (m: Mesh, axis: Axis, t: number) => onAxis(m, axis, 1, (l, s) => splitLines(l, s, t));
// Removes interior stop `boundary` (1..stops.length - 2) of the axis.
export const removeSplit = (m: Mesh, axis: Axis, boundary: number) => onAxis(m, axis, -1, (l, s) => mergeLines(l, s, boundary));

// Document point -> global (u, v): 13x13 coarse search, then up to 16 Newton steps with a finite-difference Jacobian.
export function parameterAt(m: Mesh, x: number, y: number): { u: number; v: number; distance: number } {
  let u = 0, v = 0, best = Infinity;
  for (let j = 0; j <= 12; j++) for (let i = 0; i <= 12; i++) {
    const p = evaluate(m, i / 12, j / 12), d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
    if (d < best) [best, u, v] = [d, i / 12, j / 12];
  }
  const eps = 1e-4;
  for (let k = 0; k < 16; k++) {
    const p = evaluate(m, u, v), du = u > 0.999 ? -eps : eps, dv = v > 0.999 ? -eps : eps;
    const pu = evaluate(m, u + du, v), pv = evaluate(m, u, v + dv);
    const a = (pu[0] - p[0]) / du, c = (pu[1] - p[1]) / du, b = (pv[0] - p[0]) / dv, d = (pv[1] - p[1]) / dv;
    const det = a * d - c * b;
    if (Math.abs(det) < 1e-8) break;
    const ex = x - p[0], ey = y - p[1];
    u = clamp(u + (ex * d - ey * b) / det, 0, 1);
    v = clamp(v + (ey * a - ex * c) / det, 0, 1);
    if (ex * ex + ey * ey < 1e-8) break;
  }
  const p = evaluate(m, u, v);
  return { u, v, distance: Math.hypot(p[0] - x, p[1] - y) };
}

// The interior stop nearest to the point in parameter space; column stops win a tie.
export function nearestSplit(m: Mesh, x: number, y: number): { axis: Axis; boundary: number } | null {
  const { u, v } = parameterAt(m, x, y);
  let hit: { axis: Axis; boundary: number } | null = null, best = Infinity;
  for (const [axis, stops, s] of [['vertical', m.columnStops, u], ['horizontal', m.rowStops, v]] as const) {
    for (let i = 1; i < stops.length - 1; i++) {
      const d = Math.abs(stops[i] - s);
      if (d < best) [best, hit] = [d, { axis, boundary: i }];
    }
  }
  return hit;
}

// Grid presets 1, 3, 4, 5: remove every split, then split at s/n on both axes.
export function setGrid(w: Warp, n: number): Warp {
  let m = w.mesh;
  for (const axis of ['vertical', 'horizontal'] as const) {
    for (let r = removeSplit(m, axis, 1); r !== m; r = removeSplit(m, axis, 1)) m = r;
  }
  for (const axis of ['vertical', 'horizontal'] as const) for (let s = 1; s < n; s++) m = split(m, axis, s / n);
  return custom(w, m);
}

// Moves control point `index` of the drag-start state; an anchor (index 0 mod 3 on both axes) carries its +/-1 neighbours.
export function dragPoint(w: Warp, index: number, dx: number, dy: number): Warp {
  const m = w.mesh, stride = 3 * m.cols + 1;
  if (!(index >= 0 && index < m.points.length)) return w;
  const r = Math.floor(index / stride), c = index % stride, anchor = r % 3 === 0 && c % 3 === 0;
  const points = m.points.map((p, i): Pt => {
    const hit = i === index || (anchor && Math.abs(Math.floor(i / stride) - r) <= 1 && Math.abs(i % stride - c) <= 1);
    return hit ? [p[0] + dx, p[1] + dy] : p;
  });
  return custom(w, { ...m, points });
}

// Least-norm weights w_ij = B_i(u) B_j(v) / sum (B_i B_j)^2 over the grabbed patch's non-corner points, so the
// grabbed surface point follows the cursor exactly. Null when the point is farther than `tol` or at a patch corner.
export function surfaceWeights(m: Mesh, x: number, y: number, tol: number): number[] | null {
  const { u, v, distance } = parameterAt(m, x, y);
  if (distance > tol) return null;
  const patch = (stops: number[], s: number) => clamp(stops.findIndex((st, i) => i > 0 && s <= st) - 1, 0, stops.length - 2);
  const i = patch(m.columnStops, u), j = patch(m.rowStops, v), stride = 3 * m.cols + 1;
  const bu = bernstein((u - m.columnStops[i]) / (m.columnStops[i + 1] - m.columnStops[i]));
  const bv = bernstein((v - m.rowStops[j]) / (m.rowStops[j + 1] - m.rowStops[j]));
  const weights = new Array<number>(m.points.length).fill(0);
  let sum = 0;
  for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) {
    if ((k === 0 || k === 3) && (r === 0 || r === 3)) continue;
    const b = bu[k] * bv[r];
    weights[(3 * j + r) * stride + 3 * i + k] = b;
    sum += b * b;
  }
  return sum < 1e-6 ? null : weights.map(b => b / sum);
}

// Offsets the drag-start mesh by the pointer delta times each point's weight.
export function dragSurface(w: Warp, weights: number[], dx: number, dy: number): Warp {
  return custom(w, { ...w.mesh, points: w.mesh.points.map((p, i): Pt => [p[0] + dx * weights[i], p[1] + dy * weights[i]]) });
}

export function defaultPreset(style: Style = 'none'): Preset {
  return { style, bend: 0, horizontalDistortion: 0, verticalDistortion: 0, orientation: 'horizontal' };
}

// Picking a style from none or custom starts at bend 0.5.
export function pickStyle(p: Preset, style: Style): Preset {
  return { ...p, style, bend: p.style === 'none' || p.style === 'custom' ? 0.5 : p.bend };
}

// The style's envelope: a cols x rows grid of points (row-major, bounds origin added); null for custom.
function envelope(p: Preset, b: Rect): { cols: number; rows: number; points: Pt[] } | null {
  const vert = p.orientation === 'vertical', g = vert ? b.h : b.w, I = vert ? b.w : b.h, a = clamp(p.bend, -1, 1), st = p.style;
  const lattice = (nc: number, nr: number) => Array.from({ length: nc * nr }, (_, k): Pt => [k % nc * g / (nc - 1), Math.floor(k / nc) * I / (nr - 1)]);
  let cols = 4, rows = 2, c = lattice(4, 2);
  const grid = (nc: number, nr: number) => { [cols, rows, c] = [nc, nr, lattice(nc, nr)]; };
  const shift = (k: number, dx: number, dy: number) => { c[k] = [c[k][0] + dx, c[k][1] + dy]; };
  const Q = Math.abs(a) * Math.PI / 2, l = Math.sin(Q), B = Math.cos(Q), E = 4 / 3 * Math.tan(Q / 2);
  const f = l > 1e-12 ? g / (2 * l) : 0, u = l > 1e-12 ? E * f * B : g / 3, d = E * g / 2 * Math.sign(a);
  // Circular arc of radius M about (g/2, I + f B), spanning +/-Q.
  const arcRow = (M: number): Pt[] => {
    const x = g / 2 - M * l, y = I + f * B - M * B;
    return [[x, y], [x + E * M * B, y - E * M * l], [g - x - E * M * B, y - E * M * l], [g - x, y]];
  };
  const arc = (): Pt[] => {
    if (!a) return lattice(4, 2);
    const r = [arcRow(f + I), arcRow(f)];
    return a > 0 ? r.flat() : r.reverse().flatMap(row => row.map(([x, y]): Pt => [x, I - y]));
  };
  switch (st) {
    case 'none': break;
    case 'custom': return null;
    case 'arc': c = arc(); break;
    case 'arcUpper': case 'arcLower': case 'arch': case 'bulge':
      for (const M of [0, 1]) {
        if ((st === 'arcUpper' && M === 1) || (st === 'arcLower' && M === 0)) continue;
        const y = M * I + (st === 'arch' || M === 0 ? -d : d);
        c[M * 4 + 1] = [u, y];
        c[M * 4 + 2] = [g - u, y];
      }
      break;
    case 'shellUpper': case 'shellLower': {
      grid(4, 4);
      const t = arc();
      for (let k = 0; k < 4; k++) c[k] = t[k];
      for (const k of [0, 3]) c[4 + k] = [t[k][0] * 2 / 3 + t[4 + k][0] / 3, t[k][1] * 2 / 3 + t[4 + k][1] / 3];
      if (st === 'shellLower') c = c.map((_, k): Pt => { const q = c[(3 - Math.floor(k / 4)) * 4 + k % 4]; return [q[0], I - q[1]]; });
      break;
    }
    case 'flag': case 'fish':
      for (const M of [0, 1]) {
        const s = st === 'fish' && M === 1 ? -1 : 1;
        shift(M * 4 + 1, 0, -2 * I * a * s);
        shift(M * 4 + 2, 0, 2 * I * a * s);
      }
      break;
    case 'rise': for (const k of [0, 1, 4, 5]) shift(k, 0, 2 * I * a); break;
    case 'wave': grid(4, 3); shift(5, 0, 2 * I * a); shift(6, 0, -2 * I * a); break;
    case 'fisheye':
      grid(4, 4);
      for (const r of [1, 2]) for (const k of [1, 2]) shift(r * 4 + k, (k === 1 ? -1 : 1) * g * 2 * a / 3, (r === 1 ? -1 : 1) * I * 2 * a / 3);
      break;
    case 'twist':
      grid(4, 4);
      if (a >= 0) { shift(5, g * a, 0); shift(6, 0, I * a); shift(9, 0, -I * a); shift(10, -g * a, 0); }
      else { shift(5, 0, -I * a); shift(6, g * a, 0); shift(9, -g * a, 0); shift(10, 0, I * a); }
      break;
    case 'inflate': case 'squeeze': {
      grid(3, 3);
      const sg = st === 'squeeze' ? 1 : -1;
      shift(1, 0, -I * a / 2); shift(7, 0, I * a / 2); shift(3, sg * g * a / 2, 0); shift(5, -sg * g * a / 2, 0);
      break;
    }
  }
  if (vert) {
    const t = c;
    c = Array.from({ length: cols * rows }, (_, k): Pt => { const q = t[(k % rows) * cols + Math.floor(k / rows)]; return [q[1], q[0]]; });
    [cols, rows] = [rows, cols];
  }
  const vd = st === 'none' ? 0 : clamp(p.verticalDistortion, -1, 1), hd = st === 'none' ? 0 : clamp(p.horizontalDistortion, -1, 1);
  const scale = (q: Pt, a0: Pt, a1: Pt, k: number): Pt => {
    const mx = (a0[0] + a1[0]) / 2, my = (a0[1] + a1[1]) / 2;
    return [mx + (q[0] - mx) * k, my + (q[1] - my) * k];
  };
  // Each row scales about the midpoint of its end points, then each column about the midpoint of its top and bottom.
  if (vd) c = c.map((q, k) => { const r = Math.floor(k / cols); return scale(q, c[r * cols], c[r * cols + cols - 1], 1 + vd * (2 * r / (rows - 1) - 1)); });
  if (hd) c = c.map((q, k) => { const s = k % cols; return scale(q, c[s], c[(rows - 1) * cols + s], 1 + hd * (2 * s / (cols - 1) - 1)); });
  return { cols, rows, points: c.map(([x, y]): Pt => [x + b.x, y + b.y]) };
}

// Degree elevation to 4 points: Q_i = (i/n) P_(i-1) + (1 - i/n) P_i, repeated.
function elevate(line: Pt[]): Pt[] {
  let t = line;
  while (t.length < 4) {
    const e = t.length, s = t;
    t = [s[0], ...s.slice(1).map((q, k): Pt => { const o = (k + 1) / e; return [s[k][0] * o + q[0] * (1 - o), s[k][1] * o + q[1] * (1 - o)]; }), s[e - 1]];
  }
  return t;
}

// The preset as one 4x4 bicubic patch over the bounds: rows, then columns, degree-elevated. Custom gives the identity.
export function presetMesh(p: Preset, bounds: Rect): Mesh {
  const env = envelope(p, bounds);
  if (!env) return identityMesh(bounds);
  const rows = Array.from({ length: env.rows }, (_, j) => elevate(env.points.slice(j * env.cols, (j + 1) * env.cols)));
  const points = new Array<Pt>(16);
  for (let k = 0; k < 4; k++) elevate(rows.map(r => r[k])).forEach((q, r) => { points[r * 4 + k] = q; });
  return { cols: 1, rows: 1, points, columnStops: [0, 1], rowStops: [0, 1], bounds };
}

// The engine's warp_layer mesh JSON; the mesh bounds must be the layer's tight bounds (the engine's source rect).
export function engineMesh(m: Mesh): string {
  return JSON.stringify({ cols: m.cols, rows: m.rows, points: m.points, columnStops: m.columnStops, rowStops: m.rowStops });
}

// Split mode 'both' splits crosswise through the point.
export type SplitMode = Axis | 'both';
// Splits through the surface point nearest to (x, y); mesh-level, the style is kept.
export function splitAt(m: Mesh, x: number, y: number, mode: SplitMode): Mesh {
  const { u, v } = parameterAt(m, x, y);
  const r = mode === 'horizontal' ? m : split(m, 'vertical', u);
  return mode === 'vertical' ? r : split(r, 'horizontal', v);
}

// Removes the interior stop nearest to (x, y); null when the mesh has no split.
export function removeSplitAt(m: Mesh, x: number, y: number): Mesh | null {
  const s = nearestSplit(m, x, y);
  return s && removeSplit(m, s.axis, s.boundary);
}

// Grid preset value of a mesh: '1', '3', '4', '5' for an n x n mesh, else 'custom'.
export const gridOf = (m: Mesh) => m.cols === m.rows && [1, 3, 4, 5].includes(m.cols) ? String(m.cols) : 'custom';

export const meshModified = (m: Mesh, initial: Mesh) =>
  m.points.length !== initial.points.length || m.points.some((p, i) => p[0] !== initial.points[i][0] || p[1] !== initial.points[i][1]);

// The control point nearest to `screen` within `radius` screen px, or null.
export function hitPoint(m: Mesh, toScreen: (p: Pt) => Pt, screen: Pt, radius: number): number | null {
  let hit: number | null = null, best = radius;
  m.points.forEach((p, i) => {
    const s = toScreen(p), d = Math.hypot(s[0] - screen[0], s[1] - screen[1]);
    if (d <= best) [best, hit] = [d, i];
  });
  return hit;
}
