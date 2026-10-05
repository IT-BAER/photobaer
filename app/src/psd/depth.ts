// What ag-psd's RGB/8-bit writer cannot do, as a pass over its output: Grayscale, 16 and 32 bits per
// channel (layers in an Lr16/Lr32 block, as Photoshop writes them), and alpha and spot channels in the
// composite (names in 1006/1045/1053 through ag-psd, display info 1077 here). Also reads those channels.
import { concat, psdResources, psdWithResource, view } from '../app/iccFiles.ts';
import { hsbToRgb, labToRgb } from '../shell/color.ts';

export type Depth = 8 | 16 | 32;
export type Rgb = [number, number, number];

/** A saved channel in PSD terms: `plane` is width x height big-endian samples at the file depth. */
export interface PsdChannel {
  name: string;
  /** 0 Selected Areas (black = selected), 1 Masked Areas (white = selected), 2 spot. */
  kind: 0 | 1 | 2;
  color: Rgb;
  /** Overlay opacity, or the spot solidity, 0..100. */
  opacity: number;
  plane: Uint8Array;
}

export interface Finish {
  psb: boolean; depth: Depth; gray: boolean; width: number; height: number;
  /** Composite planes (gray, or red, green, blue), big-endian samples at `depth`. */
  color: Uint8Array[];
  /** The composite transparency plane; written when it holds a sample below opaque. */
  alpha: Uint8Array;
  extras: PsdChannel[];
  /** The Duotone color mode data: the file is written in mode 8 with the gray channel. */
  duotone?: Uint8Array;
}

const bytesOf = (d: Depth) => d / 8;
const LAYER_GREEN = 1, LAYER_BLUE = 2;

// One length field of a section or block: 4 bytes, or 8 in PSB where `big` applies.
function readLen(v: DataView, o: number, big: boolean) {
  return big ? Number(v.getBigUint64(o)) : v.getUint32(o);
}
function lenBytes(n: number, big: boolean) {
  const out = new Uint8Array(big ? 8 : 4);
  if (big) view(out).setBigUint64(0, BigInt(n)); else view(out).setUint32(0, n);
  return out;
}
const pad4 = (b: Uint8Array) => (b.length % 4 ? concat([b, new Uint8Array(4 - (b.length % 4))]) : b);

// File offsets of the PSD sections.
function sections(b: Uint8Array) {
  const v = view(b), psb = v.getUint16(4) === 2;
  if (b.length < 26 || v.getUint32(0) !== 0x38425053) throw new Error('not a PSD file');
  const res = 26 + 4 + v.getUint32(26);
  const lm = res + 4 + v.getUint32(res);
  const lmData = lm + (psb ? 8 : 4);
  const image = lmData + readLen(v, lm, psb);
  if (image > b.length) throw new Error('PSD file is truncated');
  return { v, psb, res, lm, lmData, image };
}

// The layer info of a layer-and-mask section: records split into parts, plus each record's channel data.
interface Rec { head: Uint8Array; channels: { id: number; data: Uint8Array }[]; tail: Uint8Array }
function readLayerInfo(b: Uint8Array, v: DataView, at: number, end: number, psb: boolean): { count: number; recs: Rec[] } {
  const L = psb ? 8 : 4;
  const count = v.getInt16(at);
  let p = at + 2;
  const recs: (Rec & { lens: number[] })[] = [];
  for (let i = 0; i < Math.abs(count); i++) {
    const head = b.subarray(p, p + 16);
    const n = v.getUint16(p + 16);
    p += 18;
    const ids: number[] = [], lens: number[] = [];
    for (let c = 0; c < n; c++, p += 2 + L) { ids.push(v.getInt16(p)); lens.push(readLen(v, p + 2, psb)); }
    const t0 = p;
    p += 12;
    p += 4 + v.getUint32(p);
    if (p > end) throw new Error('PSD layer records are truncated');
    recs.push({ head, channels: ids.map(id => ({ id, data: new Uint8Array(0) })), tail: b.subarray(t0, p), lens });
  }
  for (const r of recs) {
    r.channels.forEach((c, i) => { c.data = b.subarray(p, p + r.lens[i]); p += r.lens[i]; });
  }
  if (p > end) throw new Error('PSD channel data is truncated');
  return { count, recs };
}

