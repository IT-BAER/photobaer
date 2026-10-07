// Pen and path selection tools (docs/M4.md section 4): hit testing, point edits, the pen and
// curvature drafts, subpath moves and the edit overlay. Pure, no engine calls.
import type { PathAnchor, PathRole, SavedPathInfo, VectorPath } from '../worker/types.ts';
import type { PathEditOverlay } from './SelectionOverlay.ts';
import { snap45, snap45Length } from './selecttools.ts';

export type XY = [number, number];
export type Sub = VectorPath['subpaths'][number];
// [subpath index, point index]
export type Ref = [number, number];
export interface Mods { shift: boolean; alt: boolean; ctrl: boolean }
export type Hit =
  | { kind: 'anchor'; s: number; i: number }
  | { kind: 'handle'; s: number; i: number; which: 'in' | 'out' }
  | { kind: 'segment'; s: number; seg: number; t: number }
  | { kind: 'fill'; s: number };
export interface Target { role: PathRole; id: number; path: VectorPath }

type Curve = [XY, XY, XY, XY];
const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const cornerAt = (x: number, y: number): PathAnchor => [x, y, x, y, x, y];
const cloneSub = (s: Sub): Sub => ({ ...s, points: s.points.map(p => [...p] as PathAnchor) });
const withSub = (path: VectorPath, s: number, sub: Sub): VectorPath => ({ ...path, subpaths: path.subpaths.map((x, k) => (k === s ? sub : x)) });
export const onePath = (sub: Sub): VectorPath => ({ fill_rule: 'nonzero', subpaths: [sub] });

// Segment k runs from point k to point k + 1, wrapping when closed.
export function segCount(s: Sub): number {
  const n = s.points.length;
  return n < 2 ? 0 : s.closed ? n : n - 1;
}

function curveOf(s: Sub, seg: number): Curve {
  const a = s.points[seg], b = s.points[(seg + 1) % s.points.length];
  return [[a[0], a[1]], [a[4], a[5]], [b[2], b[3]], [b[0], b[1]]];
}

function bezAt(c: Curve, t: number): XY {
  const u = 1 - t, k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [0, 1].map(j => k[0] * c[0][j] + k[1] * c[1][j] + k[2] * c[2][j] + k[3] * c[3][j]) as XY;
}

// The subpath as a polyline, `steps` per segment (a closed one ends back at its first point).
export function flattenSub(s: Sub, steps = 16): XY[] {
  if (!s.points.length) return [];
  const out: XY[] = [[s.points[0][0], s.points[0][1]]];
  for (let seg = 0; seg < segCount(s); seg++) {
    const c = curveOf(s, seg);
    for (let k = 1; k <= steps; k++) out.push(bezAt(c, k / steps));
  }
  return out;
}

// Smooth: both handles off the anchor, collinear on opposite sides (1e-6 relative).
export function isSmooth(p: PathAnchor): boolean {
  const ix = p[2] - p[0], iy = p[3] - p[1], ox = p[4] - p[0], oy = p[5] - p[1];
  const li = Math.hypot(ix, iy), lo = Math.hypot(ox, oy);
  if (li === 0 || lo === 0) return false;
  return Math.abs(ix * oy - iy * ox) <= 1e-6 * li * lo && ix * ox + iy * oy < 0;
}

function winding(poly: XY[], x: number, y: number): number {
  let w = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    if ((ay <= y) !== (by <= y) && ax + ((y - ay) / (by - ay)) * (bx - ax) > x) w += by > ay ? 1 : -1;
  }
  return w;
}

