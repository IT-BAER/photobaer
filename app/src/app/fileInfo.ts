// File > File Info: the description fields as XMP (Dublin Core and xmpRights), read on open and
// embedded on save (PSD resource 1060, PNG iTXt, JPEG APP1).
import { ascii, concat, isJpeg, isPng, isPsd, isWebp, jpegSegments, pngChunk, pngChunks, psdResources, psdWithResource, view } from './iccFiles.ts';

/** `extra`: further XMP properties ("prefix:Name", see XMP_FIELDS); `camera`: Camera Data by EXIF tag name. */
export interface FileInfo {
  title: string; author: string; description: string; keywords: string[]; copyright: string; copyright_url: string;
  extra?: Record<string, string>; camera?: Record<string, string>;
}

export const emptyInfo = (): FileInfo => ({ title: '', author: '', description: '', keywords: [], copyright: '', copyright_url: '' });
const filled = (m: Record<string, string> | undefined) => !!m && Object.values(m).some(Boolean);
export const hasInfo = (i: FileInfo | null | undefined): i is FileInfo =>
  !!i && (!!(i.title || i.author || i.description || i.copyright || i.copyright_url) || i.keywords.length > 0 || filled(i.extra) || filled(i.camera));

// Empty values dropped, keys sorted (the engine stores sorted maps), empty maps left out.
const tidy = (m: Record<string, string> | undefined) => {
  const e = Object.entries(m ?? {}).filter(([, v]) => v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return e.length ? Object.fromEntries(e) : undefined;
};
/** `i` as the engine stores it, for comparing. */
export function normInfo(i: FileInfo): FileInfo {
  const x = tidy(i.extra), c = tidy(i.camera);
  return {
    title: i.title, author: i.author, description: i.description, keywords: i.keywords, copyright: i.copyright, copyright_url: i.copyright_url,
    ...(x && { extra: x }), ...(c && { camera: c }),
  };
}

/** IPTC Core and Origin properties: simple text, a bag (items joined by "; "), a language alternative, or a
 * member of Iptc4xmpCore:CreatorContactInfo. */
export type XmpKind = 'text' | 'bag' | 'alt' | 'contact';
export const XMP_FIELDS: Record<string, XmpKind> = {
  'photoshop:AuthorsPosition': 'text', 'Iptc4xmpCore:CiAdrExtadr': 'contact', 'Iptc4xmpCore:CiAdrCity': 'contact', 'Iptc4xmpCore:CiAdrRegion': 'contact',
  'Iptc4xmpCore:CiAdrPcode': 'contact', 'Iptc4xmpCore:CiAdrCtry': 'contact', 'Iptc4xmpCore:CiTelWork': 'contact', 'Iptc4xmpCore:CiEmailWork': 'contact',
  'Iptc4xmpCore:CiUrlWork': 'contact', 'photoshop:Headline': 'text', 'Iptc4xmpCore:SubjectCode': 'bag', 'photoshop:CaptionWriter': 'text',
  'photoshop:DateCreated': 'text', 'Iptc4xmpCore:IntellectualGenre': 'text', 'Iptc4xmpCore:Scene': 'bag', 'Iptc4xmpCore:Location': 'text',
  'photoshop:City': 'text', 'photoshop:State': 'text', 'photoshop:Country': 'text', 'Iptc4xmpCore:CountryCode': 'text',
  'photoshop:TransmissionReference': 'text', 'photoshop:Instructions': 'text', 'photoshop:Credit': 'text', 'photoshop:Source': 'text',
  'xmpRights:UsageTerms': 'alt', 'photoshop:Urgency': 'text', 'xmp:Rating': 'text', 'xmpRights:Marked': 'text',
};
const NS: Record<string, string> = {
  dc: 'http://purl.org/dc/elements/1.1/', xmpRights: 'http://ns.adobe.com/xap/1.0/rights/', photoshop: 'http://ns.adobe.com/photoshop/1.0/',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  Iptc4xmpCore: 'http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/', tiff: 'http://ns.adobe.com/tiff/1.0/', exif: 'http://ns.adobe.com/exif/1.0/',
  exifEX: 'http://cipa.jp/exif/1.0/',
};
// Camera Data written to and read from XMP; ISOSpeedRatings is a sequence, dates use the XMP form.
const CAMERA_XMP: Record<string, string> = {
  Make: 'tiff:Make', Model: 'tiff:Model', Orientation: 'tiff:Orientation', ExposureTime: 'exif:ExposureTime', FNumber: 'exif:FNumber',
  ExposureProgram: 'exif:ExposureProgram', ISOSpeedRatings: 'exif:ISOSpeedRatings', DateTimeOriginal: 'exif:DateTimeOriginal',
  ExposureBiasValue: 'exif:ExposureBiasValue', MaxApertureValue: 'exif:MaxApertureValue', MeteringMode: 'exif:MeteringMode',
  LightSource: 'exif:LightSource', FocalLength: 'exif:FocalLength', FocalLengthIn35mmFilm: 'exif:FocalLengthIn35mmFilm',
  ExposureMode: 'exif:ExposureMode', WhiteBalance: 'exif:WhiteBalance', PixelXDimension: 'exif:PixelXDimension', PixelYDimension: 'exif:PixelYDimension',
  ColorSpace: 'exif:ColorSpace', GPSLatitude: 'exif:GPSLatitude', GPSLongitude: 'exif:GPSLongitude', GPSAltitude: 'exif:GPSAltitude',
  GPSAltitudeRef: 'exif:GPSAltitudeRef', LensModel: 'exifEX:LensModel', LensMake: 'exifEX:LensMake', BodySerialNumber: 'exifEX:BodySerialNumber',
};
const exifDate = (x: string) => /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/.exec(x)?.slice(1).map(v => v ?? '00') ?? null;
const toXmpDate = (v: string) => { const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(v); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : v; };
const fromXmpDate = (v: string) => { const d = exifDate(v); return d ? `${d[0]}:${d[1]}:${d[2]} ${d[3]}:${d[4]}:${d[5]}` : v; };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
  const k = e.toLowerCase();
  if (k[0] === '#') {
    const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : '\uFFFD';
  }
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[k];
});

