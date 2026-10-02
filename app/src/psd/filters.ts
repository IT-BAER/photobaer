// PSD smart filters (docs/M5.md batch B16): ag-psd filter objects <-> registry filters, the liquify
// mesh codec, and the SoLd read/write hooks for filters ag-psd cannot represent.
import { readPsd, writePsd, type Filter, type Layer, type Psd, type ReadOptions, type WriteOptions } from 'ag-psd';
import { infoHandlersMap } from 'ag-psd/dist/additionalInfo.js';
import * as descriptor from 'ag-psd/dist/descriptor.js';
import { readSignature, readInt32 } from 'ag-psd/dist/psdReader.js';
import { createWriter, writeBytes } from 'ag-psd/dist/psdWriter.js';
import { filter_schema, type Engine } from '../engine-pkg/photobaer_engine.js';

type Warn = (m: string) => void;
type Obj = Record<string, any>;
export type Params = Record<string, any>;
export interface Rect { x: number; y: number; w: number; h: number }
/** What an import or export of one filter needs from the document. */
export interface Ctx { e: Engine; w: number; h: number; rect: Rect }
/** A filter as `Engine.add_smart_filter` takes it; `psd` is the kept PSD record. */
export interface FilterJson { kind: string; params: Params; psd?: Obj }
export interface SmartFilterOut { id: number; filter: { kind: string; params: Params }; enabled: boolean; opacity: number; blend: string; mask: object | null; psd?: Obj }

// ---------- registry schema ----------

interface SpecParam { key: string; kind: string; min: number; max: number; default: unknown; choices?: string[] }
interface Spec { id: string; label: string; group: string; params: SpecParam[] }

let specs: Map<string, Spec> | undefined;
const specOf = (id: string) => (specs ??= new Map((JSON.parse(filter_schema()) as Spec[]).map(s => [s.id, s]))).get(id);
let labels: Map<string, Spec> | undefined;
const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
// The registry entry of an ag-psd filter type: by its normalized label, or the explicit table.
function specForType(type: string): Spec | undefined {
  if (EXPLICIT[type]) return specOf(EXPLICIT[type]);
  if (!labels) {
    specOf('');
    labels = new Map([...specs!.values()].filter(s => !s.group.startsWith('gallery')).map(s => [norm(s.label), s]));
  }
  return labels.get(norm(type));
}

// ---------- name tables ----------

// ag-psd filter type -> registry kind, where the labels differ.
const EXPLICIT: Record<string, string> = { 'oil paint plugin': 'stylize.oil_paint' };

// Registry param key -> dot path into the ag-psd filter object, by filter type.
const SEEDED = ['add noise', 'crystallize', 'mezzotint', 'pointillize', 'clouds', 'difference clouds', 'fibers', 'diffuse', 'extrude', 'tiles'];
const RENAME: Record<string, Record<string, string>> = {
  'color halftone': { maxRadius: 'radius', channel1: 'angle1', channel2: 'angle2', channel3: 'angle3', channel4: 'angle4' },
  wave: {
    generators: 'numberOfGenerators', wavelengthMin: 'wavelength.min', wavelengthMax: 'wavelength.max', amplitudeMin: 'amplitude.min', amplitudeMax: 'amplitude.max',
    horizontalScale: 'scale.x', verticalScale: 'scale.y', randomize: 'randomSeed',
  },
  tiles: { maxOffset: 'maximumOffset' },
  'lens flare': { center: 'position' },
  'de-interlace': { createNewFields: 'newFieldsBy' },
  'hsb/hsl': { input: 'inputMode', output: 'rowOrder' },
  'oil paint': { scale: 'brushScale', bristleDetail: 'microBrush', angularDirection: 'lightDirection', shine: 'specularity' },
  'smart sharpen': {
    remove: 'blur', reduceNoise: 'threshold', fadeAmountShadow: 'shadow.fadeAmount', tonalWidthShadow: 'shadow.tonalWidth', radiusShadow: 'shadow.radius',
    fadeAmountHighlight: 'highlight.fadeAmount', tonalWidthHighlight: 'highlight.tonalWidth', radiusHighlight: 'highlight.radius',
  },
  custom: { kernel: 'matrix' },
};
for (const t of SEEDED) RENAME[t] = { ...RENAME[t], seed: 'randomSeed' };

// Params stored x100 against the PSD value, by filter type.
const X100: Record<string, string[]> = {
  'add noise': ['amount'], 'unsharp mask': ['amount'],
  'smart sharpen': ['amount', 'fadeAmountShadow', 'tonalWidthShadow', 'fadeAmountHighlight', 'tonalWidthHighlight'],
  'reduce noise': ['reduceColorNoise', 'sharpenDetails'],
};

