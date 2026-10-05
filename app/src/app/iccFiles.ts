// Embedded ICC profiles of image files: read on open (PNG, JPEG, WebP, PSD), written on export (PNG, JPEG, PSD).

export const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
export const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
export const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function pipe(b: Uint8Array, t: CompressionStream | DecompressionStream) {
  const s = new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(t);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

export function crc(b: Uint8Array) {
  let c = 0xffffffff;
  for (const v of b) c = CRC_TABLE[(c ^ v) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG';
export const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
export const isWebp = (b: Uint8Array) => b.length > 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP';
export const isPsd = (b: Uint8Array) => b.length > 30 && ascii(b, 0, 4) === '8BPS';

// PNG chunks as [type, data offset, data length].
export function* pngChunks(b: Uint8Array) {
  for (let o = 8; o + 12 <= b.length;) {
    const n = view(b).getUint32(o);
    if (o + 12 + n > b.length) return;
    yield [ascii(b, o + 4, 4), o + 8, n] as const;
    o += 12 + n;
  }
}

// JPEG marker segments before the scan as [marker, segment offset, segment length incl. marker].
export function* jpegSegments(b: Uint8Array) {
  for (let o = 2; o + 4 <= b.length && b[o] === 0xff;) {
    const m = b[o + 1];
    if (m === 0xda || m === 0xd9) return;
    const n = view(b).getUint16(o + 2);
    yield [m, o, n + 2] as const;
    o += n + 2;
  }
}

const ICC_SIG = 'ICC_PROFILE\0';

// PSD image resource blocks as [id, block offset, block length, data offset, data length].
export function* psdResources(b: Uint8Array) {
  const v = view(b);
  const start = 34 + v.getUint32(26);
  const end = Math.min(b.length, start + v.getUint32(start - 4));
  for (let o = start; o + 12 <= end;) {
    const id = v.getUint16(o + 4);
    const nameLen = b[o + 6];
    const d = o + 6 + ((nameLen + 2) & ~1);
    const n = v.getUint32(d);
    const len = d + 4 + ((n + 1) & ~1) - o;
    if (o + len > end) return;
    yield [id, o, len, d + 4, n] as const;
    o += len;
  }
}

/** Whether an image file is grayscale: PNG color type 0 or 4, a one-component JPEG frame, PSD color mode 1. */
export function grayFile(b: Uint8Array): boolean {
  if (isPng(b)) return b.length > 25 && (b[25] === 0 || b[25] === 4);
  if (isPsd(b)) return view(b).getUint16(24) === 1;
  if (isJpeg(b)) {
    for (const [m, o, n] of jpegSegments(b)) {
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return n > 9 && b[o + 9] === 1;
    }
  }
  return false;
}

/** The embedded ICC profile of an image file, or null when it has none or cannot be read. */
export async function readIcc(b: Uint8Array): Promise<Uint8Array | null> {
  try {
    if (isPng(b)) {
      for (const [t, o, n] of pngChunks(b)) {
        if (t !== 'iCCP') continue;
        const z = b.subarray(o, o + n).indexOf(0);
        return z > 0 && b[o + z + 1] === 0 ? await pipe(b.subarray(o + z + 2, o + n), new DecompressionStream('deflate')) : null;
      }
      return null;
    }
    if (isJpeg(b)) {
      const parts: [number, Uint8Array][] = [];
      for (const [m, o, n] of jpegSegments(b)) {
        if (m === 0xe2 && ascii(b, o + 4, 12) === ICC_SIG) parts.push([b[o + 16], b.subarray(o + 18, o + n)]);
      }
      return parts.length ? concat(parts.sort((x, y) => x[0] - y[0]).map(p => p[1])) : null;
    }
    if (isWebp(b)) {
      for (let o = 12; o + 8 <= b.length;) {
        const n = view(b).getUint32(o + 4, true);
        if (ascii(b, o, 4) === 'ICCP') return b.slice(o + 8, o + 8 + n);
        o += 8 + n + (n & 1);
      }
      return null;
    }
    if (isPsd(b)) {
      for (const [id, , , d, n] of psdResources(b)) if (id === 1039) return b.slice(d, d + n);
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

export function pngChunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  view(out).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view(out).setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
}

/** `b` (a PNG, JPEG or WebP file) with `icc` as its only color profile. */
export async function embedIcc(b: Uint8Array, mime: string, icc: Uint8Array): Promise<Uint8Array> {
  if (mime === 'image/png' && isPng(b)) {
    const z = await pipe(icc, new CompressionStream('deflate'));
    const iccp = pngChunk('iCCP', concat([new TextEncoder().encode('ICC Profile'), Uint8Array.of(0, 0), z]));
    const parts = [b.subarray(0, 8)];
    for (const [t, o, n] of pngChunks(b)) {
      if (t === 'iCCP' || t === 'sRGB' || t === 'gAMA' || t === 'cHRM') continue;
      parts.push(b.subarray(o - 8, o + n + 4));
      if (t === 'IHDR') parts.push(iccp);
    }
    return concat(parts);
  }
  if (mime === 'image/jpeg' && isJpeg(b)) {
    const max = 65535 - 2 - 14;
    const count = Math.ceil(icc.length / max);
    const app2 = Array.from({ length: count }, (_, i) => {
      const data = icc.subarray(i * max, (i + 1) * max);
      const seg = new Uint8Array(18 + data.length);
      seg.set([0xff, 0xe2]);
      view(seg).setUint16(2, 16 + data.length);
      for (let k = 0; k < 12; k++) seg[4 + k] = ICC_SIG.charCodeAt(k);
      seg.set([i + 1, count], 16);
      seg.set(data, 18);
      return seg;
    });
    const parts = [b.subarray(0, 2)];
    let at = 2, placed = false;
    for (const [m, o, n] of jpegSegments(b)) {
      if (!placed && m !== 0xe0) { parts.push(...app2); placed = true; }
      if (!(m === 0xe2 && ascii(b, o + 4, 12) === ICC_SIG)) parts.push(b.subarray(o, o + n));
      at = o + n;
    }
    if (!placed) parts.push(...app2);
    parts.push(b.subarray(at));
    return concat(parts);
  }
  if (mime === 'image/webp' && isWebp(b)) return webpWithIcc(b, icc);
  return b;
}

function riffChunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(8 + data.length + (data.length & 1));
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i);
  view(out).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

// An extended WebP: VP8X with the ICC flag (made from the VP8 or VP8L header of a simple file),
// then `icc` as the only ICCP chunk, then the other chunks.
function webpWithIcc(b: Uint8Array, icc: Uint8Array): Uint8Array {
  const chunks: [string, Uint8Array][] = [];
  for (let o = 12; o + 8 <= b.length;) {
    const n = view(b).getUint32(o + 4, true);
    chunks.push([ascii(b, o, 4), b.subarray(o + 8, o + 8 + n)]);
    o += 8 + n + (n & 1);
  }
  let head = chunks.find(c => c[0] === 'VP8X')?.[1].slice();
  if (!head) {
    const [type, d] = chunks.find(c => c[0] === 'VP8L' || c[0] === 'VP8 ') ?? [];
    if (!d) return b;
    let w: number, h: number, alpha = false;
    if (type === 'VP8L') {
      const bits = view(d).getUint32(1, true);
      [w, h, alpha] = [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1, !!(bits & (1 << 28))];
    } else [w, h] = [view(d).getUint16(6, true) & 0x3fff, view(d).getUint16(8, true) & 0x3fff];
    head = new Uint8Array(10);
    head[0] = alpha ? 0x10 : 0;
    head.set([(w - 1) & 255, ((w - 1) >> 8) & 255, (w - 1) >> 16, (h - 1) & 255, ((h - 1) >> 8) & 255, (h - 1) >> 16], 4);
  }
  head[0] |= 0x20;
  const rest = chunks.filter(c => c[0] !== 'VP8X' && c[0] !== 'ICCP').map(([t, d]) => riffChunk(t, d));
  const body = concat([new TextEncoder().encode('WEBP'), riffChunk('VP8X', head), riffChunk('ICCP', icc), ...rest]);
  const riff = new Uint8Array(8);
  riff.set(new TextEncoder().encode('RIFF'));
  view(riff).setUint32(4, body.length, true);
  return concat([riff, body]);
}

/** A PSD file with image resource 1039 (ICC profile) set to `icc`. */
export function psdWithIcc(b: Uint8Array, icc: Uint8Array): Uint8Array {
  return psdWithResource(b, 1039, icc);
}

/** A PSD file with image resource `rid` set to `data`. */
export function psdWithResource(b: Uint8Array, rid: number, data: Uint8Array): Uint8Array {
  const v = view(b);
  const start = 34 + v.getUint32(26);
  const len = v.getUint32(start - 4);
  const keep: Uint8Array[] = [];
  for (const [id, o, n] of psdResources(b)) if (id !== rid) keep.push(b.subarray(o, o + n));
  const block = new Uint8Array(12 + data.length + (data.length & 1));
  block.set([0x38, 0x42, 0x49, 0x4d, rid >> 8, rid & 255, 0, 0]);
  view(block).setUint32(8, data.length);
  block.set(data, 12);
  const res = concat([...keep, block]);
  const size = new Uint8Array(4);
  view(size).setUint32(0, res.length);
  return concat([b.subarray(0, start - 4), size, res, b.subarray(start + len)]);
}
