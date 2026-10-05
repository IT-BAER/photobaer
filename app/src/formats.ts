// OpenEXR, Radiance HDR and ICO codecs. Float images are straight linear RGBA (w x h x 4).
export interface FloatImage { width: number; height: number; data: Float32Array }

// 32-bit documents hold sRGB-encoded floats with values above 1 kept; EXR and HDR hold linear light.
export const toLinear = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
export const fromLinear = (v: number) => v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

async function inflate(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
}
async function deflate(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
}

function halfToFloat(h: number) {
  const e = h >> 10 & 31, m = h & 1023, s = h >> 15 ? -1 : 1;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

// ---------- OpenEXR (scanline and level 0 of tiled, first part; NONE, RLE, ZIPS, ZIP, PXR24, B44, B44A; HALF, FLOAT, UINT) ----------

const EXR_MAGIC = 20000630;
const COMPRESSIONS = ['NONE', 'RLE', 'ZIPS', 'ZIP', 'PIZ', 'PXR24', 'B44', 'B44A', 'DWAA', 'DWAB'];
const SUPPORTED = [0, 1, 2, 3, 5, 6, 7];
const LINES = [1, 1, 1, 16, 32, 16, 32, 32, 32, 256];
type ExrChannel = { name: string; type: number; linear: boolean };
const typeSize = (t: number) => t === 1 ? 2 : 4;

// ZIP and RLE store bytes split into even/odd halves, then as differences.
function unpredict(t: Uint8Array): Uint8Array {
  for (let i = 1; i < t.length; i++) t[i] = (t[i - 1] + t[i] - 128) & 255;
  const out = new Uint8Array(t.length), half = (t.length + 1) >> 1;
  for (let i = 0; i < t.length; i++) out[i] = i & 1 ? t[half + (i >> 1)] : t[i >> 1];
  return out;
}
function predict(b: Uint8Array): Uint8Array {
  const t = new Uint8Array(b.length), half = (b.length + 1) >> 1;
  for (let i = 0; i < b.length; i++) t[i & 1 ? half + (i >> 1) : i >> 1] = b[i];
  for (let i = t.length - 1; i > 0; i--) t[i] = (t[i] - t[i - 1] + 128) & 255;
  return t;
}
function unRle(src: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let i = 0, o = 0;
  while (i < src.length && o < size) {
    const n = src[i] << 24 >> 24;
    i++;
    if (n < 0) { out.set(src.subarray(i, i - n), o); o -= n; i -= n; } else { out.fill(src[i], o, o + n + 1); o += n + 1; i++; }
  }
  if (o !== size) throw new Error('The EXR file is damaged (RLE data too short).');
  return out;
}

// PXR24: per row and channel, byte planes of differences (HALF 16 bits, FLOAT top 24 bits, UINT 32 bits).
function unPxr24(src: Uint8Array, w: number, rows: number, chans: ExrChannel[]): Uint8Array {
  const out = new Uint8Array(rows * w * chans.reduce((a, c) => a + typeSize(c.type), 0)), ov = new DataView(out.buffer);
  let i = 0, o = 0;
  for (let y = 0; y < rows; y++) for (const c of chans) {
    const planes = c.type === 1 ? 2 : c.type === 2 ? 3 : 4;
    if (i + planes * w > src.length) throw new Error('The EXR file is damaged (PXR24 data too short).');
    let pix = 0;
    for (let x = 0; x < w; x++) {
      let d = 0;
      for (let k = 0; k < planes; k++) d = d * 256 + src[i + k * w + x];
      if (c.type === 1) { pix = (pix + d) & 0xffff; ov.setUint16(o, pix, true); o += 2; }
      else { pix = (pix + (c.type === 2 ? d * 256 : d)) >>> 0; ov.setUint32(o, pix, true); o += 4; }
    }
    i += planes * w;
  }
  return out;
}

// B44(A): each HALF channel in 4x4 blocks of 14 bytes (3 bytes for a flat B44A block); other types raw.
function unB44(src: Uint8Array, w: number, rows: number, chans: ExrChannel[]): Uint8Array {
  const short = () => new Error('The EXR file is damaged (B44 data too short).');
  const s = new Uint16Array(16);
  let i = 0;
  const planes = chans.map(c => {
    if (c.type !== 1) {
      const n = w * rows * 4;
      if (i + n > src.length) throw short();
      i += n;
      return src.subarray(i - n, i);
    }
    if (c.linear) throw new Error('B44 EXR channels with pLinear set are not supported.');
    const plane = new Uint8Array(w * rows * 2), pv = new DataView(plane.buffer);
    for (let y = 0; y < rows; y += 4) for (let x = 0; x < w; x += 4) {
      if (i + 3 > src.length) throw short();
      const b = src.subarray(i, i + 14);
      s[0] = b[0] << 8 | b[1];
      if (b[2] >= 13 << 2) { s.fill(s[0]); i += 3; } else {
        if (b.length < 14) throw short();
        const shift = b[2] >> 2, bias = 0x20 << shift, d = (v: number) => ((v & 0x3f) << shift) - bias;
        s[4] = s[0] + d(b[2] << 4 | b[3] >> 4); s[8] = s[4] + d(b[3] << 2 | b[4] >> 6); s[12] = s[8] + d(b[4]);
        s[1] = s[0] + d(b[5] >> 2); s[5] = s[4] + d(b[5] << 4 | b[6] >> 4); s[9] = s[8] + d(b[6] << 2 | b[7] >> 6); s[13] = s[12] + d(b[7]);
        s[2] = s[1] + d(b[8] >> 2); s[6] = s[5] + d(b[8] << 4 | b[9] >> 4); s[10] = s[9] + d(b[9] << 2 | b[10] >> 6); s[14] = s[13] + d(b[10]);
        s[3] = s[2] + d(b[11] >> 2); s[7] = s[6] + d(b[11] << 4 | b[12] >> 4); s[11] = s[10] + d(b[12] << 2 | b[13] >> 6); s[15] = s[14] + d(b[13]);
        i += 14;
      }
      for (let k = 0; k < 16; k++) s[k] = s[k] & 0x8000 ? s[k] & 0x7fff : ~s[k];
      for (let dy = 0; dy < 4 && y + dy < rows; dy++) for (let dx = 0; dx < 4 && x + dx < w; dx++) pv.setUint16(((y + dy) * w + x + dx) * 2, s[dy * 4 + dx], true);
    }
    return plane;
  });
  const out = new Uint8Array(rows * w * chans.reduce((a, c) => a + typeSize(c.type), 0));
  let o = 0;
  for (let y = 0; y < rows; y++) chans.forEach((c, k) => {
    const n = w * typeSize(c.type);
    out.set(planes[k].subarray(y * n, y * n + n), o);
    o += n;
  });
  return out;
}

export async function decodeExr(bytes: Uint8Array): Promise<FloatImage> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || v.getInt32(0, true) !== EXR_MAGIC) throw new Error('This is not an OpenEXR file.');
  const flags = v.getUint32(4, true), multi = !!(flags & 0x1000);
  if (flags & 0x800) throw new Error('Deep OpenEXR files are not supported.');
  let p = 8;
  const str = () => { const e = bytes.indexOf(0, p); if (e < 0) throw new Error('The EXR header is damaged.'); const s = new TextDecoder().decode(bytes.subarray(p, e)); p = e + 1; return s; };
  const header = () => {
    const channels: ExrChannel[] = [];
    let compression = 0, win: number[] | null = null, tiles: number[] | null = null, type = '';
    for (;;) {
      const name = str();
      if (!name) break;
      const atype = str(), size = v.getInt32(p, true);
      p += 4;
      const end = p + size;
      if (end > bytes.length) throw new Error('The EXR header is damaged.');
      if (name === 'channels' && atype === 'chlist') {
        while (bytes[p]) {
          const n = str();
          const t = v.getInt32(p, true), xs = v.getInt32(p + 8, true), ys = v.getInt32(p + 12, true);
          if (xs !== 1 || ys !== 1) throw new Error('Subsampled EXR channels are not supported.');
          channels.push({ name: n, type: t, linear: !!bytes[p + 4] });
          p += 16;
        }
      } else if (name === 'compression') compression = bytes[p];
      else if (name === 'dataWindow') win = [0, 4, 8, 12].map(o => v.getInt32(p + o, true));
      else if (name === 'tiles') tiles = [v.getUint32(p, true), v.getUint32(p + 4, true)];
      else if (name === 'type') type = new TextDecoder().decode(bytes.subarray(p, end));
      p = end;
    }
    return { channels, compression, win, tiles, type };
  };
  // Multi-part: the first part is read; the other headers are skipped up to the empty header.
  const { channels, compression, win, tiles, type } = header();
  if (multi) { while (bytes[p]) header(); p++; }
  if (type.startsWith('deep')) throw new Error('Deep OpenEXR files are not supported.');
  const tiled = multi ? type.startsWith('tiledimage') : !!(flags & 0x200);
  if (!win) throw new Error('The EXR header has no dataWindow.');
  if (tiled && (!tiles || tiles[0] < 1 || tiles[1] < 1)) throw new Error('The tiled EXR header has no tile size.');
  if (!SUPPORTED.includes(compression)) throw new Error(`EXR compression ${COMPRESSIONS[compression] ?? compression} is not supported (use NONE, RLE, ZIPS, ZIP, PXR24, B44 or B44A).`);
  const width = win[2] - win[0] + 1, height = win[3] - win[1] + 1;
  if (width < 1 || height < 1 || width > 300000 || height > 300000) throw new Error('The EXR image size is out of range.');
  const sizes = channels.map(c => typeSize(c.type));
  const pixBytes = sizes.reduce((a, b) => a + b, 0);
  const pick = (n: string) => channels.findIndex(c => c.name === n || c.name.endsWith('.' + n));
  const ix = { r: pick('R'), g: pick('G'), b: pick('B'), a: pick('A'), y: pick('Y') };
  if (ix.r < 0 && ix.y < 0) throw new Error('The EXR file has no R, G, B or Y channel.');
  const data = new Float32Array(width * height * 4);
  // Level 0 comes first in the offset table of ONE_LEVEL, MIPMAP and RIPMAP files; multi-part chunks start with the part number.
  const [tw, th] = tiled ? tiles! : [width, LINES[compression]];
  const chunks = Math.ceil(width / tw) * Math.ceil(height / th), head = (multi ? 4 : 0) + (tiled ? 20 : 8);
  for (let c = 0; c < chunks; c++) {
    const off = Number(v.getBigUint64(p + c * 8, true)) + (multi ? 4 : 0);
    if (off - (multi ? 4 : 0) + head > bytes.length) throw new Error('The EXR file is truncated.');
    let x0 = 0, y0: number, n: number;
    if (tiled) {
      if (v.getInt32(off + 8, true) || v.getInt32(off + 12, true)) throw new Error('The EXR tile table is damaged.');
      x0 = v.getInt32(off, true) * tw; y0 = v.getInt32(off + 4, true) * th; n = v.getInt32(off + 16, true);
    } else { y0 = v.getInt32(off, true) - win[1]; n = v.getInt32(off + 4, true); }
    const w = Math.min(tw, width - x0), rows = Math.min(th, height - y0), raw = rows * w * pixBytes;
    if (x0 < 0 || y0 < 0 || w < 1 || rows < 1) throw new Error('The EXR chunk table is damaged.');
    const start = off + (tiled ? 20 : 8);
    let block = bytes.subarray(start, start + n);
    if (n < raw) block = compression === 1 ? unpredict(unRle(block, raw)) : compression <= 3 ? unpredict(await inflate(block))
      : compression === 5 ? unPxr24(await inflate(block), w, rows, channels) : unB44(block, w, rows, channels);
    if (block.length < raw) throw new Error('The EXR file is truncated.');
    const bv = new DataView(block.buffer, block.byteOffset, block.byteLength);
    let q = 0;
    for (let r = 0; r < rows; r++) {
      const row = ((y0 + r) * width + x0) * 4;
      for (let k = 0; k < channels.length; k++) {
        const dst = k === ix.r || k === ix.y ? 0 : k === ix.g ? 1 : k === ix.b ? 2 : k === ix.a ? 3 : -1;
        for (let x = 0; x < w; x++, q += sizes[k]) {
          if (dst < 0) continue;
          const t = channels[k].type;
          data[row + x * 4 + dst] = t === 1 ? halfToFloat(bv.getUint16(q, true)) : t === 2 ? bv.getFloat32(q, true) : bv.getUint32(q, true);
        }
      }
    }
  }
  for (let i = 0; i < width * height; i++) {
    if (ix.r < 0) data[i * 4 + 1] = data[i * 4 + 2] = data[i * 4];
    if (ix.a < 0) data[i * 4 + 3] = 1;
  }
  return { width, height, data };
}