// Nearest anchor, else handle (not equal to its anchor), else segment point within `tol`; else the
// first subpath whose polygon contains the point under the path's fill rule.
export function hitTest(path: VectorPath, x: number, y: number, tol: number, o: { handles: boolean; fill: boolean }): Hit | null {
  const q: XY = [x, y];
  let best = null as Hit | null, bd = tol;
  path.subpaths.forEach((s, si) => s.points.forEach((p, i) => {
    const d = dist([p[0], p[1]], q);
    if (d <= bd) { bd = d; best = { kind: 'anchor', s: si, i }; }
  }));
  if (best) return best;
  if (o.handles) {
    path.subpaths.forEach((s, si) => s.points.forEach((p, i) => {
      for (const [which, h] of [['in', 2], ['out', 4]] as const) {
        if (p[h] === p[0] && p[h + 1] === p[1]) continue;
        const d = dist([p[h], p[h + 1]], q);
        if (d <= bd) { bd = d; best = { kind: 'handle', s: si, i, which }; }
      }
    }));
    if (best) return best;
  }
  path.subpaths.forEach((s, si) => {
    for (let seg = 0; seg < segCount(s); seg++) {
      const c = curveOf(s, seg), f = (t: number) => dist(bezAt(c, t), q);
      let k0 = 0;
      for (let k = 1; k <= 16; k++) if (f(k / 16) < f(k0 / 16)) k0 = k;
      let lo = Math.max(0, (k0 - 1) / 16), hi = Math.min(1, (k0 + 1) / 16);
      for (let it = 0; it < 24; it++) {
        const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
        if (f(m1) < f(m2)) hi = m2; else lo = m1;
      }
      const t = f((lo + hi) / 2) < f(k0 / 16) ? (lo + hi) / 2 : k0 / 16;
      if (f(t) <= bd) { bd = f(t); best = { kind: 'segment', s: si, seg, t }; }
    }
  });
  if (best || !o.fill) return best;
  const si = path.subpaths.findIndex(s => {
    const w = s.points.length > 2 ? winding(flattenSub(s), x, y) : 0;
    return path.fill_rule === 'evenodd' ? w % 2 !== 0 : w !== 0;
  });
  return si >= 0 ? { kind: 'fill', s: si } : null;
}

export function moveAnchor(s: Sub, i: number, dx: number, dy: number): Sub {
  const r = cloneSub(s), p = r.points[i];
  for (let k = 0; k < 6; k++) p[k] += k % 2 ? dy : dx;
  return r;
}

// Sets one handle. A smooth point (unless breakSmooth) keeps the other handle opposite: same length
// when symmetric (default: the lengths were equal), else its own length.
export function moveHandle(s: Sub, i: number, which: 'in' | 'out', x: number, y: number, o: { breakSmooth?: boolean; symmetric?: boolean }): Sub {
  const r = cloneSub(s), p = r.points[i];
  const [h, g] = which === 'in' ? [2, 4] : [4, 2];
  const own = Math.hypot(p[h] - p[0], p[h + 1] - p[1]), other = Math.hypot(p[g] - p[0], p[g + 1] - p[1]);
  const mirror = !o.breakSmooth && isSmooth(p);
  const symmetric = o.symmetric ?? Math.abs(own - other) <= 1e-6 * Math.max(1, own, other);
  p[h] = x;
  p[h + 1] = y;
  const dx = x - p[0], dy = y - p[1], l = Math.hypot(dx, dy);
  if (mirror && l > 0) {
    const k = (symmetric ? l : other) / l;
    p[g] = p[0] - dx * k;
    p[g + 1] = p[1] - dy * k;
  }
  return r;
}

export function convertToCorner(s: Sub, i: number): Sub {
  const r = cloneSub(s), p = r.points[i];
  r.points[i] = cornerAt(p[0], p[1]);
  return r;
}

// De Casteljau split of segment `seg` at t; the new smooth point goes in after point `seg`.
export function addAnchor(s: Sub, seg: number, t: number): Sub {
  const r = cloneSub(s), [p0, p1, p2, p3] = curveOf(s, seg);
  const lerp = (a: XY, b: XY): XY => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const a = lerp(p0, p1), b = lerp(p1, p2), c = lerp(p2, p3), d = lerp(a, b), e = lerp(b, c), m = lerp(d, e);
  const next = r.points[(seg + 1) % r.points.length];
  [r.points[seg][4], r.points[seg][5]] = a;
  [next[2], next[3]] = c;
  r.points.splice(seg + 1, 0, [m[0], m[1], d[0], d[1], e[0], e[1]]);
  return r;
}

// A closed subpath stays closed only with 3 or more points; an empty one is removed.
export function deleteAnchor(path: VectorPath, s: number, i: number): VectorPath {
  const subs = path.subpaths.map(cloneSub), sub = subs[s];
  sub.points.splice(i, 1);
  if (sub.closed && sub.points.length < 3) sub.closed = false;
  if (!sub.points.length) subs.splice(s, 1);
  return { ...path, subpaths: subs };
}

export function deleteAnchors(path: VectorPath, refs: Ref[]): VectorPath {
  return [...refs].sort((a, b) => b[0] - a[0] || b[1] - a[1]).reduce((p, [s, i]) => deleteAnchor(p, s, i), path);
}