// PSD enum string -> registry choice, where normalizing the words does not match.
const ENUM: Record<string, string> = {
  'rectangular to polar': 'rectToPolar', 'polar to rectangular': 'polarToRect', 'odd lines': 'oddFields', 'even lines': 'evenFields',
  'set to transparent': 'setToBackground', '50-300mm zoom': 'zoom50to300', '32mm prime': 'prime35', '105mm prime': 'prime105', 'movie prime': 'moviePrime',
  left: 'fromTheLeft', right: 'fromTheRight', 'background color': 'background', 'foreground color': 'foreground', 'inverse image': 'inverseImage',
  'unaltered image': 'unalteredImage', 'level-based': 'level',
};

// Default ag-psd objects of filters made in the app, by lower-case label (null: a filter without options).
const px = (value = 1) => ({ units: 'Pixels', value });
const DEFAULT_OBJECTS: Record<string, Obj | null> = {
  average: null, blur: null, 'blur more': null, despeckle: null, sharpen: null, 'sharpen edges': null, 'sharpen more': null, facet: null, fragment: null,
  'find edges': null, solarize: null, invert: null,
  'box blur': { radius: px() }, 'gaussian blur': { radius: px() }, 'motion blur': { angle: 0, distance: px() }, 'surface blur': { radius: px(), threshold: 0 },
  'radial blur': { amount: 10, method: 'spin', quality: 'good' },
  'smart blur': { radius: 3, threshold: 25, quality: 'medium', mode: 'normal' },
  median: { radius: px() }, 'high pass': { radius: px() }, 'unsharp mask': { amount: 0.5, radius: px(), threshold: 0 },
  'dust & scratches': { radius: 1, threshold: 0 }, pinch: { amount: 0 }, twirl: { angle: 0 }, ripple: { amount: 100, size: 'medium' },
  spherize: { amount: 0, mode: 'normal' }, 'polar coordinates': { conversion: 'rectangular to polar' },
  'add noise': { amount: 0.125, distribution: 'uniform', monochromatic: false, randomSeed: 0 },
  wave: {
    numberOfGenerators: 1, type: 'sine', wavelength: { min: 10, max: 120 }, amplitude: { min: 5, max: 35 }, scale: { x: 100, y: 100 }, randomSeed: 0,
    undefinedAreas: 'repeat edge pixels',
  },
  'color halftone': { radius: 8, angle1: 108, angle2: 162, angle3: 90, angle4: 45 },
  crystallize: { cellSize: 10, randomSeed: 0 }, mosaic: { cellSize: 10 },
  'smart sharpen': {
    amount: 1.5, radius: px(), threshold: 20, angle: 0, moreAccurate: true, blur: 'lens blur', preset: 'Custom',
    shadow: { fadeAmount: 0, tonalWidth: 0.5, radius: 1 }, highlight: { fadeAmount: 0, tonalWidth: 0.5, radius: 1 },
  },
};

// ---------- values ----------

const unit = (v: unknown): any => (v && typeof v === 'object' && 'value' in v ? (v as Obj).value : v);
const getPath = (o: unknown, path: string): any => path.split('.').reduce((i: any, k) => (i && typeof i === 'object' ? i[k] : undefined), o);
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const words = (c: string) => c.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

// Sets `path` in `o` (created on the way), keeping a units wrapper of the old value.
function setPath(o: Obj, path: string, v: unknown) {
  const keys = path.split('.');
  let s = o;
  for (const k of keys.slice(0, -1)) {
    if (!s[k] || typeof s[k] !== 'object') s[k] = {};
    s = s[k];
  }
  const last = keys[keys.length - 1], old = s[last];
  s[last] = old && typeof old === 'object' && 'units' in old ? { ...old, value: v } : v;
}

// Byte arrays inside a PSD record are document blobs, referenced as `{ "$blob": id }`.
function dehydrate(v: unknown, e?: Engine): unknown {
  if (v instanceof Uint8Array) {
    if (!v.length) return { $empty: true };
    if (!e) throw new Error('A PSD filter with byte data needs a document.');
    return { $blob: Number(e.blob_add(v)) };
  }
  if (Array.isArray(v)) return v.map(x => dehydrate(x, e));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dehydrate(x, e)]));
  return v;
}