function writeLayerInfo(count: number, recs: Rec[], psb: boolean): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array(2)];
  view(parts[0]).setInt16(0, count);
  for (const r of recs) {
    const n = new Uint8Array(2);
    view(n).setUint16(0, r.channels.length);
    parts.push(r.head, n);
    for (const c of r.channels) {
      const id = new Uint8Array(2);
      view(id).setInt16(0, c.id);
      parts.push(id, lenBytes(c.data.length, psb));
    }
    parts.push(r.tail);
  }
  for (const r of recs) for (const c of r.channels) parts.push(c.data);
  return pad4(concat(parts));
}

/** PackBits rows of one plane, as PSD RLE: the per-row byte counts and the data. */
function packRows(plane: Uint8Array, w: number, h: number): { counts: number[]; data: Uint8Array[] } {
  const counts: number[] = [], data: Uint8Array[] = [];
  const out = new Uint8Array(w + Math.ceil(w / 128) + 2);
  for (let y = 0; y < h; y++) {
    const row = plane.subarray(y * w, y * w + w);
    let o = 0, i = 0;
    while (i < w) {
      let run = 1;
      while (i + run < w && run < 128 && row[i + run] === row[i]) run++;
      if (run >= 2) {
        out[o++] = 257 - run;
        out[o++] = row[i];
        i += run;
        continue;
      }
      let lit = 1;
      while (i + lit < w && lit < 128 && !(i + lit + 1 < w && row[i + lit] === row[i + lit + 1])) lit++;
      out[o++] = lit - 1;
      out.set(row.subarray(i, i + lit), o);
      o += lit;
      i += lit;
    }
    counts.push(o);
    data.push(out.slice(0, o));
  }
  return { counts, data };
}

/** The composite image data section: RLE at 8 bits, raw at 16 and 32 (as Photoshop writes them). */
function compositeSection(planes: Uint8Array[], depth: Depth, w: number, h: number, psb: boolean): Uint8Array {
  const comp = new Uint8Array(2);
  if (depth !== 8) return concat([comp, ...planes]);
  view(comp).setUint16(0, 1);
  const rows = planes.map(p => packRows(p, w, h));
  const table = new Uint8Array(planes.length * h * (psb ? 4 : 2));
  const tv = view(table);
  let k = 0;
  for (const r of rows) for (const n of r.counts) { if (psb) tv.setUint32(k * 4, n); else tv.setUint16(k * 2, n); k++; }
  return concat([comp, table, ...rows.flatMap(r => r.data)]);
}

// Resource 1077 (DisplayInfo): version 1, then per channel color space, four 16-bit components,
// opacity 0..100 and kind.
function displayInfo(extras: PsdChannel[]): Uint8Array {
  const out = new Uint8Array(4 + extras.length * 13);
  const v = view(out);
  v.setUint32(0, 1);
  extras.forEach((c, i) => {
    const o = 4 + i * 13;
    c.color.forEach((x, j) => v.setUint16(o + 2 + j * 2, Math.round(x) * 257));
    v.setUint16(o + 10, Math.round(c.opacity));
    out[o + 12] = c.kind;
  });
  return out;
}

// Whether every sample of a big-endian plane is fully opaque.
function opaque(p: Uint8Array, depth: Depth): boolean {
  const v = view(p), s = bytesOf(depth);
  for (let i = 0; i < p.length; i += s) if (depth === 8 ? p[i] !== 255 : depth === 16 ? v.getUint16(i) !== 65535 : v.getFloat32(i) < 1) return false;
  return true;
}

/** Photoshop's limit on color, transparency, alpha and spot channels together. */
export const PSD_MAX_CHANNELS = 56;

