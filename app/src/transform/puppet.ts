// Puppet Warp session: pins on the engine's mesh, their gestures and session history. The
// deformed mesh (`geometry`) comes from the engine solver; the session only reads it. Document px.
import { History } from './pwarp.ts';

// The engine mesh (puppet::Grid): opaque here, passed back in the rig.
export interface Grid { x: number; y: number; step: number; w: number; h: number; cols: number; rows: number; cells: number[]; transform: number[] }
// Flat [x, y, ...] rest and deformed vertices and [a, b, c, ...] triangles.
export interface Geometry { rest: number[]; deformed: number[]; triangles: number[] }
export type PuppetMode = 'rigid' | 'normal' | 'distort';
export type Density = 'fewerPoints' | 'normal' | 'morePoints';
export interface Options { mode: PuppetMode; density: Density; expansion: number; showMesh: boolean }
export interface Pin { id: number; x: number; y: number; tx: number; ty: number; rotation: number; fixed: boolean; depth: number }
export interface Rig { mesh: Grid; pins: Omit<Pin, 'id'>[]; mode: PuppetMode; density: Density; expansion: number }

interface Snapshot { pins: Pin[]; options: Options; mesh: Grid }
interface Gesture { before: Snapshot; at: [number, number]; rotate: boolean; pivot: Pin }

let nextId = 0;
const STEP = Math.PI / 12;

export class PuppetSession {
  pins: Pin[] = [];
  options: Options = { mode: 'normal', density: 'normal', expansion: 2, showMesh: true };
  selected = new Set<number>();
  geometry: Geometry | null = null;
  mesh: Grid;
  private history = new History<Snapshot>();
  private gesture: Gesture | null = null;
  constructor(mesh: Grid) { this.mesh = mesh; }

  get dragging() { return this.gesture !== null; }
  private snapshot(): Snapshot { return structuredClone({ pins: this.pins, options: this.options, mesh: this.mesh }); }
  private restore(s: Snapshot) {
    ({ pins: this.pins, options: this.options, mesh: this.mesh } = s);
    this.selected = new Set([...this.selected].filter(id => this.pins.some(p => p.id === id)));
  }
  private edit(f: () => void) {
    const before = this.snapshot();
    f();
    this.history.remember(before, this.snapshot());
  }
  isModified() { return this.pins.some(p => p.tx !== p.x || p.ty !== p.y || p.rotation !== 0); }

  // The `rig` param of the puppet_warp filter.
  rig(): Rig {
    const { mode, density, expansion } = this.options;
    return { mesh: this.mesh, pins: this.pins.map(({ id: _, ...p }) => p), mode, density, expansion };
  }

  hitPin(x: number, y: number, r: number) { return this.pins.find(p => Math.hypot(p.tx - x, p.ty - y) <= r) ?? null; }

  // The rest point under document point (x, y) of the deformed mesh, topmost triangle first.
  sourcePoint(x: number, y: number): [number, number] | null {
    const g = this.geometry;
    if (!g) return null;
    const d = g.deformed, r = g.rest, t = g.triangles;
    for (let k = t.length - 3; k >= 0; k -= 3) {
      const [a, b, c] = [t[k] * 2, t[k + 1] * 2, t[k + 2] * 2];
      const det = (d[b + 1] - d[c + 1]) * (d[a] - d[c]) + (d[c] - d[b]) * (d[a + 1] - d[c + 1]);
      if (Math.abs(det) < 1e-8) continue;
      const u = ((d[b + 1] - d[c + 1]) * (x - d[c]) + (d[c] - d[b]) * (y - d[c + 1])) / det;
      const v = ((d[c + 1] - d[a + 1]) * (x - d[c]) + (d[a] - d[c]) * (y - d[c + 1])) / det, w = 1 - u - v;
      if (u >= -1e-5 && v >= -1e-5 && w >= -1e-5) return [u * r[a] + v * r[b] + w * r[c], u * r[a + 1] + v * r[b + 1] + w * r[c + 1]];
    }
    return null;
  }

