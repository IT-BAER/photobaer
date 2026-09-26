// PSD open/save (M1.md section 6). Runs in the engine worker (no DOM) and in Node test/corpus code.
import { initializeCanvas, readPsd, writePsd, type AdjustmentLayer, type BlendMode, type Color, type Layer, type PixelData, type Psd } from 'ag-psd';
import { Engine } from './engine-pkg/photobaer_engine.js';

let canvasReady = false;
function ensureCanvas() {
  if (canvasReady) return;
  canvasReady = true;
  initializeCanvas(
    () => { throw new Error('canvas not available'); },
    (w, h) => (typeof ImageData !== 'undefined'
      ? new ImageData(w, h)
      : ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } as ImageData)),
  );
}

// Manifest tree shape from Engine.manifest() (M1.md section 2).
interface ManifestNode {
  id: number; name: string; kind: 'pixel' | 'group' | 'adjustment' | 'fill' | 'smart';
  visible: boolean; opacity: number; fill: number; blend: string; clipping: boolean;
  locks: { transparency: boolean; pixels: boolean; position: boolean };
  mask: { enabled: boolean; default: number; tiles?: Sparse } | null;
  tiles?: Sparse;
  children?: ManifestNode[];
  adjustment?: Adjustment;
}

// Engine adjustment params (engine/src/adjust.rs) are in PSD units.
type Adjustment = { kind: string; params: Record<string, any> };
type Rgb = [number, number, number];
interface Stop { position: number; midpoint: number }
interface GradientDef { method: string; color_stops: (Stop & { color: Rgb })[]; opacity_stops: (Stop & { opacity: number })[] }
type PsdGradient = {
  method?: string;
  colorStops?: { color: Color; location: number; midpoint: number }[];
  opacityStops?: { opacity: number; location: number; midpoint: number }[];
};

const LEVELS_DEFAULT = { shadowInput: 0, highlightInput: 255, shadowOutput: 0, highlightOutput: 255, midtoneInput: 1 };
const HUE_NAMES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const;
const HUE_BANDS = [315, 15, 75, 135, 195, 255];
const CMYK_NAMES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'] as const;

function rgbOf(c: Color | undefined, what: string): Rgb {
  if (!c) return [0, 0, 0];
  if (!('r' in c)) throw new Error(`${what} is not an RGB color`);
  return [Math.round(c.r), Math.round(c.g), Math.round(c.b)];
}
const colorOf = ([r, g, b]: Rgb) => ({ r, g, b });

function gradientIn(g: PsdGradient): GradientDef {
  return {
    method: g.method === 'perceptual' || g.method === 'linear' ? g.method : 'classic',
    color_stops: (g.colorStops ?? []).map(s => ({ position: s.location, color: rgbOf(s.color, 'a gradient stop'), midpoint: s.midpoint })),
    opacity_stops: (g.opacityStops ?? []).map(s => ({ position: s.location, opacity: s.opacity, midpoint: s.midpoint })),
  };
}

function gradientOut(g: GradientDef) {
  return {
    colorStops: g.color_stops.map(s => ({ color: colorOf(s.color), location: s.position, midpoint: s.midpoint })),
    opacityStops: g.opacity_stops.map(s => ({ opacity: s.opacity, location: s.position, midpoint: s.midpoint })),
  };
}