// FLOAT channels A, B, G, R (sorted), ZIP compression, increasing Y.
export async function encodeExr(img: FloatImage): Promise<Uint8Array<ArrayBuffer>> {
  const { width: w, height: h, data } = img;
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  const attr = (name: string, type: string, value: Uint8Array) => {
    const head = enc.encode(`${name}\0${type}\0`), n = new Uint8Array(4);
    new DataView(n.buffer).setInt32(0, value.length, true);
    parts.push(head, n, value);
  };
  const ints = (...xs: number[]) => { const b = new Uint8Array(xs.length * 4), d = new DataView(b.buffer); xs.forEach((x, i) => d.setInt32(i * 4, x, true)); return b; };
  const floats = (...xs: number[]) => { const b = new Uint8Array(xs.length * 4), d = new DataView(b.buffer); xs.forEach((x, i) => d.setFloat32(i * 4, x, true)); return b; };
  parts.push(ints(EXR_MAGIC, 2));
  const names = ['A', 'B', 'G', 'R'];
  attr('channels', 'chlist', new Uint8Array([...names.flatMap(n => [...enc.encode(n + '\0'), ...ints(2, 0, 1, 1)]), 0]));
  attr('compression', 'compression', new Uint8Array([3]));
  attr('dataWindow', 'box2i', ints(0, 0, w - 1, h - 1));
  attr('displayWindow', 'box2i', ints(0, 0, w - 1, h - 1));
  attr('lineOrder', 'lineOrder', new Uint8Array([0]));
  attr('pixelAspectRatio', 'float', floats(1));
  attr('screenWindowCenter', 'v2f', floats(0, 0));
  attr('screenWindowWidth', 'float', floats(1));
  parts.push(new Uint8Array([0]));
  const chunks = Math.ceil(h / 16);
  const blocks: Uint8Array[] = [];
  for (let c = 0; c < chunks; c++) {
    const y0 = c * 16, rows = Math.min(16, h - y0);
    const raw = new Uint8Array(rows * w * 16), d = new DataView(raw.buffer);
    let q = 0;
    for (let r = 0; r < rows; r++) for (const ch of [3, 2, 1, 0]) for (let x = 0; x < w; x++, q += 4) d.setFloat32(q, data[((y0 + r) * w + x) * 4 + ch], true);
    const z = await deflate(predict(raw));
    const body = z.length < raw.length ? z : raw;
    blocks.push(ints(y0, body.length), body);
  }
  const headLen = parts.reduce((a, b) => a + b.length, 0);
  const table = new Uint8Array(chunks * 8), tv = new DataView(table.buffer);
  let off = headLen + table.length;
  for (let c = 0; c < chunks; c++) { tv.setBigUint64(c * 8, BigInt(off), true); off += blocks[c * 2].length + blocks[c * 2 + 1].length; }
  return concat([...parts, table, ...blocks]);
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const b of parts) { out.set(b, o); o += b.length; }
  return out;
}

