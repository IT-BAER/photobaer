import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeExr, decodeHdr, encodeExr, encodeHdr, encodeIco, fromLinear, icoSizes, toLinear, type FloatImage } from './formats.ts';
import { FIXTURES } from './formats.fixtures.ts';
import { EXR_FIXTURES } from './formats.exr.fixtures.ts';

const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));
const expected = (x: number, y: number) => [(x + y) % 2 ? 3 : 0.0625, y * 0.5 + 0.125, x * 0.25, 1];

function check(img: FloatImage, tol: number) {
  assert.equal(img.width, 9);
  assert.equal(img.height, 5);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 9; x++) {
    const e = expected(x, y), o = (y * 9 + x) * 4;
    for (let c = 0; c < 4; c++) assert.ok(Math.abs(img.data[o + c] - e[c]) <= tol * Math.max(1, e[c]), `${x},${y} ch${c}: ${img.data[o + c]} vs ${e[c]}`);
  }
}

test('decodeExr reads NONE, RLE, ZIPS and ZIP files from OpenCV, half and float', async () => {
  for (const k of ['zip_half', 'rle_float', 'zips_half', 'none_float']) check(await decodeExr(b64(FIXTURES[k])), 1e-3);
});

test('decodeExr reads PXR24, B44, B44A, tiled (level 0 of ONE_LEVEL and MIPMAP) and the first part of multi-part files', async () => {
  for (const [k, f] of Object.entries(EXR_FIXTURES)) {
    const img = await decodeExr(b64(f.exr)), ref = new Float32Array(b64(f.ref).buffer);
    assert.equal(img.width, 37, k);
    assert.equal(img.height, 21, k);
    assert.deepEqual(img.data, ref, k);
  }
});

test('decodeExr names an unsupported compression', async () => {
  await assert.rejects(decodeExr(b64(FIXTURES.piz_half)), /PIZ is not supported/);
});

test('decodeHdr reads an RLE file from OpenCV', () => {
  check(decodeHdr(b64(FIXTURES.hdr)), 1 / 128);
});

const sample = (w: number, h: number): FloatImage => {
  const data = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([i % 7 * 0.3, 5.5, i % 3 ? 0 : 0.01, i % 2 ? 1 : 0.5], i * 4);
  return { width: w, height: h, data };
};

test('encodeExr round-trips exactly, over 1 and alpha kept', async () => {
  const img = sample(40, 37);
  assert.deepEqual((await decodeExr(await encodeExr(img))).data, img.data);
});

test('encodeHdr round-trips within RGBE precision; alpha becomes 1', () => {
  const img = sample(40, 3);
  const back = decodeHdr(encodeHdr(img));
  for (let i = 0; i < img.data.length; i++) {
    const want = i % 4 === 3 ? 1 : img.data[i];
    assert.ok(Math.abs(back.data[i] - want) <= Math.max(5.5, want) / 128, `${i}: ${back.data[i]} vs ${want}`);
  }
  // Under 8 px wide is written flat.
  assert.equal(decodeHdr(encodeHdr(sample(3, 2))).width, 3);
});

test('encodeIco writes one directory entry per PNG, 256 px stored as 0', () => {
  const ico = encodeIco([{ png: new Uint8Array([1, 2, 3]), width: 256, height: 16 }, { png: new Uint8Array([4, 5]), width: 32, height: 2 }]);
  assert.deepEqual([...ico.subarray(0, 8)], [0, 0, 1, 0, 2, 0, 0, 16]);
  const d = new DataView(ico.buffer);
  assert.deepEqual([d.getUint16(10, true), d.getUint16(12, true), d.getUint32(14, true), d.getUint32(18, true)], [1, 32, 3, 38]);
  assert.deepEqual([ico[22], ico[23], d.getUint32(30, true), d.getUint32(34, true)], [32, 2, 2, 41]);
  assert.deepEqual([...ico.subarray(38)], [1, 2, 3, 4, 5]);
  assert.throws(() => encodeIco([{ png: new Uint8Array(), width: 257, height: 1 }]), /256/);
});

test('icoSizes: the standard icon sizes up to the image, the long side at 256 at most, plus the own size', () => {
  assert.deepEqual(icoSizes(48, 48), [[16, 16], [24, 24], [32, 32], [48, 48]]);
  assert.deepEqual(icoSizes(100, 50), [[16, 8], [24, 12], [32, 16], [48, 24], [64, 32], [100, 50]]);
  assert.deepEqual(icoSizes(1000, 500).slice(-2), [[128, 64], [256, 128]]);
  assert.deepEqual(icoSizes(10, 3), [[10, 3]]);
});

test('toLinear and fromLinear invert each other above 1', () => {
  for (const v of [0, 0.02, 0.5, 1, 4]) assert.ok(Math.abs(fromLinear(toLinear(v)) - v) < 1e-9);
});