export function nudgeAnchors(path: VectorPath, refs: Ref[], dx: number, dy: number): VectorPath {
  return refs.reduce((p, [s, i]) => withSub(p, s, moveAnchor(p.subpaths[s], i, dx, dy)), path);
}

// Selected subpaths translate; with `copy` moved copies are appended and become the selection.
export function translateSubs(path: VectorPath, subs: number[], dx: number, dy: number, copy: boolean): { path: VectorPath; sel: number[] } {
  const moved = subs.map(s => path.subpaths[s].points.reduce((m, _, i) => moveAnchor(m, i, dx, dy), cloneSub(path.subpaths[s])));
  if (copy) return { path: { ...path, subpaths: [...path.subpaths, ...moved] }, sel: moved.map((_, k) => path.subpaths.length + k) };
  return { path: { ...path, subpaths: path.subpaths.map((x, k) => (subs.includes(k) ? moved[subs.indexOf(k)] : x)) }, sel: subs };
}

export function deleteSubs(path: VectorPath, subs: number[]): VectorPath {
  return { ...path, subpaths: path.subpaths.filter((_, k) => !subs.includes(k)) };
}

const inRect = (p: XY, a: XY, b: XY) => p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);

export function anchorsIn(path: VectorPath, a: XY, b: XY): Ref[] {
  return path.subpaths.flatMap((s, si) => s.points.flatMap((p, i) => (inRect([p[0], p[1]], a, b) ? [[si, i] as Ref] : [])));
}

export function subsIn(path: VectorPath, a: XY, b: XY): number[] {
  return path.subpaths.flatMap((s, si) => (flattenSub(s).some(p => inRect(p, a, b)) ? [si] : []));
}

export function arrowDelta(key: string, shift: boolean): XY {
  const n = shift ? 10 : 1;
  return [key === 'ArrowLeft' ? -n : key === 'ArrowRight' ? n : 0, key === 'ArrowUp' ? -n : key === 'ArrowDown' ? n : 0];
}

// Direct Selection drag: a handle (Alt breaks the mirror, Shift snaps its angle to 45 degrees),
// the selected anchors or the hit one, a segment's two ends, or (Alt) a whole subpath.
export function directDrag(base: VectorPath, hit: Hit, sel: Ref[], start: XY, cur: XY, m: Mods): VectorPath {
  if (hit.kind === 'handle') {
    const a = base.subpaths[hit.s].points[hit.i];
    const q = m.shift ? snap45Length([a[0], a[1]], cur) : cur;
    return withSub(base, hit.s, moveHandle(base.subpaths[hit.s], hit.i, hit.which, q[0], q[1], { breakSmooth: m.alt, symmetric: false }));
  }
  const e = m.shift ? snap45(start, cur) : cur, dx = e[0] - start[0], dy = e[1] - start[1];
  const s = base.subpaths[hit.s];
  if (hit.kind === 'segment') return nudgeAnchors(base, [[hit.s, hit.seg], [hit.s, (hit.seg + 1) % s.points.length]], dx, dy);
  if (hit.kind === 'fill') return nudgeAnchors(base, s.points.map((_, i) => [hit.s, i] as Ref), dx, dy);
  const refs = sel.some(r => r[0] === hit.s && r[1] === hit.i) ? sel : [[hit.s, hit.i] as Ref];
  return nudgeAnchors(base, refs, dx, dy);
}

// Convert Point drag: an anchor becomes smooth (out = pointer, in = mirror); a handle moves alone.
export function convertDrag(base: VectorPath, hit: Hit, cur: XY): VectorPath {
  const s = base.subpaths[hit.s];
  if (hit.kind === 'handle') return withSub(base, hit.s, moveHandle(s, hit.i, hit.which, cur[0], cur[1], { breakSmooth: true }));
  if (hit.kind !== 'anchor') return base;
  const r = cloneSub(s), [x, y] = r.points[hit.i];
  r.points[hit.i] = [x, y, 2 * x - cur[0], 2 * y - cur[1], cur[0], cur[1]];
  return withSub(base, hit.s, r);
}

export const hasHandles = (p: PathAnchor) => p[2] !== p[0] || p[3] !== p[1] || p[4] !== p[0] || p[5] !== p[1];