function hydrate(v: any, e: Engine): any {
  if (Array.isArray(v)) return v.map(x => hydrate(x, e));
  if (!v || typeof v !== 'object') return v;
  if ('$empty' in v) return new Uint8Array(0);
  if ('$blob' in v) return e.tile_bytes(BigInt(v.$blob));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hydrate(x, e)]));
}

// ---------- generic mapping ----------

function defaultsOf(s: Spec): Params {
  return Object.fromEntries(s.params.map(p => [p.key, p.default]));
}

// The registry params an ag-psd filter object stands for.
function paramsIn(f: Filter, s: Spec): Params {
  const params = defaultsOf(s);
  const o = 'filter' in f ? (f.filter as Obj) : {};
  for (const p of s.params) {
    let c = unit(getPath(o, RENAME[f.type]?.[p.key] ?? p.key));
    if (c === undefined) continue;
    if (typeof c === 'number') {
      if (X100[f.type]?.includes(p.key)) c *= 100;
      if (p.kind === 'int') c = Math.round(c);
      else if (p.kind === 'seed') c = Math.round(c) >>> 0;
    } else if (p.kind === 'select' && typeof c === 'string') {
      const v = c;
      c = p.choices?.find(o => norm(o) === norm(v) || o === ENUM[v]) ?? c;
    }
    params[p.key] = c;
  }
  if (f.type === 'reduce noise') {
    for (const a of (f.filter as Obj).channelDenoise ?? []) {
      for (const ch of a.channels) {
        params[ch === 'composite' ? 'strength' : `${ch}Strength`] = a.amount;
        if (ch === 'composite' && a.preserveDetails !== undefined) params.preserveDetails = a.preserveDetails;
      }
    }
  }
  if (f.type === 'oil paint' && !(f.filter as Obj).lightingOn) params.shine = 0;
  return params;
}

// `o` (a copy of an ag-psd filter object's options) with every param that differs from `base` written back.
function paramsOut(f: Filter, base: Params, params: Params): Obj {
  const o: Obj = 'filter' in f ? structuredClone(f.filter as Obj) : {};
  for (const [key, v] of Object.entries(params)) {
    if (same(v, base[key])) continue;
    if (f.type === 'reduce noise' && /^(strength|preserveDetails|(red|green|blue)Strength)$/.test(key)) {
      const ch = key.startsWith('red') ? 'red' : key.startsWith('green') ? 'green' : key.startsWith('blue') ? 'blue' : 'composite';
      const list: Obj[] = (o.channelDenoise ??= []);
      let a = list.find(x => x.channels.includes(ch));
      if (!a) list.push(a = { channels: [ch], amount: 0 });
      a[key === 'preserveDetails' ? 'preserveDetails' : 'amount'] = v;
      continue;
    }
    const path = RENAME[f.type]?.[key] ?? key;
    const old = unit(getPath(o, path));
    let w = typeof v === 'number' && X100[f.type]?.includes(key) ? v / 100 : v;
    if (typeof v === 'string' && typeof old === 'string') w = Object.entries(ENUM).find(([, c]) => c === v)?.[0] ?? words(v);
    setPath(o, path, w);
  }
  return o;
}

// ---------- liquify mesh ----------

const MESH_MAGIC = 'yfqLhseM';
const MAX_NODES = 16777216;
// A compressed mesh expands from a few bytes, so it gets a lower node cap.
const MAX_COMPRESSED_NODES = 1 << 22;
export interface PsdMesh { cols: number; rows: number; displacement: Float32Array }