// ag-psd adjustment -> engine params; null when the engine has no model for it.
function adjustmentIn(e: Engine, a: AdjustmentLayer): Adjustment | null {
  const lv = (c: typeof LEVELS_DEFAULT) => ({
    input_black: c.shadowInput, input_white: c.highlightInput, gamma: c.midtoneInput, output_black: c.shadowOutput, output_white: c.highlightOutput,
  });
  switch (a.type) {
    case 'brightness/contrast':
      return { kind: 'brightness_contrast', params: { brightness: a.brightness ?? 0, contrast: a.contrast ?? 0, legacy: !!a.useLegacy } };
    case 'levels':
      return { kind: 'levels', params: {
        composite: lv(a.rgb ?? LEVELS_DEFAULT), red: a.red ? lv(a.red) : null, green: a.green ? lv(a.green) : null, blue: a.blue ? lv(a.blue) : null,
      } };
    case 'curves': {
      const chans = [a.rgb, a.red, a.green, a.blue];
      // A pencil curve is stored as its 256 samples.
      const pencil = chans.some(c => c) && chans.every(c => !c || (c.length === 256 && c.every((p, i) => p.input === i)));
      const pts = (c: typeof a.rgb) => c ? c.map(p => [p.input, p.output]) : null;
      return { kind: 'curves', params: {
        mode: pencil ? 'pencil' : 'point', composite: pts(a.rgb) ?? [[0, 0], [255, 255]], red: pts(a.red), green: pts(a.green), blue: pts(a.blue),
      } };
    }
    case 'exposure':
      return { kind: 'exposure', params: { exposure: a.exposure ?? 0, offset: a.offset ?? 0, gamma: a.gamma ?? 1 } };
    case 'vibrance':
      return { kind: 'vibrance', params: { vibrance: a.vibrance ?? 0, saturation: a.saturation ?? 0 } };
    case 'hue/saturation': {
      const m = a.master ?? { a: 0, b: 0, c: 0, d: 0, hue: 0, saturation: 0, lightness: 0 };
      return { kind: 'hue_saturation', params: {
        master: { hue: m.hue, saturation: m.saturation, lightness: m.lightness },
        ranges: HUE_NAMES.map((k, i) => {
          const r = a[k], b = HUE_BANDS[i];
          return r ? { bands: [r.a, r.b, r.c, r.d], hue: r.hue, saturation: r.saturation, lightness: r.lightness }
            : { bands: [b, b + 30, b + 60, b + 90], hue: 0, saturation: 0, lightness: 0 };
        }),
        // The master record's a..d carry the colorize flag and values.
        colorize: m.a !== 0, colorize_values: { hue: m.b, saturation: m.c, lightness: m.d },
      } };
    }
    case 'color balance': {
      const cb = (v?: { cyanRed: number; magentaGreen: number; yellowBlue: number }) => v ? [v.cyanRed, v.magentaGreen, v.yellowBlue] : [0, 0, 0];
      return { kind: 'color_balance', params: {
        shadows: cb(a.shadows), midtones: cb(a.midtones), highlights: cb(a.highlights), preserve_luminosity: !!a.preserveLuminosity,
      } };
    }
    case 'black & white':
      return { kind: 'black_white', params: {
        reds: a.reds ?? 40, yellows: a.yellows ?? 60, greens: a.greens ?? 40, cyans: a.cyans ?? 60, blues: a.blues ?? 20, magentas: a.magentas ?? 80,
        tint: !!a.useTint, tint_color: a.tintColor ? rgbOf(a.tintColor, 'the tint color') : [225, 211, 179],
      } };
    case 'photo filter':
      return { kind: 'photo_filter', params: { color: rgbOf(a.color, 'the photo filter color'), density: a.density ?? 25, preserve_luminosity: !!a.preserveLuminosity } };
    case 'channel mixer': {
      const ch = (c: { red: number; green: number; blue: number; constant: number } | undefined, d: number[]) => c ? [c.red, c.green, c.blue, c.constant] : d;
      return { kind: 'channel_mixer', params: {
        red: ch(a.red, [100, 0, 0, 0]), green: ch(a.green, [0, 100, 0, 0]), blue: ch(a.blue, [0, 0, 100, 0]), gray: ch(a.gray, [40, 40, 20, 0]),
        monochrome: !!a.monochrome,
      } };
    }
    case 'color lookup':
      if (a.lookupType && a.lookupType !== '3dlut') return null;
      return { kind: 'color_lookup', params: {
        name: a.name ?? a.lut3DFileName ?? '', format: a.lutFormat === '3dl' ? '3dl' : 'cube',
        table: a.lut3DFileData?.length ? Number(e.blob_add(a.lut3DFileData)) : null, interpolation: 'trilinear', dither: !!a.dither,
      } };
    case 'invert':
      return { kind: 'invert', params: {} };
    case 'posterize':
      return { kind: 'posterize', params: { levels: a.levels ?? 4 } };
    case 'threshold':
      return { kind: 'threshold', params: { level: a.level ?? 128 } };
    case 'gradient map':
      if (a.gradientType !== 'solid') return null;
      return { kind: 'gradient_map', params: { gradient: gradientIn(a), reverse: !!a.reverse, dither: !!a.dither } };
    case 'selective color': {
      const p: Record<string, unknown> = { mode: a.mode ?? 'relative' };
      for (const k of CMYK_NAMES) { const v = a[k]; p[k] = v ? [v.c, v.m, v.y, v.k] : [0, 0, 0, 0]; }
      return { kind: 'selective_color', params: p };
    }
  }
}

