import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBmp, encodeTga, encodeTiff, lzwEncode, type Raster } from './encoders.ts';
import { lzwDecode, readBmp, readTga, readTiff } from './encoders.fixtures.ts';

// ---------- fixtures ----------

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
// Smooth gradients with noise and a flat block: runs for RLE, repeats for LZW, noise for table overflow.
function image(w: number, h: number, c: Raster['channels'], bits: 8 | 16 | 32): Raster {
  const n = w * h * c, data = bits === 8 ? new Uint8Array(n) : bits === 16 ? new Uint16Array(n) : new Float32Array(n);
  const top = bits === 8 ? 255 : bits === 16 ? 65535 : 4;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < c; k++) {
    const flat = x < w / 3 && y < h / 2, f = flat ? 0.25 : ((x * (k + 1) + y * 3) % 97) / 96 * 0.7 + rnd() * 0.3;
    data[(y * w + x) * c + k] = bits === 32 ? f * top : Math.round(f * top);
  }
  return { width: w, height: h, channels: c, data };
}

// ---------- tests ----------

test('LZW round-trips empty, short, repetitive and table-overflowing input', () => {
  const big = new Uint8Array(200000);
  for (let i = 0; i < big.length; i++) big[i] = rnd() * 256;
  for (const src of [new Uint8Array(0), Uint8Array.of(7), new Uint8Array(5000).fill(9), Uint8Array.from({ length: 3000 }, (_, i) => i % 7), big]) {
    assert.deepEqual(lzwDecode(lzwEncode(src)), src);
  }
});

test('TIFF round-trips gray, gray+alpha, RGB and RGBA at 8/16/32 bits with every compression', async () => {
  for (const bits of [8, 16, 32] as const) for (const c of [1, 2, 3, 4] as const) for (const compression of ['none', 'lzw', 'zip'] as const) {
    const img = image(61, 37, c, bits);
    const t = readTiff(await encodeTiff(img, { compression }));
    const what = `${bits}-bit ${c}ch ${compression}`;
    assert.deepEqual([t.w, t.h, t.c, t.bits, t.comp], [61, 37, c, bits, { none: 1, lzw: 5, zip: 8 }[compression]], what);
    assert.deepEqual(t.data, img.data, what);
    assert.deepEqual(t.tags.get(262), [c <= 2 ? 1 : 2], `${what} photometric`);
    assert.deepEqual(t.tags.get(338), c === 2 || c === 4 ? [2] : undefined, `${what} unassociated alpha`);
    assert.deepEqual(t.tags.get(339), bits === 32 ? Array(c).fill(3) : undefined, `${what} float sample format`);
  }
});

test('TIFF holds resolution, text tags, XMP and the ICC profile; several strips', async () => {
  const icc = Uint8Array.from({ length: 300 }, (_, i) => i & 255);
  const img = image(700, 200, 3, 8);
  const f = await encodeTiff(img, { compression: 'lzw', dpi: 300, icc, xmp: '<x:xmpmeta>ä</x:xmpmeta>', description: 'Désc', artist: 'Ann', copyright: '© 2026', software: 'photobaer' });
  const t = readTiff(f);
  assert.deepEqual(t.data, img.data);
  assert.ok((t.tags.get(273) as number[]).length > 1, 'more than one strip');
  assert.deepEqual(t.tags.get(282), [300, 1]);
  assert.deepEqual(t.tags.get(296), [2]);
  const text = (tag: number) => new TextDecoder().decode((t.tags.get(tag) as Uint8Array).subarray(0, -1));
  assert.equal(text(270), 'Désc');
  assert.equal(text(315), 'Ann');
  assert.equal(text(33432), '© 2026');
  assert.equal(new TextDecoder().decode(t.tags.get(700) as Uint8Array), '<x:xmpmeta>ä</x:xmpmeta>');
  assert.deepEqual(t.tags.get(34675), icc);
});

test('TIFF refuses bad sizes and mismatched data', async () => {
  await assert.rejects(encodeTiff({ width: 0, height: 1, channels: 3, data: new Uint8Array(0) }), /size/);
  await assert.rejects(encodeTiff({ width: 2, height: 2, channels: 3, data: new Uint8Array(5) }), /does not match/);
});

test('BMP round-trips gray (palette), RGB (24-bit, padded rows) and RGBA (32-bit V4 bitfields)', () => {
  for (const c of [1, 3, 4] as const) for (const w of [1, 5, 33]) {
    const img = image(w, 9, c, 8);
    const b = readBmp(encodeBmp(img, 300));
    assert.deepEqual([b.w, b.h, b.c, b.bpp, b.compression], [w, 9, c, { 1: 8, 3: 24, 4: 32 }[c], c === 4 ? 3 : 0]);
    assert.equal(b.ppm, Math.round(300 / 0.0254));
    assert.deepEqual(b.data, img.data, `${c}ch w${w}`);
  }
  assert.throws(() => encodeBmp(image(2, 2, 3, 16)), /8-bit/);
});

test('TGA round-trips gray, RGB and RGBA, raw and RLE; RLE packets stay within 128 pixels and one row', () => {
  for (const c of [1, 3, 4] as const) for (const rle of [false, true]) {
    const img = image(300, 7, c, 8);
    const f = encodeTga(img, rle), t = readTga(f);
    assert.deepEqual([t.w, t.h, t.c, t.type, t.alphaBits], [300, 7, c, (c === 1 ? 3 : 2) + (rle ? 8 : 0), c === 4 ? 8 : 0]);
    assert.deepEqual(t.data, img.data, `${c}ch rle=${rle}`);
  }
  const flat = { width: 300, height: 2, channels: 3 as const, data: new Uint8Array(1800).fill(5) };
  assert.equal(encodeTga(flat, true).length, 18 + 2 * 3 * 4 + 26, 'one row of 300 equal pixels is 3 packets (128 + 128 + 44)');
  assert.throws(() => encodeTga({ width: 70000, height: 1, channels: 3, data: new Uint8Array(210000) }), /size/);
});
