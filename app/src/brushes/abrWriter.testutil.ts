// Minimal ABR v2/v6 writer for our own test fixtures, following the public format structure
// (big-endian; v6 = version, subversion, then 8BIM sections samp/patt/desc).

export class W {
  #b: number[] = [];
  u8(v: number) { this.#b.push(v & 255); return this; }
  u16(v: number) { return this.u8(v >> 8).u8(v); }
  i16(v: number) { return this.u16(v & 0xffff); }
  u32(v: number) { return this.u16(v >>> 16).u16(v & 0xffff); }
  i32(v: number) { return this.u32(v >>> 0); }
  f64(v: number) { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, v); return this.bytes(new Uint8Array(d.buffer)); }
  ascii(s: string) { for (const ch of s) this.u8(ch.charCodeAt(0)); return this; }
  bytes(b: ArrayLike<number>) { for (let i = 0; i < b.length; i++) this.#b.push(b[i] & 255); return this; }
  ustr(s: string) { this.u32(s.length + 1); for (const ch of s) this.u16(ch.charCodeAt(0)); return this.u16(0); }
  pstr(s: string) { return this.u8(s.length).ascii(s); }
  // Descriptor key/class id: 4-char codes as length 0 + code, longer names as length + ascii.
  key(s: string) { return s.length === 4 ? this.u32(0).ascii(s) : this.u32(s.length).ascii(s); }
  pad(n: number) { while (this.#b.length % n) this.u8(0); return this; }
  get length() { return this.#b.length; }
  out() { return new Uint8Array(this.#b); }
}

// PackBits: runs of 3+ as repeats, the rest as literals.
export function packBits(src: Uint8Array): Uint8Array {
  const w = new W();
  let i = 0;
  while (i < src.length) {
    let run = 1;
    while (i + run < src.length && run < 128 && src[i + run] === src[i]) run++;
    if (run >= 3) { w.u8(257 - run).u8(src[i]); i += run; continue; }
    let lit = 0;
    while (i + lit < src.length && lit < 128 && !(i + lit + 2 < src.length && src[i + lit] === src[i + lit + 1] && src[i + lit] === src[i + lit + 2])) lit++;
    w.u8(lit - 1).bytes(src.subarray(i, i + lit));
    i += lit;
  }
  return w.out();
}

export interface Bitmap { w: number; h: number; depth: 8 | 16; compression: 0 | 1; samples: number[] }

// top, left, bottom, right, depth, compression, then raw rows or a row-length table + PackBits rows.
function bitmap(w: W, b: Bitmap) {
  w.i32(0).i32(0).i32(b.h).i32(b.w).i16(b.depth).u8(b.compression);
  const rows: Uint8Array[] = [];
  for (let y = 0; y < b.h; y++) {
    const row = new W();
    for (let x = 0; x < b.w; x++) { const v = b.samples[y * b.w + x]; if (b.depth === 8) row.u8(v); else row.u16(v); }
    rows.push(row.out());
  }
  if (b.compression === 0) { for (const r of rows) w.bytes(r); return; }
  const packed = rows.map(packBits);
  for (const p of packed) w.u16(p.length);
  for (const p of packed) w.bytes(p);
}

export type V2Brush =
  | { type: 'computed'; name: string; spacing: number; diameter: number; roundness: number; angle: number; hardness: number }
  | { type: 'sampled'; name: string; spacing: number; bitmap: Bitmap };

// v2 record layouts: computed = misc, spacing, name, diameter, roundness, angle, hardness;
// sampled = misc, spacing, name, antialias, short bounds, long bounds + bitmap.
export function writeAbrV2(brushes: V2Brush[], version = 2): Uint8Array {
  const w = new W().i16(version).i16(brushes.length);
  for (const b of brushes) {
    const r = new W().i32(0).i16(b.spacing);
    if (version === 2) r.ustr(b.name);
    if (b.type === 'computed') r.i16(b.diameter).i16(b.roundness).i16(b.angle).i16(b.hardness);
    else { r.u8(1).i16(0).i16(0).i16(b.bitmap.h).i16(b.bitmap.w); bitmap(r, b.bitmap); }
    const body = r.out();
    w.i16(b.type === 'computed' ? 1 : 2).i32(body.length).bytes(body);
  }
  return w.out();
}

export type DV =
  | ['Objc', string, [string, DV][]] | ['VlLs', DV[]] | ['doub', number] | ['UntF', string, number] | ['bool', boolean]
  | ['long', number] | ['enum', string, string] | ['TEXT', string] | ['tdta', Uint8Array] | ['alis', Uint8Array]
  | ['raw', string, Uint8Array];

function descValue(w: W, v: DV) {
  switch (v[0]) {
    case 'Objc': w.ascii('Objc'); descBody(w, v[1], v[2]); break;
    case 'VlLs': w.ascii('VlLs').i32(v[1].length); for (const it of v[1]) descValue(w, it); break;
    case 'doub': w.ascii('doub').f64(v[1]); break;
    case 'UntF': w.ascii('UntF').ascii(v[1]).f64(v[2]); break;
    case 'bool': w.ascii('bool').u8(v[1] ? 1 : 0); break;
    case 'long': w.ascii('long').i32(v[1]); break;
    case 'enum': w.ascii('enum').key(v[1]).key(v[2]); break;
    case 'TEXT': w.ascii('TEXT').ustr(v[1]); break;
    case 'tdta': w.ascii('tdta').i32(v[1].length).bytes(v[1]); break;
    case 'alis': w.ascii('alis').i32(v[1].length).bytes(v[1]); break;
    case 'raw': w.ascii(v[1]).bytes(v[2]); break;
  }
}

function descBody(w: W, cls: string, items: [string, DV][]) {
  w.ustr('').key(cls).i32(items.length);
  for (const [k, v] of items) { w.key(k); descValue(w, v); }
}

export function descriptor(cls: string, items: [string, DV][]): Uint8Array {
  const w = new W().i32(16);
  descBody(w, cls, items);
  return w.out();
}

export interface SampTip { id: string; bitmap: Bitmap; junk?: number }
export interface PatternIn { id: string; name: string; mode: 1 | 3; w: number; h: number; planes: number[][]; compression: 0 | 1 }

export function sampSection(tips: SampTip[]): Uint8Array {
  const w = new W();
  for (const t of tips) {
    const r = new W().pstr(t.id);
    for (let i = 0; i < 10 + (t.junk ?? 0); i++) r.u8(0);
    bitmap(r, t.bitmap);
    const body = r.out();
    w.u32(body.length).bytes(body).pad(4);
  }
  return w.out();
}

export function patternRecord(p: PatternIn): Uint8Array {
  const w = new W().u32(1).u32(p.mode).i16(p.h).i16(p.w).ustr(p.name).pstr(p.id);
  const planes = p.planes.map(pl => {
    const r = new W().u32(8).i32(0).i32(0).i32(p.h).i32(p.w).u16(8).u8(p.compression);
    if (p.compression === 0) r.bytes(pl);
    else {
      const rows = [];
      for (let y = 0; y < p.h; y++) rows.push(packBits(new Uint8Array(pl.slice(y * p.w, (y + 1) * p.w))));
      for (const row of rows) r.u16(row.length);
      for (const row of rows) r.bytes(row);
    }
    return r.out();
  });
  const vma = new W().i32(0).i32(0).i32(p.h).i32(p.w).u32(planes.length);
  for (const pl of planes) vma.u32(1).u32(pl.length).bytes(pl);
  const body = vma.out();
  return w.u32(3).u32(body.length).bytes(body).out();
}

export function pattSection(patterns: PatternIn[]): Uint8Array {
  const w = new W();
  for (const p of patterns) { const r = patternRecord(p); w.u32(r.length).bytes(r).pad(4); }
  return w.out();
}

export function writeAbrV6(sections: [string, Uint8Array][], subversion = 1, version = 6): Uint8Array {
  const w = new W().i16(version).i16(subversion);
  sections.forEach(([key, data], i) => {
    w.ascii('8BIM').ascii(key).u32(data.length).bytes(data);
    if (i < sections.length - 1) w.pad(4);
  });
  return w.out();
}