/** Whether the PSD of composite `rgba8` (as ag-psd sees it) and file-depth `alpha` gets a transparency channel. */
export function psdTransparency(rgba8: Uint8Array, alpha: Uint8Array, depth: Depth): boolean {
  for (let i = 3; i < rgba8.length; i += 4) if (rgba8[i] !== 255) return true;
  return depth !== 8 && !opaque(alpha, depth);
}

/** Turns ag-psd's RGB/8-bit `b` into the file `f` describes. */
export function finishPsd(b: Uint8Array, f: Finish): Uint8Array {
  const { v, psb, lm, lmData, image } = sections(b);
  // ag-psd decides on the 8-bit composite, where alpha from about 0.998 rounds to opaque.
  const transparency = v.getUint16(12) === 4 || (f.depth !== 8 && !opaque(f.alpha, f.depth));
  const header = b.slice(0, 26);
  const hv = view(header);
  hv.setUint16(12, f.color.length + (transparency ? 1 : 0) + f.extras.length);
  hv.setUint16(22, f.depth);
  hv.setUint16(24, f.duotone ? 8 : f.gray ? 1 : 3);
  const modeData = f.duotone ? concat([lenBytes(f.duotone.length, false), f.duotone, b.subarray(30 + v.getUint32(26), lm)]) : b.subarray(26, lm);

  let layerMask = b.subarray(lm, image);
  if (f.gray || f.depth !== 8) {
    const liLen = readLen(v, lmData, psb);
    const liAt = lmData + (psb ? 8 : 4), liEnd = liAt + liLen;
    let info = b.subarray(liAt, liEnd);
    if (liLen) {
      const { count, recs } = readLayerInfo(b, v, liAt, liEnd, psb);
      if (f.gray) for (const r of recs) r.channels = r.channels.filter(c => c.id !== LAYER_GREEN && c.id !== LAYER_BLUE);
      // A negative count says the first extra composite channel is the merged transparency.
      info = writeLayerInfo(transparency ? -Math.abs(count) : count, recs, psb);
    }
    const rest = b.subarray(liEnd, image);
    const parts: Uint8Array[] = [];
    if (f.depth === 8) {
      parts.push(lenBytes(info.length, psb), info, rest);
    } else {
      // Photoshop's high-depth layout: an empty layer info, the layers in an Lr16/Lr32 block first.
      const key = f.depth === 16 ? 'Lr16' : 'Lr32';
      const gm = rest.subarray(0, 4 + view(rest).getUint32(0));
      const block = concat([new TextEncoder().encode(`8BIM${key}`), lenBytes(info.length, psb), info]);
      parts.push(lenBytes(0, psb), gm, block, rest.subarray(gm.length));
    }
    const body = concat(parts);
    layerMask = concat([lenBytes(body.length, psb), body]);
  }

  const planes = [...f.color, ...(transparency ? [f.alpha] : []), ...f.extras.map(c => c.plane)];
  const n = f.width * f.height * bytesOf(f.depth);
  if (planes.some(p => p.length !== n)) throw new Error('composite planes do not match the document size');
  const out = concat([header, modeData, layerMask, compositeSection(planes, f.depth, f.width, f.height, psb)]);
  return f.extras.length ? psdWithResource(out, 1077, displayInfo(f.extras)) : out;
}

// One PackBits row from `p`: its decoded byte count.
function rowSize(b: Uint8Array, p: number, end: number): number {
  let n = 0;
  while (p < end) {
    const k = (b[p++] << 24) >> 24;
    if (k >= 0) { n += k + 1; p += k + 1; } else if (k !== -128) { n += 1 - k; p++; }
  }
  return n;
}

/** Whether the composite image data fits the header: `truncated` when the file ends inside it, `depth`
 * when its RLE rows do not hold the header's sample size (zip data is not checked). */
