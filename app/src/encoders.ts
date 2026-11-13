// TIFF, BMP and Targa writers for flattened copies and exports. Samples are straight (unassociated alpha),
// interleaved, top row first: 1 gray, 2 gray + alpha, 3 RGB, 4 RGBA.
import { ASCII, LONG, RATIONAL, SHORT, BYTE, UNDEFINED, rational, writeIfd, type IfdEntry } from './app/exif.ts';

export interface Raster { width: number; height: number; channels: 1 | 2 | 3 | 4; data: Uint8Array | Uint16Array | Float32Array }
export type TiffCompression = 'none' | 'lzw' | 'zip';
export interface TiffOptions {
  compression?: TiffCompression; dpi?: number; icc?: Uint8Array; xmp?: string;
  description?: string; artist?: string; copyright?: string; software?: string;
}

const bitsOf = (d: Raster['data']) => d instanceof Uint8Array ? 8 : d instanceof Uint16Array ? 16 : 32;

function check(img: Raster, max = 0x7fffffff) {
  const { width: w, height: h, channels: c, data } = img;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > max || h > max) throw new Error(`The image size ${w} x ${h} cannot be written in this format.`);
  if (data.length !== w * h * c) throw new Error('The pixel data does not match the image size.');
}

// ---------- LZW (TIFF variant: MSB-first codes of 9 to 12 bits, Clear 256, EOI 257, early change) ----------

const CLEAR = 256, EOI = 257, FIRST = 258, MAX_CODE = 4095;
// next[code * 256 + byte]: the code for string(code) + byte, 0 when absent; only the entries made are reset.
let next: Uint16Array | null = null;
const made = new Int32Array(4096);

/** One TIFF LZW strip: Clear first, EOI last. */
export function lzwEncode(src: Uint8Array): Uint8Array {
  next ??= new Uint16Array(4096 * 256);
  const next_ = next;
  let out = new Uint8Array(Math.max(64, (src.length * 3 >> 1) + 16)), o = 0, acc = 0, nacc = 0;
  let bits = 9, free = FIRST;
  const put = (code: number) => {
    acc = (acc << bits) | code; nacc += bits;
    while (nacc >= 8) {
      if (o >= out.length) { const g = new Uint8Array(out.length * 2); g.set(out); out = g; }
      nacc -= 8; out[o++] = (acc >>> nacc) & 255;
    }
    acc &= (1 << nacc) - 1;
  };
  const reset = () => { for (let c = FIRST; c < free; c++) next_[made[c]] = 0; free = FIRST; bits = 9; };
  // After an entry is made: full table (4094) clears, else the width grows once `free` passes the width's top code.
  const grow = () => {
    if (free === MAX_CODE - 1) { put(CLEAR); reset(); }
    else if (free > (1 << bits) - 1) bits++;
  };
  put(CLEAR);
  if (src.length) {
    let ent = src[0];
    for (let i = 1; i < src.length; i++) {
      const c = src[i], k = ent * 256 + c, hit = next_[k];
      if (hit) { ent = hit; continue; }
      put(ent);
      next_[k] = free; made[free] = k; free++;
      grow();
      ent = c;
    }
    put(ent);
    // The decoder makes one more entry after the last code, so the width may grow before EOI.
    if (free + 1 === MAX_CODE - 1) { put(CLEAR); bits = 9; } else if (free + 1 > (1 << bits) - 1) bits++;
  }
  put(EOI);
  reset();
  if (nacc) { if (o >= out.length) { const g = new Uint8Array(out.length + 1); g.set(out); out = g; } out[o++] = (acc << (8 - nacc)) & 255; }
  return out.slice(0, o);
}