// With no draft and Auto Add/Delete: a click on an anchor deletes it, on a segment adds one.
export function penAutoEdit(path: VectorPath, x: number, y: number, tol: number): { kind: 'add' | 'delete'; label: string; path: VectorPath } | null {
  const h = hitTest(path, x, y, tol, { handles: false, fill: false });
  if (h?.kind === 'anchor') return { kind: 'delete', label: 'Delete Anchor Point', path: deleteAnchor(path, h.s, h.i) };
  if (h?.kind === 'segment') return { kind: 'add', label: 'Add Anchor Point', path: withSub(path, h.s, addAnchor(path.subpaths[h.s], h.seg, h.t)) };
  return null;
}

// The Paths panel's selected path, else a selected shape layer, else the work path unless the
// panel selection was explicitly cleared.
export function penTarget(doc: { paths: SavedPathInfo[] }, node: { id: number; shape?: { path: VectorPath } } | null, selected: number | null, cleared: boolean): Target | null {
  const sel = selected == null ? undefined : doc.paths.find(p => p.id === selected);
  if (sel) return { role: 'document', id: sel.id, path: sel.path };
  if (node?.shape) return { role: 'shape', id: node.id, path: node.shape.path };
  const w = cleared ? undefined : doc.paths.find(p => p.work);
  return w ? { role: 'document', id: w.id, path: w.path } : null;
}

type PenDrag = { kind: 'new' } | { kind: 'edit'; hit: Hit; direct: boolean; start: XY; base: VectorPath; moved: boolean };

// The pen tool's draft subpath with its own undo stack of point arrays.
export class PenDraft {
  points: PathAnchor[] = [];
  closed = false;
  #undo: PathAnchor[][] = [];
  #redo: PathAnchor[][] = [];
  #drag: PenDrag | null = null;

  get dragging() { return !!this.#drag; }
  subpath(): Sub { return { closed: this.closed, op: 'combine', points: this.points.map(p => [...p] as PathAnchor) }; }
  #push() { this.#undo.push(this.subpath().points); this.#redo = []; }

  // 'closed' / 'open' = finish the draft that way; null = the press was taken by the draft.
  down(p: XY, m: Mods, tol: number): 'closed' | 'open' | null {
    if (this.points.length) {
      if (this.points.length >= 2 && dist([this.points[0][0], this.points[0][1]], p) <= tol) { this.closed = true; return 'closed'; }
      const hit = hitTest(onePath(this.subpath()), p[0], p[1], tol, { handles: true, fill: false });
      if (m.ctrl && !hit) return 'open';
      if (hit && (m.ctrl || (m.alt && hit.kind !== 'segment'))) {
        this.#push();
        this.#drag = { kind: 'edit', hit, direct: m.ctrl, start: p, base: onePath(this.subpath()), moved: false };
        return null;
      }
    }
    this.#push();
    this.points.push(cornerAt(p[0], p[1]));
    this.#drag = { kind: 'new' };
    return null;
  }

  // New point: out = pointer, in = its mirror unless Alt is held.
  move(p: XY, m: Mods) {
    const d = this.#drag;
    if (!d) return;
    if (d.kind === 'new') {
      const q = this.points[this.points.length - 1];
      [q[4], q[5]] = p;
      if (!m.alt) [q[2], q[3]] = [2 * q[0] - p[0], 2 * q[1] - p[1]];
      return;
    }
    d.moved = true;
    const r = d.direct ? directDrag(d.base, d.hit, [], d.start, p, m) : convertDrag(d.base, d.hit, p);
    this.points = r.subpaths[0].points;
  }

  // An Alt-click without drag on an anchor with handles makes it a corner.
  up() {
    const d = this.#drag;
    this.#drag = null;
    if (d?.kind === 'edit' && !d.direct && !d.moved && d.hit.kind === 'anchor' && hasHandles(this.points[d.hit.i])) {
      this.points = convertToCorner(this.subpath(), d.hit.i).points;
    }
  }

  undo() {
    const prev = this.#undo.pop();
    if (!prev) return;
    this.#redo.push(this.subpath().points);
    this.points = prev;
    this.closed = false;
  }

  redo() {
    const next = this.#redo.pop();
    if (!next) return;
    this.#undo.push(this.subpath().points);
    this.points = next;
  }
}

// Curvature pen geometry: a corner has no handles; a smooth point gets +-(next - prev) / 6, the
// neighbours wrapping when closed and the point itself standing in at open ends.
export function curvatureAnchors(pts: XY[], corner: boolean[], closed: boolean): PathAnchor[] {
  const n = pts.length;
  return pts.map((p, i) => {
    if (corner[i]) return cornerAt(p[0], p[1]);
    const prev = pts[i > 0 ? i - 1 : closed ? n - 1 : i], next = pts[i < n - 1 ? i + 1 : closed ? 0 : i];
    const hx = (next[0] - prev[0]) / 6, hy = (next[1] - prev[1]) / 6;
    return [p[0], p[1], p[0] - hx, p[1] - hy, p[0] + hx, p[1] + hy];
  });
}

export class CurvatureDraft {
  pts: XY[] = [];
  corner: boolean[] = [];
  closed = false;
  #redo: [XY, boolean][] = [];
  #drag: number | null = null;

