// PSD shapes, vector masks and saved paths (docs/M4.md sections 4 to 6, D11).
import type { BezierPath, BooleanOperation, KeyDescriptorItem, Layer, LayerMaskData, Units, UnitsValue, VectorContent } from 'ag-psd';

type Op = BooleanOperation;
export interface VPath { fill_rule: 'nonzero' | 'evenodd'; subpaths: { closed: boolean; op: Op; points: number[][] }[] }
export interface VectorMaskData { path: VPath; enabled: boolean; linked: boolean; inverted: boolean; density: number; feather: number }
export interface SavedPathData { name: string; work: boolean; path: VPath }
type Warn = (m: string) => void;

const FIXED = 2 ** 24;
const OPS: Op[] = ['exclude', 'combine', 'subtract', 'intersect'];
const px = (value: number) => ({ units: 'Pixels' as const, value });
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Descriptor units to document px at `res` ppi; `none` scales unitless values (dashes: the stroke width).
const PER_INCH: Partial<Record<Units, number>> = { Points: 72, Picas: 6, Millimeters: 25.4, Centimeters: 2.54, Inches: 1 };
export function unitsPx(u: UnitsValue | undefined, res: number, def: number, none = 1): number {
  if (!u) return def;
  if (u.units === 'None') return u.value * none;
  const per = PER_INCH[u.units];
  return per ? u.value * res / per : u.value;
}

// ag-psd knot points are [inX, inY, x, y, outX, outY]; ours [x, y, inX, inY, outX, outY].
// ag-psd's `fillRule` is a subpath record flag, not a fill rule: files from the reference editor
// flag most combine subpaths even-odd yet render them nonzero (corpus clipping-mask2), so layer
// paths import nonzero. `all` (fillStartsWithAllPixels) starts from a w x h rect.
export function pathIn(paths: BezierPath[], all = false, w = 0, h = 0): VPath {
  const corner = (x: number, y: number) => [x, y, x, y, x, y];
  return {
    fill_rule: 'nonzero',
    subpaths: [
      ...all ? [{ closed: true, op: 'combine' as Op, points: [corner(0, 0), corner(w, 0), corner(w, h), corner(0, h)] }] : [],
      ...paths.map(p => ({
        closed: !p.open, op: p.operation ?? 'combine',
        points: p.knots.map(({ points: [ix, iy, x, y, ox, oy] }) => [x, y, ix, iy, ox, oy]),
      })),
    ],
  };
}

// A smooth knot: both handles off the anchor and collinear with it.
function linked([x, y, ix, iy, ox, oy]: number[]): boolean {
  if ((ix === x && iy === y) || (ox === x && oy === y)) return false;
  return Math.abs((ix - x) * (oy - y) - (iy - y) * (ox - x)) < 1e-6 * (Math.hypot(ix - x, iy - y) * Math.hypot(ox - x, oy - y));
}

// ag-psd truncates coordinate / size * 2^24 to int32; nudging to the middle of the grid step keeps a
// read value (k / 2^24 * size) stable across saves.
function snap(v: number, size: number): number {
  const k = Math.round(v / size * FIXED);
  return (k + Math.sign(k) * 0.5) / FIXED * size;
}

export function pathOut(p: VPath, w: number, h: number): BezierPath[] {
  return p.subpaths.map(s => ({
    open: !s.closed, operation: s.op, fillRule: p.fill_rule === 'evenodd' ? 'even-odd' : 'non-zero',
    knots: s.points.map(pt => {
      const [x, y, ix, iy, ox, oy] = pt.map((v, i) => snap(v, i % 2 ? h : w));
      return { linked: linked(pt), points: [ix, iy, x, y, ox, oy] };
    }),
  }));
}

// ---------- shape layers ----------

// keyOriginType values for the live kinds whose meaning is known; others import without `live`.
const ORIGIN_TYPES: Record<number, string> = { 1: 'rectangle', 2: 'roundedRectangle', 5: 'ellipse' };

function liveIn(k: KeyDescriptorItem | undefined, res: number) {
  const b = k?.keyOriginShapeBoundingBox;
  const type = k?.keyOriginType !== undefined ? ORIGIN_TYPES[k.keyOriginType] : undefined;
  if (!k || !b || !type || k.keyShapeInvalidated) return null;
  const u = (v: UnitsValue | undefined) => unitsPx(v, res, 0);
  const bounds = [u(b.left), u(b.top), u(b.right), u(b.bottom)];
  if (type === 'ellipse') return { type, bounds };
  const r = k.keyOriginRRectRadii;
  return { type, bounds, radii: [u(r?.topLeft), u(r?.topRight), u(r?.bottomLeft), u(r?.bottomRight)] };
}