function adjustmentOut(e: Engine, { kind, params: p }: Adjustment, warn: (m: string) => void): AdjustmentLayer {
  const lv = (r: any) => r ? { shadowInput: r.input_black, highlightInput: r.input_white, shadowOutput: r.output_black, highlightOutput: r.output_white, midtoneInput: r.gamma } : undefined;
  const pts = (c: [number, number][] | null) => c?.map(([input, output]) => ({ input, output }));
  switch (kind) {
    case 'brightness_contrast': return { type: 'brightness/contrast', brightness: p.brightness, contrast: p.contrast, useLegacy: p.legacy };
    case 'levels': return { type: 'levels', rgb: lv(p.composite), red: lv(p.red), green: lv(p.green), blue: lv(p.blue) };
    case 'curves': return { type: 'curves', rgb: pts(p.composite), red: pts(p.red), green: pts(p.green), blue: pts(p.blue) };
    case 'exposure': return { type: 'exposure', exposure: p.exposure, offset: p.offset, gamma: p.gamma };
    case 'vibrance': return { type: 'vibrance', vibrance: p.vibrance, saturation: p.saturation };
    case 'hue_saturation': {
      const out: any = { type: 'hue/saturation', master: {
        a: p.colorize ? 256 : 0, b: p.colorize_values.hue, c: p.colorize_values.saturation, d: p.colorize_values.lightness, ...p.master,
      } };
      HUE_NAMES.forEach((k, i) => {
        const r = p.ranges[i];
        out[k] = { a: r.bands[0], b: r.bands[1], c: r.bands[2], d: r.bands[3], hue: r.hue, saturation: r.saturation, lightness: r.lightness };
      });
      return out;
    }
    case 'color_balance': {
      const cb = ([cyanRed, magentaGreen, yellowBlue]: number[]) => ({ cyanRed, magentaGreen, yellowBlue });
      return { type: 'color balance', shadows: cb(p.shadows), midtones: cb(p.midtones), highlights: cb(p.highlights), preserveLuminosity: p.preserve_luminosity };
    }
    case 'black_white': return {
      type: 'black & white', reds: p.reds, yellows: p.yellows, greens: p.greens, cyans: p.cyans, blues: p.blues, magentas: p.magentas,
      useTint: p.tint, tintColor: colorOf(p.tint_color),
    };
    case 'photo_filter': return { type: 'photo filter', color: colorOf(p.color), density: p.density, preserveLuminosity: p.preserve_luminosity };
    case 'channel_mixer': {
      const ch = ([red, green, blue, constant]: number[]) => ({ red, green, blue, constant });
      return { type: 'channel mixer', monochrome: p.monochrome, red: ch(p.red), green: ch(p.green), blue: ch(p.blue), gray: ch(p.gray) };
    }
    case 'color_lookup': return {
      type: 'color lookup', lookupType: '3dlut', name: p.name, dither: p.dither,
      ...(p.table != null ? { lutFormat: p.format, dataOrder: 'rgb', tableOrder: 'rgb', lut3DFileData: e.tile_bytes(BigInt(p.table)), lut3DFileName: p.name } : {}),
    };
    case 'invert': return { type: 'invert' };
    case 'posterize': return { type: 'posterize', levels: p.levels };
    case 'threshold': return { type: 'threshold', level: p.level };
    case 'gradient_map':
      // The PSD library cannot write the interpolation method of a gradient map.
      if (p.gradient.method !== 'classic') warn('gradient map interpolation other than classic is not stored in PSD');
      return { type: 'gradient map', gradientType: 'solid', name: 'Custom', reverse: p.reverse, dither: p.dither, smoothness: 1, ...gradientOut(p.gradient) };
    case 'selective_color': {
      const out: any = { type: 'selective color', mode: p.mode };
      for (const k of CMYK_NAMES) { const [c, m, y, kk] = p[k]; out[k] = { c, m, y, k: kk }; }
      return out;
    }
  }
  throw new Error(`unknown adjustment kind ${kind}`);
}

