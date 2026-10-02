import test from 'node:test';
import assert from 'node:assert/strict';
import { ZOOM_MAX, ZOOM_MIN, boxScale, docToThumb, sliderToZoom, thumbSize, thumbToDoc, viewQuad, zoomToSlider } from './navigator.ts';

const near = (a: number[][], b: number[][]) => a.forEach((p, i) => p.forEach((v, j) => assert.ok(Math.abs(v - b[i][j]) < 1e-9, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`)));

test('thumbSize keeps the aspect and never upscales', () => {
  assert.deepEqual(thumbSize(4000, 2000, 200), [200, 100]);
  assert.deepEqual(thumbSize(100, 400, 200), [50, 200]);
  assert.deepEqual(thumbSize(60, 40, 200), [60, 40]);
});

test('document to thumbnail mapping and its inverse', () => {
  const [tx, ty] = docToThumb(1000, 500, 4000, 2000, 200, 100);
  assert.deepEqual([tx, ty], [50, 25]);
  assert.deepEqual(thumbToDoc(tx, ty, 4000, 2000, 200, 100), [1000, 500]);
});

test('view quad at rot 0 is the visible rect', () => {
  // 400x200 viewport at zoom 1 centered on (2000, 1000) of a 4000x2000 doc: doc rect 1800..2200 x 900..1100.
  near(viewQuad({ zoom: 1, rot: 0, cx: 2000, cy: 1000 }, 400, 200, 4000, 2000, 200, 100), [[90, 45], [110, 45], [110, 55], [90, 55]]);
});

test('view quad at rot 90 is the rotated rectangle', () => {
  // Screen top-left (-200, -100 from center) maps to doc (cx - 100, cy + 200).
  near(viewQuad({ zoom: 1, rot: Math.PI / 2, cx: 2000, cy: 1000 }, 400, 200, 4000, 2000, 200, 100), [[95, 60], [95, 40], [105, 40], [105, 60]]);
});

test('zoom slider log mapping round-trips and hits the clamps', () => {
  assert.equal(zoomToSlider(ZOOM_MIN), 0);
  assert.equal(zoomToSlider(ZOOM_MAX), 1000);
  assert.ok(Math.abs(sliderToZoom(0) - ZOOM_MIN) < 1e-12 && Math.abs(sliderToZoom(1000) - ZOOM_MAX) < 1e-9);
  for (const z of [0.01, 0.25, 1, 4, 32]) assert.ok(Math.abs(Math.log(sliderToZoom(zoomToSlider(z)) / z)) < 0.01);
});

test('boxScale averages premultiplied pixels to straight alpha', () => {
  const src = Uint8Array.of(100, 0, 0, 100, 0, 0, 0, 0); // 2x1: half-opaque red premult, transparent
  assert.deepEqual([...boxScale(src, 2, 1, 1, 1)], [255, 0, 0, 50]);
  assert.deepEqual([...boxScale(src, 2, 1, 2, 1)], [255, 0, 0, 100, 0, 0, 0, 0]);
});