/** A PSD liquify mesh (versions 2 to 4): float32 (dx, dy) per node in cell units, v3/v4 zero-run compressed. */
export function parseLiquifyMesh(b: Uint8Array): PsdMesh {
  const bad = (m: string) => new Error(`Invalid Photoshop Liquify mesh: ${m}.`);
  if (b.length < 24 || String.fromCharCode(...b.subarray(4, 12)) !== MESH_MAGIC) throw bad('wrong header');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = v.getUint32(0), cols = v.getUint32(16, true), rows = v.getUint32(20, true);
  if (![2, 3, 4].includes(version) || v.getUint32(12, true) !== 2 || !cols || !rows || cols * rows > MAX_NODES) throw bad('unsupported version or size');
  let at = 24;
  const u32 = () => {
    if (at + 4 > b.length) throw bad('truncated');
    at += 4;
    return v.getUint32(at - 4, true);
  };
  const f32 = () => {
    if (at + 4 > b.length) throw bad('truncated');
    at += 4;
    const x = v.getFloat32(at - 4, true);
    if (!Number.isFinite(x)) throw bad('non-finite displacement');
    return x;
  };
  if (version === 4) {
    if (u32() !== 0 || u32() !== 1) throw bad('unsupported tiled mesh');
    for (let i = 0; i < 2; i++) {
      const [x0, y0, x1, y1] = [u32() | 0, u32() | 0, u32() | 0, u32() | 0];
      if (x1 <= x0 || y1 <= y0) throw bad('empty tile bounds');
    }
  }
  const n = cols * rows;
  if (version !== 2 && n > MAX_COMPRESSED_NODES) throw bad('unsupported version or size');
  // Checked before allocating: a plain mesh holds every float, a compressed one at least a zero run per row.
  if (version === 2 ? b.length - at < n * 8 : b.length - at < rows * 4) throw bad('truncated');
  const d = new Float32Array(n * 2);
  if (version === 2) {
    for (let i = 0; i < d.length; i++) d[i] = f32();
    return { cols, rows, displacement: d };
  }
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      const zeros = u32();
      if (zeros > cols - c) throw bad('zero run');
      c += zeros;
      if (c === cols) break;
      const lit = u32();
      if (!lit || lit > cols - c) throw bad('literal run');
      for (let k = 0; k < lit; k++, c++) {
        d[(r * cols + c) * 2] = f32();
        d[(r * cols + c) * 2 + 1] = f32();
      }
    }
  }
  return { cols, rows, displacement: d };
}

/** The uncompressed (version 2) PSD liquify mesh of `m`. */
export function writeLiquifyMesh(m: PsdMesh): Uint8Array {
  const out = new Uint8Array(24 + m.displacement.length * 4), v = new DataView(out.buffer);
  v.setUint32(0, 2);
  for (let i = 0; i < 8; i++) out[4 + i] = MESH_MAGIC.charCodeAt(i);
  v.setUint32(12, 2, true);
  v.setUint32(16, m.cols, true);
  v.setUint32(20, m.rows, true);
  m.displacement.forEach((x, i) => v.setFloat32(24 + i * 4, x, true));
  return out;
}

// The mesh nodes sit at the centers of cells of the layer rect: node k at x + cell / 2 + k * cell.
function lerp2(d: Float32Array, cols: number, rows: number, gx: number, gy: number, c: number): number {
  const x = Math.min(cols - 1, Math.max(0, gx)), y = Math.min(rows - 1, Math.max(0, gy));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(cols - 1, x0 + 1), y1 = Math.min(rows - 1, y0 + 1), fx = x - x0, fy = y - y0;
  const at = (i: number, j: number) => d[(j * cols + i) * 2 + c];
  return (at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx) * (1 - fy) + (at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx) * fy;
}

const PBLQ_HEADER = 28;
const pblqNodes = (len: number, spacing: number) => Math.max(2, Math.ceil(len / spacing) + 1);

/** The engine's liquify mesh (document px offsets on a grid from the origin) for a PSD mesh over `rect`, and its longest offset. */
export function meshToPblq(m: PsdMesh, rect: Rect, w: number, h: number): { bytes: Uint8Array; reach: number } {
  if (!(rect.w > 0 && rect.h > 0)) throw new Error('The layer has an empty rect.');
  const cw = rect.w / m.cols, ch = rect.h / m.rows;
  let spacing = Math.min(256, Math.max(1, Math.round(Math.min(cw, ch))));
  while (pblqNodes(w, spacing) * pblqNodes(h, spacing) > 1 << 20) spacing *= 2;
  const cols = pblqNodes(w, spacing), rows = pblqNodes(h, spacing);
  const bytes = new Uint8Array(PBLQ_HEADER + cols * rows * 12), v = new DataView(bytes.buffer);
  'PBLQ'.split('').forEach((c, i) => { bytes[i] = c.charCodeAt(0); });
  [1, w, h, spacing, cols, rows].forEach((x, i) => v.setUint32(4 + i * 4, x, true));
  let reach = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gx = (c * spacing + 0.5 - cw / 2 - rect.x) / cw, gy = (r * spacing + 0.5 - ch / 2 - rect.y) / ch;
      const dx = lerp2(m.displacement, m.cols, m.rows, gx, gy, 0) * cw, dy = lerp2(m.displacement, m.cols, m.rows, gx, gy, 1) * ch;
      v.setFloat32(PBLQ_HEADER + (r * cols + c) * 8, dx, true);
      v.setFloat32(PBLQ_HEADER + (r * cols + c) * 8 + 4, dy, true);
      reach = Math.max(reach, Math.hypot(dx, dy));
    }
  }
  return { bytes, reach: Math.min(65535, Math.ceil(reach)) };
}