function liveOut(live: any, res: number, warn: Warn): KeyDescriptorItem {
  const type = live && Number(Object.keys(ORIGIN_TYPES).find(k => ORIGIN_TYPES[+k] === live.type));
  if (!type) {
    if (live) warn('live triangle, polygon, line and custom shape parameters are not stored in PSD');
    return { keyShapeInvalidated: true };
  }
  const [left, top, right, bottom] = live.bounds;
  const out: KeyDescriptorItem = {
    keyOriginType: type, keyOriginResolution: res,
    keyOriginShapeBoundingBox: { top: px(top), left: px(left), bottom: px(bottom), right: px(right) },
  };
  if (live.radii) {
    const [tl, tr, bl, br] = live.radii;
    out.keyOriginRRectRadii = { topRight: px(tr), topLeft: px(tl), bottomLeft: px(bl), bottomRight: px(br) };
  }
  return out;
}

const blendIn = (b: string | undefined) => !b || b === 'pass through' ? 'normal' : b;

// `vectorFill` + `vectorMask` as shape data; `fill` maps PSD fill content to the engine's.
export function shapeIn(l: Layer, res: number, w: number, h: number, fill: (v: VectorContent) => unknown) {
  const s = l.vectorStroke;
  const width = clamp(unitsPx(s?.lineWidth, res, 3 * res / 72), 0, 1000);
  const list = l.vectorOrigination?.keyDescriptorList ?? [];
  return {
    path: pathIn(l.vectorMask!.paths, l.vectorMask!.fillStartsWithAllPixels, w, h),
    live: list.length === 1 ? liveIn(list[0], res) : null,
    fill: s?.fillEnabled === false || !l.vectorFill ? null : fill(l.vectorFill),
    stroke: s ? {
      enabled: s.strokeEnabled ?? true, width, align: s.lineAlignment ?? 'center', cap: s.lineCapType ?? 'butt',
      join: s.lineJoinType ?? 'miter', miter_limit: Math.max(0, s.miterLimit ?? 4),
      dash: (s.lineDashSet ?? []).map(d => Math.max(0, unitsPx(d, res, 0, width))), dash_offset: unitsPx(s.lineDashOffset, res, 0, width),
      content: s.content ? fill(s.content) : { type: 'solid', color: [0, 0, 0] }, opacity: clamp(s.opacity ?? 1, 0, 1), blend: blendIn(s.blendMode),
    } : null,
  };
}

export function shapeOut(s: any, res: number, w: number, h: number, fill: (c: any) => VectorContent, warn: Warn): Partial<Layer> {
  const st = s.stroke;
  return {
    vectorFill: s.fill ? fill(s.fill) : { type: 'color', color: { r: 0, g: 0, b: 0 } },
    vectorMask: { paths: pathOut(s.path, w, h) },
    vectorOrigination: { keyDescriptorList: [liveOut(s.live, res, warn)] },
    ...(st || !s.fill ? { vectorStroke: {
      strokeEnabled: !!st?.enabled, fillEnabled: !!s.fill,
      ...(st ? {
        lineWidth: px(st.width), lineDashOffset: px(st.dash_offset), miterLimit: st.miter_limit, lineCapType: st.cap, lineJoinType: st.join,
        lineAlignment: st.align, scaleLock: false, strokeAdjust: false, lineDashSet: st.dash.map(px), blendMode: st.blend, opacity: st.opacity,
        content: fill(st.content), resolution: res,
      } : {}),
    } } : {}),
  };
}

// ---------- vector masks ----------

export function vectorMaskIn(l: Layer, w: number, h: number): VectorMaskData | null {
  const v = l.vectorMask;
  if (!v) return null;
  return {
    path: pathIn(v.paths, v.fillStartsWithAllPixels, w, h), enabled: !v.disable, linked: !v.notLink, inverted: !!v.invert,
    density: clamp(l.mask?.vectorMaskDensity ?? 1, 0, 1), feather: clamp(l.mask?.vectorMaskFeather ?? 0, 0, 1000),
  };
}

// The raster mask of a layer with a vector mask is `realMask`; `mask` then is the rendered
// vector mask unless it carries its own pixels.
export function rasterMaskOf(l: Layer): LayerMaskData | undefined {
  const m = l.mask;
  if (!l.vectorMask) return m;
  if (l.realMask) return l.realMask;
  const empty = !m?.imageData && (m?.right ?? 0) <= (m?.left ?? 0);
  return m?.fromVectorData || empty ? undefined : m;
}

export function vectorMaskOut(vm: VectorMaskData, raster: LayerMaskData | undefined, w: number, h: number): Partial<Layer> {
  return {
    vectorMask: { invert: vm.inverted, notLink: !vm.linked, disable: !vm.enabled, paths: pathOut(vm.path, w, h) },
    mask: { top: 0, left: 0, defaultColor: 255, fromVectorData: true, vectorMaskDensity: vm.density, vectorMaskFeather: vm.feather },
    ...(raster ? { realMask: raster } : {}),
  };
}

// ---------- saved paths: image resources 2000-2997 and 1025 (work path), which ag-psd skips ----------

const WORK = 1025, FIRST = 2000, LAST = 2997;

// The image resource section of a PSD: offset of its length field, data start and end.
function resourceSection(b: Uint8Array) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 34) throw new Error('PSD file is truncated');
  const lenAt = 30 + dv.getUint32(26);
  if (lenAt + 4 > b.length) throw new Error('PSD file is truncated');
  const start = lenAt + 4;
  return { dv, lenAt, start, end: Math.min(b.length, start + dv.getUint32(lenAt)) };
}

