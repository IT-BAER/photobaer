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

// A RIFF WebP of `chunks` ([fourcc, payload]), padded to even sizes.
function webp(chunks: [string, number[]][]) {
  const body = [...new TextEncoder().encode('WEBP')];
  for (const [t, d] of chunks) body.push(...new TextEncoder().encode(t), d.length & 255, (d.length >> 8) & 255, 0, 0, ...d, ...(d.length & 1 ? [0] : []));
  const n = body.length;
  return Uint8Array.from([...new TextEncoder().encode('RIFF'), n & 255, (n >> 8) & 255, 0, 0, ...body]);
}
// The fourcc list of a WebP file and its VP8X payload.
function webpChunks(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset), out: string[] = [];
  let vp8x: number[] = [];
  for (let o = 12; o + 8 <= b.length;) {
    const t = String.fromCharCode(...b.subarray(o, o + 4)), n = v.getUint32(o + 4, true);
    out.push(t);
    if (t === 'VP8X') vp8x = [...b.subarray(o + 8, o + 18)];
    o += 8 + n + (n & 1);
  }
  return { list: out, vp8x, riff: v.getUint32(4, true) };
}

test('WebP: the profile goes in an ICCP chunk after a VP8X header made from the image size', async () => {
  const p = icc(33);
  // Lossless 300 x 200 with alpha: signature 0x2f, then (w-1) | (h-1) << 14 | alpha << 28.
  const bits = 299 | (199 << 14) | (1 << 28);
  const lossless = webp([['VP8L', [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, bits >>> 24, 7, 7]]]);
  const a = await embedIcc(lossless, 'image/webp', p);
  const ca = webpChunks(a);
  assert.deepEqual(ca.list, ['VP8X', 'ICCP', 'VP8L']);
  assert.deepEqual(ca.vp8x, [0x30, 0, 0, 0, 43, 1, 0, 199, 0, 0], 'ICC and alpha flags, width-1 and height-1 (24-bit)');
  assert.equal(ca.riff, a.length - 8);
  assert.deepEqual(await readIcc(a), p);
  // Lossy 640 x 480: frame tag, start code 9d 01 2a, 14-bit width and height.
  const lossy = webp([['VP8 ', [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01, 9]]]);
  const cb = webpChunks(await embedIcc(lossy, 'image/webp', p));
  assert.deepEqual([cb.list, cb.vp8x], [['VP8X', 'ICCP', 'VP8 '], [0x20, 0, 0, 0, 127, 2, 0, 223, 1, 0]]);
  // Extended: the flag is added and an old ICCP replaced.
  const ext = webp([['VP8X', [0x10, 0, 0, 0, 9, 0, 0, 9, 0, 0]], ['ICCP', [1, 2, 3]], ['ALPH', [5]], ['VP8 ', [6, 6]]]);
  const c = await embedIcc(ext, 'image/webp', p);
  const cc = webpChunks(c);
  assert.deepEqual([cc.list, cc.vp8x[0]], [['VP8X', 'ICCP', 'ALPH', 'VP8 '], 0x30]);
  assert.deepEqual(await readIcc(c), p);
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
