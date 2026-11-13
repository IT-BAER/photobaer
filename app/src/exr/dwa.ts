// OpenEXR DWAA and DWAB decompression (32 and 256 rows per block). Channels follow rules stored in the block:
// lossy DCT (8x8 blocks of nonlinear halves, R/G/B sets as Y'CbCr), RLE (byte planes), or zlib (as stored).
import { inflate } from 'pako';
import { floatToHalf, halfToFloat, unpredict } from './common.ts';
import { hufDecode } from './piz.ts';

const damaged = (what: string) => new Error(`The EXR file is damaged (DWA ${what}).`);

const UNKNOWN = 0, LOSSY_DCT = 1, RLE = 2;
interface Rule { suffix: string; scheme: number; csc: number; nocase: boolean; type: number }
// Files of version 1 carry no rules.
const LEGACY: Rule[] = [
  ...[['r', 0], ['red', 0], ['g', 1], ['grn', 1], ['green', 1], ['b', 2], ['blu', 2], ['blue', 2], ['y', -1], ['by', -1], ['ry', -1]]
    .map(([suffix, csc]) => ({ suffix: suffix as string, scheme: LOSSY_DCT, csc: csc as number, nocase: true, type: 1 })),
  ...[0, 1, 2].map(type => ({ suffix: 'a', scheme: RLE, csc: -1, nocase: true, type })),
];

// JPEG zigzag: natural index of each stored position.
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
// The inverse 8x8 DCT in float32 with OpenEXR's constants (pi as 3.14159), rows then columns, in place.
const F = Math.fround, PI = F(3.14159);
// 0.5 cos(num pi / den) as OpenEXR computes it in float.
const half = (num: number, den: number) => F(0.5 * F(Math.cos(F(F(num * PI) / den))));
const [A, B, C, D, E, FF, G] = [half(1, 4), half(1, 16), half(1, 8), half(3, 16), half(5, 16), half(3, 8), half(7, 16)];
function idct(d: Float32Array) {
  const pass = (at: number, step: number) => {
    const v = (i: number) => d[at + i * step];
    const a0 = F(C * v(2)), a1 = F(FF * v(2)), a2 = F(C * v(6)), a3 = F(FF * v(6));
    const b0 = F(F(F(F(B * v(1)) + F(D * v(3))) + F(E * v(5))) + F(G * v(7)));
    const b1 = F(F(F(F(D * v(1)) - F(G * v(3))) - F(B * v(5))) - F(E * v(7)));
    const b2 = F(F(F(F(E * v(1)) - F(B * v(3))) + F(G * v(5))) + F(D * v(7)));
    const b3 = F(F(F(F(G * v(1)) - F(E * v(3))) + F(D * v(5))) - F(B * v(7)));
    const t0 = F(A * F(v(0) + v(4))), t3 = F(A * F(v(0) - v(4))), t1 = F(a0 + a3), t2 = F(a1 - a2);
    const g0 = F(t0 + t1), g1 = F(t3 + t2), g2 = F(t3 - t2), g3 = F(t0 - t1);
    const r = [F(g0 + b0), F(g1 + b1), F(g2 + b2), F(g3 + b3), F(g3 - b3), F(g2 - b2), F(g1 - b1), F(g0 - b0)];
    r.forEach((x, i) => { d[at + i * step] = x; });
  };
  for (let row = 0; row < 8; row++) pass(row * 8, 1);
  for (let col = 0; col < 8; col++) pass(col, 8);
}

// Nonlinear half bits to linear half bits: y^2.2 up to 1, exp(2.2 (y - 1)) above; not finite is 0.
let toLinearLut: Uint16Array | null = null;
function toLinear(): Uint16Array {
  if (toLinearLut) return toLinearLut;
  const lut = new Uint16Array(65536), k = Math.fround(2.2);
  for (let i = 0; i < 65536; i++) {
    const f = halfToFloat(i);
    if (!Number.isFinite(f)) continue;
    const a = Math.abs(f), v = Math.fround(a <= 1 ? a ** k : Math.exp(k * (a - 1)));
    lut[i] = floatToHalf(f < 0 ? -v : v);
  }
  return (toLinearLut = lut);
}

