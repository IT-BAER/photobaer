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
  const r = await checkPsd('d.psd', psd([{ name: 'bg', imageData: img }, { name: 'mul', imageData: img, blendMode: 'multiply' }], img));
  assert.equal(r.status, 'skip');
  assert.match(r.reason!, /blend mode multiply/);
});