export function compositeFit(b: Uint8Array): 'ok' | 'truncated' | 'depth' {
  const { v, psb, image } = sections(b);
  const total = v.getUint16(12), h = v.getUint32(14), w = v.getUint32(18), depth = v.getUint16(22);
  if (image + 2 > b.length) return 'truncated';
  const comp = v.getUint16(image), p = image + 2, row = Math.ceil(w * depth / 8);
  if (comp === 0) return p + total * row * h > b.length ? 'truncated' : 'ok';
  if (comp !== 1) return 'ok';
  const cw = psb ? 4 : 2;
  let at = p + total * h * cw;
  if (at > b.length) return 'truncated';
  for (let i = 0; i < total * h; i++) {
    const n = psb ? v.getUint32(p + i * 4) : v.getUint16(p + i * 2);
    if (at + n > b.length) return 'truncated';
    if (i < h && rowSize(b, at, at + n) !== row) return 'depth';
    at += n;
  }
  return 'ok';
}

/** `b` cut to its first 16 composite channels, the most ag-psd reads; `readPsdChannels` reads the rest
 * from the full file. Unchanged when it has 16 or fewer. */
export function psdForAgPsd(b: Uint8Array): Uint8Array {
  // ag-psd refuses Duotone; the gray channel reads as Grayscale and readDuotone reads the inks.
  if (view(b).getUint16(24) === 8) {
    b = b.slice();
    view(b).setUint16(24, 1);
  }
  const { v, psb, image } = sections(b);
  const total = v.getUint16(12), keep = 16;
  if (total <= keep) return b;
  const h = v.getUint32(14), w = v.getUint32(18), depth = v.getUint16(22);
  const comp = image + 2 <= b.length ? v.getUint16(image) : -1, p = image + 2;
  let parts = [b.subarray(0, b.length)];
  if (comp === 0) parts = [b.subarray(0, p + keep * Math.ceil(w * depth / 8) * h)];
  else if (comp === 1) {
    const cw = psb ? 4 : 2, data = p + total * h * cw;
    let n = 0;
    for (let i = 0; i < keep * h && p + (i + 1) * cw <= b.length; i++) n += psb ? v.getUint32(p + i * cw) : v.getUint16(p + i * cw);
    parts = [b.subarray(0, p + keep * h * cw), b.subarray(data, data + n)];
  }
  const out = concat(parts);
  view(out).setUint16(12, keep);
  return out;
}

// Decoded planes of the composite image data, or null for a compression this reader does not know.
function compositePlanes(b: Uint8Array, at: number, count: number, w: number, h: number, depth: Depth, psb: boolean): Uint8Array[] | null {
  const v = view(b);
  const comp = v.getUint16(at);
  const size = w * h * bytesOf(depth);
  let p = at + 2;
  if (comp === 0) {
    return Array.from({ length: count }, (_, i) => b.subarray(p + i * size, p + (i + 1) * size));
  }
  if (comp !== 1 || depth !== 8) return null;
  const cw = psb ? 4 : 2;
  const counts = Array.from({ length: count * h }, (_, i) => (psb ? v.getUint32(p + i * 4) : v.getUint16(p + i * 2)));
  p += count * h * cw;
  const planes: Uint8Array[] = [];
  for (let c = 0; c < count; c++) {
    const out = new Uint8Array(size);
    for (let y = 0; y < h; y++) {
      const end = p + counts[c * h + y];
      let o = y * w;
      const stop = o + w;
      while (p < end && o < stop) {
        const k = v.getInt8(p++);
        if (k >= 0) { out.set(b.subarray(p, p + Math.min(k + 1, stop - o)), o); o += k + 1; p += k + 1; }
        else if (k !== -128) { out.fill(b[p++], o, Math.min(stop, o + 1 - k)); o += 1 - k; }
      }
      p = end;
    }
    planes.push(out);
  }
  return planes;
}