// A layer's straight RGBA8 tile, cropped to the document, written into `id`'s tiles.
export function place(e: Engine, id: number, l: { imageData?: PixelData; left?: number; top?: number }, w: number, h: number) {
  const img = l.imageData;
  if (!img || img.width === 0 || img.height === 0) return;
  const left = l.left ?? 0, top = l.top ?? 0;
  const x0 = Math.max(0, left), x1 = Math.min(w, left + img.width);
  const y0 = Math.max(0, top), y1 = Math.min(h, top + img.height);
  if (x0 >= x1 || y0 >= y1) return;
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y1 - 1) / 256); ty++) {
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x1 - 1) / 256); tx++) {
      const buf = new Uint8Array(256 * 256 * 4);
      const cx0 = Math.max(x0, tx * 256), cx1 = Math.min(x1, tx * 256 + 256);
      for (let y = Math.max(y0, ty * 256); y < Math.min(y1, ty * 256 + 256); y++) {
        const s = ((y - top) * img.width + (cx0 - left)) * 4;
        buf.set(img.data.subarray(s, s + (cx1 - cx0) * 4), ((y - ty * 256) * 256 + (cx0 - tx * 256)) * 4);
      }
      e.set_tile_rgba8(id, tx, ty, buf);
    }
  }
}

// Mask pixels (red channel) cropped to the document; tiles outside the mask rect keep the node's default.
function placeMask(e: Engine, id: number, m: NonNullable<Layer['mask']>, w: number, h: number) {
  const img = m.imageData;
  if (!img || img.width === 0 || img.height === 0) return;
  const def = m.defaultColor ?? 0;
  const left = m.left ?? 0, top = m.top ?? 0;
  const x0 = Math.max(0, left), x1 = Math.min(w, left + img.width);
  const y0 = Math.max(0, top), y1 = Math.min(h, top + img.height);
  if (x0 >= x1 || y0 >= y1) return;
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y1 - 1) / 256); ty++) {
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x1 - 1) / 256); tx++) {
      const buf = new Uint8Array(256 * 256).fill(def);
      const cx0 = Math.max(x0, tx * 256), cx1 = Math.min(x1, tx * 256 + 256);
      for (let y = Math.max(y0, ty * 256); y < Math.min(y1, ty * 256 + 256); y++) {
        for (let x = cx0; x < cx1; x++) {
          buf[(y - ty * 256) * 256 + (x - tx * 256)] = img.data[((y - top) * img.width + (x - left)) * 4];
        }
      }
      e.set_mask_tile8(id, tx, ty, buf);
    }
  }
}

function locksOf(l: Layer) {
  const p = l.protected;
  return { transparency: !!p?.transparency, pixels: !!p?.composite, position: !!p?.position };
}

function addMaskIfAny(e: Engine, id: number, l: Layer, w: number, h: number) {
  const m = l.mask;
  if (!m) return;
  e.add_mask(id, (m.defaultColor ?? 0) !== 0);
  if (m.disabled) e.set_props(id, JSON.stringify({ mask_enabled: false }));
  placeMask(e, id, m, w, h);
}

function warnKinds(l: Layer, warn: (m: string) => void) {
  if (l.text) warn('text layers were imported as pixels');
  if (l.placedLayer) warn('smart object layers were imported as pixels');
  if (l.effects) warn('layers with effects were imported as pixels');
  if (l.vectorMask || l.realMask) warn('vector mask layers were imported as pixels');
}

function addNode(e: Engine, l: Layer, w: number, h: number, warn: (m: string) => void): number {
  if (l.children) {
    const id = e.add_group(l.name ?? '', 0);
    e.set_props(id, JSON.stringify({
      visible: !l.hidden, opacity: l.opacity ?? 1, fill: l.fillOpacity ?? 1, blend: l.blendMode ?? 'pass through',
      clipping: !!l.clipping, locks: locksOf(l),
    }));
    let idx = 0;
    for (const child of l.children) e.move_node(addNode(e, child, w, h, warn), id, idx++);
    addMaskIfAny(e, id, l, w, h);
    return id;
  }
  const adj = l.adjustment && adjustmentIn(e, l.adjustment);
  if (l.adjustment && !adj) warn('adjustment layers without an engine model were imported as pixels');
  const id = adj ? e.add_special(0, JSON.stringify({ name: l.name ?? '', adjustment: adj })) : e.add_layer(l.name ?? '', 0);
  e.set_props(id, JSON.stringify({
    visible: !l.hidden, opacity: l.opacity ?? 1, fill: l.fillOpacity ?? 1,
    blend: !l.blendMode || l.blendMode === 'pass through' ? 'normal' : l.blendMode,
    clipping: !!l.clipping, locks: locksOf(l),
  }));
  if (!adj) place(e, id, l, w, h);
  addMaskIfAny(e, id, l, w, h);
  warnKinds(l, warn);
  return id;
}

