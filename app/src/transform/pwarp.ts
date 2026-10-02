// Perspective Warp session: planes (quads over shared vertices) drawn in layout mode, their
// vertices moved in warp mode; the engine renders `engineState`. Document px throughout.
import { apply, homography, rectQuad, type Pt, type Quad, type Rect } from './matrix.ts';

export type Mode = 'layout' | 'warp';
export interface Plane { id: string; corners: [number, number, number, number] }
export interface StraightEdge { a: number; b: number; axis: 'x' | 'y' }
export interface State { mode: Mode; layout: Pt[]; current: Pt[]; quads: Plane[]; straightEdges: StraightEdge[] }
export interface EngineState { layout: Pt[]; current: Pt[]; quads: number[][] }

let nextId = 0;
const clone = (s: State): State => structuredClone(s);
const corners = (v: Pt[], q: Plane): Quad => q.corners.map(i => v[i]) as Quad;
const empty = (): State => ({ mode: 'layout', layout: [], current: [], quads: [], straightEdges: [] });

// All 4 turns go the same way and no 3 corners are collinear.
export function convex(q: Pt[]): boolean {
  let sign = 0;
  for (let e = 0; e < 4; e++) {
    const [n, i, o] = [q[e], q[(e + 1) % 4], q[(e + 2) % 4]];
    const s = (i[0] - n[0]) * (o[1] - i[1]) - (i[1] - n[1]) * (o[0] - i[0]);
    if (!Number.isFinite(s) || Math.abs(s) < 1e-6 || (sign && Math.sign(s) !== sign)) return false;
    sign = Math.sign(s);
  }
  return true;
}

const allConvex = (s: State, v: Pt[]) => s.quads.every(q => convex(corners(v, q)));