/** A PSD mesh over `rect` from an engine liquify mesh, on cells of its grid spacing. */
export function pblqToMesh(b: Uint8Array, rect: Rect): PsdMesh {
  if (!(rect.w > 0 && rect.h > 0)) throw new Error('The layer has an empty rect.');
  const bad = new Error('The Liquify mesh is damaged.');
  if (b.length < PBLQ_HEADER || String.fromCharCode(...b.subarray(0, 4)) !== 'PBLQ') throw bad;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), u = (i: number) => v.getUint32(4 + i * 4, true);
  const [spacing, gc, gr] = [u(3), u(4), u(5)];
  if (!spacing || b.length !== PBLQ_HEADER + gc * gr * 12) throw bad;
  const disp = new Float32Array(gc * gr * 2);
  disp.forEach((_, i) => { disp[i] = v.getFloat32(PBLQ_HEADER + i * 4, true); });
  let cell = Math.max(1, spacing);
  const cells = (c: number) => [Math.max(1, Math.ceil(rect.w / c)), Math.max(1, Math.ceil(rect.h / c))];
  while (cells(cell)[0] * cells(cell)[1] > MAX_NODES) cell *= 2;
  const [cols, rows] = cells(cell), cw = rect.w / cols, ch = rect.h / rows;
  const out = new Float32Array(cols * rows * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (rect.x + cw / 2 + c * cw - 0.5) / spacing, y = (rect.y + ch / 2 + r * ch - 0.5) / spacing;
      out[(r * cols + c) * 2] = lerp2(disp, gc, gr, x, y, 0) / cw;
      out[(r * cols + c) * 2 + 1] = lerp2(disp, gc, gr, x, y, 1) / ch;
    }
  }
  return { cols, rows, displacement: out };
}

// ---------- puppet ----------

const PUPPET_MAX_VERTS = 1 << 20;
const PUPPET_MAX_TRIS = 1 << 21;

// The engine's PSD puppet blob (`PSPW`, see engine/src/puppet.rs) of every shape's triangles, and the longest vertex shift.
function puppetBlob(f: Obj): { bytes: Uint8Array; reach: number } {
  const src: number[] = [], dst: number[] = [], idx: number[] = [], depth: number[] = [];
  let reach = 0;
  for (const s of f.puppetShapeList ?? []) {
    const o: Obj[] = s.originalVertexArray, d: Obj[] = s.deformedVertexArray, ix: number[] = s.indexArray, base = src.length / 2;
    if (o.length !== d.length || ix.length % 3) throw new Error('Invalid Puppet Warp topology.');
    for (let i = 0; i < o.length; i++) {
      if (![o[i].x, o[i].y, d[i].x, d[i].y].every(Number.isFinite)) throw new Error('Invalid Puppet Warp vertex.');
      src.push(o[i].x, o[i].y);
      dst.push(d[i].x, d[i].y);
      reach = Math.max(reach, Math.hypot(d[i].x - o[i].x, d[i].y - o[i].y));
    }
    const pins: Obj[] = s.pinPosition ?? [], depths: number[] = s.pinDepth ?? [];
    // The depth pass is triangles x pins, so it is skipped above 1000 pins.
    const deep = pins.length <= 1000 && depths.some((x: number) => x !== 0);
    for (let t = 0; t < ix.length; t += 3) {
      const tri = ix.slice(t, t + 3);
      if (tri.some(i => !Number.isInteger(i) || i < 0 || i >= o.length)) throw new Error('Invalid Puppet Warp triangle.');
      idx.push(...tri.map(i => base + i));
      // The triangle takes the depth of the pin nearest its rest centroid.
      const cx = (o[tri[0]].x + o[tri[1]].x + o[tri[2]].x) / 3, cy = (o[tri[0]].y + o[tri[1]].y + o[tri[2]].y) / 3;
      let best = Infinity, dp = 0;
      for (let p = 0; deep && p < pins.length; p++) {
        const dist = (pins[p].x - cx) ** 2 + (pins[p].y - cy) ** 2;
        if (dist < best) { best = dist; dp = depths[p] ?? 0; }
      }
      depth.push(dp);
    }
  }
  const nv = src.length / 2, nt = idx.length / 3;
  if (nv > PUPPET_MAX_VERTS || nt > PUPPET_MAX_TRIS) throw new Error('The Puppet Warp mesh is too large.');
  const bytes = new Uint8Array(16 + nv * 32 + nt * 16), v = new DataView(bytes.buffer);
  'PSPW'.split('').forEach((c, i) => { bytes[i] = c.charCodeAt(0); });
  [1, nv, nt].forEach((x, i) => v.setUint32(4 + i * 4, x, true));
  [...src, ...dst].forEach((x, i) => v.setFloat64(16 + i * 8, x, true));
  idx.forEach((x, i) => v.setUint32(16 + nv * 32 + i * 4, x, true));
  depth.forEach((x, i) => v.setInt32(16 + nv * 32 + nt * 12 + i * 4, x, true));
  return { bytes, reach: Math.min(65535, Math.ceil(reach)) };
}