/** An XMP packet with the non-empty fields of `i`. */
export function xmpPacket(i: FileInfo): string {
  const alt = (tag: string, v: string) => v ? `   <${tag}><rdf:Alt><rdf:li xml:lang="x-default">${esc(v)}</rdf:li></rdf:Alt></${tag}>\n` : '';
  const list = (tag: string, kind: string, vs: string[]) => vs.length ? `   <${tag}><rdf:${kind}>${vs.map(v => `<rdf:li>${esc(v)}</rdf:li>`).join('')}</rdf:${kind}></${tag}>\n` : '';
  const simple = (tag: string, v: string) => v ? `   <${tag}>${esc(v)}</${tag}>\n` : '';
  const extra = i.extra ?? {}, camera = i.camera ?? {};
  let more = '', contact = '';
  for (const [k, kind] of Object.entries(XMP_FIELDS)) {
    const v = extra[k] ?? '';
    if (!v) continue;
    if (kind === 'contact') contact += `    <${k}>${esc(v)}</${k}>\n`;
    else more += kind === 'alt' ? alt(k, v) : kind === 'bag' ? list(k, 'Bag', v.split(';').map(s => s.trim()).filter(Boolean)) : simple(k, v);
  }
  if (contact) more += `   <Iptc4xmpCore:CreatorContactInfo rdf:parseType="Resource">\n${contact}   </Iptc4xmpCore:CreatorContactInfo>\n`;
  for (const [k, tag] of Object.entries(CAMERA_XMP)) {
    const v = camera[k] ?? '';
    more += k === 'ISOSpeedRatings' ? list(tag, 'Seq', v ? v.split(' ').filter(Boolean) : []) : simple(tag, k === 'DateTimeOriginal' ? toXmpDate(v) : v);
  }
  const used = Object.keys(NS).filter(p => p === 'dc' || p === 'xmpRights' || more.includes(`<${p}:`));
  return '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
    + ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
    + `  <rdf:Description rdf:about=""${used.map(p => ` xmlns:${p}="${NS[p]}"`).join('')}>\n`
    + alt('dc:title', i.title) + list('dc:creator', 'Seq', i.author ? [i.author] : []) + alt('dc:description', i.description)
    + list('dc:subject', 'Bag', i.keywords) + alt('dc:rights', i.copyright)
    + (i.copyright_url ? `   <xmpRights:WebStatement>${esc(i.copyright_url)}</xmpRights:WebStatement>\n` : '')
    + more
    + '  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>';
}

