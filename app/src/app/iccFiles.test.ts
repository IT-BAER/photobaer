import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { crc, embedIcc, grayFile, psdWithIcc, readIcc } from './iccFiles.ts';

const icc = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 255);

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function png(extra: Uint8Array[] = []) {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1);
  new DataView(ihdr.buffer).setUint32(4, 1);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk('IHDR', ihdr), ...extra,
    chunk('IDAT', deflateSync(Uint8Array.of(0, 10, 20, 30, 255))), chunk('IEND', new Uint8Array())];
  return Uint8Array.from(parts.flatMap(p => [...p]));
}

const chunkTypes = (b: Uint8Array) => {
  const types: string[] = [];
  for (let o = 8; o < b.length;) {
    const n = new DataView(b.buffer, b.byteOffset).getUint32(o);
    types.push(new TextDecoder().decode(b.subarray(o + 4, o + 8)));
    o += 12 + n;
  }
  return types;
};

test('crc32 matches zlib', () => {
  const d = icc(1000);
  assert.equal(crc(d), crc32(d));
});

test('PNG: embed replaces color chunks after IHDR and reads back', async () => {
  const p = icc(3000);
  const src = png([chunk('sRGB', Uint8Array.of(0)), chunk('gAMA', new Uint8Array(4))]);
  assert.equal(await readIcc(src), null);
  const out = await embedIcc(src, 'image/png', p);
  assert.deepEqual(chunkTypes(out), ['IHDR', 'iCCP', 'IDAT', 'IEND']);
  assert.deepEqual(await readIcc(out), p);
  const again = await embedIcc(out, 'image/png', icc(10));
  assert.deepEqual(chunkTypes(again), ['IHDR', 'iCCP', 'IDAT', 'IEND']);
  assert.deepEqual(await readIcc(again), icc(10));
});

test('JPEG: profiles split into APP2 segments in order', async () => {
  const jfif = Uint8Array.of(0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0);
  const src = Uint8Array.of(0xff, 0xd8, ...jfif, 0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9);
  assert.equal(await readIcc(src), null);
  const p = icc(150000);
  const out = await embedIcc(src, 'image/jpeg', p);
  assert.deepEqual([...out.subarray(0, 2 + jfif.length)], [0xff, 0xd8, ...jfif], 'APP0 stays first');
  assert.deepEqual(await readIcc(out), p);
  assert.deepEqual([...out.subarray(-7)], [0xda, 0, 2, 1, 2, 3, 0xff, 0xd9].slice(-7), 'scan data untouched');
  assert.deepEqual(await readIcc(await embedIcc(out, 'image/jpeg', icc(20))), icc(20), 'old segments replaced');
});

test('WebP: the ICCP chunk is read', async () => {
  const p = icc(33);
  const iccp = [...new TextEncoder().encode('ICCP'), 33, 0, 0, 0, ...p, 0];
  const vp8x = [...new TextEncoder().encode('VP8X'), 10, 0, 0, 0, 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const body = [...new TextEncoder().encode('WEBP'), ...vp8x, ...iccp];
  const riff = Uint8Array.from([...new TextEncoder().encode('RIFF'), body.length & 255, body.length >> 8, 0, 0, ...body]);
  assert.deepEqual(await readIcc(riff), p);
});

test('PSD: resource 1039 is inserted, replaced and read', async () => {
  const head = new Uint8Array(26);
  head.set(new TextEncoder().encode('8BPS'));
  head[5] = 1;
  const other = [...new TextEncoder().encode('8BIM'), 0x04, 0x0c, 0, 0, 0, 0, 0, 3, 9, 9, 9, 0];
  const psd = Uint8Array.from([...head, 0, 0, 0, 0, 0, 0, 0, other.length, ...other, 0, 0, 0, 0, 7, 7]);
  assert.equal(await readIcc(psd), null);
  const out = psdWithIcc(psd, icc(5));
  assert.deepEqual(await readIcc(out), icc(5));
  const again = psdWithIcc(out, icc(8));
  assert.deepEqual(await readIcc(again), icc(8));
  assert.deepEqual([...again.subarray(-6)], [0, 0, 0, 0, 7, 7], 'layer section untouched');
  assert.equal(again.length, psd.length + 12 + 8, 'one resource block of 8 bytes plus header');
});

test('grayFile: PNG color type 0 or 4, JPEG with one component, PSD color mode 1', () => {
  const pngOf = (type: number) => { const b = png(); b[25] = type; return b; };
  assert.deepEqual([0, 2, 3, 4, 6].map(t => grayFile(pngOf(t))), [true, false, false, true, false]);
  const jfif = [0xff, 0xe0, 0, 4, 0, 0];
  const sof = (m: number, n: number) => [0xff, m, 0, 8 + 3 * n, 8, 0, 1, 0, 1, n, ...Array(3 * n).fill(1)];
  const jpeg = (m: number, n: number) => Uint8Array.of(0xff, 0xd8, ...jfif, ...sof(m, n), 0xff, 0xda, 0, 2, 0xff, 0xd9);
  assert.deepEqual([jpeg(0xc0, 1), jpeg(0xc2, 1), jpeg(0xc0, 3), jpeg(0xc2, 4)].map(grayFile), [true, true, false, false]);
  assert.equal(grayFile(Uint8Array.of(0xff, 0xd8, 0xff, 0xc4, 0, 3, 1, ...sof(0xc0, 3), 0xff, 0xd9)), false, 'DHT is not a frame header');
  const psd = (mode: number) => { const b = new Uint8Array(40); b.set(new TextEncoder().encode('8BPS')); b[5] = 1; b[25] = mode; return b; };
  assert.deepEqual([1, 3, 4].map(m => grayFile(psd(m))), [true, false, false]);
  assert.equal(grayFile(Uint8Array.of(1, 2, 3)), false);
});
