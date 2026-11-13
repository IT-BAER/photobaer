// TIFF image file directories (IFDs): written for TIFF files and EXIF blocks, read for File Info > Camera Data.

export type IfdValue = string | number[] | Uint8Array;
/** One IFD entry; RATIONAL and SRATIONAL values are numerator/denominator pairs. */
export interface IfdEntry { tag: number; type: number; value: IfdValue }
export const BYTE = 1, ASCII = 2, SHORT = 3, LONG = 4, RATIONAL = 5, UNDEFINED = 7, SRATIONAL = 10;
const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

// ASCII values are UTF-8 with a terminating NUL (EXIF readers decode them as UTF-8 in practice).
function entryBytes(e: IfdEntry, le: boolean): Uint8Array {
  if (typeof e.value === 'string') return new Uint8Array([...new TextEncoder().encode(e.value), 0]);
  if (e.value instanceof Uint8Array) return e.value;
  const size = SIZE[e.type], out = new Uint8Array(e.value.length * (e.type === RATIONAL || e.type === SRATIONAL ? 4 : size)), v = new DataView(out.buffer);
  e.value.forEach((x, i) => {
    if (e.type === SHORT) v.setUint16(i * 2, x, le);
    else if (e.type === LONG || e.type === RATIONAL) v.setUint32(i * 4, x, le);
    else if (e.type === SRATIONAL) v.setInt32(i * 4, x, le);
    else out[i] = x;
  });
  return out;
}
const count = (e: IfdEntry, bytes: Uint8Array) => bytes.length / SIZE[e.type];

/** An IFD placed at file offset `at`, followed by the values that do not fit in their entries. */
export function writeIfd(entries: IfdEntry[], at: number, le: boolean, next = 0): Uint8Array {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const head = 2 + sorted.length * 12 + 4, datas = sorted.map(e => entryBytes(e, le));
  const extra = datas.reduce((n, d) => n + (d.length > 4 ? d.length + (d.length & 1) : 0), 0);
  const out = new Uint8Array(head + extra), v = new DataView(out.buffer);
  v.setUint16(0, sorted.length, le);
  let tail = head;
  sorted.forEach((e, i) => {
    const o = 2 + i * 12, d = datas[i];
    v.setUint16(o, e.tag, le); v.setUint16(o + 2, e.type, le); v.setUint32(o + 4, count(e, d), le);
    if (d.length <= 4) out.set(d, o + 8);
    else { v.setUint32(o + 8, at + tail, le); out.set(d, tail); tail += d.length + (d.length & 1); }
  });
  v.setUint32(head - 4, next, le);
  return out;
}

/** An ASCII rational pair for a positive number: n/d with d a power of ten up to 10^4. */
export function rational(x: number): [number, number] {
  if (!(x > 0) || !isFinite(x)) return [0, 1];
  let d = 1;
  while (d < 10000 && Math.abs(Math.round(x * d) - x * d) > 1e-9) d *= 10;
  return [Math.min(0xffffffff, Math.round(x * d)), d];
}

/** Text fields of File Info that EXIF IFD0 holds. */
export interface ExifText { description?: string; artist?: string; copyright?: string; software?: string; dpi?: number }

/** An EXIF block (big-endian TIFF structure, no "Exif" prefix) with IFD0 text tags and the resolution; null when empty. */
export function exifBlock(t: ExifText): Uint8Array | null {
  const e: IfdEntry[] = [];
  if (t.description) e.push({ tag: 270, type: ASCII, value: t.description });
  if (t.software) e.push({ tag: 305, type: ASCII, value: t.software });
  if (t.artist) e.push({ tag: 315, type: ASCII, value: t.artist });
  if (t.copyright) e.push({ tag: 33432, type: ASCII, value: t.copyright });
  if (!e.length) return null;
  if (t.dpi) e.push({ tag: 282, type: RATIONAL, value: rational(t.dpi) }, { tag: 283, type: RATIONAL, value: rational(t.dpi) }, { tag: 296, type: SHORT, value: [2] });
  const head = Uint8Array.of(0x4d, 0x4d, 0, 42, 0, 0, 0, 8);
  const ifd = writeIfd(e, 8, false);
  const out = new Uint8Array(8 + ifd.length);
  out.set(head); out.set(ifd, 8);
  return out;
}

// ---------- reading ----------

/** Camera Data: EXIF tag name to its value as text (rationals as "n/d"), from IFD0, the EXIF IFD and the GPS IFD. */
export type CameraData = Record<string, string>;

const TAGS: Record<number, string> = {
  270: 'ImageDescription', 271: 'Make', 272: 'Model', 274: 'Orientation', 282: 'XResolution', 283: 'YResolution', 296: 'ResolutionUnit',
  305: 'Software', 306: 'DateTime', 315: 'Artist', 33432: 'Copyright',
  33434: 'ExposureTime', 33437: 'FNumber', 34850: 'ExposureProgram', 34855: 'ISOSpeedRatings', 36867: 'DateTimeOriginal',
  36868: 'DateTimeDigitized', 37377: 'ShutterSpeedValue', 37378: 'ApertureValue', 37380: 'ExposureBiasValue', 37381: 'MaxApertureValue',
  37383: 'MeteringMode', 37384: 'LightSource', 37385: 'Flash', 37386: 'FocalLength', 40961: 'ColorSpace', 40962: 'PixelXDimension',
  40963: 'PixelYDimension', 41986: 'ExposureMode', 41987: 'WhiteBalance', 41989: 'FocalLengthIn35mmFilm', 42033: 'BodySerialNumber',
  42035: 'LensMake', 42036: 'LensModel',
};
const GPS_TAGS: Record<number, string> = { 1: 'GPSLatitudeRef', 2: 'GPSLatitude', 3: 'GPSLongitudeRef', 4: 'GPSLongitude', 5: 'GPSAltitudeRef', 6: 'GPSAltitude' };

