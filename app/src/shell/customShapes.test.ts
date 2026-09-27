import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_SHAPES, ShapeLibrary, fitUnit, parseCsh, toBounds, type CustomShape } from './customShapes.ts';
import type { VectorPath } from '../worker/types.ts';

const c = (x: number, y: number): [number, number, number, number, number, number] => [x, y, x, y, x, y];
const box = (p: VectorPath) => {
  const xs = p.subpaths.flatMap(s => s.points.map(q => q[0])), ys = p.subpaths.flatMap(s => s.points.map(q => q[1]));
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

test('fitUnit centers a path in the unit square keeping its aspect; toBounds stretches it to a drag', () => {
  const p: VectorPath = { fill_rule: 'nonzero', subpaths: [{ closed: true, op: 'combine', points: [c(10, 20), c(50, 20), c(50, 40), c(10, 40)] }] };
  const u = fitUnit(p);
  assert.deepEqual(box(u), [0, 0.25, 1, 0.75]);
  assert.deepEqual(box(toBounds(u, [100, 100, 300, 200])), [100, 125, 300, 175]);
  for (const s of BUILTIN_SHAPES) {
    const [l, t, r, b] = box(s.path);
    assert.ok(l >= -1e-9 && t >= -1e-9 && r <= 1 + 1e-9 && b <= 1 + 1e-9 && (r - l > 0.99 || b - t > 0.99), s.name);
  }
});

// A .csh as written by the format (ag-psd readCsh layout): name, pad to 4, shape version 1, size,
// Pascal id, bounds (y1 x1 y2 x2), then 26-byte path records with 8.24 fixed coordinates.
function csh(shapes: { name: string; version?: number; knots: [number, number][] }[]): Uint8Array {
  const out: number[] = [];
  const u32 = (v: number) => out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const u16 = (v: number) => out.push((v >>> 8) & 255, v & 255);
  [...'cush'].forEach(ch => out.push(ch.charCodeAt(0)));
  u32(2); u32(shapes.length);
  for (const s of shapes) {
    u32(s.name.length);
    for (const ch of s.name) u16(ch.charCodeAt(0));
    while (out.length % 4) out.push(0);
    u32(s.version ?? 1);
    const body: number[] = [];
    const b32 = (v: number) => body.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
    const b16 = (v: number) => body.push((v >>> 8) & 255, v & 255);
    body.push(2, 105, 100);
    b32(0); b32(0); b32(100); b32(200);
    b16(6); body.push(...new Array(24).fill(0));
    b16(0); b16(s.knots.length); body.push(...new Array(22).fill(0));
    for (const [x, y] of s.knots) {
      b16(2);
      for (let k = 0; k < 3; k++) { b32(Math.round(y * 2 ** 24)); b32(Math.round(x * 2 ** 24)); }
    }
    u32(body.length);
    out.push(...body);
  }
  return Uint8Array.from(out);
}

test('parseCsh reads every good shape, skips a broken one with a warning, and refuses a non-.csh file', () => {
  const tri: [number, number][] = [[0.5, 0], [1, 1], [0, 1]];
  const r = parseCsh(csh([{ name: 'Tri', knots: tri }, { name: 'Bad', version: 9, knots: tri }, { name: 'Sq', knots: [[0, 0], [1, 0], [1, 1], [0, 1]] }]));
  assert.deepEqual(r.shapes.map(s => s.name), ['Tri', 'Sq']);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /shape 2 \("Bad"\)/);
  const [l, t, rr, b] = box(r.shapes[0].path);
  assert.ok(l === 0 && rr === 1 && Math.abs(t - 0.25) < 1e-6 && Math.abs(b - 0.75) < 1e-6, 'a 200 x 100 box fits full width, half height');
  assert.deepEqual(parseCsh(Uint8Array.from([1, 2, 3])), { shapes: [], warnings: ['This is not a custom shape (.csh) file.'] });
});

test('the library lists built-ins then loaded shapes, keeps ids unique and persists them', () => {
  const store = new Map<string, string>();
  const backing = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const lib = new ShapeLibrary(backing);
  const shape: CustomShape = { id: 'csh.0.Tri', name: 'Tri', path: BUILTIN_SHAPES[0].path };
  lib.append([shape, shape]);
  const ids = lib.list().map(s => s.id);
  assert.equal(ids.length, BUILTIN_SHAPES.length + 2);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(new ShapeLibrary(backing).list().map(s => s.id), ids, 'reloaded from storage');
});