class Reader {
  at = 0;
  b: Uint8Array;
  v: DataView;
  constructor(b: Uint8Array) { this.b = b; this.v = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  need(n: number) { if (this.at + n > this.b.length) throw damaged('data too short'); }
  u64() { this.need(8); const x = this.v.getBigUint64(this.at, true); this.at += 8; if (x > 2n ** 40n) throw damaged('size'); return Number(x); }
  u16() { this.need(2); const x = this.v.getUint16(this.at, true); this.at += 2; return x; }
  u8() { this.need(1); return this.b[this.at++]; }
  bytes(n: number) { this.need(n); this.at += n; return this.b.subarray(this.at - n, this.at); }
}

/**
 * One DWA block of `rows` rows of `w` pixels over channels `chans` (sorted by name) to the uncompressed layout:
 * per row, each channel's samples, little-endian.
 */
export function unDwa(src: Uint8Array, w: number, rows: number, chans: { name: string; type: number; linear: boolean }[]): Uint8Array {
  const r = new Reader(src);
  const [version, unknownRaw, unknownSize, acSize, dcSize, rleSize, rleRaw, rleFull, acCount, dcCount, acCompression] = Array.from({ length: 11 }, () => r.u64());
  let rules = LEGACY;
  if (version >= 2) {
    let left = r.u16() - 2;
    rules = [];
    while (left > 0) {
      const start = r.at, end = src.indexOf(0, start);
      if (end < 0 || end - start > 255) throw damaged('channel rules');
      const suffix = new TextDecoder().decode(src.subarray(start, end));
      r.at = end + 1;
      const flags = r.u8(), type = r.u8();
      rules.push({ suffix, scheme: (flags >> 2) & 3, csc: (flags >> 4) - 1, nocase: !!(flags & 1), type });
      left -= r.at - start;
    }
    if (left < 0) throw damaged('channel rules');
  }
  const unknown = r.bytes(unknownSize), ac = r.bytes(acSize), dc = r.bytes(dcSize), rle = r.bytes(rleSize);

  // Each channel's scheme by the last rule its name suffix and type match; R, G and B indices group by prefix.
  const size = (t: number) => (t === 1 ? 2 : 4);
  const scheme = chans.map(() => UNKNOWN);
  const sets = new Map<string, number[]>();
  chans.forEach((c, i) => {
    const dot = c.name.lastIndexOf('.'), prefix = dot < 0 ? '' : c.name.slice(0, dot), suffix = c.name.slice(dot + 1);
    if (!sets.has(prefix)) sets.set(prefix, [-1, -1, -1]);
    for (const rule of rules) {
      if (rule.type !== c.type || (rule.nocase ? rule.suffix.toLowerCase() !== suffix.toLowerCase() : rule.suffix !== suffix)) continue;
      scheme[i] = rule.scheme;
      if (rule.csc >= 0) sets.get(prefix)![rule.csc] = i;
    }
  });
  const groups = [...sets.keys()].sort().map(k => sets.get(k)!).filter(s => s.every(i => i >= 0));

  const acWords = !acSize ? new Uint16Array(0) : acCompression === 0 ? hufDecode(ac, acCount) : asWords(inflate(ac), acCount);
  const dcWords = !dcSize ? new Uint16Array(0) : asWords(unpredict(inflate(dc)), dcCount);
  const unknownBytes = unknownSize ? inflate(unknown) : new Uint8Array(0);
  if (unknownBytes.length !== unknownRaw) throw damaged('zlib data');
  const rleBytes = rleFull ? unRle(inflate(rle), rleRaw, rleFull) : new Uint8Array(0);

  // Output rows: per row, each channel's samples.
  const rowBytes = chans.reduce((a, c) => a + w * size(c.type), 0), out = new Uint8Array(rowBytes * rows), ov = new DataView(out.buffer);
  const colOf = chans.map((_, i) => chans.slice(0, i).reduce((a, c) => a + w * size(c.type), 0));
  const halves = chans.map(() => new Uint16Array(0));
  let acAt = 0, dcAt = 0;
  const decode = (ids: number[], linear: boolean) => {
    const planes = lossyDct(ids.length, w, rows, acWords, acAt, dcWords, dcAt, linear);
    acAt = planes.ac;
    dcAt = planes.dc;
    ids.forEach((id, k) => { halves[id] = planes.out[k]; });
  };
  const done = new Set<number>();
  for (const g of groups) { decode(g, true); g.forEach(i => done.add(i)); }
  let unknownAt = 0, rleAt = 0;
  chans.forEach((c, i) => {
    if (done.has(i)) return;
    const n = w * rows, s = size(c.type);
    if (scheme[i] === LOSSY_DCT) decode([i], !c.linear);
    else if (scheme[i] === RLE) {
      // Byte planes: byte k of every sample, then byte k + 1.
      if (rleAt + n * s > rleBytes.length) throw damaged('RLE data');
      for (let y = 0; y < rows; y++) for (let x = 0; x < w; x++) for (let k = 0; k < s; k++) out[y * rowBytes + colOf[i] + x * s + k] = rleBytes[rleAt + k * n + y * w + x];
      rleAt += n * s;
    } else {
      if (unknownAt + n * s > unknownBytes.length) throw damaged('zlib data');
      for (let y = 0; y < rows; y++) out.set(unknownBytes.subarray(unknownAt + y * w * s, unknownAt + (y + 1) * w * s), y * rowBytes + colOf[i]);
      unknownAt += n * s;
    }
  });
  // Lossy channels hold halves; FLOAT ones widen.
  chans.forEach((c, i) => {
    if (!halves[i].length) return;
    for (let y = 0; y < rows; y++) for (let x = 0; x < w; x++) {
      const h = halves[i][y * w + x], at = y * rowBytes + colOf[i] + x * size(c.type);
      if (c.type === 1) ov.setUint16(at, h, true); else if (c.type === 2) ov.setFloat32(at, halfToFloat(h), true);
      else throw damaged('lossy UINT channel');
    }
  });
  return out;
}

function asWords(b: Uint8Array, count: number): Uint16Array {
  if (b.length !== count * 2) throw damaged('data size');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return Uint16Array.from({ length: count }, (_, i) => v.getUint16(i * 2, true));
}

function unRle(src: Uint8Array, size: number, full: number): Uint8Array {
  if (src.length !== size) throw damaged('RLE data');
  const out = new Uint8Array(full);
  let i = 0, o = 0;
  while (i < src.length) {
    const n = (src[i++] << 24) >> 24;
    if (n < 0) { if (o - n > full || i - n > src.length) throw damaged('RLE data'); out.set(src.subarray(i, i - n), o); o -= n; i -= n; }
    else { if (o + n + 1 > full) throw damaged('RLE data'); out.fill(src[i++], o, o + n + 1); o += n + 1; }
  }
  if (o !== full) throw damaged('RLE data');
  return out;
}

/**
 * `n` lossy channels (3: a Y'CbCr set to R, G, B) of `w` x `rows`, 8x8 blocks in row order. Per block and channel,
 * the DC from that channel's DC plane, then AC words in zigzag order: 0xff00 ends the block, 0xffNN skips NN.
 * Returns linear (unless `linear` is false) half bits per channel and where the AC and DC words end.
 */
function lossyDct(n: number, w: number, rows: number, acw: Uint16Array, acAt: number, dcw: Uint16Array, dcAt: number, linear: boolean) {
  const bx = Math.ceil(w / 8), by = Math.ceil(rows / 8), blocks = bx * by;
  if (dcAt + n * blocks > dcw.length) throw damaged('DC data');
  const lut = linear ? toLinear() : null;
  const out = Array.from({ length: n }, () => new Uint16Array(w * rows));
  const px = Array.from({ length: n }, () => new Float32Array(64));
  for (let b = 0; b < blocks; b++) {
    for (let c = 0; c < n; c++) {
      const f = px[c];
      f.fill(0);
      f[0] = halfToFloat(dcw[dcAt + c * blocks + b]);
      let last = 0;
      for (let k = 1; k < 64;) {
        if (acAt >= acw.length) throw damaged('AC data');
        const word = acw[acAt++];
        if (word === 0xff00) break;
        if (word >> 8 === 0xff) { k += word & 0xff; continue; }
        f[ZIGZAG[k]] = halfToFloat(word);
        last = k++;
      }
      if (!last) f.fill(F(F(f[0] * F(0.3535536)) * F(0.3535536)));
      else idct(f);
    }
    if (n === 3) for (let i = 0; i < 64; i++) {
      const [yy, cb, cr] = [px[0][i], px[1][i], px[2][i]];
      px[0][i] = F(yy + F(F(1.5747) * cr));
      px[1][i] = F(F(yy + F(F(-0.1873) * cb)) + F(F(-0.4682) * cr));
      px[2][i] = F(yy + F(F(1.8556) * cb));
    }
    const ox = (b % bx) * 8, oy = Math.floor(b / bx) * 8;
    for (let c = 0; c < n; c++) for (let y = 0; y < 8 && oy + y < rows; y++) for (let x = 0; x < 8 && ox + x < w; x++) {
      const h = floatToHalf(px[c][y * 8 + x]);
      out[c][(oy + y) * w + ox + x] = lut ? lut[h] : h;
    }
  }
  return { out, ac: acAt, dc: dcAt + n * blocks };
}
