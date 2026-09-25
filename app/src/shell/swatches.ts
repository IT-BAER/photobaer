// ACO (v1/v2) and ASE swatch import/export, the default swatch grid, and an IndexedDB-backed store.
import { hsbToRgb, labToRgb, type Rgb } from './color.ts';

export interface Swatch { name: string; rgb: Rgb }
export interface ParseResult { swatches: Swatch[]; warnings: string[] }

// -- ACO -----------------------------------------------------------------------------------------

const ACO_RGB = 0, ACO_HSB = 1, ACO_CMYK = 2, ACO_LAB = 7, ACO_GRAY = 8;

class Reader {
  #d: DataView;
  #p = 0;
  constructor(bytes: Uint8Array) { this.#d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  u16() { const v = this.#d.getUint16(this.#p); this.#p += 2; return v; }
  i16() { const v = this.#d.getInt16(this.#p); this.#p += 2; return v; }
  u32() { const v = this.#d.getUint32(this.#p); this.#p += 4; return v; }
  utf16(len: number) { let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(this.u16()); return s; }
  ascii(len: number) { let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(this.#d.getUint8(this.#p++)); return s; }
  f32() { const v = this.#d.getFloat32(this.#p); this.#p += 4; return v; }
  get eof() { return this.#p >= this.#d.byteLength; }
}

export function parseAco(bytes: Uint8Array): ParseResult {
  const r = new Reader(bytes);
  const version = r.u16();
  const count = r.u16();
  const swatches: Swatch[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < count && !r.eof; i++) {
    const space = r.u16();
    const v1 = r.u16(), v2 = r.u16(), v3 = r.u16(); r.u16(); // fourth value unused by the spaces we read
    let name = '';
    if (version === 2) {
      const len = r.u32();
      name = r.utf16(Math.max(0, len - 1)).replace(/\0+$/, '');
      if (len > 0) r.u16(); // trailing NUL
    }
    if (space === ACO_RGB) swatches.push({ name, rgb: [Math.round(v1 / 257), Math.round(v2 / 257), Math.round(v3 / 257)] });
    else if (space === ACO_HSB) swatches.push({ name, rgb: hsbToRgb([v1 / 182.04, v2 / 655.35, v3 / 655.35]) });
    else if (space === ACO_GRAY) { const g = Math.round(v1 / 39.0625); swatches.push({ name, rgb: [g, g, g] }); }
    else warnings.push(`swatch ${i + 1}: unsupported color space ${space} (CMYK/Lab), skipped`);
  }
  return { swatches, warnings };
}

export function writeAco(swatches: Swatch[]): Uint8Array {
  // Version 2 body only; version-1 readers ignore the trailing name bytes they don't expect.
  let size = 4;
  for (const s of swatches) size += 10 + 4 + 2 + s.name.length * 2;
  const buf = new Uint8Array(size);
  const d = new DataView(buf.buffer);
  let p = 0;
  d.setUint16(p, 2); p += 2;
  d.setUint16(p, swatches.length); p += 2;
  for (const s of swatches) {
    d.setUint16(p, ACO_RGB); p += 2;
    for (const c of s.rgb) { d.setUint16(p, Math.round(c * 257)); p += 2; }
    d.setUint16(p, 0); p += 2;
    d.setUint32(p, s.name.length + 1); p += 4;
    for (const ch of s.name) { d.setUint16(p, ch.charCodeAt(0)); p += 2; }
    d.setUint16(p, 0); p += 2;
  }
  return buf;
}

// -- ASE -----------------------------------------------------------------------------------------

const ASE_GROUP_START = 0xc001, ASE_GROUP_END = 0xc002, ASE_COLOR = 0x0001;

export function parseAse(bytes: Uint8Array): ParseResult {
  const r = new Reader(bytes);
  if (r.ascii(4) !== 'ASEF') return { swatches: [], warnings: ['not an ASE file'] };
  r.u16(); r.u16(); // version
  const blocks = r.u32();
  const swatches: Swatch[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < blocks && !r.eof; i++) {
    const type = r.u16();
    const len = r.u32();
    if (type === ASE_GROUP_START || type === ASE_GROUP_END) {
      // Groups are flattened: skip the name (start) or nothing (end), keep colors that follow.
      if (type === ASE_GROUP_START) { const nameLen = r.u16(); r.utf16(nameLen); }
      continue;
    }
    if (type !== ASE_COLOR) { for (let k = 0; k < len; k++) r.ascii(1); warnings.push(`block ${i + 1}: unsupported type 0x${type.toString(16)}, skipped`); continue; }
    const nameLen = r.u16();
    const name = r.utf16(nameLen).replace(/\0+$/, '');
    const model = r.ascii(4);
    let rgb: Rgb;
    if (model === 'RGB ') rgb = [r.f32() * 255, r.f32() * 255, r.f32() * 255].map(Math.round) as Rgb;
    else if (model === 'Gray') { const g = Math.round(r.f32() * 255); rgb = [g, g, g]; }
    else if (model === 'LAB ') rgb = labToRgb([r.f32() * 100, r.f32() * 255 - 128, r.f32() * 255 - 128]);
    else if (model === 'CMYK') {
      // Naive conversion: no ICC profile, just the textbook formula (documented, not colorimetric).
      const c = r.f32(), m = r.f32(), y = r.f32(), k = r.f32();
      rgb = [255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)].map(Math.round) as Rgb;
    } else { warnings.push(`block ${i + 1}: unknown color model ${model}, skipped`); r.u16(); continue; }
    r.u16(); // color type (global/spot/normal), not tracked
    swatches.push({ name, rgb });
  }
  return { swatches, warnings };
}

export function writeAse(swatches: Swatch[]): Uint8Array {
  let size = 4 + 2 + 2 + 4;
  for (const s of swatches) size += 2 + 4 + 2 + (s.name.length + 1) * 2 + 4 + 12 + 2;
  const buf = new Uint8Array(size);
  const d = new DataView(buf.buffer);
  let p = 0;
  const ascii = (s: string) => { for (const ch of s) d.setUint8(p++, ch.charCodeAt(0)); };
  ascii('ASEF');
  d.setUint16(p, 1); p += 2; d.setUint16(p, 0); p += 2;
  d.setUint32(p, swatches.length); p += 4;
  for (const s of swatches) {
    d.setUint16(p, ASE_COLOR); p += 2;
    d.setUint32(p, 2 + (s.name.length + 1) * 2 + 4 + 12 + 2); p += 4;
    d.setUint16(p, s.name.length + 1); p += 2;
    for (const ch of s.name) { d.setUint16(p, ch.charCodeAt(0)); p += 2; }
    d.setUint16(p, 0); p += 2;
    ascii('RGB ');
    for (const c of s.rgb) { d.setFloat32(p, c / 255); p += 4; }
    d.setUint16(p, 2); p += 2; // normal color type
  }
  return buf;
}

// -- Default set -----------------------------------------------------------------------------------

// Grey ramp plus 12 hues in light, base and dark rows, matching the Photoshop default swatches shape.
export function defaultSwatches(): Swatch[] {
  const out: Swatch[] = [];
  for (let i = 0; i <= 10; i++) { const g = Math.round((i / 10) * 255); out.push({ name: `Gray ${i * 10}%`, rgb: [g, g, g] }); }
  const rows: [string, number][] = [['Light', 80], ['Base', 55], ['Dark', 30]];
  for (const [rowName, brightness] of rows) {
    for (let h = 0; h < 360; h += 30) out.push({ name: `${rowName} ${h}`, rgb: hsbToRgb([h, 85, brightness]) });
  }
  return out;
}

// -- Store -------------------------------------------------------------------------------------

export interface SwatchStore { list(): Promise<Swatch[]>; save(list: Swatch[]): Promise<void> }

// ponytail: one JSON blob for the whole list, fine at swatch-panel scale (dozens of entries).
class MemoryStore implements SwatchStore {
  #list: Swatch[];
  constructor(initial: Swatch[]) { this.#list = initial; }
  async list() { return this.#list; }
  async save(list: Swatch[]) { this.#list = list; }
}

class IdbStore implements SwatchStore {
  #db: IDBDatabase;
  constructor(db: IDBDatabase) { this.#db = db; }
  #tx(mode: IDBTransactionMode) { return this.#db.transaction('swatches', mode).objectStore('swatches'); }
  list(): Promise<Swatch[]> {
    return new Promise((resolve, reject) => {
      const req = this.#tx('readonly').get('list');
      req.onsuccess = () => resolve((req.result as Swatch[] | undefined) ?? defaultSwatches());
      req.onerror = () => reject(req.error);
    });
  }
  save(list: Swatch[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = this.#tx('readwrite').put(list, 'list');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}

export async function openSwatchStore(): Promise<SwatchStore> {
  if (typeof indexedDB === 'undefined') return new MemoryStore(defaultSwatches());
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('photobaer-swatches', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('swatches');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return new IdbStore(db);
  } catch {
    return new MemoryStore(defaultSwatches());
  }
}