function isEmptyPlaceholder(l: Layer): boolean {
  return !l.children && !l.name && (!l.imageData || l.imageData.width === 0 || l.imageData.height === 0);
}

export function importPsd(bytes: Uint8Array): { engine: Engine; warnings: string[] } {
  ensureCanvas();
  if (bytes.length >= 6 && bytes[4] === 0 && bytes[5] === 2) throw new Error('PSB files are not supported yet');
  // Header depth (offset 22) is checked before decoding, so a large 16-bit file is rejected cheaply.
  if (bytes.length >= 24 && [16, 32].includes(bytes[22] << 8 | bytes[23])) throw new Error('16-bit and 32-bit PSD files are not supported yet');
  const psd = readPsd(bytes, { useImageData: true, skipThumbnail: true });
  if ((psd.bitsPerChannel ?? 8) !== 8) throw new Error('16-bit and 32-bit PSD files are not supported yet');
  if (psd.colorMode !== undefined && psd.colorMode !== 3 && !psd.imageData) throw new Error('Only RGB PSD files are supported');
  const { width: w, height: h } = psd;
  const e = new Engine(w, h, 8);
  try {
    const warnings: string[] = [];
    const warn = (m: string) => { if (!warnings.includes(m)) warnings.push(m); };
    const children = psd.children ?? [];
    // A flat PSD (no real layer records) reads back as [] or, via ag-psd's own writer, as one nameless
    // 0x0 placeholder layer; either way there is nothing to build, so the composite becomes the Background.
    const flat = children.length === 0 || (children.length === 1 && isEmptyPlaceholder(children[0]));
    if (flat) {
      place(e, 1, psd, w, h);
    } else {
      for (const l of children) addNode(e, l, w, h, warn);
      e.delete_node(1);
    }
    return { engine: e, warnings };
  } catch (err) {
    e.free();
    throw err;
  }
}

interface Rect { left: number; top: number; right: number; bottom: number }
const fullCanvas = (w: number, h: number): Rect => ({ left: 0, top: 0, right: w, bottom: h });

// Assembles a rect (document pixel space) from 256x256 tiles, cropping edge tiles to the rect.
function assembleImage(tile: (tx: number, ty: number) => Uint8Array | null, rect: Rect, channels: number, fill: number): Uint8Array {
  const rw = rect.right - rect.left, rh = rect.bottom - rect.top;
  const out = new Uint8Array(Math.max(0, rw) * Math.max(0, rh) * channels).fill(fill);
  for (let ty = Math.floor(rect.top / 256); ty * 256 < rect.bottom; ty++) {
    for (let tx = Math.floor(rect.left / 256); tx * 256 < rect.right; tx++) {
      const buf = tile(tx, ty);
      if (!buf) continue;
      const cx0 = Math.max(rect.left, tx * 256), cx1 = Math.min(rect.right, tx * 256 + 256);
      const cy0 = Math.max(rect.top, ty * 256), cy1 = Math.min(rect.bottom, ty * 256 + 256);
      for (let y = cy0; y < cy1; y++) {
        const s = ((y - ty * 256) * 256 + (cx0 - tx * 256)) * channels;
        const d = ((y - rect.top) * rw + (cx0 - rect.left)) * channels;
        out.set(buf.subarray(s, s + (cx1 - cx0) * channels), d);
      }
    }
  }
  return out;
}

// Manifest v3 tile list: [tx, ty, id] with signed tile coordinates; tiles outside the canvas are not exported.
type Sparse = [number, number, number][];

const tileMap = (ids: Sparse | undefined) => new Map((ids ?? []).map(([tx, ty, id]) => [`${tx},${ty}`, id]));

function tileAt(e: Engine, map: Map<string, number>, tx: number, ty: number): Uint8Array | null {
  const id = map.get(`${tx},${ty}`);
  return id ? e.tile_bytes(BigInt(id)) : null;
}