// ---------- perspective warp ----------

const pointsIn = (a: Obj[]): [number, number][] => a.map(p => [unit(p.x), unit(p.y)]);
const pointsOut = (a: number[][]) => a.map(([x, y]) => ({ x: px(x), y: px(y) }));

// ---------- curves and brightness/contrast ----------

const CURVE_CHANNELS = ['composite', 'red', 'green', 'blue'] as const;

function curvesIn(f: Extract<Filter, { type: 'curves' }>, warn: Warn): FilterJson {
  const p: Params = { mode: 'point', composite: [[0, 0], [255, 255]], red: null, green: null, blue: null };
  for (const a of f.filter.adjustments ?? []) {
    const pts = 'curve' in a ? a.curve.map(c => [c.x, c.y]) : a.values.map((v, i) => [i, v]);
    if (!('curve' in a)) p.mode = 'pencil';
    for (const ch of a.channels) {
      if ((CURVE_CHANNELS as readonly string[]).includes(ch)) p[ch] = pts;
      else warn('curves smart filter channels other than composite, red, green and blue were not imported');
    }
  }
  return { kind: 'curves', params: p };
}

function curvesOut(p: Params) {
  const adjustments = CURVE_CHANNELS.filter(ch => p[ch]).map(ch => p.mode === 'pencil' && p[ch].length === 256
    ? { channels: [ch], values: (p[ch] as number[][]).map(q => q[1]) }
    : { channels: [ch], curve: (p[ch] as number[][]).map(([x, y]) => ({ x, y })) });
  return { name: 'Curves', type: 'curves', filter: { presetKind: 'custom', adjustments } } as unknown as Partial<Filter>;
}

// ---------- import ----------

/** A `psd_filter` that keeps `f` without rendering it. */
export const opaqueFilter = (f: Filter, cx?: Ctx, params: Params = {}): FilterJson => ({
  kind: 'psd_filter', params: { name: f.name ?? '', ...params }, psd: { filter: dehydrate(f, cx?.e) } as Obj,
});

/**
 * The registry filter for an ag-psd smart filter, with the original object kept in `psd`; a
 * filter the registry has no kind for becomes a `psd_filter` that keeps it.
 */
export function filterIn(f: Filter, warn: Warn, cx?: Ctx): FilterJson {
  if (f.type === 'brightness/contrast') {
    return { kind: 'brightness_contrast', params: { brightness: f.filter.brightness, contrast: f.filter.contrast, legacy: !!f.filter.useLegacy } };
  }
  if (f.type === 'curves') return curvesIn(f, warn);
  const keep = (extra: Obj = {}) => ({ filter: dehydrate(f, cx?.e), ...extra });
  try {
    if (f.type === 'puppet') {
      const { bytes, reach } = puppetBlob(f.filter);
      return opaqueFilter(f, cx, { puppet: Number(cx!.e.blob_add(bytes)), reach });
    }
    if (f.type === 'liquify') {
      if (!cx) return opaqueFilter(f);
      const { bytes, reach } = meshToPblq(parseLiquifyMesh(f.filter.liquifyMesh), cx.rect, cx.w, cx.h);
      const mesh = Number(cx.e.blob_add(bytes));
      return { kind: 'liquify', params: { mesh, reach }, psd: keep({ mesh }) as Obj };
    }
    if (f.type === 'perspective warp') {
      const o = f.filter;
      return { kind: 'perspective_warp', params: { state: { layout: pointsIn(o.vertices), current: pointsIn(o.warpedVertices), quads: o.quads } }, psd: keep() as Obj };
    }
  } catch (e) {
    warn(`the ${f.name} smart filter could not be mapped (${(e as Error).message}) and is kept without its effect`);
    return opaqueFilter(f, cx);
  }
  const s = specForType(f.type);
  return s ? { kind: s.id, params: paramsIn(f, s), psd: keep() as Obj } : opaqueFilter(f, cx);
}