// ---------- Radiance HDR (RGBE, flat or adaptive RLE scanlines) ----------

export function decodeHdr(bytes: Uint8Array): FloatImage {
  let p = 0;
  const line = () => { const e = bytes.indexOf(10, p); if (e < 0) throw new Error('The HDR header is damaged.'); const s = new TextDecoder().decode(bytes.subarray(p, e)); p = e + 1; return s; };
  const magic = line();
  if (!magic.startsWith('#?')) throw new Error('This is not a Radiance HDR file.');
  for (let l = line(); l !== ''; l = line()) {
    if (l.startsWith('FORMAT=') && l !== 'FORMAT=32-bit_rle_rgbe') throw new Error(`HDR ${l} is not supported (only 32-bit_rle_rgbe).`);
  }
  const m = /^-Y (\d+) \+X (\d+)$/.exec(line().trim());
  if (!m) throw new Error('Only top-to-bottom, left-to-right HDR files (-Y h +X w) are supported.');
  const height = +m[1], width = +m[2];
  if (!width || !height || width > 300000 || height > 300000) throw new Error('The HDR image size is out of range.');
  const data = new Float32Array(width * height * 4);
  const rgbe = new Uint8Array(width * 4);
  const need = (n: number) => { if (p + n > bytes.length) throw new Error('The HDR file is truncated.'); };
  for (let y = 0; y < height; y++) {
    need(4);
    if (width >= 8 && width < 32768 && bytes[p] === 2 && bytes[p + 1] === 2 && !(bytes[p + 2] & 128)) {
      if ((bytes[p + 2] << 8 | bytes[p + 3]) !== width) throw new Error('The HDR scanline width is wrong.');
      p += 4;
      for (let c = 0; c < 4; c++) {
        for (let x = 0; x < width;) {
          need(2);
          let n = bytes[p++];
          if (n > 128) { n -= 128; if (x + n > width) throw new Error('The HDR file is damaged.'); const b = bytes[p++]; for (let k = 0; k < n; k++) rgbe[(x++) * 4 + c] = b; }
          else { if (!n || x + n > width) throw new Error('The HDR file is damaged.'); need(n); for (let k = 0; k < n; k++) rgbe[(x++) * 4 + c] = bytes[p++]; }
        }
      }
    } else {
      need(width * 4);
      rgbe.set(bytes.subarray(p, p + width * 4));
      p += width * 4;
    }
    for (let x = 0; x < width; x++) {
      const e = rgbe[x * 4 + 3], f = e ? 2 ** (e - 136) : 0, o = (y * width + x) * 4;
      data[o] = rgbe[x * 4] * f; data[o + 1] = rgbe[x * 4 + 1] * f; data[o + 2] = rgbe[x * 4 + 2] * f; data[o + 3] = 1;
    }
  }
  return { width, height, data };
}