async function deflate(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// ---------- TIFF ----------

// Rows of `img` from y0 as little-endian bytes; with `predict`, horizontal differencing per sample (Predictor 2).
function stripBytes(img: Raster, y0: number, rows: number, predict: boolean): Uint8Array {
  const { width: w, channels: c, data } = img, bits = bitsOf(data), n = w * c, bpr = n * bits / 8;
  const out = new Uint8Array(rows * bpr), v = new DataView(out.buffer);
  for (let r = 0; r < rows; r++) {
    const s = (y0 + r) * n, o = r * bpr;
    if (bits === 8) {
      const row = (data as Uint8Array).subarray(s, s + n);
      if (!predict) { out.set(row, o); continue; }
      for (let i = 0; i < n; i++) out[o + i] = i < c ? row[i] : (row[i] - row[i - c]) & 255;
    } else if (bits === 16) {
      const row = (data as Uint16Array).subarray(s, s + n);
      for (let i = 0; i < n; i++) v.setUint16(o + i * 2, predict && i >= c ? (row[i] - row[i - c]) & 0xffff : row[i], true);
    } else {
      const row = (data as Float32Array).subarray(s, s + n);
      for (let i = 0; i < n; i++) v.setFloat32(o + i * 4, row[i], true);
    }
  }
  return out;
}

/** A baseline little-endian TIFF: one IFD, strips of about 256 KB, alpha as an unassociated extra sample,
 * 8/16-bit unsigned or 32-bit float samples; LZW and ZIP use the horizontal predictor for integer samples. */
export async function encodeTiff(img: Raster, o: TiffOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  check(img);
  const { width: w, height: h, channels: c } = img, bits = bitsOf(img.data), comp = o.compression ?? 'none';
  const predict = comp !== 'none' && bits !== 32;
  const bpr = w * c * bits / 8, rps = Math.max(1, Math.min(h, Math.floor((256 * 1024) / bpr)));
  const strips: Uint8Array[] = [];
  for (let y = 0; y < h; y += rps) {
    const raw = stripBytes(img, y, Math.min(rps, h - y), predict);
    strips.push(comp === 'lzw' ? lzwEncode(raw) : comp === 'zip' ? await deflate(raw) : raw);
  }
  const data = strips.reduce((n, s) => n + s.length + (s.length & 1), 0);
  if (8 + data > 0xfff00000) throw new Error('The TIFF file would be larger than 4 GB.');
  const offsets: number[] = [];
  let at = 8;
  for (const s of strips) { offsets.push(at); at += s.length + (s.length & 1); }
  const gray = c <= 2, alpha = c === 2 || c === 4;
  const e: IfdEntry[] = [
    { tag: 256, type: LONG, value: [w] }, { tag: 257, type: LONG, value: [h] },
    { tag: 258, type: SHORT, value: Array(c).fill(bits) },
    { tag: 259, type: SHORT, value: [comp === 'lzw' ? 5 : comp === 'zip' ? 8 : 1] },
    { tag: 262, type: SHORT, value: [gray ? 1 : 2] },
    { tag: 273, type: LONG, value: offsets }, { tag: 277, type: SHORT, value: [c] }, { tag: 278, type: LONG, value: [rps] },
    { tag: 279, type: LONG, value: strips.map(s => s.length) },
    { tag: 282, type: RATIONAL, value: rational(o.dpi ?? 72) }, { tag: 283, type: RATIONAL, value: rational(o.dpi ?? 72) },
    { tag: 284, type: SHORT, value: [1] }, { tag: 296, type: SHORT, value: [2] },
  ];
  if (predict) e.push({ tag: 317, type: SHORT, value: [2] });
  if (alpha) e.push({ tag: 338, type: SHORT, value: [2] });
  if (bits === 32) e.push({ tag: 339, type: SHORT, value: Array(c).fill(3) });
  if (o.description) e.push({ tag: 270, type: ASCII, value: o.description });
  if (o.software) e.push({ tag: 305, type: ASCII, value: o.software });
  if (o.artist) e.push({ tag: 315, type: ASCII, value: o.artist });
  if (o.xmp) e.push({ tag: 700, type: BYTE, value: new TextEncoder().encode(o.xmp) });
  if (o.copyright) e.push({ tag: 33432, type: ASCII, value: o.copyright });
  if (o.icc?.length) e.push({ tag: 34675, type: UNDEFINED, value: o.icc });
  const ifd = writeIfd(e, at, true);
  const out = new Uint8Array(at + ifd.length), v = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]);
  v.setUint32(4, at, true);
  strips.forEach((s, i) => out.set(s, offsets[i]));
  out.set(ifd, at);
  return out;
}

// ---------- BMP ----------

/** A bottom-up Windows bitmap from 8-bit samples: 8-bit gray palette, 24-bit BGR, or 32-bit BGRA with a
 * BITMAPV4HEADER alpha mask when the image has alpha. */