// ---------- export ----------

const refuse = (label: string) => new Error(`Cannot export ${label} as an editable Photoshop filter.`);
const colors = { foregroundColor: { r: 0, g: 0, b: 0 }, backgroundColor: { r: 255, g: 255, b: 255 } };

/** The ag-psd filter for a stack entry: its kept PSD record with the changed params written back, else a default object plus the params. */
export function filterOut(f: SmartFilterOut, cx: Ctx): Filter {
  const { kind, params: p } = f.filter;
  const wrap = { opacity: f.opacity, enabled: f.enabled, blendMode: f.blend } as Obj;
  if (kind === 'brightness_contrast') {
    return { ...wrap, name: 'Brightness/Contrast', hasOptions: true, ...colors, type: 'brightness/contrast', filter: { brightness: p.brightness, contrast: p.contrast, useLegacy: p.legacy } } as Filter;
  }
  if (kind === 'curves') return { ...wrap, hasOptions: true, ...colors, ...curvesOut(p) } as Filter;
  const s = specOf(kind);
  const label = s?.label ?? kind;
  if (kind === 'puppet_warp') throw refuse(label);
  const rec = f.psd?.filter ? (hydrate(f.psd.filter, cx.e) as Filter) : undefined;
  if (kind === 'psd_filter') {
    if (!rec) throw refuse(p.name || label);
    return { ...rec, ...wrap };
  }
  if (kind === 'perspective_warp') {
    const mapped = rec?.type === 'perspective warp' ? { layout: pointsIn(rec.filter.vertices), current: pointsIn(rec.filter.warpedVertices), quads: rec.filter.quads } : undefined;
    if (rec && same(mapped, p.state)) return { ...rec, ...wrap };
    const st = p.state as { layout: number[][]; current: number[][]; quads: number[][] };
    const filter = { vertices: pointsOut(st.layout), warpedVertices: pointsOut(st.current), quads: st.quads };
    return { ...(rec ?? { name: label, hasOptions: true, ...colors }), ...wrap, type: 'perspective warp', filter } as Filter;
  }
  if (kind === 'liquify') {
    if (rec && f.psd?.mesh === p.mesh) return { ...rec, ...wrap };
    const liquifyMesh = writeLiquifyMesh(pblqToMesh(cx.e.tile_bytes(BigInt(p.mesh)), cx.rect));
    return { ...(rec ?? { name: label, hasOptions: true, ...colors }), ...wrap, type: 'liquify', filter: { liquifyMesh } } as Filter;
  }
  if (!s) throw refuse(label);
  let base = rec as Filter | undefined;
  if (!base) {
    const o = DEFAULT_OBJECTS[s.label.toLowerCase()];
    if (o === undefined) throw refuse(label);
    const type = s.label.toLowerCase() === 'dust & scratches' ? 'dust and scratches' : s.label.toLowerCase();
    base = { name: s.label, hasOptions: !!o, ...colors, ...wrap, type, ...(o ? { filter: structuredClone(o) } : {}) } as Filter;
  }
  const out = 'filter' in base || Object.keys(p).length ? paramsOut(base, paramsIn(base, specForType(base.type) ?? s), p) : undefined;
  return { ...base, ...(out && Object.keys(out).length ? { filter: out } : {}), ...wrap } as Filter;
}

// ---------- SoLd hooks ----------

/** The raw placed-layer block (keyed by the layer's `placedLayer` object, which ag-psd's writer shares) of a layer with filters ag-psd dropped, and their names. */
export interface RawSoLd { bytes: Uint8Array; dropped: string[] }

/** `readPsd` that also returns, per placed layer, the raw SoLd block of layers whose filter list ag-psd could not fully parse. */
export function readPsdRaw(bytes: Uint8Array, opts: ReadOptions): { psd: Psd; raw: Map<object, RawSoLd> } {
  const raw = new Map<object, RawSoLd>();
  const h = infoHandlersMap.SoLd, read = h.read;
  h.read = (reader, target, left, psd, res) => {
    const start = reader.offset, size = left();
    read(reader, target, left, psd, res);
    const parsedLayer = target as Layer;
    const parsed = parsedLayer.placedLayer?.filter?.list;
    if (!parsed) return;
    const end = reader.offset;
    try {
      reader.offset = start;
      readSignature(reader);
      readInt32(reader);
      const items: Obj[] = descriptor.readVersionAndDescriptor(reader, true).filterFX?.filterFXList ?? [];
      if (items.length === parsed.length) return;
      const dropped: string[] = [];
      let j = 0;
      for (const it of items) {
        if (parsed[j]?.name === it['Nm  ']) j++;
        else dropped.push(String(it['Nm  '] ?? 'unknown filter'));
      }
      const view = reader.view;
      raw.set(parsedLayer.placedLayer!, { bytes: new Uint8Array(view.buffer, view.byteOffset + start, size).slice(), dropped });
    } finally {
      reader.offset = end;
    }
  };
  try {
    return { psd: readPsd(bytes, opts), raw };
  } finally {
    h.read = read;
  }
}