  anchors(cursor?: XY): PathAnchor[] {
    return cursor ? curvatureAnchors([...this.pts, cursor], [...this.corner, false], false) : curvatureAnchors(this.pts, this.corner, this.closed);
  }

  // 'closed' = finish closed. A press on a point toggles its corner (Alt) or drags it.
  down(p: XY, alt: boolean, tol: number): 'closed' | null {
    const i = this.pts.findIndex(q => dist(q, p) <= tol);
    if (i === 0 && this.pts.length > 2) { this.closed = true; return 'closed'; }
    if (i >= 0) {
      if (alt) this.corner[i] = !this.corner[i]; else this.#drag = i;
      return null;
    }
    this.pts.push(p);
    this.corner.push(alt);
    this.#redo = [];
    return null;
  }

  move(p: XY) { if (this.#drag !== null) this.pts[this.#drag] = p; }
  up() { this.#drag = null; }
  get dragging() { return this.#drag !== null; }

  undo() {
    const p = this.pts.pop();
    if (p) this.#redo.push([p, this.corner.pop()!]);
    this.closed = false;
  }

  redo() {
    const r = this.#redo.pop();
    if (r) { this.pts.push(r[0]); this.corner.push(r[1]); }
  }
}

// Magnetic freeform: candidates along the normal of the last step within +-width px (nearest
// first) and their probe pairs p + n, p - n as [x, y, x, y] per candidate.
export function magneticProbes(prev: XY, p: XY, width: number): { cands: XY[]; probes: number[] } | null {
  const l = dist(prev, p);
  if (l === 0) return null;
  const nx = -(p[1] - prev[1]) / l, ny = (p[0] - prev[0]) / l, w = Math.max(1, Math.round(width));
  const ks = [0, ...Array.from({ length: w }, (_, k) => [k + 1, -(k + 1)]).flat()];
  const cands = ks.map(k => [p[0] + k * nx, p[1] + k * ny] as XY);
  return { cands, probes: cands.flatMap(c => [c[0] + nx, c[1] + ny, c[0] - nx, c[1] - ny]) };
}

// The candidate with the largest |L(p + n) - L(p - n)|, the nearest on ties.
export function magneticPick(cands: XY[], lum: number[]): XY {
  let best = 0, bd = -1;
  cands.forEach((_, k) => {
    const d = Math.abs(lum[2 * k] - lum[2 * k + 1]);
    if (d > bd) { bd = d; best = k; }
  });
  return cands[best];
}

// The edit overlay for a path: its outline, anchors (selected ones filled) and handles of every
// point (`all`), of the selected points and their neighbours (`selected`) or none.
export function editOverlay(path: VectorPath, sel: Ref[], selSubs: number[], handles: 'all' | 'selected' | 'none'): Omit<PathEditOverlay, 'band'> {
  const isSel = (s: number, i: number) => selSubs.includes(s) || sel.some(r => r[0] === s && r[1] === i);
  const out: Omit<PathEditOverlay, 'band'> = { lines: path.subpaths.map(s => flattenSub(s).flat()), anchors: [], handles: [] };
  path.subpaths.forEach((s, si) => s.points.forEach((p, i) => {
    out.anchors.push({ x: p[0], y: p[1], selected: isSel(si, i) });
    const n = s.points.length;
    const show = handles === 'all' || (handles === 'selected' && [i, (i + 1) % n, (i + n - 1) % n].some(j => isSel(si, j)));
    if (!show) return;
    if (p[2] !== p[0] || p[3] !== p[1]) out.handles.push([p[0], p[1], p[2], p[3]]);
    if (p[4] !== p[0] || p[5] !== p[1]) out.handles.push([p[0], p[1], p[4], p[5]]);
  }));
  return out;
}