/** The Camera Data of a TIFF-structured EXIF block; empty when it cannot be read. Bounded: at most 3 IFDs of 1000 entries. */
export function readExif(b: Uint8Array): CameraData {
  const out: CameraData = {};
  if (b.length < 8) return out;
  const le = b[0] === 0x49 && b[1] === 0x49;
  if (!le && !(b[0] === 0x4d && b[1] === 0x4d)) return out;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o: number) => v.getUint16(o, le), u32 = (o: number) => v.getUint32(o, le);
  const value = (type: number, n: number, at: number): string | null => {
    const size = SIZE[type];
    if (!size || n > 4096 || at + n * size > b.length) return null;
    if (type === ASCII) return new TextDecoder().decode(b.subarray(at, at + n)).replace(/\0[\s\S]*$/, '').trim();
    if (type === UNDEFINED) return /[^\x20-\x7e\0]/.test(String.fromCharCode(...b.subarray(at, at + Math.min(n, 64)))) ? null : new TextDecoder().decode(b.subarray(at, at + n)).replace(/\0+$/, '');
    const vals: string[] = [];
    for (let i = 0; i < Math.min(n, 16); i++) {
      const o = at + i * size;
      if (type === SHORT) vals.push(String(u16(o)));
      else if (type === LONG) vals.push(String(u32(o)));
      else if (type === RATIONAL) vals.push(`${u32(o)}/${u32(o + 4)}`);
      else if (type === SRATIONAL) vals.push(`${v.getInt32(o, le)}/${v.getInt32(o + 4, le)}`);
      else if (type === 9) vals.push(String(v.getInt32(o, le)));
      else vals.push(String(b[o]));
    }
    return vals.join(' ');
  };
  const ifd = (at: number, names: Record<number, string>, links: Record<number, number> = {}) => {
    if (at < 8 || at + 2 > b.length) return {};
    const n = Math.min(u16(at), 1000), found: Record<number, number> = {};
    for (let i = 0; i < n; i++) {
      const o = at + 2 + i * 12;
      if (o + 12 > b.length) break;
      const tag = u16(o), type = u16(o + 2), cnt = u32(o + 4), size = (SIZE[type] ?? 0) * cnt;
      if (tag in links) { found[tag] = u32(o + 8); continue; }
      const name = names[tag];
      if (!name || !size) continue;
      const s = value(type, cnt, size <= 4 ? o + 8 : u32(o + 8));
      if (s) out[name] = s;
    }
    return found;
  };
  try {
    const sub = ifd(u32(4), TAGS, { 34665: 0, 34853: 0 });
    if (sub[34665]) ifd(sub[34665], TAGS);
    if (sub[34853]) ifd(sub[34853], GPS_TAGS);
  } catch { /* a damaged block keeps what was read */ }
  // GPS coordinates in the XMP form "DDD,MM.mmmmmmR" (degrees, decimal minutes, reference), as exif:GPSLatitude holds them.
  for (const k of ['GPSLatitude', 'GPSLongitude']) {
    const parts = out[k]?.split(' ').map(r => { const [n, d] = r.split('/').map(Number); return d ? n / d : NaN; });
    const ref = out[`${k}Ref`];
    delete out[`${k}Ref`];
    if (!parts || parts.length < 2 || parts.some(p => !isFinite(p)) || !ref) { delete out[k]; continue; }
    const min = parts[1] + (parts[2] ?? 0) / 60;
    out[k] = `${Math.trunc(parts[0])},${+min.toFixed(6)}${ref}`;
  }
  return out;
}

/** The EXIF block of a JPEG (APP1 "Exif\0\0"), PNG (eXIf), WebP (EXIF chunk) or PSD (image resource 1058) file, or null. */
export function fileExif(b: Uint8Array): Uint8Array | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length > 30 && ascii(0, 4) === '8BPS') {
    const start = 34 + v.getUint32(26), end = Math.min(b.length, start + v.getUint32(start - 4));
    for (let o = start; o + 12 <= end;) {
      const d = o + 6 + ((b[o + 6] + 2) & ~1), n = v.getUint32(d);
      if (d + 4 + n > end) return null;
      if (v.getUint16(o + 4) === 1058) return b.subarray(d + 4, d + 4 + n);
      o = d + 4 + ((n + 1) & ~1);
    }
    return null;
  }
  if (b.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    for (let o = 12; o + 8 <= b.length;) {
      const n = v.getUint32(o + 4, true);
      if (ascii(o, 4) === 'EXIF') { const e = b.subarray(o + 8, o + 8 + n); return ascii(o + 8, 6) === 'Exif\0\0' ? e.subarray(6) : e; }
      o += 8 + n + (n & 1);
    }
    return null;
  }
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50) {
    for (let o = 8; o + 12 <= b.length;) {
      const n = v.getUint32(o), t = String.fromCharCode(...b.subarray(o + 4, o + 8));
      if (o + 12 + n > b.length) return null;
      if (t === 'eXIf') return b.subarray(o + 8, o + 8 + n);
      if (t === 'IDAT' || t === 'IEND') return null;
      o += 12 + n;
    }
  } else if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let o = 2; o + 4 <= b.length && b[o] === 0xff;) {
      const m = b[o + 1];
      if (m === 0xda || m === 0xd9) return null;
      const n = v.getUint16(o + 2);
      if (m === 0xe1 && n > 8 && String.fromCharCode(...b.subarray(o + 4, o + 10)) === 'Exif\0\0') return b.subarray(o + 10, o + 2 + n);
      o += n + 2;
    }
  }
  return null;
}