// ag-psd cannot write the keys of a perspective warp filter (no descriptor type for them). Its item is
// serialized under typed stand-in keys, which the SoLd write hook then renames in the written bytes.
const STAND_IN: [string, string][] = [['Pts ', 'vertices'], ['SbpL', 'warpedVertices'], ['pathComponents', 'quads'], ['Mtrx', 'indices']];
let pending: Obj[] = [];

const keyBytes = (k: string) => {
  const b = k.length === 4 ? [0, 0, 0, 0] : [0, 0, 0, k.length];
  return Uint8Array.from([...b, ...[...k].map(c => c.charCodeAt(0))]);
};

function indexOfBytes(b: Uint8Array, p: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= b.length - p.length; i++) {
    for (let j = 0; j < p.length; j++) if (b[i + j] !== p[j]) continue outer;
    return i;
  }
  return -1;
}

function replaceAll(b: Uint8Array, from: Uint8Array, to: Uint8Array): Uint8Array {
  const out: number[] = [];
  let at = 0;
  for (let i = indexOfBytes(b, from); i >= 0; i = indexOfBytes(b, from, at)) {
    out.push(...b.subarray(at, i), ...to);
    at = i + from.length;
  }
  return Uint8Array.from([...out, ...b.subarray(at)]);
}

/** Prepares a placed layer's filter list for ag-psd's writer: Photoshop's puppet class name and perspective warp items. */
export function prepareList(list: Filter[]) {
  if (!list.some(f => f.type === 'puppet' || f.type === 'perspective warp')) return;
  Object.defineProperty(list, 'map', {
    value(fn: (f: Filter, i: number) => any) {
      const out = Array.prototype.map.call(this, fn) as Obj[];
      for (const d of out) {
        if (d.Fltr?._classID === 'rigidTransform') d.Fltr._name = 'Puppet Warp';
        if (d.Fltr?._classID === 'perspectiveWarpTransform') {
          const q = d.Fltr;
          [q['Pts '], q.SbpL, q.pathComponents] = [q.vertices, q.warpedVertices, q.quads.map((x: Obj) => ({ _name: '', _classID: 'null', Mtrx: x.indices }))];
          delete q.vertices; delete q.warpedVertices; delete q.quads;
          pending.push(d);
        }
      }
      return out;
    },
  });
}

// The written bytes of `d` with each stand-in key renamed.
function renamed(d: Obj, root: string): { from: Uint8Array; to: Uint8Array } {
  const w = createWriter();
  descriptor.writeDescriptorStructure(w, d._name, d._classID, d, root);
  const from = new Uint8Array(w.buffer, 0, w.offset).slice();
  return { from, to: STAND_IN.reduce<Uint8Array>((b, [k, v]) => replaceAll(b, keyBytes(k), keyBytes(v)), from) };
}

/** `writePsd` that writes the given raw SoLd blocks verbatim for their layers. */
export function writePsdRaw(psd: Psd, opts: WriteOptions, raw: Map<object, Uint8Array>): ArrayBuffer {
  const h = infoHandlersMap.SoLd, write = h.write;
  h.write = (writer, target, p, o) => {
    const b = raw.get((target as Layer).placedLayer!);
    if (b) {
      writeBytes(writer, b);
      return;
    }
    const start = writer.offset;
    pending = [];
    write(writer, target, p, o);
    if (!pending.length) return;
    let bytes = new Uint8Array(writer.buffer, start, writer.offset - start).slice();
    for (const d of pending) {
      const { from, to } = renamed(d, 'warp');
      const at = indexOfBytes(bytes, from);
      if (at < 0) throw new Error('Cannot write the perspective warp filter.');
      bytes = Uint8Array.from([...bytes.subarray(0, at), ...to, ...bytes.subarray(at + from.length)]);
    }
    writer.offset = start;
    writeBytes(writer, bytes);
  };
  try {
    return writePsd(psd, opts);
  } finally {
    h.write = write;
    pending = [];
  }
}
