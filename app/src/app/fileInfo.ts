// File > File Info: the description fields as XMP (Dublin Core and xmpRights), read on open and
// embedded on save (PSD resource 1060, PNG iTXt, JPEG APP1).
import { ascii, concat, isJpeg, isPng, isPsd, isWebp, jpegSegments, pngChunk, pngChunks, psdResources, psdWithResource, view } from './iccFiles.ts';

export interface FileInfo { title: string; author: string; description: string; keywords: string[]; copyright: string; copyright_url: string }

export const emptyInfo = (): FileInfo => ({ title: '', author: '', description: '', keywords: [], copyright: '', copyright_url: '' });
export const hasInfo = (i: FileInfo | null | undefined): i is FileInfo =>
  !!i && (!!(i.title || i.author || i.description || i.copyright || i.copyright_url) || i.keywords.length > 0);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
  const k = e.toLowerCase();
  if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[k];
});

/** An XMP packet with the non-empty fields of `i`. */
export function xmpPacket(i: FileInfo): string {
  const alt = (tag: string, v: string) => v ? `   <${tag}><rdf:Alt><rdf:li xml:lang="x-default">${esc(v)}</rdf:li></rdf:Alt></${tag}>\n` : '';
  const list = (tag: string, kind: string, vs: string[]) => vs.length ? `   <${tag}><rdf:${kind}>${vs.map(v => `<rdf:li>${esc(v)}</rdf:li>`).join('')}</rdf:${kind}></${tag}>\n` : '';
  return '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
    + ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
    + '  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/">\n'
    + alt('dc:title', i.title) + list('dc:creator', 'Seq', i.author ? [i.author] : []) + alt('dc:description', i.description)
    + list('dc:subject', 'Bag', i.keywords) + alt('dc:rights', i.copyright)
    + (i.copyright_url ? `   <xmpRights:WebStatement>${esc(i.copyright_url)}</xmpRights:WebStatement>\n` : '')
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

/** The File Info fields of an XMP packet; null when it has none. */
export function parseXmp(x: string): FileInfo | null {
  const one = (tag: string, alt = false) => { const v = prop(x, tag); return alt ? v[0] ?? '' : v.join('; '); };
  const i: FileInfo = {
    title: one('dc:title', true), author: one('dc:creator'), description: one('dc:description', true),
    keywords: prop(x, 'dc:subject'), copyright: one('dc:rights', true), copyright_url: one('xmpRights:WebStatement'),
  };
  return hasInfo(i) ? i : null;
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

/** The File Info of an image file (PNG, JPEG, WebP, PSD), or null when it has none or cannot be read. */
export function readInfo(b: Uint8Array): FileInfo | null {
  try {
    const x = readXmp(b);
    return x ? parseXmp(x) : null;
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
