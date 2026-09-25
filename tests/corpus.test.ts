import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writePsdUint8Array, type Layer, type PixelData } from 'ag-psd';
import { checkPsd } from './corpus.ts';

const W = 300, H = 200;
function image(w: number, h: number, px: (x: number, y: number) => number[]): PixelData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(px(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}
const pattern = (x: number, y: number) => [(x * 7) % 256, (y * 5) % 256, (x + y) % 256, 255];
const psd = (children: Layer[], composite: PixelData) => writePsdUint8Array({ width: W, height: H, children, imageData: composite });

test('an opaque layer that equals the composite passes with dE 0', async () => {
  const img = image(W, H, pattern);
  const r = await checkPsd('a.psd', psd([{ name: 'bg', imageData: img }], img));
  assert.equal(r.status, 'pass', JSON.stringify(r));
  assert.equal(r.max, 0);
});

test('a composite that differs from the layers fails', async () => {
  const img = image(W, H, pattern);
  const bad = image(W, H, (x, y) => (x > 250 && y > 150 ? [0, 255, 0, 255] : pattern(x, y)));
  const r = await checkPsd('b.psd', psd([{ name: 'bg', imageData: img }], bad));
  assert.equal(r.status, 'fail');
  assert.ok(r.max! > 5);
});

test('layer opacity and an offset layer that sticks out of the canvas are rendered', async () => {
  const white = image(W, H, () => [255, 255, 255, 255]);
  const red = image(100, 100, () => [255, 0, 0, 255]);
  // Red at 50% over white, placed at x -50..50, y 150..250 (clipped to the 300x200 canvas).
  const comp = image(W, H, (x, y) => (x < 50 && y >= 150 ? [255, 128, 128, 255] : [255, 255, 255, 255]));
  const r = await checkPsd('c.psd', psd([{ name: 'bg', imageData: white }, { name: 'red', imageData: red, left: -50, top: 150, opacity: 0.5 }], comp));
  assert.equal(r.status, 'pass', JSON.stringify(r));
});

test('features the engine cannot render yet are skipped with a reason', async () => {
  const img = image(W, H, pattern);
  const r = await checkPsd('d.psd', psd([{ name: 'bg', imageData: img }, { name: 'adj', adjustment: { type: 'invert' } }], img));
  assert.equal(r.status, 'skip');
  assert.match(r.reason!, /adjustment/);
});

test('default Blend If ranges are rendered, custom ranges are skipped', async () => {
  const img = image(W, H, pattern);
  const full = { sourceRange: [0, 0, 255, 255], destRange: [0, 0, 255, 255] };
  const ranges = (source: number[]) => ({ compositeGrayBlendSource: source, compositeGraphBlendDestinationRange: [0, 0, 255, 255], ranges: [full, full, full] });
  const ok = await checkPsd('f.psd', psd([{ name: 'bg', imageData: img, blendingRanges: ranges([0, 0, 255, 255]) }], img));
  assert.equal(ok.status, 'pass', JSON.stringify(ok));
  const custom = await checkPsd('g.psd', psd([{ name: 'bg', imageData: img, blendingRanges: ranges([0, 0, 128, 200]) }], img));
  assert.equal(custom.status, 'skip');
  assert.match(custom.reason!, /blendingRanges/);
});

test('shape layers render their stored raster, vector masks on pixel layers are skipped', async () => {
  const img = image(W, H, pattern);
  const vectorMask = { paths: [] };
  const shape = await checkPsd('h.psd', psd([{ name: 'bg', imageData: img, vectorMask, vectorFill: { type: 'color', color: { r: 255, g: 0, b: 0 } } }], img));
  assert.equal(shape.status, 'pass', JSON.stringify(shape));
  const pixel = await checkPsd('i.psd', psd([{ name: 'bg', imageData: img, vectorMask }], img));
  assert.equal(pixel.status, 'skip');
  assert.match(pixel.reason!, /vectorMask/);
});

test('a PSB file is skipped, not failed', async () => {
  const img = image(W, H, pattern);
  const r = await checkPsd('e.psb', writePsdUint8Array({ width: W, height: H, children: [{ name: 'bg', imageData: img }], imageData: img }, { psb: true }));
  assert.equal(r.status, 'skip', JSON.stringify(r));
  assert.match(r.reason!, /PSB/);
});

test('pixels where a dissolve layer has partial coverage are excluded, full coverage is compared', async () => {
  const bg = image(W, H, () => [255, 255, 255, 255]);
  // Left half at alpha 128 (random pattern in Photoshop), right half opaque (always drawn).
  const top = image(W, H, x => [255, 0, 0, x < 150 ? 128 : 255]);
  const layers = [{ name: 'bg', imageData: bg }, { name: 'd', imageData: top, blendMode: 'dissolve' as const }];
  const ok = await checkPsd('j.psd', psd(layers, image(W, H, x => (x < 150 ? [0, 255, 0, 255] : [255, 0, 0, 255]))));
  assert.equal(ok.status, 'pass', JSON.stringify(ok));
  assert.equal(ok.excluded, 150 * H);
  const bad = await checkPsd('k.psd', psd(layers, image(W, H, () => [0, 255, 0, 255])));
  assert.equal(bad.status, 'fail');
});

test('a per-file exception allows a bounded count of pixels at dE 5 or more', async () => {
  const img = image(W, H, pattern);
  const bad = psd([{ name: 'bg', imageData: img }], image(W, H, (x, y) => (x < 5 && y < 5 ? [0, 255, 0, 255] : pattern(x, y))));
  assert.equal((await checkPsd('l.psd', bad)).status, 'fail');
  const r = await checkPsd('l.psd', bad, 25);
  assert.equal(r.status, 'pass', JSON.stringify(r));
  assert.equal(r.over, 25);
  assert.equal((await checkPsd('l.psd', bad, 24)).status, 'fail');
});
