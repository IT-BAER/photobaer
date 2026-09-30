import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloneSources, cloneOverlaySource, emptySlot, mapPoint, redEyeRect, sourceMap, tintOverlay } from './retouch.ts';

test('aligned strokes keep the first stroke origin, non-aligned strokes restart at the anchor', () => {
  const c = new CloneSources();
  c.setAnchor({ x: 10, y: 10 }, 1, 7);
  const m1 = c.beginStroke({ x: 50, y: 50 }, 1, true)!;
  assert.deepEqual(mapPoint(m1, 50, 50), [10, 10]);
  const m2 = c.beginStroke({ x: 60, y: 50 }, 1, true)!;
  assert.deepEqual(mapPoint(m2, 60, 50), [20, 10]);
  const m3 = c.beginStroke({ x: 60, y: 50 }, 1, false)!;
  assert.deepEqual(mapPoint(m3, 60, 50), [10, 10]);
});

test('slot scale 50 % maps a 10 px destination offset to 20 px of source', () => {
  const s = { ...emptySlot(), anchor: { x: 10, y: 10 }, scaleX: 0.5, scaleY: 0.5 };
  const m = sourceMap(s, { x: 50, y: 50 })!;
  assert.deepEqual(mapPoint(m, 60, 50), [30, 10]);
});

test('rotation and flip enter the map; a new anchor keeps a locked offset', () => {
  const s = { ...emptySlot(), anchor: { x: 0, y: 0 }, flipX: true };
  assert.deepEqual(mapPoint(sourceMap(s, { x: 0, y: 0 })!, 5, 3), [-5, 3]);
  const r = sourceMap({ ...emptySlot(), anchor: { x: 0, y: 0 }, rotation: 90 }, { x: 0, y: 0 })!;
  const [x, y] = mapPoint(r, 1, 0);
  assert.ok(Math.abs(x) < 1e-9 && Math.abs(y + 1) < 1e-9);
  const c = new CloneSources();
  c.setAnchor({ x: 10, y: 10 }, 1, null);
  c.update(c.active, { lockOffset: true });
  c.setOffset('x', 40, 1);
  c.setOffset('y', 0, 1);
  c.setAnchor({ x: 20, y: 20 }, 1, null);
  assert.deepEqual(c.offset(), { x: 40, y: 0 });
});

test('slots are independent and the active slot switches', () => {
  const c = new CloneSources();
  let n = 0;
  c.subscribe(() => n++);
  c.setAnchor({ x: 1, y: 2 }, 1, null);
  c.setActive(3);
  assert.equal(c.slot().anchor, null);
  assert.deepEqual(c.slot(0).anchor, { x: 1, y: 2 });
  c.setActive(9);
  assert.equal(c.active, 3);
  assert.equal(n, 2);
  assert.equal(c.beginStroke({ x: 0, y: 0 }, 1, true), null);
});

test('a red eye click takes a 40 px box, a drag its own box', () => {
  assert.deepEqual(redEyeRect([100, 50], [101, 50]), [80, 30, 40, 40]);
  assert.deepEqual(redEyeRect([10, 20], [4, 60.4]), [4, 20, 6, 40]);
});

test('the overlay source point follows the pointer when aligned and stays on the anchor otherwise', () => {
  const c = new CloneSources();
  assert.equal(cloneOverlaySource(c, [5, 5], 1, true), null);
  c.setAnchor({ x: 10, y: 10 }, 1, null);
  assert.deepEqual(cloneOverlaySource(c, [70, 50], 1, true)!.src, [10, 10]);
  c.beginStroke({ x: 50, y: 50 }, 1, true);
  assert.deepEqual(cloneOverlaySource(c, [70, 50], 1, true)!.src, [30, 10]);
  assert.deepEqual(cloneOverlaySource(c, [70, 50], 1, false)!.src, [10, 10]);
});

test('tintOverlay clips to the round tip and applies opacity and invert', () => {
  const px = new Uint8ClampedArray(4 * 4 * 4).fill(200);
  tintOverlay(px, 4, 4, { clipped: true, opacity: 0.5, inverted: true });
  assert.equal(px[3], 0);
  const c = (1 * 4 + 1) * 4;
  assert.deepEqual([...px.slice(c, c + 4)], [55, 55, 55, 100]);
});

test('tintOverlay blends with the destination by the overlay mode', () => {
  const px = new Uint8ClampedArray([100, 200, 50, 255]), dest = new Uint8ClampedArray([150, 150, 150, 255]);
  tintOverlay(px, 1, 1, { clipped: false, opacity: 1, inverted: false, mode: 'difference', dest });
  assert.deepEqual([...px], [50, 50, 100, 255]);
  const q = new Uint8ClampedArray([100, 200, 50, 255]);
  tintOverlay(q, 1, 1, { clipped: false, opacity: 1, inverted: false, mode: 'darken', dest });
  assert.deepEqual([...q], [100, 150, 50, 255]);
});
