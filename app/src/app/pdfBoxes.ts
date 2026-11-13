// A page's boxes from the raw PDF: pdf.js exposes only the visible crop. Reads plain objects (the last
// definition wins, as after incremental updates) and FlateDecode object streams; null when not found.
type Ref = { num: number; gen: number };
// Each box as [x0, y0, x1, y1] in PDF units, cut to the media box (PDF 32000-1 section 14.11.2).
export interface PageBoxes { media: number[]; crop: number[]; bleed: number[]; trim: number[]; art: number[] }

async function inflate(b: Uint8Array): Promise<string> {
  const out = await new Response(new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
  return new TextDecoder('latin1').decode(out);
}

export const pageBoxes = (bytes: Uint8Array, ref: Ref) => boxReader(bytes)(ref);

// One reader per file: the text is decoded and object streams inflated once for all pages.
export function boxReader(bytes: Uint8Array): (ref: Ref) => Promise<PageBoxes | null> {
  const text = new TextDecoder('latin1').decode(bytes);
  let streamed: Map<number, string> | null = null;
  // Objects in object streams (generation 0), read once on the first miss.
  async function fromStreams() {
    const map = new Map<number, string>();
    for (const m of text.matchAll(/\/Type\s*\/ObjStm\b/g)) {
      const s = text.indexOf('stream', m.index);
      if (s < 0) continue;
      const dict = text.slice(text.lastIndexOf('obj', m.index), s);
      const n = +(/\/N\s+(\d+)/.exec(dict)?.[1] ?? 0), first = +(/\/First\s+(\d+)/.exec(dict)?.[1] ?? 0);
      if (!/\/FlateDecode/.test(dict) || /\/DecodeParms/.test(dict)) continue;
      // A direct /Length, else up to endstream without its end-of-line (data after the zlib end fails).
      const start = s + 6 + (text[s + 6] === '\r' ? 2 : 1), len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      let end = len ? start + +len[1] : text.indexOf('endstream', start);
      if (end < 0) continue;
      if (!len) end -= text[end - 1] !== '\n' ? 0 : text[end - 2] === '\r' ? 2 : 1;
      let data: string;
      try { data = await inflate(bytes.subarray(start, end)); } catch { continue; }
      const head = data.slice(0, first).trim().split(/\s+/).map(Number);
      for (let i = 0; i < n; i++) map.set(head[i * 2], data.slice(first + head[i * 2 + 1], i + 1 < n ? first + head[i * 2 + 3] : data.length));
    }
    return map;
  }
  async function object({ num, gen }: Ref): Promise<string | null> {
    let last: RegExpExecArray | null = null;
    for (const m of text.matchAll(new RegExp(`(?<!\\d)${num}\\s+${gen}\\s+obj\\b`, 'g'))) last = m as RegExpExecArray;
    if (last) {
      const start = last.index + last[0].length, end = text.indexOf('endobj', start);
      return text.slice(start, end < 0 ? undefined : end);
    }
    if (gen) return null;
    streamed ??= await fromStreams();
    return streamed.get(num) ?? null;
  }
  async function box(dict: string, key: string): Promise<number[] | null> {
    const m = new RegExp(`/${key}\\s*(?:\\[([^\\]]*)\\]|(\\d+)\\s+(\\d+)\\s+R)`).exec(dict);
    if (!m) return null;
    const arr = m[1] ?? /\[([^\]]*)\]/.exec(await object({ num: +m[2], gen: +m[3] }) ?? '')?.[1];
    const v = arr?.trim().split(/\s+/).map(Number);
    if (!v || v.length !== 4 || v.some(x => !Number.isFinite(x))) return null;
    return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
  }
  // A box cut to the media box, or null when they do not overlap.
  const cut = (b: number[] | null, m: number[]) => {
    if (!b) return null;
    const r = [Math.max(b[0], m[0]), Math.max(b[1], m[1]), Math.min(b[2], m[2]), Math.min(b[3], m[3])];
    return r[2] > r[0] && r[3] > r[1] ? r : null;
  };
  // MediaBox and CropBox inherit through /Parent; BleedBox, TrimBox and ArtBox are the page's own and default to the crop.
  return async ref => {
    let media: number[] | null = null, crop: number[] | null = null, at: Ref | null = ref;
    const own: (number[] | null)[] = [];
    for (let depth = 0; at && depth < 32 && !(media && crop); depth++) {
      const dict = await object(at);
      if (dict == null) { if (depth === 0) return null; break; }
      if (depth === 0) for (const k of ['BleedBox', 'TrimBox', 'ArtBox']) own.push(await box(dict, k));
      media ??= await box(dict, 'MediaBox');
      crop ??= await box(dict, 'CropBox');
      const p = /\/Parent\s+(\d+)\s+(\d+)\s+R/.exec(dict);
      at = p ? { num: +p[1], gen: +p[2] } : null;
    }
    if (!media) return null;
    const c = cut(crop, media) ?? media, [bleed, trim, art] = own.map(b => cut(b, media!) ?? c);
    return { media, crop: c, bleed, trim, art };
  };
}
