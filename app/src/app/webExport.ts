// File > Export encoders the browser canvas lacks: palette quantization, GIF, PNG-8, a JPEG-page PDF and saved
// paths as SVG. Pure functions over RGBA8, so Node tests can decode their output.
import { pathData } from './svgcss.ts';
import type { VectorPath } from '../worker/types.ts';

export type Dither = 'none' | 'diffusion' | 'pattern';
export interface Indexed { palette: Uint8Array; index: Uint8Array; transparent: number }

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** At most `colors` entries (one is the transparent entry when `transparency` and any pixel has alpha < 128).
 * Without transparency, pixels are flattened onto white. Median cut on the exact color histogram. */
export function quantize(rgba: Uint8ClampedArray, w: number, colors: number, dither: Dither, transparency: boolean): Indexed {
  const n = rgba.length / 4;
  const rgb = new Float32Array(n * 3), clear = new Uint8Array(n);
  const hist = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    if (transparency && a < 0.5) { clear[i] = 1; continue; }
    const k = transparency ? 1 : a;
    let key = 0;
    for (let c = 0; c < 3; c++) key = key << 8 | (rgb[i * 3 + c] = Math.round(rgba[i * 4 + c] * k + 255 * (1 - k)));
    hist.set(key, (hist.get(key) ?? 0) + 1);
  }
  const hasClear = clear.includes(1);
  const max = Math.max(1, Math.min(256, colors) - (hasClear ? 1 : 0));
  const entries = [...hist].map(([k, w]) => ({ c: [k >> 16 & 255, k >> 8 & 255, k & 255], w }));
  const exact = entries.length <= max;
  const pal = exact ? entries.map(e => e.c) : medianCut(entries, max);
  const palette = new Uint8Array((pal.length + (hasClear ? 1 : 0)) * 3);
  pal.forEach((c, i) => palette.set(c, i * 3));
  const transparent = hasClear ? pal.length : -1;
  const index = new Uint8Array(n);
  const cache = new Map<number, number>();
  const nearest = (r: number, g: number, b: number) => {
    r = Math.max(0, Math.min(255, Math.round(r))); g = Math.max(0, Math.min(255, Math.round(g))); b = Math.max(0, Math.min(255, Math.round(b)));
    const key = r << 16 | g << 8 | b;
    let best = cache.get(key);
    if (best !== undefined) return best;
    let d = Infinity;
    for (let i = 0; i < pal.length; i++) {
      const e = (pal[i][0] - r) ** 2 + (pal[i][1] - g) ** 2 + (pal[i][2] - b) ** 2;
      if (e < d) { d = e; best = i; }
    }
    cache.set(key, best!);
    return best!;
  };
  for (let i = 0; i < n; i++) {
    if (clear[i]) { index[i] = transparent; continue; }
    let r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    if (!exact && dither === 'pattern') {
      const t = (BAYER[(Math.floor(i / w) & 3) * 4 + (i % w & 3)] / 16 - 0.5) * 48;
      r += t; g += t; b += t;
    }
    const p = index[i] = nearest(r, g, b);
    if (exact || dither !== 'diffusion') continue;
    const x = i % w;
    for (let c = 0; c < 3; c++) {
      const err = rgb[i * 3 + c] - pal[p][c];
      if (x + 1 < w) rgb[(i + 1) * 3 + c] += err * 7 / 16;
      if (i + w < n) {
        if (x > 0) rgb[(i + w - 1) * 3 + c] += err * 3 / 16;
        rgb[(i + w) * 3 + c] += err * 5 / 16;
        if (x + 1 < w) rgb[(i + w + 1) * 3 + c] += err / 16;
      }
    }
  }
  return { palette, index, transparent };
}