// Bounding rect (document pixel space, cropped to the canvas) of the non-empty tiles in `ids`, or null if none.
function tileBounds(ids: Sparse | undefined, w: number, h: number): Rect | null {
  const txN = Math.ceil(w / 256), tyN = Math.ceil(h / 256);
  let minTx = Infinity, minTy = Infinity, maxTx = -1, maxTy = -1;
  for (const [tx, ty] of ids ?? []) {
    if (tx < 0 || ty < 0 || tx >= txN || ty >= tyN) continue;
    minTx = Math.min(minTx, tx); minTy = Math.min(minTy, ty);
    maxTx = Math.max(maxTx, tx); maxTy = Math.max(maxTy, ty);
  }
  if (maxTx < 0) return null;
  return { left: minTx * 256, top: minTy * 256, right: Math.min((maxTx + 1) * 256, w), bottom: Math.min((maxTy + 1) * 256, h) };
}

// ag-psd writes a zero-size rect and no channel data for a mask/layer with no imageData (psdWriter.js getLayerChannels/getMaskChannels).
function maskFields(e: Engine, n: ManifestNode, w: number, h: number) {
  if (!n.mask) return {};
  const rect = tileBounds(n.mask.tiles, w, h);
  const base = { defaultColor: n.mask.default, disabled: !n.mask.enabled };
  if (!rect) return { mask: { top: 0, left: 0, ...base } };
  const map = tileMap(n.mask.tiles);
  const gray = assembleImage((tx, ty) => tileAt(e, map, tx, ty), rect, 1, n.mask.default);
  const rw = rect.right - rect.left, rh = rect.bottom - rect.top;
  const rgba = new Uint8ClampedArray(rw * rh * 4);
  for (let i = 0; i < rw * rh; i++) {
    const v = gray[i];
    rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
  }
  return { mask: { top: rect.top, left: rect.left, ...base, imageData: { width: rw, height: rh, data: rgba } } };
}

function exportNode(e: Engine, n: ManifestNode, w: number, h: number, warn: (m: string) => void): Layer {
  const common = {
    name: n.name, hidden: !n.visible, opacity: n.opacity, fillOpacity: n.fill, blendMode: n.blend as BlendMode, clipping: n.clipping,
    protected: { transparency: n.locks.transparency, composite: n.locks.pixels, position: n.locks.position },
    ...maskFields(e, n, w, h),
  };
  if (n.kind === 'group') return { ...common, children: (n.children ?? []).map(c => exportNode(e, c, w, h, warn)) };
  if (n.adjustment) return { ...common, top: 0, left: 0, adjustment: adjustmentOut(e, n.adjustment, warn) };
  const rect = tileBounds(n.tiles, w, h);
  if (!rect) return { ...common, top: 0, left: 0 };
  const map = tileMap(n.tiles);
  const data = assembleImage((tx, ty) => tileAt(e, map, tx, ty), rect, 4, 0);
  const rw = rect.right - rect.left, rh = rect.bottom - rect.top;
  return { ...common, top: rect.top, left: rect.left, imageData: { width: rw, height: rh, data: new Uint8ClampedArray(data.buffer) } };
}

// ag-psd's typed Psd/ImageResources (node_modules/ag-psd/src/psd.ts) only carry alpha-channel
// *names* (imageResources.alphaChannelNames/alphaIdentifiers), not pixel data for extra alpha
// channels; there is no field to round-trip saved-selection channel bitmaps through a PSD.
export function exportPsd(e: Engine): { bytes: Uint8Array<ArrayBuffer>; warnings: string[] } {
  ensureCanvas();
  if (e.depth() !== 8) throw new Error('16-bit PSD export is not supported yet');
  const w = e.width(), h = e.height();
  const manifest = JSON.parse(e.manifest()) as { layers: ManifestNode[] };
  const warnings: string[] = [];
  const warn = (m: string) => { if (!warnings.includes(m)) warnings.push(m); };
  const composite = assembleImage((tx, ty) => e.flatten_tile_rgba8(tx, ty), fullCanvas(w, h), 4, 0);
  const psd: Psd = {
    width: w, height: h, colorMode: 3, bitsPerChannel: 8,
    children: manifest.layers.map(n => exportNode(e, n, w, h, warn)),
    imageData: { width: w, height: h, data: new Uint8ClampedArray(composite.buffer) },
  };
  const channels = (JSON.parse(e.channels_json()) as { channels: { id: number; name: string }[] }).channels;
  if (channels.length) warn('saved selections are not stored in PSD');
  return { bytes: new Uint8Array(writePsd(psd, { generateThumbnail: false })), warnings };
}