export function encodeHdr(img: FloatImage): Uint8Array<ArrayBuffer> {
  const { width: w, height: h, data } = img;
  const parts: Uint8Array[] = [new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`)];
  const rgbe = new Uint8Array(w * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, r = Math.max(0, data[o]), g = Math.max(0, data[o + 1]), b = Math.max(0, data[o + 2]);
      const m = Math.max(r, g, b);
      if (!(m >= 1e-32) || !isFinite(m)) { rgbe.fill(0, x * 4, x * 4 + 4); continue; }
      // frexp: m = mantissa * 2^e with mantissa in [0.5, 1).
      let e = Math.floor(Math.log2(m)) + 1;
      if (m * 256 / 2 ** e >= 256) e++;
      const s = 256 / 2 ** e;
      rgbe[x * 4] = Math.min(255, Math.floor(r * s)); rgbe[x * 4 + 1] = Math.min(255, Math.floor(g * s)); rgbe[x * 4 + 2] = Math.min(255, Math.floor(b * s));
      rgbe[x * 4 + 3] = Math.max(0, Math.min(255, e + 128));
    }
    if (w < 8 || w >= 32768) { parts.push(rgbe.slice()); continue; }
    const out: number[] = [2, 2, w >> 8, w & 255];
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < w) {
        let run = 1;
        while (x + run < w && run < 127 && rgbe[(x + run) * 4 + c] === rgbe[x * 4 + c]) run++;
        if (run >= 3) { out.push(128 + run, rgbe[x * 4 + c]); x += run; continue; }
        let n = 0;
        while (x + n < w && n < 128) {
          const at = x + n;
          if (at + 2 < w && rgbe[at * 4 + c] === rgbe[(at + 1) * 4 + c] && rgbe[at * 4 + c] === rgbe[(at + 2) * 4 + c]) break;
          n++;
        }
        out.push(n);
        for (let k = 0; k < n; k++) out.push(rgbe[(x + k) * 4 + c]);
        x += n;
      }
    }
    parts.push(Uint8Array.from(out));
  }
  return concat(parts);
}

// ---------- ICO (one PNG image, up to 256 x 256) ----------

export interface IcoEntry { png: Uint8Array; width: number; height: number }

// One 32-bit PNG entry per image; a side of 256 is stored as 0.
export function encodeIco(entries: IcoEntry[]): Uint8Array<ArrayBuffer> {
  const head = new Uint8Array(6 + 16 * entries.length), d = new DataView(head.buffer);
  d.setUint16(2, 1, true); d.setUint16(4, entries.length, true);
  let at = head.length;
  entries.forEach(({ png, width, height }, i) => {
    if (width > 256 || height > 256) throw new Error('An ICO image is at most 256 x 256 pixels.');
    const o = 6 + 16 * i;
    head[o] = width & 255; head[o + 1] = height & 255;
    d.setUint16(o + 4, 1, true); d.setUint16(o + 6, 32, true);
    d.setUint32(o + 8, png.length, true); d.setUint32(o + 12, at, true);
    at += png.length;
  });
  return concat([head, ...entries.map(e => e.png)]);
}

const ICO_SIDES = [16, 24, 32, 48, 64, 128, 256];

// The entry sizes of an image of w x h: each standard side up to its long side (at most 256), plus its
// own size when that fits and is not standard; the aspect ratio is kept.
export function icoSizes(w: number, h: number): [number, number][] {
  const long = Math.max(w, h), top = Math.min(long, 256);
  const sides = ICO_SIDES.filter(s => s <= top);
  if (long <= 256 && !sides.includes(long)) sides.push(long);
  return sides.map(s => [Math.max(1, Math.round(w * s / long)), Math.max(1, Math.round(h * s / long))]);
}