function medianCut(entries: { c: number[]; w: number }[], max: number): number[][] {
  const boxes = [entries];
  const range = (b: typeof entries, c: number) => b.reduce((m, e) => Math.max(m, e.c[c]), 0) - b.reduce((m, e) => Math.min(m, e.c[c]), 255);
  while (boxes.length < max) {
    let pick = -1, wide = 0, axis = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let c = 0; c < 3; c++) { const r = range(b, c); if (r > wide) { wide = r; pick = i; axis = c; } }
    });
    if (pick < 0) break;
    const b = boxes[pick].sort((p, q) => p.c[axis] - q.c[axis]);
    const total = b.reduce((s, e) => s + e.w, 0);
    let acc = 0, cut = 1;
    for (; cut < b.length - 1; cut++) if ((acc += b[cut - 1].w) >= total / 2) break;
    boxes.splice(pick, 1, b.slice(0, cut), b.slice(cut));
  }
  return boxes.map(b => {
    const s = b.reduce((m, e) => m + e.w, 0);
    return [0, 1, 2].map(c => Math.round(b.reduce((m, e) => m + e.c[c] * e.w, 0) / s));
  });
}

/** GIF89a, one frame, global color table, binary transparency. */
export function encodeGif(q: Indexed, w: number, h: number): Uint8Array<ArrayBuffer> {
  if (w > 65535 || h > 65535) throw new Error('GIF images are at most 65535 pixels wide and high.');
  const count = q.palette.length / 3;
  let bits = 1;
  while (1 << bits < count) bits++;
  const out: number[] = [...new TextEncoder().encode('GIF89a'), w & 255, w >> 8, h & 255, h >> 8, 0xf0 | (bits - 1), 0, 0];
  const table = new Uint8Array(3 << bits);
  table.set(q.palette);
  out.push(...table);
  if (q.transparent >= 0) out.push(0x21, 0xf9, 4, 1, 0, 0, q.transparent, 0);
  out.push(0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0);
  const min = Math.max(2, bits);
  out.push(min);
  const data = lzw(q.index, min);
  for (let p = 0; p < data.length; p += 255) out.push(Math.min(255, data.length - p), ...data.subarray(p, p + 255));
  out.push(0, 0x3b);
  return Uint8Array.from(out);
}

function lzw(index: Uint8Array, min: number): Uint8Array {
  const clear = 1 << min, eoi = clear + 1, out: number[] = [];
  let acc = 0, nbits = 0, width = min + 1, next = eoi + 1, dict = new Map<number, number>();
  const emit = (c: number) => {
    acc |= c << nbits;
    nbits += width;
    while (nbits >= 8) { out.push(acc & 255); acc >>>= 8; nbits -= 8; }
  };
  emit(clear);
  let prefix = index[0] ?? 0;
  for (let i = 1; i < index.length; i++) {
    const k = index[i], key = prefix << 8 | k, hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      dict = new Map(); width = min + 1; next = eoi + 1;
    } else {
      if (next >= 1 << width) width++;
      dict.set(key, next++);
    }
    prefix = k;
  }
  if (index.length) emit(prefix);
  emit(eoi);
  if (nbits) out.push(acc & 255);
  return Uint8Array.from(out);
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0; });
const crc32 = (b: Uint8Array) => { let c = ~0; for (const x of b) c = CRC[(c ^ x) & 255] ^ c >>> 8; return ~c >>> 0; };

/** 8-bit palette PNG; the transparent entry gets alpha 0 in tRNS. */
export async function encodePng8(q: Indexed, w: number, h: number): Promise<Uint8Array<ArrayBuffer>> {
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) raw.set(q.index.subarray(y * w, y * w + w), y * (w + 1) + 1);
  const extra: [string, Uint8Array][] = [['PLTE', q.palette]];
  if (q.transparent >= 0) extra.push(['tRNS', Uint8Array.from({ length: q.transparent + 1 }, (_, i) => (i === q.transparent ? 0 : 255))]);
  return pngFile(w, h, 3, raw, extra);
}

/** An 8-bit Grayscale PNG of straight RGBA (gray from red): with alpha (color type 4) only when needed. */
export async function encodeGrayPng(rgba: Uint8ClampedArray, w: number, h: number): Promise<Uint8Array<ArrayBuffer>> {
  let alpha = false;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { alpha = true; break; }
  const n = alpha ? 2 : 1, raw = new Uint8Array((w * n + 1) * h);
  for (let y = 0, o = 0; y < h; y++) {
    o++;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      raw[o++] = rgba[i];
      if (alpha) raw[o++] = rgba[i + 3];
    }
  }
  return pngFile(w, h, alpha ? 4 : 0, raw, []);
}