export function encodeBmp(img: Raster, dpi = 72): Uint8Array<ArrayBuffer> {
  check(img);
  if (bitsOf(img.data) !== 8) throw new Error('BMP files are written from 8-bit samples.');
  const { width: w, height: h, channels: c } = img, d = img.data as Uint8Array;
  const alpha = c === 4, gray = c <= 2, bpp = gray ? 8 : alpha ? 32 : 24;
  const stride = ((w * bpp + 31) >> 5) * 4, info = alpha ? 108 : 40, palette = gray ? 1024 : 0;
  const off = 14 + info + palette, size = off + stride * h;
  if (size > 0xffffffff) throw new Error('The BMP file would be larger than 4 GB.');
  const out = new Uint8Array(size), v = new DataView(out.buffer);
  out.set([0x42, 0x4d]);
  v.setUint32(2, size, true); v.setUint32(10, off, true);
  v.setUint32(14, info, true); v.setInt32(18, w, true); v.setInt32(22, h, true);
  v.setUint16(26, 1, true); v.setUint16(28, bpp, true); v.setUint32(30, alpha ? 3 : 0, true);
  v.setUint32(34, stride * h, true);
  const ppm = Math.round(dpi / 0.0254);
  v.setInt32(38, ppm, true); v.setInt32(42, ppm, true);
  if (gray) v.setUint32(46, 256, true);
  if (alpha) {
    v.setUint32(54, 0x00ff0000, true); v.setUint32(58, 0x0000ff00, true); v.setUint32(62, 0x000000ff, true); v.setUint32(66, 0xff000000, true);
    v.setUint32(70, 0x73524742, true); // LCS_sRGB
  }
  if (gray) for (let i = 0; i < 256; i++) out.set([i, i, i, 0], 14 + info + i * 4);
  for (let y = 0; y < h; y++) {
    const o = off + (h - 1 - y) * stride, s = y * w * c;
    for (let x = 0; x < w; x++) {
      const p = s + x * c;
      if (gray) out[o + x] = d[p];
      else if (alpha) out.set([d[p + 2], d[p + 1], d[p], d[p + 3]], o + x * 4);
      else out.set([d[p + 2], d[p + 1], d[p]], o + x * 3);
    }
  }
  return out;
}

// ---------- Targa ----------

/** A Truevision Targa (bottom-left origin, TGA 2.0 footer) from 8-bit samples: 8-bit gray, 24-bit BGR or
 * 32-bit BGRA, raw or run-length encoded per scanline. */
export function encodeTga(img: Raster, rle = false): Uint8Array<ArrayBuffer> {
  check(img, 65535);
  if (bitsOf(img.data) !== 8) throw new Error('Targa files are written from 8-bit samples.');
  const { width: w, height: h, channels: c } = img, d = img.data as Uint8Array;
  const gray = c <= 2, alpha = c === 4, px = gray ? 1 : alpha ? 4 : 3;
  const head = new Uint8Array(18), hv = new DataView(head.buffer);
  head[2] = (gray ? 3 : 2) + (rle ? 8 : 0);
  hv.setUint16(12, w, true); hv.setUint16(14, h, true);
  head[16] = px * 8; head[17] = alpha ? 8 : 0;
  const row = new Uint8Array(w * px), parts: Uint8Array[] = [head];
  for (let y = h - 1; y >= 0; y--) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * c;
      if (gray) row[x] = d[p];
      else { row[x * px] = d[p + 2]; row[x * px + 1] = d[p + 1]; row[x * px + 2] = d[p]; if (alpha) row[x * px + 3] = d[p + 3]; }
    }
    parts.push(rle ? rleRow(row, w, px) : row.slice());
  }
  const foot = new Uint8Array(26);
  foot.set(new TextEncoder().encode('TRUEVISION-XFILE.'), 8);
  parts.push(foot);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Targa RLE packets of at most 128 pixels: 0x80 | (n - 1) then one pixel, or n - 1 then n raw pixels.
function rleRow(row: Uint8Array, w: number, px: number): Uint8Array {
  const out: number[] = [];
  const same = (a: number, b: number) => { for (let k = 0; k < px; k++) if (row[a * px + k] !== row[b * px + k]) return false; return true; };
  for (let x = 0; x < w;) {
    let run = 1;
    while (x + run < w && run < 128 && same(x, x + run)) run++;
    if (run > 1) { out.push(0x80 | (run - 1)); for (let k = 0; k < px; k++) out.push(row[x * px + k]); x += run; continue; }
    let n = 1;
    while (x + n < w && n < 128 && !(x + n + 1 < w && same(x + n, x + n + 1))) n++;
    out.push(n - 1);
    for (let i = 0; i < n * px; i++) out.push(row[x * px + i]);
    x += n;
  }
  return Uint8Array.from(out);
}
