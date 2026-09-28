import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docToScreen, screenToDoc, zoomAt, panBy, fit, levelFor, visibleTiles, clipMatrix, invalidateEntries, visibleRect, type View } from './view.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const W = 800, H = 600;

test('screen and document coordinates invert each other under rotation', () => {
  const v: View = { zoom: 0.37, rot: 0.9, cx: 1234, cy: 567 };
  const [dx, dy] = screenToDoc(v, 100, 50, W, H);
  const [sx, sy] = docToScreen(v, dx, dy, W, H);
  near(sx, 100); near(sy, 50);
});

test('viewport center shows the view center', () => {
  const v: View = { zoom: 3, rot: 1.2, cx: 10, cy: 20 };
  const [dx, dy] = screenToDoc(v, W / 2, H / 2, W, H);
  near(dx, 10); near(dy, 20);
});

test('zoomAt keeps the document point under the cursor', () => {
  const v: View = { zoom: 0.5, rot: 0.3, cx: 400, cy: 300 };
  const before = screenToDoc(v, 700, 100, W, H);
  const z = zoomAt(v, 4, 700, 100, W, H);
  near(z.zoom, 2);
  const after = screenToDoc(z, 700, 100, W, H);
  near(after[0], before[0]); near(after[1], before[1]);
});

test('panBy moves the image with the pointer', () => {
  const v: View = { zoom: 2, rot: Math.PI / 2, cx: 50, cy: 50 };
  const d = screenToDoc(v, 300, 200, W, H);
  const p = panBy(v, 30, -10);
  const s = docToScreen(p, d[0], d[1], W, H);
  near(s[0], 330); near(s[1], 190);
});

test('fit centers the document and fits it inside the viewport', () => {
  const v = fit(8000, 4000, W, H);
  near(v.cx, 4000); near(v.cy, 2000); near(v.rot, 0);
  assert.ok(v.zoom * 8000 <= W && v.zoom * 4000 <= H);
});

test('levelFor picks the finest level that is not magnified less than 1:2', () => {
  assert.equal(levelFor(1, 1, 5), 0);
  assert.equal(levelFor(4, 1, 5), 0);
  assert.equal(levelFor(0.5, 1, 5), 1);
  assert.equal(levelFor(0.49, 1, 5), 1);
  assert.equal(levelFor(0.25, 2, 5), 1);
  assert.equal(levelFor(0.001, 1, 5), 5);
});

test('visibleTiles covers the viewport and stays inside the document', () => {
  const v = fit(8000, 8000, W, H);
  const lvl = levelFor(v.zoom, 1, 5);
  const t = visibleTiles(v, W, H, lvl, 8000, 8000);
  const n = Math.ceil(8000 / (256 << lvl));
  assert.equal(t.length, n * n);
  // Zoomed in on the top-left corner: only a few tiles, none outside.
  const z: View = { zoom: 4, rot: 0.5, cx: 0, cy: 0 };
  const c = visibleTiles(z, W, H, 0, 8000, 8000);
  assert.ok(c.length > 0 && c.length < 12);
  for (const [tx, ty] of c) assert.ok(tx >= 0 && ty >= 0);
  assert.deepEqual(c[0], [0, 0]);
});

test('invalidateEntries revalidates tiles outside the dirty rect, leaves intersecting ones stale', () => {
  const cache = new Map([
    ['0/0/0', { version: 1 }], // doc px 0..256
    ['0/1/0', { version: 1 }], // doc px 256..512
    ['1/0/0', { version: 1 }], // level 1 tile covers 0..512
  ]);
  invalidateEntries(cache, 2, [10, 10, 5, 5]);
  assert.equal(cache.get('0/0/0')!.version, 1); // intersects: stays stale, refetched
  assert.equal(cache.get('0/1/0')!.version, 2); // no intersection: revalidated
  assert.equal(cache.get('1/0/0')!.version, 1); // also covers the rect: stale
});

test('invalidateEntries with an empty rect revalidates everything without refetching', () => {
  const cache = new Map([['0/0/0', { version: 1 }], ['0/5/5', { version: 1 }]]);
  invalidateEntries(cache, 2, []);
  for (const e of cache.values()) assert.equal(e.version, 2);
});

test('invalidateEntries keeps entries that were already stale before the stroke frame stale', () => {
  // '0/3/3' still holds version 0 from before an earlier full change (e.g. an off-screen tile after Fill).
  const cache = new Map([['0/0/0', { version: 1 }], ['0/3/3', { version: 0 }]]);
  invalidateEntries(cache, 2, [10, 10, 5, 5]);
  assert.equal(cache.get('0/3/3')!.version, 0);
});

test('clipMatrix maps the view center to clip origin and a screen corner to (-1, 1)', () => {
  const v: View = { zoom: 0.8, rot: 0.4, cx: 200, cy: 100 };
  const m = clipMatrix(v, W, H);
  const ap = (x: number, y: number) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
  const [ox, oy] = ap(200, 100);
  near(ox, 0); near(oy, 0);
  const [dx, dy] = screenToDoc(v, 0, 0, W, H);
  const [cx, cy] = ap(dx, dy);
  near(cx, -1); near(cy, 1);
});

test('visibleRect bounds the viewport corners in whole doc px, clamped to the document', () => {
  assert.deepEqual(visibleRect({ zoom: 2, rot: 0, cx: 50, cy: 50 }, 100, 60, 1000, 1000), [25, 35, 50, 30]);
  assert.deepEqual(visibleRect({ zoom: 1, rot: 0, cx: 10, cy: 10 }, 100, 100, 30, 30), [0, 0, 30, 30]);
  assert.deepEqual(visibleRect({ zoom: 1, rot: Math.PI / 4, cx: 100, cy: 100 }, 20, 20, 1000, 1000), [85, 85, 30, 30]);
});
