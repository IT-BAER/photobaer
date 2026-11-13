// Test-only readers for TIFF (with an LZW decoder), BMP and Targa, written apart from app/src/encoders.ts.
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

// TIFF LZW decoder (MSB-first, early change), written apart from the encoder.
export function lzwDecode(b: Uint8Array): Uint8Array {
  const out: number[] = [];
  let table: number[][] = [], bits = 9, pos = 0, prev: number[] | null = null;
  const reset = () => { table = Array.from({ length: 258 }, (_, i) => [i]); bits = 9; prev = null; };
  const read = () => {
    let v = 0;
    for (let i = 0; i < bits; i++) { const byte = b[(pos + i) >> 3] ?? 0; v = (v << 1) | ((byte >> (7 - ((pos + i) & 7))) & 1); }
    pos += bits;
    return v;
  };
  reset();
  for (;;) {
    if (pos + bits > b.length * 8) throw new Error('LZW data ends without EOI');
    const code = read();
    if (code === 257) break;
    if (code === 256) { reset(); continue; }
    let entry: number[];
    if (code < table.length) entry = table[code];
    else if (prev && code === table.length) entry = [...prev, prev[0]];
    else throw new Error(`bad LZW code ${code}`);
    out.push(...entry);
    if (prev) table.push([...prev, entry[0]]);
    prev = entry;
    if (table.length + 1 >= 1 << bits && bits < 12) bits++;
  }
  return Uint8Array.from(out);
}

export function readTiff(f: Uint8Array) {
  const v = new DataView(f.buffer, f.byteOffset, f.byteLength);
  assert.equal(String.fromCharCode(f[0], f[1]), 'II');
  assert.equal(v.getUint16(2, true), 42);
  const at = v.getUint32(4, true), n = v.getUint16(at, true), tags = new Map<number, number[] | Uint8Array>();
  const size: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };
  let last = 0;
  for (let i = 0; i < n; i++) {
    const o = at + 2 + i * 12, tag = v.getUint16(o, true), type = v.getUint16(o + 2, true), cnt = v.getUint32(o + 4, true);
    assert.ok(tag > last, 'tags ascend');
    last = tag;
    const len = size[type] * cnt, p = len <= 4 ? o + 8 : v.getUint32(o + 8, true);
    if (type === 1 || type === 2 || type === 7) tags.set(tag, f.slice(p, p + len));
    else tags.set(tag, Array.from({ length: type === 5 ? cnt * 2 : cnt }, (_, k) => type === 3 ? v.getUint16(p + k * 2, true) : v.getUint32(p + k * 4, true)));
  }
  const num = (t: number) => (tags.get(t) as number[] | undefined) ?? [];
  const [w] = num(256), [h] = num(257), c = num(277)[0], bits = num(258)[0], comp = num(259)[0], pred = num(317)[0] ?? 1;
  const rps = num(278)[0], offs = num(273), lens = num(279), bpr = w * c * bits / 8;
  const raw = new Uint8Array(bpr * h);
  offs.forEach((o, i) => {
    const s = f.subarray(o, o + lens[i]);
    const d = comp === 5 ? lzwDecode(s) : comp === 8 ? new Uint8Array(inflateSync(s)) : s;
    const rows = Math.min(rps, h - i * rps);
    assert.equal(d.length, rows * bpr, `strip ${i} length`);
    raw.set(d, i * rps * bpr);
  });
  const rv = new DataView(raw.buffer);
  const data = bits === 8 ? new Uint8Array(raw) : bits === 16 ? new Uint16Array(w * h * c) : new Float32Array(w * h * c);
  for (let i = 0; bits !== 8 && i < w * h * c; i++) data[i] = bits === 16 ? rv.getUint16(i * 2, true) : rv.getFloat32(i * 4, true);
  if (pred === 2) for (let y = 0; y < h; y++) for (let i = c; i < w * c; i++) {
    const k = y * w * c + i;
    data[k] = bits === 8 ? (data[k] + data[k - c]) & 255 : (data[k] + data[k - c]) & 0xffff;
  }
  return { w, h, c, bits, comp, tags, data };
}

export function readBmp(f: Uint8Array) {
  const v = new DataView(f.buffer, f.byteOffset, f.byteLength);
  assert.equal(String.fromCharCode(f[0], f[1]), 'BM');
  assert.equal(v.getUint32(2, true), f.length);
  const off = v.getUint32(10, true), w = v.getInt32(18, true), h = v.getInt32(22, true), bpp = v.getUint16(28, true);
  const c = bpp === 8 ? 1 : bpp === 24 ? 3 : 4, stride = Math.ceil(w * bpp / 32) * 4, out = new Uint8Array(w * h * c);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = off + (h - 1 - y) * stride + x * bpp / 8, o = (y * w + x) * c;
    if (c === 1) out[o] = f[p + 0];
    else { out[o] = f[p + 2]; out[o + 1] = f[p + 1]; out[o + 2] = f[p]; if (c === 4) out[o + 3] = f[p + 3]; }
  }
  return { w, h, c, bpp, ppm: v.getInt32(38, true), compression: v.getUint32(30, true), data: out };
}

export function readTga(f: Uint8Array) {
  const v = new DataView(f.buffer, f.byteOffset, f.byteLength);
  const type = f[2], w = v.getUint16(12, true), h = v.getUint16(14, true), px = f[16] / 8, top = !!(f[17] & 0x20);
  assert.equal(String.fromCharCode(...f.subarray(f.length - 18, f.length - 1)), 'TRUEVISION-XFILE.');
  const pixels = new Uint8Array(w * h * px);
  let p = 18 + f[0];
  if (type & 8) {
    for (let o = 0; o < pixels.length;) {
      const hd = f[p++], n = (hd & 127) + 1;
      if (hd & 128) { for (let k = 0; k < n; k++) pixels.set(f.subarray(p, p + px), o + k * px); p += px; }
      else { pixels.set(f.subarray(p, p + n * px), o); p += n * px; }
      o += n * px;
    }
  } else pixels.set(f.subarray(p, p + pixels.length));
  const c = px === 1 ? 1 : px, out = new Uint8Array(w * h * c);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((top ? y : h - 1 - y) * w + x) * px, o = (y * w + x) * c;
    if (c === 1) out[o] = pixels[s];
    else { out[o] = pixels[s + 2]; out[o + 1] = pixels[s + 1]; out[o + 2] = pixels[s]; if (c === 4) out[o + 3] = pixels[s + 3]; }
  }
  return { w, h, c, type, alphaBits: f[17] & 15, data: out };
}

