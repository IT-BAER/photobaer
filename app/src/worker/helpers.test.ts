import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { initSync, Engine } from '../engine-pkg/photobaer_engine.js';
import { exportAsset, flatRaster, renderRgba, shiftedRegion, tileLoop, type ExportOptions } from './helpers.ts';
import { grayIcc } from '../psd.ts';
import { readTga } from '../encoders.fixtures.ts';
import { tileIds } from '../project.ts';

initSync({ module: readFileSync(new URL('../engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });

test('renderRgba with several layers keeps only them, reveals hidden ones and trims to their union', () => {
  const e = new Engine(64, 32, 8);
  const square = (x: number, y: number, rgb: number[]) => {
    const id = e.add_layer('L', 0);
    e.put_rgba8(id, x, y, 4, 4, Uint8Array.from({ length: 64 }, (_, i) => (i % 4 === 3 ? 255 : rgb[i % 4])));
    return id;
  };
  const a = square(2, 2, [255, 0, 0]), b = square(20, 10, [0, 0, 255]), c = square(40, 20, [0, 255, 0]);
  e.set_props(b, JSON.stringify({ visible: false }));
  const r = renderRgba(e, { layers: [a, b], trim: true, reveal: true })!;
  assert.deepEqual([r.w, r.h], [22, 12], 'from (2,2) to (24,14)');
  assert.deepEqual([...r.data.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...r.data.subarray(((8 * 22) + 18) * 4, ((8 * 22) + 19) * 4)], [0, 0, 255, 255], 'the hidden layer is revealed');
  assert.equal(r.data[(11 * 22 + 21) * 4 + 3], 255);
  assert.equal(renderRgba(e, { layers: [c] })!.w, 64, 'untrimmed keeps the canvas');
  assert.equal(JSON.parse(e.layers_json()).find((n: { id: number }) => n.id === b).visible, false, 'the document is unchanged');
});

test('shiftedRegion past the canvas edge leaves the layer on its own tiles, so cached effect tiles stay valid', () => {
  const e = new Engine(1000, 600, 8);
  const id = e.add_layer('L', 0);
  e.put_rgba8(id, 0, 0, 1000, 600, Uint8Array.from({ length: 1000 * 600 * 4 }, (_, i) => (i % 4 === 3 ? 255 : 128)));
  const before = [...tileIds(e.manifest())].sort();
  const r = shiftedRegion(e, [id], 0, [-50, 0, 1100, 600])!;
  assert.deepEqual([r.image.x, r.image.w], [-50, 1100]);
  assert.deepEqual([...tileIds(e.manifest())].sort(), before);
});

// The previous flatRaster, with the full-size float intermediate, as the reference for the tiled one.
function flatRasterRef(e: Engine) {
  const W = e.width(), H = e.height(), depth = e.depth(), gray = grayIcc(e) !== null;
  const f = new Float32Array(W * H * 4);
  tileLoop(W, H, (tx, ty) => {
    const t = depth === 16 ? e.flatten_tile_f32(tx, ty) : e.flatten_tile_linear(tx, ty), w = Math.min(256, W - tx * 256);
    for (let y = 0; y < 256 && ty * 256 + y < H; y++) f.set(t.subarray(y * 1024, y * 1024 + w * 4), ((ty * 256 + y) * W + tx * 256) * 4);
  });
  let alpha = false;
  for (let i = 3; i < f.length; i += 4) if (f[i] < 1) { alpha = true; break; }
  const c = ((gray ? 1 : 3) + (alpha ? 1 : 0)), n = W * H;
  const data = depth === 16 ? new Uint16Array(n * c) : new Float32Array(n * c);
  const put = (o: number, v: number, a = false) => { data[o] = depth === 16 ? Math.round(Math.min(1, Math.max(0, v)) * 65535) : a ? Math.min(1, Math.max(0, v)) : v; };
  for (let p = 0, o = 0; p < n; p++) {
    const i = p * 4;
    put(o++, f[i]);
    if (!gray) { put(o++, f[i + 1]); put(o++, f[i + 2]); }
    if (alpha) put(o++, f[i + 3], true);
  }
  return { width: W, height: H, channels: c, data };
}

test('flatRaster at 16 and 32 bits equals the full-size reference, RGB and gray, opaque and transparent', () => {
  for (const depth of [16, 32] as const) for (const gray of [false, true]) for (const clear of [false, true]) {
    const e = new Engine(300, 270, depth);
    if (gray) e.convert_mode(true);
    const id = e.add_layer('L', 0);
    const w = clear ? 280 : 300, h = clear ? 250 : 270;
    e.put_rgba8(id, 0, 0, w, h, Uint8Array.from({ length: w * h * 4 }, (_, i) => (i % 4 === 3 ? (i >> 2) % 5 === 0 ? 100 : 255 : (i * 7) % 256)));
    const a = flatRaster(e), b = flatRasterRef(e);
    assert.deepEqual([a.width, a.height, a.channels], [b.width, b.height, b.channels], `${depth} gray=${gray} clear=${clear}`);
    assert.equal(a.data.constructor, b.data.constructor);
    assert.deepEqual(a.data, b.data, `${depth} gray=${gray} clear=${clear}`);
    e.free();
  }
});

test('flatRaster refuses a 4-channel buffer over 4 GiB before allocating', () => {
  const big = (depth: number) => ({ width: () => 40000, height: () => 40000, depth: () => depth }) as unknown as Engine;
  assert.throws(() => flatRaster(big(16)), /too large to save at this bit depth/);
  assert.throws(() => flatRaster(big(32)), /too large to save at this bit depth/);
});

test('a matte on a gray document is converted to one gray value', async () => {
  const e = new Engine(4, 4, 8);
  e.convert_mode(true);
  const id = e.add_layer('L', 0);
  e.put_rgba8(id, 0, 0, 2, 4, Uint8Array.from({ length: 32 }, (_, i) => 0));
  assert.notEqual(grayIcc(e), null);
  const o: ExportOptions = { format: 'tga', quality: 1, scale: 1, colors: 256, dither: 'none', icc: false, compression: 'none', matte: [255, 0, 0] };
  const t = readTga(new Uint8Array(await (await exportAsset(e, o)).blob.arrayBuffer()));
  assert.equal(t.c, 1);
  assert.equal(t.data[0], Math.round(0.3 * 255), 'Rec. 601 gray of the matte, not the red channel');
});
