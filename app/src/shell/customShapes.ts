// Custom shapes (docs/M4.md section 5): a library of unit-square paths (own starter set plus
// shapes loaded from .csh files, kept in localStorage) that the Custom Shape tool stretches to a drag.
import { readCsh } from 'ag-psd';
import { pathIn } from '../psd/vector.ts';
import type { PathAnchor, VectorPath } from '../worker/types.ts';
import type { Bounds } from './shapetools.ts';

export interface CustomShape { id: string; name: string; path: VectorPath }
type Store = Pick<Storage, 'getItem' | 'setItem'>;

// ponytail: the box includes handles, so a curve whose handles overshoot fits a little small.
function box(p: VectorPath): Bounds {
  const xs = p.subpaths.flatMap(s => s.points.flatMap(q => [q[0], q[2], q[4]]));
  const ys = p.subpaths.flatMap(s => s.points.flatMap(q => [q[1], q[3], q[5]]));
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// Every coordinate through `f` (x at even, y at odd indices).
function mapPath(p: VectorPath, f: (v: number, y: boolean) => number): VectorPath {
  return { ...p, subpaths: p.subpaths.map(s => ({ ...s, points: s.points.map(q => q.map((v, i) => f(v, i % 2 === 1)) as PathAnchor) })) };
}

/** The path scaled into the unit square, keeping its aspect, centered on the shorter side. */
export function fitUnit(p: VectorPath): VectorPath {
  const [l, t, r, b] = box(p);
  const n = Math.max(r - l, b - t);
  if (!(n > 0)) return p;
  const ox = (1 - (r - l) / n) / 2, oy = (1 - (b - t) / n) / 2;
  return mapPath(p, (v, y) => (y ? oy + (v - t) / n : ox + (v - l) / n));
}

/** A unit-square path stretched onto [left, top, right, bottom]. */
export function toBounds(p: VectorPath, [l, t, r, b]: Bounds): VectorPath {
  return mapPath(p, (v, y) => (y ? t + v * (b - t) : l + v * (r - l)));
}

const corner = (x: number, y: number): PathAnchor => [x, y, x, y, x, y];
const poly = (pts: [number, number][]) => ({ closed: true, op: 'combine', points: pts.map(([x, y]) => corner(x, y)) });
const K = 0.5522847498;

// A circle (clockwise, or counter-clockwise for a hole) as four smooth anchors.
function circle(cx: number, cy: number, r: number, hole = false) {
  const k = r * K;
  const pts: PathAnchor[] = [
    [cx, cy - r, cx - k, cy - r, cx + k, cy - r], [cx + r, cy, cx + r, cy - k, cx + r, cy + k],
    [cx, cy + r, cx + k, cy + r, cx - k, cy + r], [cx - r, cy, cx - r, cy + k, cx - r, cy - k],
  ];
  return { closed: true, op: 'combine', points: hole ? pts.reverse().map(([x, y, ix, iy, ox, oy]) => [x, y, ox, oy, ix, iy] as PathAnchor) : pts };
}

function star(points: number, inner: number) {
  return poly(Array.from({ length: points * 2 }, (_, i) => {
    const a = -Math.PI / 2 + i * Math.PI / points, r = i % 2 ? 50 * inner : 50;
    return [50 + r * Math.cos(a), 50 + r * Math.sin(a)] as [number, number];
  }));
}

const shape = (id: string, name: string, subpaths: VectorPath['subpaths']): CustomShape =>
  ({ id: `builtin.${id}`, name, path: fitUnit({ fill_rule: 'nonzero', subpaths }) });

// The starter set, drawn on a 100 x 100 grid.
export const BUILTIN_SHAPES: CustomShape[] = [
  shape('arrow', 'Arrow', [poly([[0, 35], [55, 35], [55, 10], [100, 50], [55, 90], [55, 65], [0, 65]])]),
  shape('chevron', 'Chevron', [poly([[0, 0], [45, 0], [100, 50], [45, 100], [0, 100], [55, 50]])]),
  shape('plus', 'Plus', [poly([[35, 0], [65, 0], [65, 35], [100, 35], [100, 65], [65, 65], [65, 100], [35, 100], [35, 65], [0, 65], [0, 35], [35, 35]])]),
  shape('bolt', 'Lightning', [poly([[60, 0], [15, 55], [45, 55], [30, 100], [85, 40], [55, 40], [75, 0]])]),
  shape('star', 'Star', [star(5, 0.4)]),
  shape('ring', 'Ring', [circle(50, 50, 50), circle(50, 50, 28, true)]),
  shape('bubble', 'Speech Bubble', [poly([[0, 0], [100, 0], [100, 70], [48, 70], [24, 96], [28, 70], [0, 70]])]),
  shape('tag', 'Tag', [poly([[0, 15], [65, 15], [100, 50], [65, 85], [0, 85]]), circle(20, 50, 7, true)]),
];

const KEY = 'photobaer.customShapes';
let shared: ShapeLibrary | null = null;

/** The app's library, opened on first use. */
export const shapeLibrary = () => (shared ??= new ShapeLibrary());

export class ShapeLibrary {
  #store: Store | undefined;
  #user: CustomShape[] = [];
  constructor(store: Store | undefined = globalThis.localStorage) {
    this.#store = store;
    try { this.#user = JSON.parse(store?.getItem(KEY) ?? '[]') as CustomShape[]; } catch { this.#user = []; }
  }
  list(): CustomShape[] { return [...BUILTIN_SHAPES, ...this.#user]; }
  get(id: string): CustomShape | undefined { return this.list().find(s => s.id === id); }
  /** Adds shapes after the current ones; a taken id gets a numeric suffix. */
  append(shapes: CustomShape[]) {
    const taken = new Set(this.list().map(s => s.id));
    for (const s of shapes) {
      let id = s.id;
      for (let n = 2; taken.has(id); n++) id = `${s.id}.${n}`;
      taken.add(id);
      this.#user.push({ ...s, id });
    }
    try { this.#store?.setItem(KEY, JSON.stringify(this.#user)); } catch { /* session-only */ }
  }
}

/** Every readable shape of a .csh file (fit to the unit square) and a warning per skipped one. */
export function parseCsh(bytes: Uint8Array): { shapes: CustomShape[]; warnings: string[] } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'cush') return { shapes: [], warnings: ['This is not a custom shape (.csh) file.'] };
  const count = v.getUint32(8), shapes: CustomShape[] = [], warnings: string[] = [];
  let o = 12;
  for (let i = 0; i < count; i++) {
    let name = '', end = 0, one: Uint8Array;
    try {
      const len = v.getUint32(o), nameEnd = o + 4 + len * 2;
      for (let k = 0; k < len; k++) name += String.fromCharCode(v.getUint16(o + 4 + k * 2));
      name = name.replace(/\0+$/, '');
      let p = nameEnd;
      while (p % 4) p++;
      end = p + 8 + v.getUint32(p + 4);
      if (end > bytes.length) throw new Error('truncated');
      // The shape alone as a one-shape file (its name padded again from offset 12), for readCsh.
      const nameRec = nameEnd - o, pad = (4 - nameRec % 4) % 4;
      one = new Uint8Array(12 + nameRec + pad + end - p);
      one.set(bytes.subarray(0, 4));
      new DataView(one.buffer).setUint32(4, 2);
      new DataView(one.buffer).setUint32(8, 1);
      one.set(bytes.subarray(o, nameEnd), 12);
      one.set(bytes.subarray(p, end), 12 + nameRec + pad);
    } catch {
      warnings.push(`shape ${i + 1}: its header could not be read; stopping`);
      break;
    }
    o = end;
    try {
      const c = readCsh(one).shapes[0];
      const path = pathIn(c.paths) as VectorPath;
      const [l, t, r, b] = path.subpaths.length ? box(path) : [0, 0, 0, 0];
      if (!(r - l > 0 || b - t > 0)) { warnings.push(`shape ${i + 1} ("${name}"): no usable subpaths`); continue; }
      shapes.push({ id: `csh.${i}.${name || 'shape'}`, name: name || `Shape ${i + 1}`, path: fitUnit(path) });
    } catch (e) {
      warnings.push(`shape ${i + 1} ("${name}"): ${(e as Error).message}`);
    }
  }
  return { shapes, warnings };
}
