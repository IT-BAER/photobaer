// ABR brush import (v1/v2 records, v6-v10 8BIM sections). Trust boundary: every length and count is
// checked against the remaining bytes and the caps below; parseAbr never throws.
import {
  computedTip, defaultDynamics, dyn,
  type BlendMode, type BrushPreset, type Captured, type Control, type Dyn, type Dynamics, type PatternRecord, type Tip, type TipRecord,
} from './preset.ts';

export interface AbrReport { version: number; warnings: string[]; skipped: string[] }
export interface AbrResult { presets: BrushPreset[]; tips: TipRecord[]; patterns: PatternRecord[]; report: AbrReport }

export const ABR_LIMITS = { tipSide: 2500, patternSide: 4096, sections: 10000, depth: 32, items: 100000, probe: 4096 };

class Reader {
  readonly b: Uint8Array;
  p: number;
  #d: DataView;
  constructor(b: Uint8Array, p = 0) { this.b = b; this.p = p; this.#d = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  get left() { return this.b.length - this.p; }
  need(n: number) { if (!(n >= 0) || n > this.left) throw new RangeError(`needs ${n} bytes at offset ${this.p}, ${Math.max(0, this.left)} left`); }
  u8() { this.need(1); return this.b[this.p++]; }
  i16() { this.need(2); const v = this.#d.getInt16(this.p); this.p += 2; return v; }
  u16() { this.need(2); const v = this.#d.getUint16(this.p); this.p += 2; return v; }
  i32() { this.need(4); const v = this.#d.getInt32(this.p); this.p += 4; return v; }
  u32() { this.need(4); const v = this.#d.getUint32(this.p); this.p += 4; return v; }
  f64() { this.need(8); const v = this.#d.getFloat64(this.p); this.p += 8; return v; }
  bytes(n: number) { this.need(n); const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  ascii(n: number) { return String.fromCharCode(...this.bytes(n)); }
  // Unicode string: u32 UTF-16 unit count, then big-endian units; trailing NULs dropped.
  ustr() {
    const n = this.u32();
    this.need(n * 2);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u16());
    return s.replace(/\0+$/, '');
  }
  pstr() { return this.ascii(this.u8()); }
  // Descriptor key / class id: length 0 means a 4-char code.
  key() { const n = this.u32(); return this.ascii(n === 0 ? 4 : n); }
}

interface Budget { take(pixels: number): boolean }
const noBudgetLimit: Budget = { take: () => true };

class Ctx implements Budget {
  report: AbrReport;
  #seen = new Set<string>();
  #budget: number;
  constructor(report: AbrReport, budget = Infinity) { this.report = report; this.#budget = budget; }
  warn(m: string) { if (!this.#seen.has(m)) { this.#seen.add(m); this.report.warnings.push(m); } }
  skip(m: string) { if (!this.#seen.has(m)) { this.#seen.add(m); this.report.skipped.push(m); } }
  // Whole-file decoded-pixel budget: stops many small truncated records from claiming huge bitmaps.
  take(pixels: number): boolean {
    if (pixels > this.#budget) { this.warn('decoded-pixel budget exceeded; further tips and pattern planes skipped'); return false; }
    this.#budget -= pixels;
    return true;
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => (Number.isFinite(v) ? clamp(v, 0, 1) : 0);
const inRange = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
const align = (n: number, a: number) => n + ((a - (n % a)) % a);

function uniqueId(used: Set<string>, id: string) {
  let out = id;
  for (let n = 2; used.has(out); n++) out = `${id}#${n}`;
  used.add(out);
  return out;
}

export function parseAbr(bytes: Uint8Array): AbrResult {
  const report: AbrReport = { version: 0, warnings: [], skipped: [] };
  const out: AbrResult = { presets: [], tips: [], patterns: [], report };
  const ctx = new Ctx(report, Math.min(256_000_000, 64 * bytes.length));
  if (bytes.length < 4) { ctx.warn(`header needs 4 bytes, file has ${bytes.length}`); return out; }
  try {
    const r = new Reader(bytes);
    const version = r.i16();
    report.version = version;
    if (version === 1 || version === 2) parseV12(r, version, out, ctx);
    else if (version >= 6 && version <= 10) parseV6(r, out, ctx);
    else ctx.warn(`unsupported ABR version ${version}`);
  } catch (e) {
    ctx.warn(`parse aborted: ${errMsg(e)}`);
  }
  return out;
}

// -- Bitmaps ---------------------------------------------------------------------------------------

function unpackBits(src: Uint8Array, out: Uint8Array, at: number, len: number): boolean {
  let i = 0, o = at;
  const end = at + len;
  while (o < end && i < src.length) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) { for (let k = 0; k <= n && o < end && i < src.length; k++) out[o++] = src[i++]; }
    else if (n !== -128) { if (i >= src.length) break; const v = src[i++]; for (let k = 0; k < 1 - n && o < end; k++) out[o++] = v; }
  }
  return o === end;
}

// Reads w x h samples of `depth` bits (1/8/16) raw or PackBits with a u16 row-length table; returns 8-bit values.
function decodeBitmap(r: Reader, w: number, h: number, depth: number, comp: number, label: string, ctx: Ctx): Uint8Array | null {
  if (depth !== 1 && depth !== 8 && depth !== 16) { ctx.skip(`${label}: ${depth}-bit samples not supported`); return null; }
  const rowBytes = Math.ceil((w * depth) / 8);
  let data: Uint8Array;
  if (comp === 0) {
    const n = rowBytes * h;
    if (n > r.left) { ctx.warn(`${label}: raw bitmap truncated, needs ${n} bytes, ${r.left} left; skipped`); return null; }
    data = r.bytes(n);
  } else if (comp === 1) {
    if (h * 2 > r.left) { ctx.warn(`${label}: row-length table truncated`); return null; }
    const lens: number[] = [];
    let total = 0;
    for (let y = 0; y < h; y++) { const len = r.u16(); lens.push(len); total += len; }
    if (total > r.left) { ctx.warn(`${label}: PackBits rows claim ${total} bytes, ${r.left} left; skipped`); return null; }
    data = new Uint8Array(rowBytes * h);
    for (let y = 0; y < h; y++) {
      const src = r.bytes(lens[y]);
      if (!unpackBits(src, data, y * rowBytes, rowBytes)) ctx.warn(`${label}: PackBits row ${y} truncated`);
    }
  } else { ctx.skip(`${label}: compression ${comp} not supported`); return null; }
  const alpha = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < w; x++) {
      alpha[y * w + x] = depth === 8 ? data[row + x] : depth === 16 ? data[row + x * 2] : (data[row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
    }
  }
  return alpha;
}

// -- v1 / v2 ---------------------------------------------------------------------------------------

function field(v: number, lo: number, hi: number, def: number, label: string, ctx: Ctx) {
  if (inRange(v, lo, hi)) return v;
  ctx.warn(`${label} ${v} outside ${lo}..${hi}, using ${def}`);
  return def;
}

function parseV12(r: Reader, version: number, out: AbrResult, ctx: Ctx) {
  const count = r.i16();
  ctx.warn(`ABR v${version} carries no dynamics; presets use default dynamics`);
  if (count <= 0) { ctx.warn(`header claims ${count} brushes`); return; }
  const tipIds = new Set<string>();
  for (let i = 1; i <= count; i++) {
    if (r.left < 6) { ctx.warn(`header claims ${count} brushes, file ends after ${i - 1}`); return; }
    const type = r.i16(), len = r.i32();
    if (len < 0 || len > r.left) { ctx.warn(`brush ${i}: record length ${len} exceeds the ${r.left} bytes left`); return; }
    const rec = new Reader(r.bytes(len));
    try {
      if (type === 1 || type === 2) {
        rec.i32();
        const spacing = rec.i16();
        let name = version === 2 ? rec.ustr() : '';
        if (type === 1) {
          name ||= `Brush ${i}`;
          const diameter = rec.i16(), roundness = rec.i16(), angle = rec.i16(), hardness = rec.i16();
          out.presets.push({
            id: `abr-${i}`, name, dynamics: defaultDynamics(),
            tip: computedTip({
              diameter: field(diameter, 1, 5000, 25, `${name}: diameter`, ctx), roundness: field(roundness, 1, 100, 100, `${name}: roundness`, ctx) / 100,
              angle: field(angle, -180, 180, 0, `${name}: angle`, ctx), hardness: field(hardness, 0, 100, 100, `${name}: hardness`, ctx) / 100,
              spacing: field(spacing, 1, 1000, 25, `${name}: spacing`, ctx) / 100,
            }),
          });
        } else {
          name ||= `Sampled ${i}`;
          rec.u8(); rec.bytes(8);
          const top = rec.i32(), left = rec.i32(), bottom = rec.i32(), right = rec.i32(), depth = rec.i16(), comp = rec.u8();
          const w = right - left, h = bottom - top;
          if (!inRange(w, 1, ABR_LIMITS.tipSide) || !inRange(h, 1, ABR_LIMITS.tipSide)) { ctx.skip(`brush ${i}: tip ${w}x${h} outside 1..${ABR_LIMITS.tipSide}`); continue; }
          if (!ctx.take(w * h)) continue;
          const alpha = decodeBitmap(rec, w, h, depth, comp, `brush ${i}`, ctx);
          if (!alpha) continue;
          const id = uniqueId(tipIds, `abr-tip-${i}`);
          out.tips.push({ id, name, width: w, height: h, alpha });
          out.presets.push({ id: `abr-${i}`, name, dynamics: defaultDynamics(), tip: sampledTip(id, w, h, field(spacing, 1, 1000, 25, `${name}: spacing`, ctx) / 100) });
        }
      } else ctx.skip(`brush ${i}: record type ${type}`);
    } catch (e) {
      ctx.warn(`brush ${i}: record truncated (${errMsg(e)})`);
    }
  }
}

function sampledTip(tipRef: string, w: number, h: number, spacing = 0.25): Tip {
  return { kind: 'sampled', tipRef, diameter: Math.max(w, h), hardness: 1, angle: 0, roundness: 1, spacing, flipX: false, flipY: false };
}

// -- v6+ sections ----------------------------------------------------------------------------------

function parseV6(r: Reader, out: AbrResult, ctx: Ctx) {
  const sub = r.i16();
  const sections: { key: string; data: Uint8Array }[] = [];
  const is8bim = (p: number) => p + 4 <= r.b.length && r.b[p] === 56 && r.b[p + 1] === 66 && r.b[p + 2] === 73 && r.b[p + 3] === 77;
  while (r.left >= 12) {
    if (sections.length >= ABR_LIMITS.sections) { ctx.warn(`more than ${ABR_LIMITS.sections} sections; rest ignored`); break; }
    if (!is8bim(r.p)) {
      let next = r.p + 1;
      while (next + 4 <= r.b.length && !is8bim(next)) next++;
      ctx.warn(`lost 8BIM section alignment at byte ${r.p}${next + 4 <= r.b.length ? `, resumed at ${next}` : ''}`);
      if (next + 4 > r.b.length) { r.p = r.b.length; break; }
      r.p = next;
      continue;
    }
    r.p += 4;
    const key = r.ascii(4);
    const len = r.u32();
    if (len > r.left) ctx.warn(`8BIM ${key}: length ${len} exceeds the ${r.left} bytes left; reading what is there`);
    const data = r.bytes(Math.min(len, r.left));
    sections.push({ key, data });
    const end = r.p;
    r.p = [align(end, 4), align(end, 2), end].find(is8bim) ?? Math.min(align(end, 4), r.b.length);
  }
  if (r.left > 0) ctx.warn(`${r.left} trailing bytes after the last section`);
  const tipIds = new Set<string>();
  const patterns = new Map<string, PatternRecord>();
  for (const s of sections) {
    if (s.key === 'samp') parseSamp(s.data, sub, out.tips, tipIds, ctx);
    else if (s.key === 'patt') {
      let res = decodePatternRecords(s.data, true, ctx);
      if (!res.patterns.length) res = decodePatternRecords(s.data, false, ctx);
      for (const w of res.warnings) ctx.warn(`8BIM patt: ${w}`);
      for (const p of res.patterns) if (!patterns.has(p.id)) patterns.set(p.id, p);
    }
  }
  out.patterns.push(...patterns.values());
  const used = new Set<string>();
  let sawDesc = false;
  for (const s of sections) {
    if (s.key === 'samp' || s.key === 'patt') continue;
    if (s.key === 'desc') { sawDesc = true; parseDesc(s.data, out, used, ctx); }
    else if (s.key === 'phry') ctx.skip(`8BIM phry (${s.data.length} bytes): hierarchy not decoded`);
    else ctx.skip(`8BIM ${s.key} (${s.data.length} bytes): unknown section`);
  }
  if (!sawDesc) ctx.warn('no desc section: tips imported with default dynamics');
  const ids = new Set(out.presets.map(p => p.id));
  for (const t of out.tips) {
    if (used.has(t.id)) continue;
    out.presets.push({ id: uniqueId(ids, `abr-tip-${t.id}`), name: t.name, tip: sampledTip(t.id, t.width, t.height), dynamics: defaultDynamics() });
  }
}

interface BitmapHeader { w: number; h: number; depth: number; comp: number }

function readHeader(rec: Uint8Array, at: number): (BitmapHeader & { r: Reader }) | null {
  if (at < 0 || at + 19 > rec.length) return null;
  const r = new Reader(rec, at);
  const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32(), depth = r.i16(), comp = r.u8();
  return { w: right - left, h: bottom - top, depth, comp, r };
}

const sizeOk = (h: BitmapHeader) => inRange(h.w, 1, ABR_LIMITS.tipSide) && inRange(h.h, 1, ABR_LIMITS.tipSide);
function plausible(h: BitmapHeader & { r: Reader }) {
  if (!sizeOk(h) || (h.depth !== 1 && h.depth !== 8 && h.depth !== 16) || (h.comp !== 0 && h.comp !== 1)) return false;
  return h.comp === 0 ? Math.ceil((h.w * h.depth) / 8) * h.h <= h.r.left : h.h * 2 <= h.r.left;
}

function parseSamp(data: Uint8Array, sub: number, tips: TipRecord[], ids: Set<string>, ctx: Ctx) {
  const r = new Reader(data);
  for (let n = 1; r.left >= 4; n++) {
    if (n > ABR_LIMITS.items) { ctx.warn(`8BIM samp: more than ${ABR_LIMITS.items} records; rest ignored`); return; }
    const len = r.u32();
    if (len === 0 || len > r.left) { ctx.warn(`8BIM samp: record ${n} claims ${len} bytes, ${r.left} left; stopping`); return; }
    const rec = r.bytes(len);
    r.p = Math.min(align(r.p, 4), data.length);
    const label = `8BIM samp record ${n}`;
    try {
      const idLen = rec[0];
      const rawId = String.fromCharCode(...rec.subarray(1, 1 + idLen));
      // Fixed offsets: subversion 1 = 47 bytes, subversion 2 = 301 bytes from the record start (after a 37-byte id).
      const afterId = 1 + idLen;
      const fixed = [sub === 2 ? 301 : 47, afterId + 10, afterId + 264, afterId];
      let hdr = null;
      for (const at of fixed) {
        const h = readHeader(rec, at);
        if (h && plausible(h)) { hdr = h; break; }
      }
      if (!hdr) {
        for (let at = 0; at < Math.min(rec.length, ABR_LIMITS.probe); at++) {
          const h = readHeader(rec, at);
          if (h && plausible(h)) { hdr = h; ctx.warn(`${label}: bitmap header found by probing at byte ${at}`); break; }
        }
      }
      if (!hdr) { ctx.warn(`${label}: no readable bitmap header; skipped`); continue; }
      if (!ctx.take(hdr.w * hdr.h)) continue;
      const alpha = decodeBitmap(hdr.r, hdr.w, hdr.h, hdr.depth, hdr.comp, label, ctx);
      if (!alpha) continue;
      const id = uniqueId(ids, rawId || `samp-${n}`);
      if (rawId && id !== rawId) ctx.warn(`${label}: repeated tip id ${rawId}, stored as ${id}`);
      tips.push({ id, name: `Sampled ${tips.length + 1}`, width: hdr.w, height: hdr.h, alpha });
    } catch (e) {
      ctx.warn(`${label}: ${errMsg(e)}`);
    }
  }
}

// -- Patterns (shared with .pat import) ------------------------------------------------------------

const MODE_BITMAP = 0, MODE_GRAY = 1, MODE_INDEXED = 2, MODE_RGB = 3;

// Pattern records: version 1, image mode, height, width, name, id, [palette], virtual memory array.
// `lengthPrefixed`: each record starts with a u32 length and is padded to 4 (ABR patt section).
export function decodePatternRecords(bytes: Uint8Array, lengthPrefixed: boolean, budget: Budget = noBudgetLimit): { patterns: PatternRecord[]; warnings: string[] } {
  const patterns: PatternRecord[] = [];
  const warnings: string[] = [];
  const r = new Reader(bytes);
  try {
    for (let n = 1; r.left >= 16; n++) {
      if (n > ABR_LIMITS.items) { warnings.push(`more than ${ABR_LIMITS.items} patterns; rest ignored`); break; }
      let rec = r;
      if (lengthPrefixed) {
        const len = r.u32();
        if (len < 16 || len > r.left) { warnings.push(`pattern ${n}: record length ${len} invalid, ${r.left} left`); break; }
        rec = new Reader(r.bytes(len));
        r.p = Math.min(align(r.p, 4), bytes.length);
      }
      try {
        const p = patternRecord(rec, n, warnings, budget);
        if (p) patterns.push(p);
      } catch (e) {
        warnings.push(`pattern ${n}: ${errMsg(e)}`);
        if (!lengthPrefixed) break;
      }
    }
  } catch (e) {
    warnings.push(`pattern data aborted: ${errMsg(e)}`);
  }
  return { patterns, warnings };
}

function patternRecord(r: Reader, n: number, warnings: string[], budget: Budget): PatternRecord | null {
  const version = r.u32();
  if (version !== 1) throw new RangeError(`record version ${version}, expected 1`);
  const mode = r.u32(), h = r.i16(), w = r.i16();
  const name = r.ustr() || `Pattern ${n}`;
  const id = r.pstr() || `pattern-${n}`;
  const palette = mode === MODE_INDEXED ? r.bytes(768) : null;
  if (r.u32() !== 3) throw new RangeError('virtual memory array version is not 3');
  const vmaLen = r.u32();
  r.need(vmaLen);
  const end = r.p + vmaLen;
  r.bytes(16);
  const channels = r.u32();
  if (!inRange(w, 1, ABR_LIMITS.patternSide) || !inRange(h, 1, ABR_LIMITS.patternSide)) {
    warnings.push(`pattern ${id}: size ${w}x${h} outside 1..${ABR_LIMITS.patternSide}; skipped`);
    r.p = end;
    return null;
  }
  if (mode !== MODE_GRAY && mode !== MODE_RGB && mode !== MODE_INDEXED && mode !== MODE_BITMAP) {
    warnings.push(`pattern ${id}: image mode ${mode} not supported; skipped`);
    r.p = end;
    return null;
  }
  const planes: Uint8Array[] = [];
  const want = mode === MODE_RGB ? 3 : 1;
  for (let c = 0; c < Math.min(channels, 64) + 2 && planes.length < want && r.p < end; c++) {
    if (r.u32() === 0) continue;
    const len = r.u32();
    if (len === 0) continue;
    r.need(len);
    const pr = new Reader(r.bytes(len));
    pr.u32();
    const top = pr.i32(), left = pr.i32(), bottom = pr.i32(), right = pr.i32();
    const depth = pr.u16(), comp = pr.u8();
    if (right - left !== w || bottom - top !== h) { warnings.push(`pattern ${id}: plane ${c} size differs from the pattern; skipped`); continue; }
    const plane = decodePlane(pr, w, h, mode === MODE_BITMAP ? 1 : depth, comp, budget);
    if (!plane) { warnings.push(`pattern ${id}: plane ${c} depth ${depth} compression ${comp} not decodable`); continue; }
    planes.push(plane);
  }
  r.p = end;
  if (planes.length < want) { warnings.push(`pattern ${id}: ${planes.length} of ${want} planes readable; skipped`); return null; }
  if (mode === MODE_RGB || palette) {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      if (palette) { const k = planes[0][i] * 3; data.set([palette[k], palette[k + 1], palette[k + 2], 255], i * 4); }
      else data.set([planes[0][i], planes[1][i], planes[2][i], 255], i * 4);
    }
    return { id, name, width: w, height: h, channels: 4, data };
  }
  const data = mode === MODE_BITMAP ? planes[0].map(v => 255 - v) : planes[0];
  return { id, name, width: w, height: h, channels: 1, data };
}

function decodePlane(r: Reader, w: number, h: number, depth: number, comp: number, budget: Budget): Uint8Array | null {
  if (!budget.take(w * h)) return null;
  if (comp === 1) {
    // Row-length table + PackBits; fall back to one PackBits stream when the table does not add up.
    const start = r.p;
    const sink = new Ctx({ version: 0, warnings: [], skipped: [] });
    const bmp = decodeBitmap(r, w, h, depth, 1, '', sink);
    if (bmp && !sink.report.warnings.length) return bmp;
    r.p = start;
    const packed = new Uint8Array(Math.ceil((w * depth) / 8) * h);
    if (!unpackBits(r.bytes(r.left), packed, 0, packed.length)) return null;
    return decodeBitmap(new Reader(packed), w, h, depth, 0, '', sink);
  }
  if (comp !== 0 || Math.ceil((w * depth) / 8) * h > r.left) return null;
  return decodeBitmap(r, w, h, depth, 0, '', new Ctx({ version: 0, warnings: [], skipped: [] }));
}

// -- Descriptors -----------------------------------------------------------------------------------

type DVal =
  | { t: 'obj'; cls: string; items: Map<string, DVal> } | { t: 'list'; items: DVal[] } | { t: 'num'; v: number; unit: string }
  | { t: 'bool'; v: boolean } | { t: 'text'; v: string } | { t: 'enum'; type: string; v: string } | { t: 'raw'; n: number };
type Items = Map<string, DVal>;

interface DescState { ctx: Ctx; stopped: boolean }

function readItems(r: Reader, depth: number, st: DescState): Items {
  const items: Items = new Map();
  if (depth > ABR_LIMITS.depth) { st.ctx.skip(`descriptor nesting deeper than ${ABR_LIMITS.depth}`); st.stopped = true; return items; }
  r.ustr();
  const cls = r.key();
  const count = r.i32();
  if (count < 0 || count > ABR_LIMITS.items || count * 9 > r.left) { st.ctx.warn(`descriptor ${cls}: ${count} items do not fit`); st.stopped = true; return items; }
  items.set('\0class', { t: 'text', v: cls });
  for (let i = 0; i < count && !st.stopped; i++) {
    const key = r.key();
    const v = readValue(r, r.ascii(4), depth, st, key);
    if (v) items.set(key, v);
  }
  return items;
}

function readValue(r: Reader, type: string, depth: number, st: DescState, key: string): DVal | null {
  switch (type) {
    case 'Objc': case 'GlbO': { const items = readItems(r, depth + 1, st); return { t: 'obj', cls: (items.get('\0class') as { v: string } | undefined)?.v ?? '', items }; }
    case 'VlLs': {
      if (depth > ABR_LIMITS.depth) { st.ctx.skip(`descriptor nesting deeper than ${ABR_LIMITS.depth}`); st.stopped = true; return null; }
      const n = r.i32();
      if (n < 0 || n > ABR_LIMITS.items || n * 4 > r.left) { st.ctx.warn(`list ${key}: ${n} items do not fit`); st.stopped = true; return null; }
      const items: DVal[] = [];
      for (let i = 0; i < n && !st.stopped; i++) { const v = readValue(r, r.ascii(4), depth + 1, st, key); if (v) items.push(v); }
      return { t: 'list', items };
    }
    case 'doub': return { t: 'num', v: r.f64(), unit: '' };
    case 'UntF': { const unit = r.ascii(4); return { t: 'num', v: r.f64(), unit }; }
    case 'long': return { t: 'num', v: r.i32(), unit: '#Lng' };
    case 'comp': { const hi = r.i32(), lo = r.u32(); return { t: 'num', v: hi * 2 ** 32 + lo, unit: '#Lng' }; }
    case 'bool': return { t: 'bool', v: r.u8() !== 0 };
    case 'TEXT': return { t: 'text', v: r.ustr() };
    case 'enum': { const et = r.key(); return { t: 'enum', type: et, v: r.key() }; }
    case 'type': case 'GlbC': r.ustr(); return { t: 'text', v: r.key() };
    case 'tdta': case 'alis': case 'Pth ': {
      const n = r.i32();
      if (n < 0 || n > r.left) { st.ctx.warn(`${type} ${key}: length ${n} exceeds the ${r.left} bytes left`); st.stopped = true; return null; }
      r.bytes(n);
      if (type !== 'tdta') st.ctx.skip(`descriptor ${key}: ${type} value not decoded`);
      return { t: 'raw', n };
    }
    default:
      st.ctx.skip(`descriptor ${key}: unknown value type ${JSON.stringify(type)}`);
      st.ctx.warn(`descriptor read stopped at key ${JSON.stringify(key)} (unknown value type)`);
      st.stopped = true;
      return null;
  }
}

// Typed lookups over the first present key.
const first = (m: Items | null, keys: string[]) => { if (m) for (const k of keys) { const v = m.get(k); if (v) return v; } return undefined; };
function num(m: Items | null, keys: string[], def: number) {
  const v = first(m, keys);
  return v?.t === 'num' && Number.isFinite(v.v) ? v.v : v?.t === 'bool' ? +v.v : def;
}
// Percent values: #Prc and long are 0..100, a plain double is taken as a fraction when |v| <= 1.
function pct(m: Items | null, keys: string[], def: number) {
  const v = first(m, keys);
  if (v?.t !== 'num' || !Number.isFinite(v.v)) return def;
  return v.unit === '#Prc' || v.unit === '#Lng' || Math.abs(v.v) > 1 ? v.v / 100 : v.v;
}
function bool(m: Items | null, keys: string[], def: boolean) {
  const v = first(m, keys);
  return v?.t === 'bool' ? v.v : v?.t === 'num' ? v.v !== 0 : def;
}
function text(m: Items | null, keys: string[], def: string) {
  const v = first(m, keys);
  return v?.t === 'text' || v?.t === 'enum' ? v.v : def;
}
function sub(m: Items | null, keys: string[]): Items | null { const v = first(m, keys); return v?.t === 'obj' ? v.items : null; }

const BLEND_IDS: Record<string, BlendMode> = {
  Nrml: 'normal', Dslv: 'dissolve', Drkn: 'darken', Mltp: 'multiply', CBrn: 'color burn', linearBurn: 'linear burn',
  darkerColor: 'darker color', Lghn: 'lighten', Scrn: 'screen', CDdg: 'color dodge', linearDodge: 'linear dodge',
  lighterColor: 'lighter color', Ovrl: 'overlay', SftL: 'soft light', HrdL: 'hard light', vividLight: 'vivid light',
  linearLight: 'linear light', pinLight: 'pin light', hardMix: 'hard mix', Dfrn: 'difference', Xclu: 'exclusion',
  blendSubtraction: 'subtract', Sbtr: 'subtract', blendDivide: 'divide', Dvid: 'divide', 'H   ': 'hue', Strt: 'saturation',
  'Clr ': 'color', Lmns: 'luminosity',
};

// bVTy index order.
const CONTROL_BY_INDEX: Control[] = ['off', 'fade', 'penPressure', 'penTilt', 'stylusWheel', 'initialDirection', 'direction', 'rotation', 'rotation'];
const CONTROL_BY_NAME: Record<string, Control> = {
  off: 'off', Off: 'off', fade: 'fade', Fade: 'fade', pressure: 'penPressure', penPressure: 'penPressure', tilt: 'penTilt',
  penTilt: 'penTilt', stylusWheel: 'stylusWheel', initialDirection: 'initialDirection', direction: 'direction',
  initialRotation: 'rotation', rotation: 'rotation',
};

const DYN_KEYS = ['bVTy', 'fStp', 'jitter', 'Mnm ', 'minimum', 'minimumDiameter', 'minimumRoundness'];

function control(m: Items, label: string, ctx: Ctx): Control {
  const v = m.get('bVTy');
  if (!v) return 'off';
  if (v.t === 'num') {
    const c = CONTROL_BY_INDEX[Math.round(v.v)];
    if (c) return c;
    ctx.warn(`${label}: control ${v.v} unknown, using off`);
  } else if (v.t === 'enum' || v.t === 'text') {
    const c = CONTROL_BY_NAME[v.v];
    if (c) return c;
    ctx.warn(`${label}: control ${v.v} unknown, using off`);
  }
  return 'off';
}

function readDyn(m: Items | null, label: string, ctx: Ctx, def: Dyn, extraMin: string[] = []): Dyn {
  if (!m) return def;
  const steps = num(m, ['fStp'], 25);
  return dyn({
    control: control(m, label, ctx), fadeSteps: inRange(steps, 1, 9999) ? Math.round(steps) : 25,
    jitter: clamp01(pct(m, ['jitter'], 0)), minimum: clamp01(pct(m, ['Mnm ', 'minimum', ...extraMin], 0)),
  });
}

function blend(m: Items | null, keys: string[], label: string, ctx: Ctx): BlendMode {
  const id = text(m, keys, '');
  if (id && !BLEND_IDS[id]) ctx.warn(`${label}: blend mode ${id} unknown, using multiply`);
  return BLEND_IDS[id] ?? 'multiply';
}

const TIP_KEYS = ['Nm  ', 'Dmtr', 'Angl', 'Rndn', 'Hrdn', 'Intr', 'Spcn', 'flipX', 'flipY', 'sampledData', 'dBrush', 'dTips'];

interface DescEnv { out: AbrResult; used: Set<string>; ctx: Ctx; patterns: Map<string, PatternRecord> }

function lookupTip(tips: TipRecord[], ref: string) {
  return tips.find(t => t.id === ref) ?? tips.find(t => t.id.length > 0 && (ref.startsWith(t.id) || t.id.startsWith(ref)));
}

function readTip(m: Items, name: string, env: DescEnv): Tip {
  const { ctx } = env;
  const d = num(m, ['Dmtr'], 25), a = num(m, ['Angl'], 0), sp = pct(m, ['Spcn'], 0.25);
  const geo = {
    diameter: field(d, 0.1, 5000, 25, `${name}: diameter`, ctx),
    hardness: clamp01(pct(m, ['Hrdn'], 1)),
    angle: inRange(a, -360, 360) ? ((a + 540) % 360) - 180 : 0,
    roundness: clamp(pct(m, ['Rndn'], 1), 0.01, 1),
    spacing: bool(m, ['Intr'], true) && inRange(sp, 0.01, 10) ? sp : 0.25,
    flipX: bool(m, ['flipX'], false), flipY: bool(m, ['flipY'], false),
  };
  const ref = text(m, ['sampledData'], '');
  if (ref) {
    const t = lookupTip(env.out.tips, ref);
    if (t) { env.used.add(t.id); return { kind: 'sampled', tipRef: t.id, ...geo, hardness: 1 }; }
    ctx.warn(`${name}: sampled tip ${ref} is not in this file; using a round tip`);
  }
  return { kind: 'computed', profile: 'round', ...geo };
}

function checkKeys(m: Items, known: Set<string>, where: string, ctx: Ctx) {
  for (const k of m.keys()) if (k !== '\0class' && !known.has(k)) ctx.skip(`descriptor ${where}: key ${JSON.stringify(k)}`);
}

const BRUSH_KEYS = new Set([
  'Nm  ', 'Brsh', 'useTipDynamics', 'szVr', 'angleDynamics', 'roundnessDynamics', 'flipX', 'flipY', 'flipXJitter', 'flipYJitter',
  'brushProjection', 'minimumDiameter', 'minimumRoundness', 'useScatter', 'scatterDynamics', 'countDynamics', 'Cnt ', 'bothAxes',
  'countJitter', 'useTexture', 'Txtr', 'textureBlendMode', 'textureDepth', 'textureScale', 'textureBrightness', 'textureContrast',
  'textureDepthDynamics', 'minimumDepth', 'InvT', 'textureEachTip', 'TxtC', 'useDualBrush', 'dualBrush', 'useColorDynamics', 'clVr',
  'H   ', 'Strt', 'Brgh', 'purity', 'colorDynamicsPerTip', 'usePaintDynamics', 'opVr', 'prVr', 'useBrushPose', 'brushPose',
  'toolOptions', 'useBrushGroup', 'brushGroup', 'Wtdg', 'Rpt ', 'Nose', 'protectTexture', 'dBrush', 'dTips',
]);
const DUAL_KEYS = new Set(['useDualBrush', 'Flip', 'flipX', 'flipY', 'Brsh', 'BlnM', 'useScatter', 'Spcn', 'Cnt ', 'bothAxes', 'countDynamics', 'scatterDynamics']);
const POSE_KEYS = new Set(['overrideTilt', 'tiltX', 'tiltY', 'overrideRotation', 'overrideAngle', 'rotation', 'Angl', 'overridePressure', 'pressure']);
const TOOL_KEYS = new Set(['Opct', 'Flw ', 'Md  ', 'Clr ', 'useColor']);

function parseDesc(data: Uint8Array, out: AbrResult, used: Set<string>, ctx: Ctx) {
  const r = new Reader(data);
  const st: DescState = { ctx, stopped: false };
  let root: Items;
  try {
    const ver = r.i32();
    if (ver !== 16) ctx.warn(`desc: descriptor version ${ver}, expected 16`);
    root = readItems(r, 0, st);
  } catch (e) {
    ctx.warn(`desc: descriptor truncated (${errMsg(e)})`);
    return;
  }
  const env: DescEnv = { out, used, ctx, patterns: new Map(out.patterns.map(p => [p.id, p])) };
  const list = first(root, ['Brsh']);
  const brushes = list?.t === 'list' ? list.items : [{ t: 'obj', cls: '', items: root } as DVal];
  const ids = new Set(out.presets.map(p => p.id));
  for (const b of brushes) {
    if (b.t !== 'obj') { ctx.skip(`desc: Brsh list entry of type ${b.t}`); continue; }
    try {
      out.presets.push(readBrush(b.items, uniqueId(ids, `abr-${ids.size + 1}`), out.presets.length + 1, env));
    } catch (e) {
      ctx.warn(`desc: brush ${out.presets.length + 1} unreadable (${errMsg(e)})`);
    }
  }
}

function readBrush(m: Items, id: string, n: number, env: DescEnv): BrushPreset {
  const { ctx } = env;
  const tipM = sub(m, ['Brsh']);
  const name = text(m, ['Nm  '], text(tipM, ['Nm  '], `Brush ${n}`)).slice(0, 200);
  checkKeys(m, BRUSH_KEYS, name, ctx);
  if (tipM) checkKeys(tipM, new Set(TIP_KEYS), `${name} tip`, ctx);
  const tip = tipM ? readTip(tipM, name, env) : computedTip();
  const d: Dynamics = defaultDynamics();
  const L = (s: string) => `${name}: ${s}`;

  d.shape = {
    enabled: bool(m, ['useTipDynamics'], false),
    size: readDyn(sub(m, ['szVr']), L('size'), ctx, d.shape.size, ['minimumDiameter']),
    angle: { ...readDyn(sub(m, ['angleDynamics']), L('angle'), ctx, d.shape.angle), minimum: 0 },
    roundness: readDyn(sub(m, ['roundnessDynamics']), L('roundness'), ctx, d.shape.roundness, ['minimumRoundness']),
    flipXJitter: bool(m, ['flipXJitter', 'flipX'], false), flipYJitter: bool(m, ['flipYJitter', 'flipY'], false),
    brushProjection: bool(m, ['brushProjection'], false),
  };
  for (const [k, keys] of [['szVr', ['minimumDiameter']], ['roundnessDynamics', ['minimumRoundness']]] as const) {
    const s = sub(m, [k]);
    if (!s && first(m, [...keys])) (k === 'szVr' ? d.shape.size : d.shape.roundness).minimum = clamp01(pct(m, [...keys], 0));
  }

  const sc = sub(m, ['scatterDynamics']);
  const amount = pct(sc, ['jitter'], 0);
  const count = num(sc, ['Cnt '], num(m, ['Cnt '], 1));
  const countDyn = sub(m, ['countDynamics']);
  d.scattering = {
    enabled: bool(m, ['useScatter'], false), amount: inRange(amount, 0, 10) ? amount : 0,
    scatter: { ...readDyn(sc, L('scatter'), ctx, dyn()), jitter: 0 },
    bothAxes: bool(sc, ['bothAxes'], bool(m, ['bothAxes'], false)),
    count: inRange(count, 1, 16) ? Math.round(count) : 1,
    countJitter: countDyn ? readDyn(countDyn, L('count'), ctx, dyn()) : dyn({ jitter: clamp01(pct(sc, ['countJitter'], pct(m, ['countJitter'], 0))) }),
  };

  const txtr = sub(m, ['Txtr']);
  let patternRef: string | null = null;
  if (txtr) {
    const pid = text(txtr, ['Idnt'], '');
    const hit = env.patterns.get(pid) ?? [...env.patterns.values()].find(p => pid && (pid.startsWith(p.id) || p.id.startsWith(pid)));
    if (hit) patternRef = hit.id;
    else ctx.warn(`${name}: texture pattern ${text(txtr, ['Nm  '], pid) || '(unnamed)'} is not in this file; brush paints untextured`);
  }
  const scale = pct(m, ['textureScale'], 1);
  const depthDyn = sub(m, ['textureDepthDynamics']);
  d.texture = {
    enabled: bool(m, ['useTexture'], false) && patternRef !== null, patternRef, invert: bool(m, ['InvT'], false),
    scale: inRange(scale, 0.01, 10) ? scale : 1,
    brightness: clamp(pct(m, ['textureBrightness'], 0) || 0, -1, 1), contrast: clamp(pct(m, ['textureContrast'], 0) || 0, -1, 1),
    eachTip: bool(m, ['textureEachTip', 'TxtC'], false), mode: blend(m, ['textureBlendMode'], L('texture'), ctx),
    depth: clamp01(pct(m, ['textureDepth'], 1)), minimumDepth: clamp01(pct(m, ['minimumDepth'], 0)),
    depthJitter: depthDyn ? readDyn(depthDyn, L('texture depth'), ctx, dyn()) : dyn({ minimum: 1 }),
  };

  const dual = sub(m, ['dualBrush']);
  if (dual) {
    checkKeys(dual, DUAL_KEYS, `${name} dual brush`, ctx);
    const dtM = sub(dual, ['Brsh']);
    const dtip = dtM ? readTip(dtM, `${name} (dual)`, env) : null;
    const on = bool(m, ['useDualBrush'], false) || bool(dual, ['useDualBrush'], false);
    if (on && !dtip) ctx.warn(`${name}: dual brush has no secondary tip; disabled`);
    const dsc = sub(dual, ['scatterDynamics']);
    const scatter = pct(dsc, ['jitter'], 0), dcount = num(dual, ['Cnt '], num(dsc, ['Cnt '], 1)), dsp = pct(dual, ['Spcn'], dtip?.spacing ?? 0.25);
    d.dualBrush = {
      enabled: on && dtip !== null, tip: dtip, mode: blend(dual, ['BlnM', 'Md  '], L('dual brush'), ctx),
      size: clamp(dtip?.diameter ?? 25, 1, 1000), spacing: inRange(dsp, 0.01, 10) ? dsp : 0.25,
      scatter: inRange(scatter, 0, 10) ? scatter : 0, bothAxes: bool(dual, ['bothAxes'], bool(dsc, ['bothAxes'], false)),
      count: inRange(dcount, 1, 16) ? Math.round(dcount) : 1, flipX: bool(dual, ['Flip', 'flipX'], false), flipY: bool(dual, ['flipY'], false),
    };
  }

  const clVr = sub(m, ['clVr']);
  d.color = {
    enabled: bool(m, ['useColorDynamics'], false), fgBg: clamp01(pct(clVr, ['jitter'], 0)),
    hueJitter: clamp01(pct(m, ['H   '], 0)), satJitter: clamp01(pct(m, ['Strt'], 0)), briJitter: clamp01(pct(m, ['Brgh'], 0)),
    purity: clamp(pct(m, ['purity'], 0) || 0, -1, 1), perTip: bool(m, ['colorDynamicsPerTip'], false),
  };

  d.transfer = {
    enabled: bool(m, ['usePaintDynamics'], false),
    opacity: readDyn(sub(m, ['opVr']), L('opacity'), ctx, d.transfer.opacity),
    flow: readDyn(sub(m, ['prVr']), L('flow'), ctx, d.transfer.flow),
  };

  const pose = sub(m, ['brushPose']);
  if (pose) {
    checkKeys(pose, POSE_KEYS, `${name} pose`, ctx);
    const oTilt = bool(pose, ['overrideTilt'], false), oRot = bool(pose, ['overrideRotation', 'overrideAngle'], false), oPr = bool(pose, ['overridePressure'], false);
    d.pose = {
      enabled: bool(m, ['useBrushPose'], oTilt || oRot || oPr), overrideTilt: oTilt,
      tiltX: clamp(num(pose, ['tiltX'], 0), -90, 90), tiltY: clamp(num(pose, ['tiltY'], 0), -90, 90),
      overrideRotation: oRot, rotation: clamp(num(pose, ['rotation', 'Angl'], 0), -180, 180),
      overridePressure: oPr, pressure: clamp01(pct(pose, ['pressure'], 1)),
    };
  }

  d.wetEdges = bool(m, ['Wtdg'], false);
  d.buildUp = bool(m, ['Rpt '], false);
  d.noise = bool(m, ['Nose'], false) ? 0.1 : 0;
  d.protectTexture = bool(m, ['protectTexture'], false);

  const preset: BrushPreset = { id, name, tip, dynamics: d };
  const tool = sub(m, ['toolOptions']);
  if (tool) {
    checkKeys(tool, TOOL_KEYS, `${name} tool options`, ctx);
    const c: Captured = {};
    if (first(tool, ['Opct'])) c.opacity = clamp01(pct(tool, ['Opct'], 1));
    if (first(tool, ['Flw '])) c.flow = clamp01(pct(tool, ['Flw '], 1));
    const md = text(tool, ['Md  '], '');
    if (md) { if (BLEND_IDS[md]) c.mode = BLEND_IDS[md]; else ctx.warn(`${name}: captured blend mode ${md} unknown`); }
    const clr = sub(tool, ['Clr ']);
    if (clr && bool(tool, ['useColor'], true)) {
      const cls = text(clr, ['\0class'], '');
      if (first(clr, ['Rd  ', 'Grn ', 'Bl  '])) c.color = [num(clr, ['Rd  '], 0), num(clr, ['Grn '], 0), num(clr, ['Bl  '], 0)].map(v => Math.round(clamp(v, 0, 255))) as [number, number, number];
      else if (first(clr, ['Gry '])) { const g = Math.round(255 * (1 - clamp01(num(clr, ['Gry '], 0) / 100))); c.color = [g, g, g]; }
      else ctx.warn(`${name}: captured color class ${cls || '?'} not supported`);
    }
    if (Object.keys(c).length) preset.captured = c;
  }
  if (bool(m, ['useBrushGroup'], true)) {
    const g = first(m, ['brushGroup']);
    const gname = (g?.t === 'obj' ? text(g.items, ['Nm  '], '') : g?.t === 'text' ? g.v : '').trim().slice(0, 200);
    if (gname) preset.group = gname;
  }
  const meta: Record<string, unknown> = {};
  for (const k of ['dBrush', 'dTips']) { const v = first(m, [k]) ?? first(tipM, [k]); if (v) meta[k] = plain(v); }
  if (Object.keys(meta).length) preset.tipMeta = meta;
  return preset;
}

// Inert metadata: descriptor subtree as plain JSON values.
function plain(v: DVal): unknown {
  switch (v.t) {
    case 'obj': return Object.fromEntries([...v.items].filter(([k]) => k !== '\0class').map(([k, x]) => [k, plain(x)]));
    case 'list': return v.items.map(plain);
    case 'raw': return null;
    default: return v.v;
  }
}

// Runs parseAbr in a short-lived module worker; `bytes` is transferred (unusable afterwards).
export function parseAbrOffThread(bytes: ArrayBuffer): Promise<AbrResult> {
  const w = new Worker(new URL('./abr.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<AbrResult>((resolve, reject) => {
    w.onmessage = (ev: MessageEvent<AbrResult>) => resolve(ev.data);
    w.onerror = ev => reject(new Error(`ABR parser failed: ${ev.message}`));
    w.postMessage(bytes, [bytes]);
  }).finally(() => w.terminate());
}