// A 1077 color as RGB: color space 0 RGB, 1 HSB, 2 CMYK, 7 Lab, 8 Gray; null for other spaces (color books).
function displayColor(v: DataView, o: number): Rgb | null {
  const c = [0, 1, 2, 3].map(i => v.getUint16(o + 2 + i * 2));
  switch (v.getUint16(o)) {
    case 0: return [c[0] >> 8, c[1] >> 8, c[2] >> 8];
    case 1: {
      const [hh, s, b] = [c[0] / 65535 * 6, c[1] / 65535, c[2] / 65535];
      const f = (n: number) => { const k = (n + hh) % 6; return b - b * s * Math.max(0, Math.min(1, k, 4 - k)); };
      return [f(5), f(3), f(1)].map(x => Math.round(x * 255)) as Rgb;
    }
    case 2: return [0, 1, 2].map(i => Math.round((c[i] / 65535) * (c[3] / 65535) * 255)) as Rgb;
    case 7: {
      const L = c[0] / 100, a = (c[1] << 16 >> 16) / 100, bb = (c[2] << 16 >> 16) / 100;
      const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - bb / 200;
      const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
      const [x, y, z] = [0.9642 * inv(fx), inv(fy), 0.8249 * inv(fz)];
      const lin = [3.1339 * x - 1.6169 * y - 0.4906 * z, -0.9788 * x + 1.9161 * y + 0.0335 * z, 0.0719 * x - 0.2290 * y + 1.4052 * z];
      return lin.map(u => Math.round(255 * Math.min(1, Math.max(0, u <= 0.0031308 ? 12.92 * u : 1.055 * u ** (1 / 2.4) - 0.055)))) as Rgb;
    }
    case 8: { const g = Math.round(255 - (c[0] / 10000) * 255); return [g, g, g]; }
    default: return null;
  }
}

/** The layer count of a PSD, from its layer info or its Lr16/Lr32 block; negative when the first
 * extra composite channel is the merged transparency. */