// An 8-bit PNG of filter-0 rows `raw`, with `extra` chunks before the image data.
async function pngFile(w: number, h: number, colorType: number, raw: Uint8Array, extra: [string, Uint8Array][]): Promise<Uint8Array<ArrayBuffer>> {
  const idat = new Uint8Array(await new Response(new Blob([raw as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr.set([8, colorType, 0, 0, 0], 8);
  const chunks: [string, Uint8Array][] = [['IHDR', ihdr], ...extra, ['IDAT', idat], ['IEND', new Uint8Array()]];
  const parts: Uint8Array[] = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)];
  for (const [type, data] of chunks) {
    const c = new Uint8Array(12 + data.length), v = new DataView(c.buffer);
    v.setUint32(0, data.length);
    c.set(new TextEncoder().encode(type), 4);
    c.set(data, 8);
    v.setUint32(8 + data.length, crc32(c.subarray(4, 8 + data.length)));
    parts.push(c);
  }
  return new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
}

export interface PdfPage { jpeg: Uint8Array; width: number; height: number; ptW: number; ptH: number }

/** One page per JPEG, the image filling a ptW x ptH page (points). */
export function makePdf(pages: PdfPage[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder(), parts: Uint8Array[] = [], offsets: number[] = [];
  let size = 0;
  const put = (x: string | Uint8Array) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); size += b.length; };
  const obj = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = size;
    put(`${n} 0 obj\n${body}\n`);
    if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); }
    put('endobj\n');
  };
  put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  pages.forEach((p, i) => {
    const o = 3 + i * 3, draw = enc.encode(`q ${p.ptW} 0 0 ${p.ptH} 0 0 cm /Im Do Q`);
    obj(o, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.ptW} ${p.ptH}] /Resources << /XObject << /Im ${o + 2} 0 R >> >> /Contents ${o + 1} 0 R >>`);
    obj(o + 1, `<< /Length ${draw.length} >>`, draw);
    obj(o + 2, `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>`, p.jpeg);
  });
  const xref = size, count = 3 + pages.length * 3;
  put(`xref\n0 ${count}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  put(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let p = 0;
  for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** File > Export > Paths to SVG: each saved path as an unfilled black outline named by its id, in document pixels. */
export function pathsSvg(w: number, h: number, paths: { name: string; path: VectorPath }[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n`
    + paths.map(p => `<path id="${esc(p.name)}" d="${pathData(p.path)}" fill="none" stroke="black" fill-rule="${p.path.fill_rule}"/>\n`).join('')
    + '</svg>\n';
}

/** A file name stem without characters file systems refuse, unique (case-insensitive) within `used`. */
export function fileStem(name: string, used: Set<string>): string {
  const base = name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '').trim() || 'Untitled';
  let s = base;
  for (let n = 2; used.has(s.toLowerCase()); n++) s = `${base}-${n}`;
  used.add(s.toLowerCase());
  return s;
}

export interface AssetSpec { file: string; format: 'png' | 'png8' | 'jpeg' | 'webp' | 'gif'; scale: number; quality: number }

/** File > Generate > Image Assets: the assets a layer name asks for, e.g. "200% icon.png, photo.jpg80"
 * (JPEG/WebP quality 1-10 or 11-100 percent, default 90%). */
export function assetSpecs(name: string): AssetSpec[] {
  const out: AssetSpec[] = [];
  for (const part of name.split(',')) {
    const m = /^(?:(\d+(?:\.\d+)?)%\s+)?([^/\\:*?"<>|]+?)\.(png8|png24|png32|png|jpe?g|gif|webp)(\d{1,3})?$/i.exec(part.trim());
    if (!m || (m[1] && !(Number(m[1]) > 0))) continue;
    const ext = m[3].toLowerCase(), q = m[4] ? Number(m[4]) : 0;
    const format = ext === 'png8' ? 'png8' : ext.startsWith('png') ? 'png' : ext.startsWith('jp') ? 'jpeg' : ext as 'gif' | 'webp';
    const lossy = format === 'jpeg' || format === 'webp';
    out.push({
      file: `${m[2]}.${ext.startsWith('png') ? 'png' : ext}`, format, scale: m[1] ? Number(m[1]) / 100 : 1,
      quality: !lossy ? 1 : !q ? 0.9 : Math.min(1, q <= 10 ? q / 10 : q / 100),
    });
  }
  return out;
}