// Throws when a plane's homography takes the source bounds across the horizon or to an
// unbounded area (the engine refuses the same states).
export function validate(s: State, bounds: Rect): void {
  if (!s.quads.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of s.quads) {
    const h = homography(corners(s.layout, q), corners(s.current, q));
    const ws = rectQuad(bounds).map(([x, y]) => h[6] * x + h[7] * y + h[8]);
    if (ws.some(w => Math.abs(w) < 1e-8 || Math.sign(w) !== Math.sign(ws[0]))) throw new Error('The perspective crosses the image horizon. Move the corners closer to the original plane.');
    for (const [x, y] of rectQuad(bounds).map(([x, y]) => apply(h, x, y))) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  if (![x0, y0, x1, y1].every(Number.isFinite) || (x1 - x0) * (y1 - y0) > 1e8) throw new Error('The perspective extends beyond a finite image. Move the corners closer to the original plane.');
}

// Moves vertex i; in warp mode every vertex locked to it on an axis keeps its coordinate.
function moveVertex(s: State, i: number, x: number, y: number): State {
  const layout = s.layout.map(p => [...p] as Pt), current = s.current.map(p => [...p] as Pt);
  current[i] = [x, y];
  if (s.mode === 'layout') layout[i] = [x, y];
  else for (const axis of [0, 1] as const) {
    const group = new Set([i]);
    for (let n = 0; n < current.length; n++) for (const e of s.straightEdges) if ((e.axis === 'x') === (axis === 0) && (group.has(e.a) || group.has(e.b))) { group.add(e.a); group.add(e.b); }
    for (const g of group) current[g][axis] = current[i][axis];
  }
  return allConvex(s, current) ? { ...s, layout, current } : s;
}

// Aligns edge a-b on its dominant axis (both ends to their mean) and locks it; unlocks a locked edge.
function straighten(s: State, a: number, b: number): State {
  const lock = s.straightEdges.find(e => (e.a === a && e.b === b) || (e.a === b && e.b === a));
  if (lock) return { ...s, straightEdges: s.straightEdges.filter(e => e !== lock) };
  const current = s.current.map(p => [...p] as Pt);
  const axis = Math.abs(current[a][1] - current[b][1]) >= Math.abs(current[a][0] - current[b][0]) ? 'x' : 'y';
  const k = axis === 'x' ? 0 : 1, mean = (current[a][k] + current[b][k]) / 2;
  current[a][k] = mean; current[b][k] = mean;
  return allConvex(s, current) ? { ...s, current, straightEdges: [...s.straightEdges, { a, b, axis }] } : s;
}

// Adds a plane over `r`; corners within `snap` of an existing vertex reuse it (joining planes).
function addQuad(s: State, r: Rect, snap: number): State {
  const n = clone(s);
  const ids = rectQuad(r).map(p => {
    const hit = n.layout.findIndex(v => Math.hypot(v[0] - p[0], v[1] - p[1]) <= snap);
    if (hit >= 0) return hit;
    n.layout.push([...p]); n.current.push([...p]);
    return n.layout.length - 1;
  }) as Plane['corners'];
  if (new Set(ids).size !== 4 || !convex(ids.map(i => n.layout[i]))) return s;
  n.quads.push({ id: `pw-quad-${++nextId}`, corners: ids });
  return n;
}

// Drops vertices no plane uses and renumbers.
function compact(s: State): State {
  const used = [...new Set(s.quads.flatMap(q => q.corners))], at = (i: number) => used.indexOf(i);
  return {
    ...s, layout: used.map(i => s.layout[i]), current: used.map(i => s.current[i]),
    quads: s.quads.map(q => ({ ...q, corners: q.corners.map(at) as Plane['corners'] })),
    straightEdges: s.straightEdges.filter(e => used.includes(e.a) && used.includes(e.b)).map(e => ({ ...e, a: at(e.a), b: at(e.b) })),
  };
}

// The `state` param of the perspective_warp filter; layout mode warps nothing.
export function engineState(s: State): EngineState {
  return { layout: s.layout, current: s.mode === 'layout' ? s.layout : s.current, quads: s.quads.map(q => [...q.corners]) };
}

export class History<T> {
  private undo: T[] = [];
  private redo: T[] = [];
  remember(before: T, after: T) {
    if (JSON.stringify(before) !== JSON.stringify(after)) { this.undo.push(before); this.redo = []; }
  }
  step(now: T, dir: 'undo' | 'redo'): T {
    const [from, to] = dir === 'undo' ? [this.undo, this.redo] : [this.redo, this.undo];
    const prev = from.pop();
    if (prev === undefined) return now;
    to.push(structuredClone(now));
    return prev;
  }
}

interface Gesture { before: State; at: Pt; vertex: number | null; quad: string | null; snap: number }

export class PerspectiveSession {
  state = empty();
  selectedQuad: string | null = null;
  private history = new History<State>();
  private gesture: Gesture | null = null;
  readonly bounds: Rect;
  constructor(bounds: Rect) { this.bounds = bounds; }

  get dragging() { return this.gesture !== null; }
  private shown() { return this.state.mode === 'layout' ? this.state.layout : this.state.current; }
  isModified() { return this.state.current.some((p, i) => p[0] !== this.state.layout[i][0] || p[1] !== this.state.layout[i][1]); }

  private valid(s: State) {
    try { validate(s, this.bounds); return true; } catch { return false; }
  }
  private change(f: (s: State) => State) {
    const before = clone(this.state), next = f(clone(this.state));
    if (!this.valid(next)) return;
    this.state = next;
    this.history.remember(before, next);
  }

  setMode(m: Mode) {
    if (m === 'warp' && !this.state.quads.length) return;
    this.change(s => ({ ...s, mode: m }));
  }
  hitVertex(x: number, y: number, r: number): number | null {
    const v = this.shown();
    let best = -1, d = Infinity;
    v.forEach((p, i) => { const e = Math.hypot(p[0] - x, p[1] - y); if (e < d) { d = e; best = i; } });
    return best >= 0 && d <= r ? best : null;
  }
  hitEdge(x: number, y: number, r: number): [number, number] | null {
    const v = this.shown();
    for (const q of this.state.quads) for (let k = 0; k < 4; k++) {
      const a = q.corners[k], b = q.corners[(k + 1) % 4], [ax, ay] = v[a], dx = v[b][0] - ax, dy = v[b][1] - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
      if (Math.hypot(x - ax - dx * t, y - ay - dy * t) <= r) return [a, b];
    }
    return null;
  }
  hitQuad(x: number, y: number): string | null {
    const v = this.shown();
    for (const q of [...this.state.quads].reverse()) {
      const signs = q.corners.map((c, k) => {
        const [ox, oy] = v[c], [ux, uy] = v[q.corners[(k + 1) % 4]];
        return Math.sign((ux - ox) * (y - oy) - (uy - oy) * (x - ox));
      });
      if (signs.every(s => s >= 0) || signs.every(s => s <= 0)) return q.id;
    }
    return null;
  }

  // Pointer down at (x, y) with hit radius `snap`: a vertex, a plane (layout) or empty canvas (layout: draws).
  begin(x: number, y: number, snap: number) {
    const vertex = this.hitVertex(x, y, snap), quad = vertex === null && this.state.mode === 'layout' ? this.hitQuad(x, y) : null;
    if (this.state.mode === 'warp' && vertex === null) return;
    this.selectedQuad = quad ?? (vertex === null ? null : this.state.quads.find(q => q.corners.includes(vertex))?.id ?? null);
    this.gesture = { before: clone(this.state), at: [x, y], vertex, quad, snap };
  }
  move(x: number, y: number) {
    const g = this.gesture;
    if (!g) return;
    const dx = x - g.at[0], dy = y - g.at[1];
    let s = clone(g.before);
    if (g.vertex !== null) {
      const p = (s.mode === 'layout' ? s.layout : s.current)[g.vertex];
      s = moveVertex(s, g.vertex, p[0] + dx, p[1] + dy);
    } else if (g.quad) {
      for (const i of s.quads.find(q => q.id === g.quad)!.corners) {
        s.layout[i] = [s.layout[i][0] + dx, s.layout[i][1] + dy];
        s.current[i] = [...s.layout[i]];
      }
      if (!allConvex(s, s.layout)) s = clone(g.before);
    } else if (Math.abs(dx) >= g.snap && Math.abs(dy) >= g.snap) {
      s = addQuad(s, { x: Math.min(x, g.at[0]), y: Math.min(y, g.at[1]), w: Math.abs(dx), h: Math.abs(dy) }, g.snap);
      this.selectedQuad = s.quads.at(-1)?.id ?? null;
    }
    this.state = this.valid(s) ? s : clone(g.before);
  }
  end() {
    const g = this.gesture;
    if (!g) return;
    if (this.state.mode === 'layout' && g.vertex !== null) {
      // A vertex dropped onto a vertex of another plane merges into it.
      const t = g.vertex, [px, py] = this.state.layout[t];
      const r = this.state.layout.findIndex((p, i) => i !== t && Math.hypot(p[0] - px, p[1] - py) <= g.snap && !this.state.quads.some(q => q.corners.includes(t) && q.corners.includes(i)));
      if (r >= 0) {
        const s = clone(this.state);
        s.quads.forEach(q => { q.corners = q.corners.map(c => c === t ? r : c) as Plane['corners']; });
        if (allConvex(s, s.layout)) this.state = compact(s);
      }
    }
    this.history.remember(g.before, this.state);
    this.gesture = null;
  }
  cancelDrag() {
    if (this.gesture) this.state = this.gesture.before;
    this.gesture = null;
  }
  removeSelected() {
    if (this.state.mode !== 'layout' || !this.selectedQuad) return;
    const id = this.selectedQuad;
    this.change(s => compact({ ...s, quads: s.quads.filter(q => q.id !== id) }));
    this.selectedQuad = null;
  }
  straighten(a: number, b: number) { this.change(s => straighten(s, a, b)); }
  autoStraighten(which: 'vertical' | 'horizontal' | 'both') {
    if (this.state.mode !== 'warp') return;
    this.change(s => {
      const seen = new Set<string>();
      for (const q of s.quads) for (let k = 0; k < 4; k++) {
        const a = q.corners[k], b = q.corners[(k + 1) % 4], key = [a, b].sort((m, n) => m - n).join(':');
        const horizontal = Math.abs(s.current[a][0] - s.current[b][0]) > Math.abs(s.current[a][1] - s.current[b][1]);
        if (seen.has(key) || (which !== 'both' && horizontal !== (which === 'horizontal'))) continue;
        seen.add(key);
        if (!s.straightEdges.some(e => (e.a === a && e.b === b) || (e.a === b && e.b === a))) s = straighten(s, a, b);
      }
      return s;
    });
  }
  reset() { this.change(s => ({ ...s, current: structuredClone(s.layout), straightEdges: [] })); }
  historyStep(dir: 'undo' | 'redo') {
    this.cancelDrag();
    this.state = this.history.step(this.state, dir);
  }

  // 5 x 5 grid lines per plane (as shown: layout or current), each a [from, to] segment.
  gridLines(): [Pt, Pt][] {
    const v = this.shown(), unit: Quad = [[0, 0], [1, 0], [1, 1], [0, 1]];
    return this.state.quads.flatMap(q => {
      const h = homography(unit, corners(v, q)), at = (u: number, w: number) => apply(h, u, w);
      return [0, 0.25, 0.5, 0.75, 1].flatMap((t): [Pt, Pt][] => [[at(t, 0), at(t, 1)], [at(0, t), at(1, t)]]);
    });
  }
}