export function psdLayerCount(b: Uint8Array): number {
  const { v, psb, lmData, image } = sections(b);
  const L = psb ? 8 : 4;
  // An empty layer and mask section has no layer info length either.
  if (image - lmData < L) return 0;
  if (readLen(v, lmData, psb)) return v.getInt16(lmData + L);
  let p = lmData + L;
  p += 4 + v.getUint32(p);
  while (p + 12 <= image) {
    const key = String.fromCharCode(...b.subarray(p + 4, p + 8));
    const big = psb && ['Lr16', 'Lr32', 'LMsk', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD'].includes(key);
    const n = readLen(v, p + 8, big), d = p + 8 + (big ? 8 : 4);
    if (key === 'Lr16' || key === 'Lr32') return v.getInt16(d);
    p = d + n + (n & 1);
  }
  return 0;
}

/** The alpha and spot channels of a Gray or RGB PSD's composite, with what the file says about them. */
export function readPsdChannels(b: Uint8Array): { channels: PsdChannel[]; depth: Depth; width: number; height: number; warnings: string[] } {
  const { v, psb, image } = sections(b);
  const total = v.getUint16(12), height = v.getUint32(14), width = v.getUint32(18);
  const depth = v.getUint16(22) as Depth, mode = v.getUint16(24);
  const warnings: string[] = [];
  const none = { channels: [], depth, width, height, warnings };
  const colors = mode === 1 || mode === 8 ? 1 : mode === 3 ? 3 : mode === 4 ? 4 : 0;
  if (!colors || ![8, 16, 32].includes(depth)) return none;
  const extras = total - colors - (psdLayerCount(b) < 0 ? 1 : 0);
  if (extras <= 0) return none;
  const res = new Map<number, [number, number]>();
  for (const [id, , , d, n] of psdResources(b)) res.set(id, [d, n]);
  // Name lists that also name the transparency (older Photoshop) line up from the end.
  const names: string[] = [];
  const uni = res.get(1045), pas = res.get(1006);
  if (uni) {
    for (let p = uni[0]; p + 4 <= uni[0] + uni[1];) {
      const n = v.getUint32(p);
      p += 4;
      names.push(String.fromCharCode(...Array.from({ length: n }, (_, i) => v.getUint16(p + i * 2))).replace(/\0$/, ''));
      p += n * 2;
    }
  } else if (pas) {
    for (let p = pas[0]; p < pas[0] + pas[1];) { const n = b[p]; names.push(new TextDecoder('latin1').decode(b.subarray(p + 1, p + 1 + n))); p += 1 + n; }
  }
  const info: { kind: 0 | 1 | 2; color: Rgb; opacity: number }[] = [];
  const di = res.get(1077);
  if (di && v.getUint32(di[0]) === 1) {
    for (let o = di[0] + 4; o + 13 <= di[0] + di[1]; o += 13) {
      const kind = b[o + 12] as 0 | 1 | 2;
      const color = displayColor(v, o);
      if (!color) warnings.push('spot and alpha channel colors from color books were imported as black');
      info.push({ kind: kind <= 2 ? kind : 1, color: color ?? [0, 0, 0], opacity: Math.min(100, v.getUint16(o + 10)) });
    }
  }
  if (compositeFit(b) !== 'ok') return { ...none, warnings: ['the composite image data is incomplete: alpha and spot channels were not imported'] };
  const planes = compositePlanes(b, image, total, width, height, depth, psb);
  if (!planes) return { ...none, warnings: ['alpha and spot channels with an unknown compression were not imported'] };
  const tail = <T,>(list: T[], i: number) => list[list.length - extras + i];
  const channels = planes.slice(total - extras).map((plane, i) => ({
    name: tail(names, i) ?? `Alpha ${i + 1}`, ...(tail(info, i) ?? { kind: 1 as const, color: [255, 0, 0] as Rgb, opacity: 50 }), plane,
  }));
  return { channels, depth, width, height, warnings: [...new Set(warnings)] };
}

// ---------- Duotone ----------

/** Image > Mode > Duotone in PSD terms: 1 to 4 inks, curves (output % at the 13 inputs, null unset), overprints in engine order. */
export interface DuotoneSpec { inks: Rgb[]; curves?: (number | null)[][]; overprints?: Rgb[] }

// The color mode data (undocumented, as Photoshop writes it): version, ink count, 4 colors, 4 names
// (64 bytes), 4 curves (13 values in 0.1 %, -1 unset, then a flag), dot gain, 11 overprint colors.
const DUO_SIZE = 524, DUO_COLORS = 4, DUO_NAMES = 44, DUO_CURVES = 300, DUO_DOT_GAIN = 412, DUO_OVERPRINTS = 414;
// Overprint slots as ink bit masks: 1+2, 1+3, 2+3, 1+2+3, 1+4, 2+4, 3+4, 1+2+4, 1+3+4, 2+3+4, 1+2+3+4.
const OVERPRINT_SLOTS = [3, 5, 6, 7, 9, 10, 12, 11, 13, 14, 15];
const inkBits = (m: number) => [0, 1, 2, 3].filter(i => (m >> i) & 1);
// The engine's overprint order: by ink count, then by inks (color_mode.rs overprint_sets).
const overprintMasks = (n: number) => Array.from({ length: 1 << n }, (_, m) => m).filter(m => inkBits(m).length >= 2)
  .sort((a, b) => inkBits(a).length - inkBits(b).length || inkBits(a).join('').localeCompare(inkBits(b).join('')));

// A 10-byte color structure as sRGB; null when unset or in a color book, whose values are only the book code.
function structColor(v: DataView, o: number): Rgb | null {
  const c = [1, 2, 3, 4].map(i => v.getUint16(o + i * 2));
  switch (v.getInt16(o)) {
    case 0: return [Math.round(c[0] / 257), Math.round(c[1] / 257), Math.round(c[2] / 257)];
    case 1: return hsbToRgb([c[0] / 65535 * 360, c[1] / 65535 * 100, c[2] / 65535 * 100]);
    // CMYK values are inverted: 65535 is no ink.
    case 2: return [0, 1, 2].map(i => Math.round(255 * c[i] / 65535 * c[3] / 65535)) as Rgb;
    case 7: return labToRgb([c[0] / 100, v.getInt16(o + 4) / 100, v.getInt16(o + 6) / 100]);
    default: return null;
  }
}

/** The Duotone inks of a mode 8 PSD; null for other modes or data this reader does not know. Ink colors come
 * from the Lab alternates (resource 1066) when present, as Photoshop displays them. */
export function readDuotone(b: Uint8Array, warn: (m: string) => void): DuotoneSpec | null {
  const v = view(b);
  if (b.length < 30 || v.getUint16(24) !== 8) return null;
  const count = v.getUint16(32);
  if (v.getUint32(26) < DUO_SIZE || v.getUint16(30) !== 1 || count < 1 || count > 4) {
    warn('the Duotone inks could not be read; the file opened in Grayscale');
    return null;
  }
  const d = 30, alt: (Rgb | null)[] = [];
  for (const [id, , , p, n] of psdResources(b)) {
    if (id !== 1066 || n < 4 || v.getUint16(p) !== 1) continue;
    for (let i = 0; i < v.getUint16(p + 2) && 4 + i * 10 + 10 <= n; i++) alt.push(structColor(v, p + 4 + i * 10));
  }
  const inks = Array.from({ length: count }, (_, i) => {
    const c = alt[i] ?? structColor(v, d + DUO_COLORS + i * 10);
    if (!c) warn('Duotone inks without a color were opened as black');
    return c ?? [0, 0, 0] as Rgb;
  });
  const curves = inks.map((_, i) => Array.from({ length: 13 }, (_, k) => {
    const x = v.getInt16(d + DUO_CURVES + i * 28 + k * 2);
    return x >= 0 && x <= 1000 ? x / 10 : null;
  }));
  const slot = new Map(OVERPRINT_SLOTS.map((m, j) => [m, structColor(v, d + DUO_OVERPRINTS + j * 10)]));
  const masks = overprintMasks(count);
  // Unset overprints multiply the inks, as the engine does without any.
  const overprints = masks.some(m => slot.get(m)) ? masks.map(m => slot.get(m)
    ?? [0, 1, 2].map(k => Math.round(inkBits(m).reduce((p, i) => p * inks[i][k] / 255, 255))) as Rgb) : undefined;
  return { inks, curves, ...(overprints ? { overprints } : {}) };
}

/** The color mode data of a Duotone PSD: RGB ink colors named Ink 1 to Ink 4, unset end points at 0 and 100 %. */
export function duotoneData(spec: DuotoneSpec): Uint8Array {
  const out = new Uint8Array(DUO_SIZE), v = view(out), n = spec.inks.length;
  const color = (o: number, c: Rgb | undefined) => {
    if (!c) { v.setInt16(o, -1); return; }
    c.forEach((x, k) => v.setUint16(o + 2 + k * 2, x * 257));
  };
  v.setUint16(0, 1);
  v.setUint16(2, n);
  for (let i = 0; i < 4; i++) {
    color(DUO_COLORS + i * 10, spec.inks[i]);
    if (i < n) out.set([5, ...new TextEncoder().encode(`Ink ${i + 1}`)], DUO_NAMES + i * 64);
    const c = spec.curves?.[i];
    for (let k = 0; k < 13; k++) {
      const x = c?.[k] ?? (k === 0 ? 0 : k === 12 ? 100 : null);
      v.setInt16(DUO_CURVES + i * 28 + k * 2, x === null ? -1 : Math.round(x * 10));
    }
  }
  v.setUint16(DUO_DOT_GAIN, 20);
  const masks = overprintMasks(n);
  OVERPRINT_SLOTS.forEach((m, j) => color(DUO_OVERPRINTS + j * 10, spec.overprints?.[masks.indexOf(m)]));
  return out;
}