// The values of property `tag`: its rdf:li items (x-default first), its text, or its attribute form.
function prop(x: string, tag: string): string[] {
  const el = new RegExp(`<${tag}\\b[^>]*?(?:/>|>([\\s\\S]*?)</${tag}>)`).exec(x);
  if (el) {
    const body = el[1] ?? '';
    const items = [...body.matchAll(/<rdf:li\b([^>]*?)(?:\/>|>([\s\S]*?)<\/rdf:li>)/g)];
    if (!items.length) return /<rdf:(Alt|Seq|Bag)\b/.test(body) || !body.trim() ? [] : [unesc(body.trim())];
    const def = items.find(m => /xml:lang\s*=\s*["']x-default["']/.test(m[1]));
    const vals = (def ? [def] : items).map(m => unesc(m[2] ?? ''));
    return def ? vals.slice(0, 1) : vals;
  }
  const at = new RegExp(`\\s${tag}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(x);
  return at ? [unesc(at[1] ?? at[2])] : [];
}

// `s` cut to at most `max` UTF-8 bytes at a character boundary (the engine limits by bytes).
function cutUtf8(s: string, max: number): string {
  const b = new TextEncoder().encode(s);
  if (b.length <= max) return s;
  let n = max;
  while (n > 0 && (b[n] & 0xc0) === 0x80) n--;
  return new TextDecoder().decode(b.subarray(0, n));
}

/** The File Info fields of an XMP packet; null when it has none. Values are cut to the engine's limits, and
 * `onCut` is called when one was. */
export function parseXmp(x: string, onCut?: () => void): FileInfo | null {
  const one = (tag: string, alt = false) => { const v = prop(x, tag); return alt ? v[0] ?? '' : v.join('; '); };
  const cutBytes = (s: string, max: number) => { const c = cutUtf8(s, max); if (c !== s) onCut?.(); return c; };
  const subject = prop(x, 'dc:subject');
  if (subject.length > 1000) onCut?.();
  const i: FileInfo = {
    title: one('dc:title', true), author: one('dc:creator'), description: one('dc:description', true),
    keywords: subject.slice(0, 1000).map(k => cutBytes(k, 1024)), copyright: one('dc:rights', true), copyright_url: one('xmpRights:WebStatement'),
  };
  for (const k of ['title', 'author', 'description', 'copyright', 'copyright_url'] as const) i[k] = cutBytes(i[k], 65536);
  const extra: Record<string, string> = {}, camera: Record<string, string> = {};
  for (const [k, kind] of Object.entries(XMP_FIELDS)) { const v = cutBytes(one(k, kind === 'alt'), 65536); if (v) extra[k] = v; }
  for (const [k, tag] of Object.entries(CAMERA_XMP)) {
    const v = cutBytes(k === 'ISOSpeedRatings' ? prop(x, tag).join(' ') : one(tag), 4096);
    if (v) camera[k] = k === 'DateTimeOriginal' ? fromXmpDate(v) : v;
  }
  const r = normInfo({ ...i, extra, camera });
  return hasInfo(r) ? r : null;
}

/** How a File Info template applies: replace everything, replace the properties it fills, or fill only the empty
 * ones and add new list items. The document's Camera Data is never taken from a template. */
export type TemplateMode = 'clear' | 'replace' | 'append';
const LISTS = new Set(Object.entries(XMP_FIELDS).filter(([, k]) => k === 'bag').map(([n]) => n));
const items = (v: string) => v.split(';').map(s => s.trim()).filter(Boolean);
const union = (a: string[], b: string[]) => [...a, ...b.filter(x => !a.includes(x))];

export function applyTemplate(cur: FileInfo, tpl: FileInfo, mode: TemplateMode): FileInfo {
  const camera = cur.camera;
  if (mode === 'clear') return normInfo({ ...tpl, camera });
  const pick = (a: string, b: string) => (mode === 'replace' ? b || a : a || b);
  const extra: Record<string, string> = { ...cur.extra };
  for (const [k, v] of Object.entries(tpl.extra ?? {})) {
    extra[k] = mode === 'append' && LISTS.has(k) ? union(items(extra[k] ?? ''), items(v)).join('; ') : pick(extra[k] ?? '', v);
  }
  return normInfo({
    title: pick(cur.title, tpl.title), author: pick(cur.author, tpl.author), description: pick(cur.description, tpl.description),
    keywords: mode === 'append' ? union(cur.keywords, tpl.keywords) : tpl.keywords.length ? tpl.keywords : cur.keywords,
    copyright: pick(cur.copyright, tpl.copyright), copyright_url: pick(cur.copyright_url, tpl.copyright_url), extra, camera,
  });
}

// Balanced, properly nested elements around an rdf:RDF element (comments, CDATA and processing instructions skipped).
function wellFormed(x: string): boolean {
  const stack: string[] = [];
  let rdf = false;
  for (const m of x.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, '').matchAll(/<(\/?)([^\s/>!]+)[^>]*?(\/?)>|</g)) {
    if (!m[2]) return false;
    if (m[2] === 'rdf:RDF') rdf = true;
    if (m[1]) { if (stack.pop() !== m[2]) return false; } else if (!m[3]) stack.push(m[2]);
  }
  return rdf && !stack.length;
}

/** The File Info of the edited Raw XMP `x`, keeping the Camera Data of `cur` that XMP does not carry; an empty
 * packet clears the fields; null when `x` is not well-formed XMP. */
export function rawXmpInfo(x: string, cur: FileInfo): FileInfo | null {
  if (x.trim() && !wellFormed(x)) return null;
  const p = (x.trim() && parseXmp(x)) || emptyInfo();
  const kept = Object.fromEntries(Object.entries(cur.camera ?? {}).filter(([k]) => !(k in CAMERA_XMP)));
  return normInfo({ ...p, camera: { ...kept, ...p.camera } });
}

const utf8 = new TextDecoder();
const XMP_PNG = 'XML:com.adobe.xmp';
const XMP_JPEG = 'http://ns.adobe.com/xap/1.0/\0';

// The XMP packet of an image file, or null.
function readXmp(b: Uint8Array): string | null {
  if (isPng(b)) {
    for (const [t, o, n] of pngChunks(b)) {
      // keyword\0, compression flag 0 (compressed iTXt is not read), method, language\0, translated\0, text
      if (t !== 'iTXt' || ascii(b, o, XMP_PNG.length + 2) !== `${XMP_PNG}\0\0`) continue;
      let p = o + XMP_PNG.length + 3;
      for (let k = 0; k < 2; k++) p = b.indexOf(0, p) + 1;
      return p > 0 && p <= o + n ? utf8.decode(b.subarray(p, o + n)) : null;
    }
  } else if (isJpeg(b)) {
    for (const [m, o, n] of jpegSegments(b)) if (m === 0xe1 && ascii(b, o + 4, XMP_JPEG.length) === XMP_JPEG) return utf8.decode(b.subarray(o + 4 + XMP_JPEG.length, o + n));
  } else if (isPsd(b)) {
    for (const [id, , , d, n] of psdResources(b)) if (id === 1060) return utf8.decode(b.subarray(d, d + n));
  } else if (isWebp(b)) {
    for (let o = 12; o + 8 <= b.length;) {
      const n = view(b).getUint32(o + 4, true);
      if (ascii(b, o, 4) === 'XMP ') return utf8.decode(b.subarray(o + 8, o + 8 + n));
      o += 8 + n + (n & 1);
    }
  }
  return null;
}

/** The File Info of an image file (PNG, JPEG, WebP, PSD), or null when it has none or cannot be read;
 * `onCut` as in parseXmp. */
export function readInfo(b: Uint8Array, onCut?: () => void): FileInfo | null {
  try {
    const x = readXmp(b);
    return x ? parseXmp(x, onCut) : null;
  } catch {
    return null;
  }
}

/** `b` (PNG, JPEG or PSD by `mime`) with `i` as its only XMP packet; other files are returned as they are. */
export function embedInfo(b: Uint8Array, mime: string, i: FileInfo): Uint8Array {
  const x = new TextEncoder().encode(xmpPacket(i));
  if (mime === 'image/png' && isPng(b)) {
    const itxt = pngChunk('iTXt', concat([new TextEncoder().encode(XMP_PNG), new Uint8Array(5), x]));
    const parts = [b.subarray(0, 8)];
    for (const [t, o, n] of pngChunks(b)) {
      if (t === 'iTXt' && ascii(b, o, XMP_PNG.length + 1) === `${XMP_PNG}\0`) continue;
      parts.push(b.subarray(o - 8, o + n + 4));
      if (t === 'IHDR') parts.push(itxt);
    }
    return concat(parts);
  }
  if (mime === 'image/jpeg' && isJpeg(b)) {
    const n = 2 + XMP_JPEG.length + x.length;
    if (n > 65535) throw new Error('The File Info is too large for a JPEG file.');
    const app1 = new Uint8Array(2 + n);
    app1.set([0xff, 0xe1]);
    view(app1).setUint16(2, n);
    for (let k = 0; k < XMP_JPEG.length; k++) app1[4 + k] = XMP_JPEG.charCodeAt(k);
    app1.set(x, 4 + XMP_JPEG.length);
    const parts = [b.subarray(0, 2)];
    let at = 2, placed = false;
    for (const [m, o, len] of jpegSegments(b)) {
      if (!placed && m !== 0xe0) { parts.push(app1); placed = true; }
      if (!(m === 0xe1 && ascii(b, o + 4, XMP_JPEG.length) === XMP_JPEG)) parts.push(b.subarray(o, o + len));
      at = o + len;
    }
    if (!placed) parts.push(app1);
    parts.push(b.subarray(at));
    return concat(parts);
  }
  if (mime === 'image/vnd.adobe.photoshop' && isPsd(b)) return psdWithResource(b, 1060, x);
  return b;
}

/** `b` (PNG or JPEG by `mime`) with `exif` (a TIFF-structured block) as its only EXIF: a PNG eXIf chunk after
 * IHDR, or a JPEG APP1 "Exif" segment after APP0; other files are returned as they are. */
export function embedExif(b: Uint8Array, mime: string, exif: Uint8Array): Uint8Array {
  if (mime === 'image/png' && isPng(b)) {
    const parts = [b.subarray(0, 8)];
    for (const [t, o, n] of pngChunks(b)) {
      if (t === 'eXIf') continue;
      parts.push(b.subarray(o - 8, o + n + 4));
      if (t === 'IHDR') parts.push(pngChunk('eXIf', exif));
    }
    return concat(parts);
  }
  if (mime === 'image/jpeg' && isJpeg(b)) {
    if (exif.length + 8 > 65535) throw new Error('The EXIF data is too large for a JPEG file.');
    const app1 = new Uint8Array(10 + exif.length);
    app1.set([0xff, 0xe1]);
    view(app1).setUint16(2, 8 + exif.length);
    app1.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
    app1.set(exif, 10);
    const parts = [b.subarray(0, 2)];
    let at = 2, placed = false;
    for (const [m, o, len] of jpegSegments(b)) {
      if (!placed && m !== 0xe0) { parts.push(app1); placed = true; }
      if (!(m === 0xe1 && ascii(b, o + 4, 6) === 'Exif\0\0')) parts.push(b.subarray(o, o + len));
      at = o + len;
    }
    if (!placed) parts.push(app1);
    parts.push(b.subarray(at));
    return concat(parts);
  }
  return b;
}