function recordsIn(dv: DataView, from: number, to: number, w: number, h: number): VPath {
  const path: VPath = { fill_rule: 'nonzero', subpaths: [] };
  let cur: VPath['subpaths'][number] | null = null;
  const fx = (o: number) => dv.getInt32(o) / FIXED;
  for (let o = from; o + 26 <= to; o += 26) {
    const sel = dv.getUint16(o);
    if (sel === 0 || sel === 3) {
      const op = dv.getInt16(o + 4);
      cur = { closed: sel === 0, op: OPS[op] ?? 'combine', points: [] };
      if (!path.subpaths.length) path.fill_rule = dv.getUint16(o + 6) === 2 ? 'nonzero' : 'evenodd';
      path.subpaths.push(cur);
    } else if (sel >= 1 && sel <= 5 && sel !== 3 && cur) {
      const [iy, ix, y, x, oy, ox] = [0, 1, 2, 3, 4, 5].map(i => fx(o + 2 + i * 4) * (i % 2 ? w : h));
      cur.points.push([x, y, ix, iy, ox, oy]);
    }
  }
  return path;
}

export function readSavedPaths(b: Uint8Array, w: number, h: number): SavedPathData[] {
  const { dv, start, end } = resourceSection(b);
  const out: SavedPathData[] = [];
  for (let p = start; p + 12 <= end && dv.getUint32(p) === 0x3842494d;) {
    const id = dv.getUint16(p + 4), nameLen = b[p + 6];
    const nameTotal = (nameLen + 2) & ~1;
    if (p + 6 + nameTotal + 4 > end) break;
    const size = dv.getUint32(p + 6 + nameTotal), data = p + 10 + nameTotal;
    if (data + size > end) break;
    if (id === WORK || (id >= FIRST && id <= LAST)) {
      const name = String.fromCharCode(...b.subarray(p + 7, p + 7 + nameLen));
      out.push({ name: id === WORK ? 'Work Path' : name, work: id === WORK, path: recordsIn(dv, data, data + size, w, h) });
    }
    p = data + size + (size & 1);
  }
  return out;
}

function recordsOut(path: VPath, w: number, h: number): Uint8Array {
  const n = 2 + path.subpaths.reduce((a, s) => a + 1 + s.points.length, 0);
  const out = new Uint8Array(n * 26), dv = new DataView(out.buffer);
  const fx = (o: number, v: number) => dv.setInt32(o, clamp(Math.round(v * FIXED), -(2 ** 31), 2 ** 31 - 1));
  dv.setUint16(0, 6);
  dv.setUint16(26, 8);
  let o = 52;
  for (const s of path.subpaths) {
    dv.setUint16(o, s.closed ? 0 : 3);
    dv.setUint16(o + 2, s.points.length);
    dv.setInt16(o + 4, OPS.indexOf(s.op));
    dv.setUint16(o + 6, path.fill_rule === 'nonzero' ? 2 : 1);
    o += 26;
    for (const pt of s.points) {
      dv.setUint16(o, s.closed ? (linked(pt) ? 1 : 2) : (linked(pt) ? 4 : 5));
      const [x, y, ix, iy, ox, oy] = pt;
      [iy / h, ix / w, y / h, x / w, oy / h, ox / w].forEach((v, i) => fx(o + 2 + i * 4, v));
      o += 26;
    }
  }
  return out;
}

// Appends the paths as image resources (names Latin-1, at most 255 bytes).
export function writeSavedPaths(b: Uint8Array, paths: SavedPathData[], w: number, h: number): Uint8Array<ArrayBuffer> {
  const saved = paths.filter(p => !p.work);
  if (saved.length > LAST - FIRST + 1) throw new Error(`PSD stores at most ${LAST - FIRST + 1} saved paths`);
  let next = FIRST;
  const blocks = paths.map(p => {
    const name = p.work ? [] : [...p.name].slice(0, 255).map(c => c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 63);
    const data = recordsOut(p.path, w, h);
    const nameTotal = (name.length + 2) & ~1;
    const out = new Uint8Array(10 + nameTotal + data.length + (data.length & 1)), dv = new DataView(out.buffer);
    dv.setUint32(0, 0x3842494d);
    dv.setUint16(4, p.work ? WORK : next++);
    out[6] = name.length;
    out.set(name, 7);
    dv.setUint32(6 + nameTotal, data.length);
    out.set(data, 10 + nameTotal);
    return out;
  });
  const add = blocks.reduce((a, x) => a + x.length, 0);
  const { dv, lenAt, end } = resourceSection(b);
  const out = new Uint8Array(b.length + add);
  out.set(b.subarray(0, end));
  let o = end;
  for (const x of blocks) { out.set(x, o); o += x.length; }
  out.set(b.subarray(end), o);
  new DataView(out.buffer).setUint32(lenAt, dv.getUint32(lenAt) + add);
  return out;
}
