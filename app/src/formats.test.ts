import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeExr, decodeHdr, encodeExr, encodeHdr, encodeIco, fromLinear, toLinear, type FloatImage } from './formats.ts';
import { FIXTURES } from './formats.fixtures.ts';

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

test('encodeIco wraps a PNG and refuses more than 256 px', () => {
  const ico = encodeIco(new Uint8Array([1, 2, 3]), 256, 16);
  assert.deepEqual([...ico.subarray(0, 8)], [0, 0, 1, 0, 1, 0, 0, 16]);
  assert.deepEqual([...ico.subarray(22)], [1, 2, 3]);
  assert.throws(() => encodeIco(new Uint8Array(), 257, 1), /256 x 256/);
});

test('toLinear and fromLinear invert each other above 1', () => {
  for (const v of [0, 0.02, 0.5, 1, 4]) assert.ok(Math.abs(fromLinear(toLinear(v)) - v) < 1e-9);
});