  // A pin at (x, y), selected alone; null on the mesh's outside or within `r` of a pin.
  add(x: number, y: number, r: number): Pin | null {
    if (this.hitPin(x, y, r)) return null;
    const s = this.sourcePoint(x, y);
    if (!s) return null;
    const pin: Pin = { id: ++nextId, x: s[0], y: s[1], tx: x, ty: y, rotation: 0, fixed: false, depth: 0 };
    this.edit(() => { this.pins = [...this.pins, pin]; });
    this.selected = new Set([pin.id]);
    return pin;
  }

  // Pointer down on `pin`: `toggle` (Shift) flips its selection, `rotate` (Alt) turns the selection around it.
  begin(pin: Pin, x: number, y: number, rotate = false, toggle = false) {
    if (toggle) { if (!this.selected.delete(pin.id)) this.selected.add(pin.id); }
    else if (!this.selected.has(pin.id)) this.selected = new Set([pin.id]);
    if (this.selected.has(pin.id)) this.gesture = { before: this.snapshot(), at: [x, y], rotate, pivot: { ...pin } };
  }
  move(x: number, y: number, shift = false) {
    const g = this.gesture;
    if (!g) return;
    let dx = x - g.at[0], dy = y - g.at[1];
    if (shift && !g.rotate) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
    const turn = Math.atan2(y - g.pivot.ty, x - g.pivot.tx) - Math.atan2(g.at[1] - g.pivot.ty, g.at[0] - g.pivot.tx);
    const angle = shift ? Math.round(turn / STEP) * STEP : turn;
    this.pins = g.before.pins.map(p => !this.selected.has(p.id) ? p
      : g.rotate ? { ...p, fixed: true, rotation: p.rotation + angle } : { ...p, tx: p.tx + dx, ty: p.ty + dy });
  }
  end() {
    if (this.gesture) this.history.remember(this.gesture.before, this.snapshot());
    this.gesture = null;
  }
  cancelDrag() {
    if (this.gesture) this.restore(this.gesture.before);
    this.gesture = null;
  }
  removeSelected() {
    this.edit(() => { this.pins = this.pins.filter(p => !this.selected.has(p.id)); });
    this.selected.clear();
  }
  // Density or expansion changes come with the engine's rebuilt `mesh`.
  updateOptions(o: Partial<Options>, mesh = this.mesh) {
    this.edit(() => { this.options = { ...this.options, ...o }; this.mesh = mesh; });
  }
  updatePins(f: (p: Pin) => Pin) {
    this.edit(() => { this.pins = this.pins.map(p => this.selected.has(p.id) ? f(p) : p); });
  }
  // A fixed rotation, else how far the mesh edge at the pin's nearest vertex turned.
  rotationOf(pin: Pin): number {
    const g = this.geometry;
    if (pin.fixed || pin.rotation || !g || !g.triangles.length) return pin.rotation;
    let n = 0;
    for (let i = 1; i < g.rest.length / 2; i++) if (Math.hypot(g.rest[2 * i] - pin.x, g.rest[2 * i + 1] - pin.y) < Math.hypot(g.rest[2 * n] - pin.x, g.rest[2 * n + 1] - pin.y)) n = i;
    const k = g.triangles.findIndex(v => v === n);
    if (k < 0) return 0;
    const tri = g.triangles.slice(k - k % 3, k - k % 3 + 3), o = tri.find(v => v !== n)!;
    const ang = (v: number[]) => Math.atan2(v[2 * o + 1] - v[2 * n + 1], v[2 * o] - v[2 * n]);
    return ang(g.deformed) - ang(g.rest);
  }
  reset() {
    this.edit(() => { this.pins = []; });
    this.selected.clear();
  }
  historyStep(dir: 'undo' | 'redo') {
    this.cancelDrag();
    this.restore(this.history.step(this.snapshot(), dir));
  }
}
