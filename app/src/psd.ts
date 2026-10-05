// PSD open/save (M1.md section 6). Runs in the engine worker (no DOM) and in Node test/corpus code.
import {
  initializeCanvas, type AdjustmentLayer, type BlendMode, type Color, type EffectContour, type Layer, type LayerEffectsInfo,
  type LayerTextData, type LinkedFile, type PixelData, type PlacedLayerFilter, type Psd, type VectorContent,
} from 'ag-psd';
import { Engine } from './engine-pkg/photobaer_engine.js';
import { artboardIn, artboardOut, layoutIn, layoutOut } from './psd/layout.ts';
import { rasterMaskOf, readSavedPaths, shapeIn, shapeOut, vectorMaskIn, vectorMaskOut, writeSavedPaths } from './psd/vector.ts';
import { textIn, textOut } from './psd/text.ts';
import { filterIn, filterOut, prepareList, opaqueFilter, readPsdRaw, writePsdRaw, type FilterJson, type RawSoLd, type SmartFilterOut } from './psd/filters.ts';
import { compositeFit, finishPsd, PSD_MAX_CHANNELS, psdForAgPsd, psdLayerCount, psdTransparency, readPsdChannels, type Depth, type PsdChannel } from './psd/depth.ts';

export { filterIn };

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
  id: number; name: string; kind: 'pixel' | 'group' | 'adjustment' | 'fill' | 'smart' | 'shape' | 'text';
  visible: boolean; opacity: number; fill: number; blend: string; clipping: boolean;
  locks: { transparency: boolean; pixels: boolean; position: boolean };
  mask: { enabled: boolean; default: number; tiles?: Sparse } | null;
  tiles?: Sparse;
  children?: ManifestNode[];
  adjustment?: Adjustment;
  content?: any; style?: any; blending: any; shape?: any; vector_mask?: any; artboard?: any; text?: any;
  smart?: {
    link: any; source: { blob: number | null }; source_size: [number, number]; transform: number[]; warp: unknown;
    filters: SmartFilterOut[]; stack_mask: { enabled: boolean; default: number; tiles?: Sparse } | null;
  };
}

// Engine adjustment params (engine/src/adjust.rs) are in PSD units.
type Adjustment = { kind: string; params: Record<string, any> };
type FilterMasks = NonNullable<Psd['filterEffectsMasks']>;
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
  // Grayscale colors are ink percent (0 white, 100 black).
  if ('k' in c && !('c' in c)) { const g = Math.round(255 * (1 - Math.min(100, Math.max(0, c.k)) / 100)); return [g, g, g]; }
  if (!('r' in c)) throw new Error(`${what} is not an RGB color`);
  return [Math.round(c.r), Math.round(c.g), Math.round(c.b)];
}
const colorOf = ([r, g, b]: Rgb) => ({ r, g, b });

function gradientIn(g: PsdGradient, method = g.method): GradientDef {
  return {
    method: method === 'perceptual' || method === 'linear' ? method : 'classic',
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

// Fill content, layer styles and blending options (docs/M3.md sections 4 and 5). ag-psd gives opacity,
// noise, range, jitter, strength and scale as fractions, sizes and distances as pixel units, spread as percent.
type Warn = (m: string) => void;
const LINEAR = { name: 'Linear', points: [[0, 0], [255, 255]], mode: 'point', anti_alias: false };
const BLACK_WHITE: GradientDef = {
  method: 'classic',
  color_stops: [{ position: 0, color: [0, 0, 0], midpoint: 0.5 }, { position: 1, color: [255, 255, 255], midpoint: 0.5 }],
  opacity_stops: [{ position: 0, opacity: 1, midpoint: 0.5 }, { position: 1, opacity: 1, midpoint: 0.5 }],
};
const BEVEL_STYLES: Record<string, string> = { outer: 'outer bevel', inner: 'inner bevel', emboss: 'emboss', pillow: 'pillow emboss', stroke_emboss: 'stroke emboss' };
const px = (value: number) => ({ units: 'Pixels' as const, value });
const xy = (o?: { x: number; y: number }) => [o?.x ?? 0, o?.y ?? 0];
const snake = (s: string) => s.replace(/ /g, '_');
const spaced = (s: string) => s.replace(/_/g, ' ');

function contourIn(c: EffectContour | undefined, antiAlias?: boolean) {
  if (!c?.curve?.length) return { ...LINEAR, anti_alias: !!antiAlias };
  return { name: c.name, points: c.curve.map(p => [p.x, p.y]), mode: 'point', anti_alias: !!antiAlias };
}
function contourOut(c: any, warn: Warn): EffectContour {
  if (c.mode === 'pencil') warn('pencil contours are saved as smooth curves in PSD');
  return { name: c.name, curve: c.points.map(([x, y]: number[]) => ({ x, y })) };
}

function gradientFillIn(g: any, warn: Warn) {
  if (g.type === 'noise') warn('noise gradients were imported as a black to white gradient');
  return {
    gradient: g.type === 'noise' ? BLACK_WHITE : gradientIn(g, g.interpolationMethod), style: g.style ?? 'linear', angle: g.angle ?? 90,
    scale: g.scale ?? 1, reverse: !!g.reverse, dither: !!g.dither, align_with_layer: g.align ?? true, offset: xy(g.offset),
  };
}
function gradientFillOut(g: any) {
  const [x, y] = g.offset;
  return {
    name: 'Custom', type: 'solid' as const, ...gradientOut(g.gradient), interpolationMethod: g.gradient.method, style: g.style, angle: g.angle,
    scale: g.scale, reverse: g.reverse, dither: g.dither, align: g.align_with_layer, offset: { x, y },
  };
}

// ag-psd reads neither scale nor angle of a pattern fill layer or stroke, and cannot write `linked`.
function patternFillOut(p: any, names: Map<string, string>, warn: Warn) {
  if (p.scale !== 1 || p.angle !== 0 || !p.linked) warn('pattern scale, angle and link of fill layers and strokes are not stored in PSD');
  const [x, y] = p.offset;
  return { type: 'pattern' as const, name: names.get(p.pattern_id) ?? '', id: p.pattern_id, phase: { x, y } };
}

function fillIn(v: VectorContent, pats: Set<string>, warn: Warn) {
  if (v.type === 'color') return { type: 'solid', color: rgbOf(v.color, 'a fill color') };
  if (v.type === 'pattern' && pats.has(v.id)) {
    return { type: 'pattern', pattern_id: v.id, scale: 1, angle: 0, linked: v.linked ?? true, offset: xy(v.phase) };
  }
  if (v.type === 'pattern') {
    warn('fill layers with a missing pattern were imported as black');
    return { type: 'solid', color: [0, 0, 0] };
  }
  return { type: 'gradient', ...gradientFillIn(v, warn) };
}
function fillOut(c: any, names: Map<string, string>, warn: Warn): VectorContent {
  if (c.type === 'solid') return { type: 'color', color: colorOf(c.color) };
  if (c.type === 'gradient') return gradientFillOut(c);
  return patternFillOut(c, names, warn);
}

function shadowIn(s: any, drop: boolean) {
  return {
    present: s.present ?? true, enabled: !!s.enabled, blend: s.blendMode ?? 'multiply', opacity: s.opacity ?? 0.75,
    color: s.color ? rgbOf(s.color, 'a shadow color') : [0, 0, 0], use_global_light: s.useGlobalLight ?? true, angle: s.angle ?? 120,
    distance: s.distance?.value ?? 5, spread: (s.choke?.value ?? 0) / 100, size: s.size?.value ?? 5,
    contour: contourIn(s.contour, s.antialiased), noise: s.noise ?? 0, knocks_out: drop && (s.layerConceals ?? true),
  };
}
function shadowOut(s: any, drop: boolean, warn: Warn) {
  return {
    present: s.present, enabled: s.enabled, blendMode: s.blend, opacity: s.opacity, color: colorOf(s.color), useGlobalLight: s.use_global_light,
    angle: s.angle, distance: px(s.distance), choke: px(s.spread * 100), size: px(s.size), contour: contourOut(s.contour, warn),
    antialiased: s.contour.anti_alias, noise: s.noise, ...(drop ? { layerConceals: s.knocks_out } : {}),
  };
}

function glowIn(g: any, warn: Warn) {
  const grad = g.gradient && g.gradient.type === 'solid';
  if (g.gradient && !grad) warn('noise gradients were imported as a black to white gradient');
  return {
    present: g.present ?? true, enabled: !!g.enabled, blend: g.blendMode ?? 'screen', opacity: g.opacity ?? 0.75,
    fill: grad ? { type: 'gradient', gradient: gradientIn(g.gradient, g.interpolationMethod) }
      : { type: 'color', color: g.color ? rgbOf(g.color, 'a glow color') : [255, 255, 190] },
    technique: g.technique ?? 'softer', spread: (g.choke?.value ?? 0) / 100, size: g.size?.value ?? 5, range: g.range ?? 0.5,
    jitter: g.jitter ?? 0, noise: g.noise ?? 0, contour: contourIn(g.contour, g.antialiased), source: g.source ?? 'edge',
  };
}
function glowOut(g: any, inner: boolean, warn: Warn) {
  const fill = g.fill.type === 'gradient'
    ? { gradient: { name: 'Custom', type: 'solid', ...gradientOut(g.fill.gradient) }, interpolationMethod: g.fill.gradient.method }
    : { color: colorOf(g.fill.color) };
  return {
    present: g.present, enabled: g.enabled, blendMode: g.blend, opacity: g.opacity, ...fill, technique: g.technique, choke: px(g.spread * 100),
    size: px(g.size), range: g.range, jitter: g.jitter, noise: g.noise, contour: contourOut(g.contour, warn), antialiased: g.contour.anti_alias,
    ...(inner ? { source: g.source } : {}),
  };
}

function styleIn(fx: LayerEffectsInfo, warn: Warn) {
  const b: any = fx.bevel, p: any = fx.patternOverlay;
  return {
    enabled: !fx.disabled, scale: fx.scale ?? 1,
    drop_shadows: (fx.dropShadow ?? []).map(s => shadowIn(s, true)), inner_shadows: (fx.innerShadow ?? []).map(s => shadowIn(s, false)),
    color_overlays: (fx.solidFill ?? []).map(c => ({
      present: c.present ?? true, enabled: !!c.enabled, blend: c.blendMode ?? 'normal', opacity: c.opacity ?? 1,
      color: c.color ? rgbOf(c.color, 'an overlay color') : [128, 128, 128],
    })),
    gradient_overlays: (fx.gradientOverlay ?? []).map(g => ({
      present: g.present ?? true, enabled: !!g.enabled, blend: g.blendMode ?? 'normal', opacity: g.opacity ?? 1,
      gradient: gradientFillIn({ ...g, ...g.gradient, style: g.type }, warn),
    })),
    pattern_overlays: p?.pattern ? [{
      present: p.present ?? true, enabled: !!p.enabled, blend: p.blendMode ?? 'normal', opacity: p.opacity ?? 1,
      pattern: { pattern_id: p.pattern.id, scale: p.scale ?? 1, angle: p.angle ?? 0, linked: p.align ?? true, offset: xy(p.phase) },
    }] : [],
    strokes: (fx.stroke ?? []).map(s => ({
      present: s.present ?? true, enabled: !!s.enabled, size: s.size?.value ?? 3, position: s.position ?? 'outside',
      blend: s.blendMode ?? 'normal', opacity: s.opacity ?? 1, overprint: !!s.overprint,
      fill: s.fillType === 'gradient' && s.gradient ? { type: 'gradient', ...gradientFillIn(s.gradient, warn) }
        : s.fillType === 'pattern' && s.pattern
          ? { type: 'pattern', pattern_id: s.pattern.id, scale: 1, angle: 0, linked: (s.pattern as any).linked ?? true, offset: xy((s.pattern as any).phase) }
          : { type: 'solid', color: s.color ? rgbOf(s.color, 'a stroke color') : [0, 0, 0] },
    })),
    outer_glow: fx.outerGlow ? glowIn(fx.outerGlow, warn) : null,
    inner_glow: fx.innerGlow ? glowIn(fx.innerGlow, warn) : null,
    bevel: b ? {
      present: b.present ?? true, enabled: !!b.enabled, style: Object.keys(BEVEL_STYLES).find(k => BEVEL_STYLES[k] === b.style) ?? 'inner',
      technique: snake(b.technique ?? 'smooth'), depth: b.strength ?? 1, direction: b.direction ?? 'up', size: b.size?.value ?? 5,
      soften: b.soften?.value ?? 0, use_global_light: b.useGlobalLight ?? true, angle: b.angle ?? 120, altitude: b.altitude ?? 30,
      gloss_contour: contourIn(b.contour, b.antialiasGloss), highlight_blend: b.highlightBlendMode ?? 'screen',
      highlight_color: b.highlightColor ? rgbOf(b.highlightColor, 'a bevel color') : [255, 255, 255], highlight_opacity: b.highlightOpacity ?? 0.75,
      shadow_blend: b.shadowBlendMode ?? 'multiply', shadow_color: b.shadowColor ? rgbOf(b.shadowColor, 'a bevel color') : [0, 0, 0],
      shadow_opacity: b.shadowOpacity ?? 0.75,
    } : null,
    contour: b?.useShape !== undefined ? { present: true, enabled: !!b.useShape, contour: { ...LINEAR, anti_alias: true }, range: b.range ?? 1 } : null,
    texture: b?.useTexture !== undefined && b.pattern ? {
      present: true, enabled: !!b.useTexture, pattern_id: b.pattern.id, scale: b.scale ?? 1, depth: 1, invert: !!b.invert,
      linked: b.align ?? true, offset: xy(b.phase),
    } : null,
    satin: fx.satin ? {
      present: fx.satin.present ?? true, enabled: !!fx.satin.enabled, blend: fx.satin.blendMode ?? 'multiply', opacity: fx.satin.opacity ?? 0.5,
      color: fx.satin.color ? rgbOf(fx.satin.color, 'a satin color') : [0, 0, 0], angle: fx.satin.angle ?? 19,
      distance: fx.satin.distance?.value ?? 11, size: fx.satin.size?.value ?? 14, contour: contourIn(fx.satin.contour, fx.satin.antialiased),
      invert: fx.satin.invert ?? true,
    } : null,
  };
}

function styleOut(st: any, names: Map<string, string>, warn: Warn): LayerEffectsInfo {
  const out: any = {
    disabled: !st.enabled, scale: st.scale,
    dropShadow: st.drop_shadows.map((s: any) => shadowOut(s, true, warn)), innerShadow: st.inner_shadows.map((s: any) => shadowOut(s, false, warn)),
    solidFill: st.color_overlays.map((c: any) => ({ present: c.present, enabled: c.enabled, blendMode: c.blend, opacity: c.opacity, color: colorOf(c.color) })),
    gradientOverlay: st.gradient_overlays.map((g: any) => {
      const { interpolationMethod, style, angle, scale, reverse, dither, align, offset, ...gradient } = gradientFillOut(g.gradient);
      return { present: g.present, enabled: g.enabled, blendMode: g.blend, opacity: g.opacity, gradient, interpolationMethod, type: style, angle, scale, reverse, dither, align, offset };
    }),
    stroke: st.strokes.map((s: any) => {
      const base = { present: s.present, enabled: s.enabled, size: px(s.size), position: s.position, blendMode: s.blend, opacity: s.opacity, overprint: s.overprint };
      if (s.fill.type === 'solid') return { ...base, fillType: 'color', color: colorOf(s.fill.color) };
      if (s.fill.type === 'gradient') return { ...base, fillType: 'gradient', gradient: gradientFillOut(s.fill) };
      const { name, id, phase } = patternFillOut(s.fill, names, warn);
      return { ...base, fillType: 'pattern', pattern: { name, id, phase } };
    }),
  };
  if (st.pattern_overlays.length > 1) warn('only the first pattern overlay is stored in PSD');
  const p = st.pattern_overlays[0];
  if (p) {
    const [x, y] = p.pattern.offset;
    out.patternOverlay = {
      present: p.present, enabled: p.enabled, blendMode: p.blend, opacity: p.opacity, pattern: { name: names.get(p.pattern.pattern_id) ?? '', id: p.pattern.pattern_id },
      scale: p.pattern.scale, angle: p.pattern.angle, align: p.pattern.linked, phase: { x, y },
    };
  }
  if (st.outer_glow) out.outerGlow = glowOut(st.outer_glow, false, warn);
  if (st.inner_glow) out.innerGlow = glowOut(st.inner_glow, true, warn);
  const b = st.bevel, c = st.contour, t = st.texture;
  if (b) {
    out.bevel = {
      present: b.present, enabled: b.enabled, style: BEVEL_STYLES[b.style], technique: spaced(b.technique), strength: b.depth, direction: b.direction,
      size: px(b.size), soften: px(b.soften), useGlobalLight: b.use_global_light, angle: b.angle, altitude: b.altitude,
      contour: contourOut(b.gloss_contour, warn), antialiasGloss: b.gloss_contour.anti_alias,
      highlightBlendMode: b.highlight_blend, highlightColor: colorOf(b.highlight_color), highlightOpacity: b.highlight_opacity,
      shadowBlendMode: b.shadow_blend, shadowColor: colorOf(b.shadow_color), shadowOpacity: b.shadow_opacity,
    };
    if (c) {
      if (JSON.stringify(c.contour.points) !== JSON.stringify(LINEAR.points)) warn('bevel contour curves are not stored in PSD');
      Object.assign(out.bevel, { useShape: c.enabled, range: c.range });
    }
    if (t) {
      if (t.depth !== 1) warn('bevel texture depth is not stored in PSD');
      const [x, y] = t.offset;
      Object.assign(out.bevel, {
        useTexture: t.enabled, pattern: { name: names.get(t.pattern_id) ?? '', id: t.pattern_id }, scale: t.scale, invert: t.invert, align: t.linked, phase: { x, y },
      });
    }
  }
  const s = st.satin;
  if (s) {
    out.satin = {
      present: s.present, enabled: s.enabled, blendMode: s.blend, opacity: s.opacity, color: colorOf(s.color), angle: s.angle,
      distance: px(s.distance), size: px(s.size), contour: contourOut(s.contour, warn), antialiased: s.contour.anti_alias, invert: s.invert,
    };
  }
  return out;
}

const RANGE_DEFAULT = [0, 0, 255, 255];
function blendingIn(l: Layer) {
  const r = l.blendingRanges, rs = r?.ranges ?? [];
  const range = (s?: number[], d?: number[]) => ({ source: s ?? RANGE_DEFAULT, destination: d ?? RANGE_DEFAULT });
  const restricted = l.channelBlendingRestrictions ?? [];
  return {
    blend_if: {
      gray: range(r?.compositeGrayBlendSource, r?.compositeGraphBlendDestinationRange),
      red: range(rs[0]?.sourceRange, rs[0]?.destRange), green: range(rs[1]?.sourceRange, rs[1]?.destRange), blue: range(rs[2]?.sourceRange, rs[2]?.destRange),
    },
    channels: [0, 1, 2].map(c => !restricted.includes(c)), knockout: l.knockout ? 'shallow' : 'none',
    blend_interior: !!l.blendInteriorElements, blend_clipped: l.blendClippendElements ?? true, transparency_shapes: l.transparencyShapesLayer ?? true,
    layer_mask_hides_effects: false, vector_mask_hides_effects: false,
  };
}
// Mask-hides-effects is not written (docs/M3.md section 5).
function blendingOut(b: any, warn: Warn): Partial<Layer> {
  if (b.knockout === 'deep') warn('deep knockout is saved as shallow in PSD');
  const restricted = [0, 1, 2].filter(c => !b.channels[c]);
  // ag-psd drops the last entry when it reads `brst` back.
  if (restricted.length) warn('blending channel restrictions are not fully read back from PSD');
  const bi = b.blend_if;
  return {
    blendingRanges: {
      compositeGrayBlendSource: bi.gray.source, compositeGraphBlendDestinationRange: bi.gray.destination,
      ranges: [bi.red, bi.green, bi.blue].map((r: any) => ({ sourceRange: r.source, destRange: r.destination })),
    },
    ...(restricted.length ? { channelBlendingRestrictions: restricted } : {}),
    knockout: b.knockout !== 'none', blendInteriorElements: b.blend_interior, blendClippendElements: b.blend_clipped, transparencyShapesLayer: b.transparency_shapes,
  };
}

// Source px -> document projective transform (row-major 3x3) mapping the source rect onto the corner quad
// [x0, y0 (top left), x1, y1, x2, y2, x3, y3 (bottom left)].
function quadTransform(q: number[], w: number, h: number): number[] {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q;
  const dx3 = x0 - x1 + x2 - x3, dy3 = y0 - y1 + y2 - y3;
  let g = 0, k = 0;
  if (dx3 !== 0 || dy3 !== 0) {
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    k = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return [(x1 - x0 + g * x1) / w, (x3 - x0 + k * x3) / h, x0, (y1 - y0 + g * y1) / w, (y3 - y0 + k * y3) / h, y0, g / w, k / h, 1];
}
function quadOf(t: number[], w: number, h: number): number[] {
  return [[0, 0], [w, 0], [w, h], [0, h]].flatMap(([x, y]) => {
    const d = t[6] * x + t[7] * y + t[8];
    return [(t[0] * x + t[1] * y + t[2]) / d, (t[3] * x + t[4] * y + t[5]) / d];
  });
}
// ag-psd writes an identity custom mesh when a placed layer has no warp.
function isIdentityWarp(wp: any): boolean {
  if (!wp || wp.style === 'none') return true;
  const pts = wp.customEnvelopeWarp?.meshPoints, b = wp.bounds;
  if (wp.style !== 'custom' || !pts || pts.length !== 16 || !b) return false;
  const [l, t, r, btm] = [b.left.value, b.top.value, b.right.value, b.bottom.value];
  return pts.every((p: { x: number; y: number }, i: number) =>
    Math.abs(p.x - (l + (r - l) * (i % 4) / 3)) < 1e-6 && Math.abs(p.y - (t + (btm - t) * Math.floor(i / 4) / 3)) < 1e-6);
}

function smartIn(e: Engine, l: Layer, files: Map<string, LinkedFile>, warn: Warn) {
  const pl = l.placedLayer!;
  const f = files.get(pl.id);
  if (!f) warn('smart object sources missing from the file were not imported');
  if (!isIdentityWarp(pl.warp)) warn('smart object warps were not imported');
  const w = Math.max(1, Math.round(pl.width ?? l.imageData?.width ?? 1)), h = Math.max(1, Math.round(pl.height ?? l.imageData?.height ?? 1));
  return {
    link: f && !f.data ? { type: 'linked', name: f.linkedFile?.fullPath || f.name, handle: '' } : { type: 'embedded', id: pl.id },
    source_blob: f?.data?.length ? Number(e.blob_add(f.data)) : null, source_size: [w, h],
    transform: quadTransform(pl.nonAffineTransform ?? pl.transform, w, h),
  };
}
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A layer's straight RGBA8 tile, cropped to the document, written into `id`'s tiles.
// 16-bit samples as Uint16Array, 32-bit as Float32Array (ag-psd), 8-bit as bytes.
type Samples = Uint8ClampedArray | Uint8Array | Uint16Array | Float32Array;
const asBytes = (a: Uint16Array | Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const toRgba8 = (d: Samples) =>
  d instanceof Uint16Array ? Uint8Array.from(d, v => Math.round(v / 257)) : d instanceof Float32Array ? Uint8Array.from(d, v => Math.round(Math.min(1, Math.max(0, v)) * 255)) : d;

// Straight RGBA into layer `id`: 16/32-bit samples as the document's own tiles, unless `rgba8` (text layer caches).
export function place(e: Engine, id: number, l: { imageData?: PixelData; left?: number; top?: number }, w: number, h: number, rgba8 = false) {
  const img = l.imageData;
  if (!img || img.width === 0 || img.height === 0) return;
  const src = (rgba8 ? toRgba8(img.data as Samples) : img.data) as Samples;
  const left = l.left ?? 0, top = l.top ?? 0;
  const x0 = Math.max(0, left), x1 = Math.min(w, left + img.width);
  const y0 = Math.max(0, top), y1 = Math.min(h, top + img.height);
  if (x0 >= x1 || y0 >= y1) return;
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y1 - 1) / 256); ty++) {
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x1 - 1) / 256); tx++) {
      const buf = src instanceof Uint16Array ? new Uint16Array(256 * 256 * 4) : src instanceof Float32Array ? new Float32Array(256 * 256 * 4) : new Uint8Array(256 * 256 * 4);
      const cx0 = Math.max(x0, tx * 256), cx1 = Math.min(x1, tx * 256 + 256);
      for (let y = Math.max(y0, ty * 256); y < Math.min(y1, ty * 256 + 256); y++) {
        const s = ((y - top) * img.width + (cx0 - left)) * 4;
        buf.set(src.subarray(s, s + (cx1 - cx0) * 4), ((y - ty * 256) * 256 + (cx0 - tx * 256)) * 4);
      }
      if (buf instanceof Uint8Array) e.set_tile_rgba8(id, tx, ty, buf);
      else e.set_tile_bytes('pixels', id, tx, ty, asBytes(buf));
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
  // 16/32-bit masks (Uint16Array, Float32Array) go in as 16-bit mask tiles.
  const data = img.data as Samples;
  const wide = data instanceof Uint16Array || data instanceof Float32Array;
  const at = (i: number) => (data instanceof Float32Array ? Math.round(Math.min(1, Math.max(0, data[i])) * 65535) : data[i]);
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y1 - 1) / 256); ty++) {
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x1 - 1) / 256); tx++) {
      const buf = wide ? new Uint16Array(256 * 256).fill(def * 257) : new Uint8Array(256 * 256).fill(def);
      const cx0 = Math.max(x0, tx * 256), cx1 = Math.min(x1, tx * 256 + 256);
      for (let y = Math.max(y0, ty * 256); y < Math.min(y1, ty * 256 + 256); y++) {
        for (let x = cx0; x < cx1; x++) {
          buf[(y - ty * 256) * 256 + (x - tx * 256)] = at(((y - top) * img.width + (x - left)) * 4);
        }
      }
      if (buf instanceof Uint16Array) e.set_tile_bytes('mask', id, tx, ty, asBytes(buf));
      else e.set_mask_tile8(id, tx, ty, buf);
    }
  }
}

function locksOf(l: Layer) {
  const p = l.protected;
  return { transparency: !!p?.transparency, pixels: !!p?.composite, position: !!p?.position };
}

function addMaskIfAny(e: Engine, id: number, l: Layer, w: number, h: number) {
  const m = rasterMaskOf(l);
  if (!m) return;
  e.add_mask(id, (m.defaultColor ?? 0) !== 0);
  if (m.disabled) e.set_props(id, JSON.stringify({ mask_enabled: false }));
  placeMask(e, id, m, w, h);
}


// A smart object source that needs an async image decoder (the worker's), keyed by node id.
export interface PendingSource { id: number; bytes: Uint8Array }
interface ImportCtx {
  e: Engine; w: number; h: number; warn: Warn; files: Map<string, LinkedFile>; pats: Set<string>; comps: Map<Layer, number>; sources: PendingSource[];
  fx: FilterMasks; raw: Map<object, RawSoLd>;
  res: number; guides: ReturnType<typeof layoutIn>['guides'];
}

// PackBits rows with 16-bit (PSD) byte counts; null for other layouts.
function unpackRows(data: Uint8Array, w: number, h: number): Uint8Array | null {
  const out = new Uint8Array(w * h);
  let src = h * 2, dst = 0;
  for (let y = 0; y < h; y++) {
    const end = src + ((data[y * 2] << 8) | data[y * 2 + 1]);
    while (src < end) {
      const n = data[src++];
      if (n < 128) { out.set(data.subarray(src, src + n + 1), dst); src += n + 1; dst += n + 1; }
      else if (n > 128) { out.fill(data[src++], dst, dst + 257 - n); dst += 257 - n; }
    }
    if (dst !== (y + 1) * w) return null;
  }
  return out;
}

// The layer's pixel rect in document px; the document when the layer has none.
const layerRect = (l: Layer, w: number, h: number) => {
  const x = l.left ?? 0, y = l.top ?? 0, rw = (l.right ?? x) - x, rh = (l.bottom ?? y) - y;
  return rw > 0 && rh > 0 ? { x, y, w: rw, h: rh } : { x: 0, y: 0, w, h };
};

const linkKey = (l: { type: string; id?: string; name?: string; handle?: string }) => (l.type === 'embedded' ? `e:${l.id}` : `l:${l.name}|${l.handle ?? ''}`);
const placementOf = (p: NonNullable<Layer['placedLayer']>) => p.nonAffineTransform ?? p.transform;
const stackOf = (fs: SmartFilterOut[]) => fs.map(f => [f.filter.kind, f.filter.params, f.enabled, f.opacity, f.blend]);

// Imports a placed layer's filters and its stack mask (the filter effects entry's user mask channel).
function filtersIn(c: ImportCtx, id: number, l: Layer) {
  const pf = l.placedLayer?.filter;
  const raw = c.raw.get(l.placedLayer!);
  if (!pf || (!pf.list.length && !raw)) return;
  const cx = { e: c.e, w: c.w, h: c.h, rect: layerRect(l, c.w, c.h) };
  const add = (a: FilterJson) => c.e.add_smart_filter(id, JSON.stringify(a));
  // PSD lists the stack top first.
  for (const f of [...pf.list].reverse()) {
    const a = filterIn(f, c.warn, cx);
    let fid: number;
    try {
      fid = add(a);
    } catch {
      c.warn(`the ${f.name} smart filter was kept without its effect because the engine refused its values`);
      try {
        fid = add(opaqueFilter(f, cx));
      } catch {
        c.warn(`the ${f.name} smart filter was not imported`);
        continue;
      }
    }
    c.e.set_smart_filter(id, fid, JSON.stringify({ enabled: f.enabled, opacity: f.opacity, blend: f.blendMode ?? 'normal' }));
  }
  if (raw) {
    // Filters ag-psd cannot read stay in the raw block, which export writes back while the placement and the other filters are unchanged.
    c.warn(`smart filters ag-psd cannot read are kept without their effect: ${raw.dropped.join(', ')}`);
    const stack = stackOf((JSON.parse(c.e.manifest()).layers as ManifestNode[]).flatMap(function find(n): SmartFilterOut[] { return n.id === id ? n.smart!.filters : (n.children ?? []).flatMap(find); }));
    const smart = (JSON.parse(c.e.manifest()).layers as ManifestNode[]).flatMap(function find(n): ManifestNode[] { return n.id === id ? [n] : (n.children ?? []).flatMap(find); })[0].smart!;
    const dropped = { names: raw.dropped, raw: { $blob: Number(c.e.blob_add(raw.bytes)) }, placement: placementOf(l.placedLayer!), stack, link: smart.link, size: smart.source_size };
    add({ kind: 'psd_filter', params: { name: raw.dropped.join(', ') }, psd: { dropped } });
  }
  const pid = l.placedLayer!.placed ?? l.placedLayer!.id;
  const m = c.fx.find(x => x.id === pid);
  const ch = m?.channels[m.channels.length - 2];
  if (!m || !ch) return;
  const mw = m.right - m.left, mh = m.bottom - m.top;
  const data = ch.compressionMode === 0 ? ch.data : ch.compressionMode === 1 ? unpackRows(ch.data, mw, mh) : null;
  if (!data || data.length < mw * mh) { c.warn('smart filter masks were not imported'); return; }
  const def = pf.maskExtendWithWhite === false ? 0 : 255;
  c.e.add_filter_mask(id, 0, def === 255);
  const x0 = Math.max(0, m.left), x1 = Math.min(c.w, m.right), y0 = Math.max(0, m.top), y1 = Math.min(c.h, m.bottom);
  for (let ty = Math.floor(y0 / 256); ty * 256 < y1; ty++) {
    for (let tx = Math.floor(x0 / 256); tx * 256 < x1; tx++) {
      const buf = new Uint8Array(256 * 256).fill(def);
      for (let y = Math.max(y0, ty * 256); y < Math.min(y1, ty * 256 + 256); y++) {
        for (let x = Math.max(x0, tx * 256); x < Math.min(x1, tx * 256 + 256); x++) buf[(y - ty * 256) * 256 + x - tx * 256] = data[(y - m.top) * mw + x - m.left];
      }
      c.e.set_filter_mask_tile8(id, 0, tx, ty, buf);
    }
  }
  if (pf.maskEnabled === false) c.e.toggle_filter_masks(id);
}

export const isPsdBytes = (b: Uint8Array) => b.length >= 4 && b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53;

// The flattened composite as straight RGBA8, width x height x 4.
export function compositeRgba(e: Engine): Uint8Array {
  return assembleImage((tx, ty) => e.flatten_tile_rgba8(tx, ty), fullCanvas(e.width(), e.height()), 4, 0);
}

// Source pixels of an imported smart object: PSD/PSB bytes are parsed and flattened now, image
// bytes wait for the caller's decoder. The layer pixels stay its cache.
function loadSource(c: ImportCtx, id: number, bytes: Uint8Array, size: [number, number]) {
  if (!isPsdBytes(bytes)) { c.sources.push({ id, bytes }); return; }
  let sub: Engine;
  try {
    sub = importPsd(bytes, { psb: true }).engine;
  } catch {
    c.warn('smart object sources that could not be read were not imported');
    return;
  }
  try {
    if (sub.width() !== size[0] || sub.height() !== size[1]) c.warn('smart object sources of a different size were not imported');
    else c.e.load_smart_source(id, compositeRgba(sub));
  } finally {
    sub.free();
  }
}

// Blending options and layer style, shared by every kind; adjustment layers take no style.
function addM3Props({ e, warn, pats }: ImportCtx, id: number, l: Layer, adjustment: boolean) {
  e.set_blending(id, JSON.stringify(blendingIn(l)));
  if (!l.effects || adjustment) return;
  const st = styleIn(l.effects, warn);
  // Photoshop keeps unused effect slots that name presets the file does not embed; only enabled ones warn.
  let lost = false;
  const keep = (fx: any, pattern: string) => pats.has(pattern) || (lost ||= fx.enabled, false);
  st.pattern_overlays = st.pattern_overlays.filter(p => keep(p, p.pattern.pattern_id));
  st.strokes = st.strokes.filter(s => s.fill.type !== 'pattern' || keep(s, (s.fill as any).pattern_id));
  if (st.texture && !keep(st.texture, st.texture.pattern_id)) st.texture = null;
  if (lost) warn('pattern effects that use a missing pattern were not imported');
  e.set_style(id, JSON.stringify(st));
}

// A type layer that cannot be mapped or that the engine refuses stays a pixel layer with its PSD pixels.
function addSpecial(e: Engine, name: string, special: object, res: number, warn: Warn): number {
  if (!('text' in special)) return e.add_special(0, JSON.stringify({ name, ...special }));
  try {
    return e.add_special(0, JSON.stringify({ name, text: textIn(special.text as LayerTextData, res, warn) }));
  } catch {
    warn('text layers with unsupported values were imported as pixels');
    return e.add_layer(name, 0);
  }
}

function addNode(c: ImportCtx, l: Layer): number {
  const { e, w, h, warn } = c;
  if (l.children) {
    const id = e.add_group(l.name ?? '', 0);
    e.set_props(id, JSON.stringify({
      visible: !l.hidden, opacity: l.opacity ?? 1, fill: l.fillOpacity ?? 1, blend: l.blendMode ?? 'pass through',
      clipping: !!l.clipping, locks: locksOf(l),
    }));
    let idx = 0;
    for (const child of l.children) e.move_node(addNode(c, child), id, idx++);
    addMaskIfAny(e, id, l, w, h);
    const vm = vectorMaskIn(l, w, h);
    if (vm) e.set_vector_mask(id, JSON.stringify(vm));
    addM3Props(c, id, l, false);
    c.comps.set(l, id);
    return id;
  }
  const adj = l.adjustment && adjustmentIn(e, l.adjustment);
  if (l.adjustment && !adj) warn('adjustment layers without an engine model were imported as pixels');
  // A shape layer is fill content plus a vector mask; it renders from its path, not its stored raster.
  // Density, feather, invert or disable shows the fill outside the path, which only a fill layer
  // with a vector mask renders (corpus layer_mask_data); a stroked one stays a shape without them.
  const soft = (l.mask?.vectorMaskDensity ?? 1) < 1 || (l.mask?.vectorMaskFeather ?? 0) > 0 || !!l.vectorMask?.invert || !!l.vectorMask?.disable;
  const stroked = !!l.vectorStroke && l.vectorStroke.strokeEnabled !== false;
  if (soft && stroked && l.vectorFill && l.vectorMask) warn('vector mask density, feather, invert and disable of stroked shape layers were dropped');
  const shape = !adj && l.vectorFill && l.vectorMask && (!soft || stroked) ? shapeIn(l, c.res, w, h, v => fillIn(v, c.pats, warn)) : null;
  const special = adj ? { adjustment: adj } : shape ? null : l.text ? { text: l.text }
    : l.vectorFill ? { content: fillIn(l.vectorFill, c.pats, warn) } : l.placedLayer ? { smart: smartIn(e, l, c.files, warn) } : null;
  const id = special || shape ? addSpecial(e, l.name ?? '', special ?? { shape }, c.res, warn) : e.add_layer(l.name ?? '', 0);
  const data = l.placedLayer && c.files.get(l.placedLayer.id)?.data;
  if (special && 'smart' in special && special.smart && data?.length) loadSource(c, id, data, special.smart.source_size as [number, number]);
  if (special && 'smart' in special) filtersIn(c, id, l);
  e.set_props(id, JSON.stringify({
    visible: !l.hidden, opacity: l.opacity ?? 1, fill: l.fillOpacity ?? 1,
    blend: !l.blendMode || l.blendMode === 'pass through' ? 'normal' : l.blendMode,
    clipping: !!l.clipping, locks: locksOf(l),
  }));
  // Smart object and text layer pixels become their cache (D5); fill and adjustment layers render from their params.
  if (!shape && (!special || 'smart' in special || 'text' in special)) place(e, id, l, w, h, !!special && 'text' in special);
  addMaskIfAny(e, id, l, w, h);
  const vm = shape ? null : vectorMaskIn(l, w, h);
  if (vm) e.set_vector_mask(id, JSON.stringify(vm));
  addM3Props(c, id, l, !!adj);
  c.comps.set(l, id);
  return id;
}

// Document patterns and global light (image resources 1037/1049, default 120/30).
function importDocument(e: Engine, psd: Psd): Set<string> {
  const patterns = (psd.patterns ?? []).map(p => ({
    id: p.id, name: p.name, width: p.bounds.w, height: p.bounds.h, blob: Number(e.blob_add(p.data)),
  }));
  const r = psd.imageResources;
  e.set_document_m3(JSON.stringify({ global_light: { angle: r?.globalAngle ?? 120, altitude: r?.globalAltitude ?? 30 }, patterns }));
  return new Set(patterns.map(p => p.id));
}

// PSD layer comps: the standard comp list (image resource 1065) plus each layer's `comps.settings`
// (M3.md section 8, B12 gap notes). Appearance (opacity, fill, blend, style) is not carried by
// ag-psd's comp model; a reopened comp gets each layer's current value for that part.
function importLayerComps(c: ImportCtx, psd: Psd) {
  const list = psd.imageResources?.layerComps?.list;
  if (!list?.length) return;
  const { e, w, h } = c;
  const manifest = JSON.parse(e.manifest()) as { layers: ManifestNode[] };
  type Default = { visible: boolean; position: [number, number] | null; opacity: number; fill: number; blend: string; style: unknown };
  const defaults = new Map<number, Default>();
  const walk = (nodes: ManifestNode[]) => {
    for (const n of nodes) {
      const rect = tileBounds(n.tiles, w, h);
      defaults.set(n.id, { visible: n.visible, position: rect ? [rect.left, rect.top] : null, opacity: n.opacity, fill: n.fill, blend: n.blend, style: n.style ?? null });
      if (n.children) walk(n.children);
    }
  };
  walk(manifest.layers);
  const layers = new Map(list.map(l => [l.id, [] as unknown[]]));
  for (const [layer, id] of c.comps) {
    const def = defaults.get(id);
    if (!def || !layer.comps?.settings) continue;
    for (const s of layer.comps.settings) {
      for (const compId of s.compList) {
        const arr = layers.get(compId);
        if (!arr) continue;
        // The offset is relative to the layer record's origin, where `place()` wrote the pixels.
        const base = def.position && [layer.left ?? 0, layer.top ?? 0];
        const position = s.offset && base ? [base[0] + s.offset.x, base[1] + s.offset.y] : base;
        arr.push({ id, visible: s.enabled ?? def.visible, position, opacity: def.opacity, fill: def.fill, blend: def.blend, style: def.style });
      }
    }
  }
  const layer_comps = list.map(l => ({
    id: l.id, name: l.name, comment: l.comment ?? '',
    apply_visibility: !!(l.capturedInfo & 1), apply_position: !!(l.capturedInfo & 2), apply_appearance: !!(l.capturedInfo & 4),
    layers: layers.get(l.id) ?? [],
  }));
  e.set_document_m3(JSON.stringify({ layer_comps }));
}

// The composite's alpha and spot channels (CH4). Ours select white, so Selected Areas channels invert.
function channelsIn(e: Engine, bytes: Uint8Array, warn: Warn) {
  const { channels, depth, warnings } = readPsdChannels(bytes);
  warnings.forEach(warn);
  const w = e.width(), h = e.height();
  for (const c of channels) {
    const id = c.kind === 2 ? e.new_spot_channel(c.name, Uint8Array.from(c.color), c.opacity / 100) : e.new_channel(c.name);
    const v = new DataView(c.plane.buffer, c.plane.byteOffset, c.plane.byteLength);
    const max = depth === 8 ? 255 : 65535;
    const at = (i: number) => {
      const x = depth === 8 ? c.plane[i] : depth === 16 ? v.getUint16(i * 2) : Math.round(Math.min(1, Math.max(0, v.getFloat32(i * 4))) * max);
      return c.kind === 0 ? max - x : x;
    };
    for (let ty = 0; ty * 256 < h; ty++) {
      for (let tx = 0; tx * 256 < w; tx++) {
        const buf = depth === 8 ? new Uint8Array(256 * 256) : new Uint16Array(256 * 256);
        buf.fill(c.kind === 2 ? max : 0);
        for (let y = ty * 256; y < Math.min(h, ty * 256 + 256); y++) {
          for (let x = tx * 256; x < Math.min(w, tx * 256 + 256); x++) buf[(y - ty * 256) * 256 + x - tx * 256] = at(y * w + x);
        }
        e.set_tile_bytes('channel', id, tx, ty, buf instanceof Uint16Array ? asBytes(buf) : buf);
      }
    }
  }
}

function isEmptyPlaceholder(l: Layer): boolean {
  return !l.children && !l.name && (!l.imageData || l.imageData.width === 0 || l.imageData.height === 0);
}

// `psb` accepts PSB (large document) files too, for smart object sources.
export function importPsd(bytes: Uint8Array, opts: { psb?: boolean } = {}): { engine: Engine; warnings: string[]; sources: PendingSource[] } {
  ensureCanvas();
  if (!opts.psb && bytes.length >= 6 && bytes[4] === 0 && bytes[5] === 2) throw new Error('PSB files are not supported yet');
  // ag-psd cannot read a 16/32-bit composite with merged transparency; a layered file builds from its layers.
  const wide = bytes.length >= 24 && (bytes[22] << 8 | bytes[23]) > 8;
  const fit = compositeFit(bytes);
  if (fit === 'depth') throw new Error(`the PSD image data does not match its ${bytes[22] << 8 | bytes[23]}-bit header`);
  if (fit === 'truncated' && psdLayerCount(bytes) === 0) throw new Error('PSD file is truncated');
  // ag-psd byte-swaps 16/32-bit raw channel data in its input buffer: wide files read from a copy.
  const forAg = psdForAgPsd(bytes);
  const { psd, raw } = readPsdRaw(wide && forAg === bytes ? bytes.slice() : forAg, { useImageData: true, skipThumbnail: true, skipCompositeImageData: wide && psdLayerCount(bytes) !== 0 });
  const paths = readSavedPaths(bytes, psd.width, psd.height);
  const depth = psd.bitsPerChannel ?? 8;
  if (![8, 16, 32].includes(depth)) throw new Error(`${depth}-bit PSD files are not supported`);
  if (psd.colorMode !== undefined && psd.colorMode !== 3 && psd.colorMode !== 1 && !psd.imageData) throw new Error('Only RGB PSD files are supported');
  const { width: w, height: h } = psd;
  const e = new Engine(w, h, depth);
  try {
    const warnings: string[] = [];
    const warn = (m: string) => { if (!warnings.includes(m)) warnings.push(m); };
    const sources: PendingSource[] = [];
    const children = psd.children ?? [];
    // A flat PSD (no real layer records) reads back as [] or, via ag-psd's own writer, as one nameless
    // 0x0 placeholder layer; either way there is nothing to build, so the composite becomes the Background.
    const flat = children.length === 0 || (children.length === 1 && isEmptyPlaceholder(children[0]));
    const { grid, ...layout } = layoutIn(psd);
    const locked = children.some(l => l.artboard && l.protected?.artboards);
    e.set_document_vector(JSON.stringify({
      ...JSON.parse(e.vector_json()), ...layout, ...(grid ? { grid } : {}), paths: paths.map((p, i) => ({ id: i + 1, ...p })), artboards_locked: locked,
    }));
    if (flat) {
      place(e, 1, psd, w, h);
    } else {
      const c: ImportCtx = { e, w, h, warn, files: new Map((psd.linkedFiles ?? []).map(f => [f.id, f])), pats: importDocument(e, psd), comps: new Map(), sources, fx: psd.filterEffectsMasks ?? [], raw,
        res: layout.resolution, guides: layout.guides,
      };
      // Artboards are top-level groups only.
      for (const l of children) {
        const id = addNode(c, l);
        if (l.artboard && l.children) e.set_artboard(id, JSON.stringify(artboardIn(l, layout.guides)));
      }
      importLayerComps(c, psd);
      e.delete_node(1);
    }
    channelsIn(e, bytes, warn);
    return { engine: e, warnings, sources };
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
function maskFields(e: Engine, n: ManifestNode, w: number, h: number, hi = false) {
  if (!n.mask) return {};
  const rect = tileBounds(n.mask.tiles, w, h);
  const base = { defaultColor: n.mask.default, disabled: !n.mask.enabled };
  // `hiLayer` writes 16/32-bit and Grayscale masks itself.
  if (!rect || hi) return { mask: { top: 0, left: 0, ...base } };
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

type LayerCompOut = {
  id: number; name: string; comment: string; apply_visibility: boolean; apply_position: boolean; apply_appearance: boolean;
  layers: { id: number; visible: boolean; position: [number, number] | null; opacity: number; fill: number; blend: string; style: unknown }[];
};
interface ExportCtx {
  e: Engine; w: number; h: number; warn: Warn; names: Map<string, string>; files: Map<string, LinkedFile>; comps: LayerCompOut[]; fx: FilterMasks;
  raws: Map<object, Uint8Array>;
  res: number; guides: { id: number; axis: 'x' | 'y'; pos: number }[]; artboardsLocked: boolean;
  /** Grayscale or 16/32-bit: layer channels are written by `hiLayer`, not by ag-psd. */
  hi: { depth: Depth; gray: boolean } | null;
}

// Big-endian planes of interleaved little-endian samples (`size` bytes each, `n` per pixel).
function planesOf(le: Uint8Array, size: number, n: number): Uint8Array[] {
  const px = le.length / size / n;
  const out = Array.from({ length: n }, () => new Uint8Array(px * size));
  for (let i = 0; i < px; i++) {
    for (let c = 0; c < n; c++) {
      const s = (i * n + c) * size, d = i * size;
      for (let k = 0; k < size; k++) out[c][d + k] = le[s + size - 1 - k];
    }
  }
  return out;
}

// A layer mask or saved channel (8-bit, or 16-bit in 16/32-bit documents) at the file depth.
function maskPlane(le: Uint8Array, depth: Depth): Uint8Array {
  if (depth === 8) return le;
  const [p] = planesOf(le, 2, 1);
  if (depth === 16) return p;
  const out = new Uint8Array(p.length * 2), v = new DataView(out.buffer), s = new DataView(p.buffer);
  for (let i = 0; i < p.length / 2; i++) v.setFloat32(i * 4, s.getUint16(i * 2) / 65535);
  return out;
}

// Layer channels at 16/32 bits or in Grayscale, raw, as ag-psd's `rawData` (its writer copies them):
// transparency, gray or red/green/blue (linear at 32 bits), then the masks. `rect` is the pixel rect.
function hiLayer({ e, w, h, hi }: ExportCtx, n: ManifestNode, l: Layer, rect: Rect | null): Layer {
  const { depth, gray } = hi!;
  const size = depth / 8;
  const colors = gray ? [0] : [0, 1, 2];
  const chan = (id: number, data: Uint8Array = new Uint8Array(0)) => ({ id, compression: 0, data });
  const channels: ReturnType<typeof chan>[] = [];
  if (rect) {
    const map = tileMap(n.tiles);
    let px = assembleImage((tx, ty) => tileAt(e, map, tx, ty), rect, size * 4, 0);
    if (depth === 32) px = asBytes(e.to_linear_f32(new Float32Array(px.buffer, px.byteOffset, px.length / 4)));
    const p = planesOf(px, size, 4);
    channels.push(chan(-1, p[3]), ...colors.map(c => chan(c, p[c])));
    Object.assign(l, { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right });
  } else {
    channels.push(...[-1, ...colors].map(id => chan(id)));
  }
  const mr = n.mask && tileBounds(n.mask.tiles, w, h);
  const raster = n.mask && mr && {
    rect: mr, data: maskPlane(assembleImage((tx, ty) => tileAt(e, tileMap(n.mask!.tiles), tx, ty), mr, depth === 8 ? 1 : 2, n.mask.default ? 255 : 0), depth),
  };
  for (const [key, id] of [['mask', -2], ['realMask', -3]] as const) {
    const m = l[key];
    if (!m) continue;
    const r = m.fromVectorData ? null : raster;
    delete m.imageData;
    m.defaultColor = m.defaultColor ? 255 : 0;
    if (r) {
      Object.assign(m, { top: r.rect.top, left: r.rect.left, bottom: r.rect.bottom, right: r.rect.right });
      channels.push(chan(id, r.data));
    } else {
      Object.assign(m, { bottom: m.top ?? 0, right: m.left ?? 0 });
      channels.push(chan(id));
    }
  }
  delete l.imageData;
  (l as { rawData?: unknown }).rawData = { channels };
  return l;
}

// The flattened image as file planes: gray or red/green/blue, and transparency; partly transparent
// pixels are matted with white, as ag-psd (and Photoshop) write the composite.
function compositeOut(e: Engine, depth: Depth, gray: boolean, rgba8: Uint8Array): { color: Uint8Array[]; alpha: Uint8Array } {
  const w = e.width(), h = e.height();
  let planes: Uint8Array[];
  if (depth === 8) {
    const px = rgba8.slice();
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3];
      if (a && a < 255) for (let c = 0; c < 3; c++) px[i + c] = px[i + c] * a / 255 + 255 - a;
    }
    planes = planesOf(px, 1, 4);
  } else {
    const fl = assembleImage((tx, ty) => asBytes(e.flatten_tile_f32(tx, ty)), fullCanvas(w, h), 16, 0);
    let f = new Float32Array(fl.buffer, fl.byteOffset, fl.length / 4);
    if (depth === 32) f = e.to_linear_f32(f);
    for (let i = 0; i < f.length; i += 4) {
      const a = f[i + 3];
      if (a > 0 && a < 1) for (let c = 0; c < 3; c++) f[i + c] = f[i + c] * a + 1 - a;
    }
    const le = depth === 32 ? asBytes(f) : asBytes(Uint16Array.from(f, v => Math.round(Math.min(1, Math.max(0, v)) * 65535)));
    planes = planesOf(le, depth / 8, 4);
  }
  return { color: gray ? [planes[0]] : planes.slice(0, 3), alpha: planes[3] };
}

type ChannelOut = { id: number; name: string; default: number; tiles?: Sparse; spot: { color: [number, number, number]; solidity: number } | null };
// Saved channels as composite planes: alpha channels as Photoshop's default Masked Areas (white
// selects), spot channels with their ink color and solidity.
function channelsOut(e: Engine, list: ChannelOut[], depth: Depth): PsdChannel[] {
  const w = e.width(), h = e.height();
  return list.map(c => {
    const max = e.depth() === 8 ? 255 : 65535;
    const le = assembleImage((tx, ty) => tileAt(e, tileMap(c.tiles), tx, ty), fullCanvas(w, h), max === 255 ? 1 : 2, c.default >= max ? 255 : 0);
    return {
      name: c.name, kind: c.spot ? 2 : 1, color: c.spot?.color ?? [255, 0, 0], opacity: c.spot ? Math.round(c.spot.solidity * 100) : 50, plane: maskPlane(le, depth),
    };
  });
}

// Per-layer `comps.settings`: one entry per comp, `enabled` its captured visibility, `offset` the
// captured position as a delta from this layer's current bounds origin (M3.md section 8).
function compsOut(n: ManifestNode, comps: LayerCompOut[], w: number, h: number) {
  const rect = tileBounds(n.tiles, w, h);
  const origin: [number, number] | null = rect ? [rect.left, rect.top] : null;
  return {
    settings: comps.map(c => {
      const cl = c.layers.find(l => l.id === n.id);
      const offset = cl?.position && origin ? { x: cl.position[0] - origin[0], y: cl.position[1] - origin[1] } : undefined;
      return { compList: [c.id], enabled: cl ? cl.visible : true, offset };
    }),
  };
}

// ag-psd refuses placed layer ids that are not GUIDs; other ids get one derived from the node id.
function smartOut({ e, w, h, warn, files, fx }: ExportCtx, n: ManifestNode): Partial<Layer> & { rawSoLd?: Uint8Array } {
  const s = n.smart!;
  const tb = tileBounds(n.tiles, w, h);
  const cx = { e, w, h, rect: tb ? { x: tb.left, y: tb.top, w: tb.right - tb.left, h: tb.bottom - tb.top } : { x: 0, y: 0, w, h } };
  const droppedAt = s.filters.findIndex(f => f.psd?.dropped);
  const dropped = droppedAt < 0 ? undefined : s.filters[droppedAt].psd!.dropped;
  const rest = s.filters.filter((_, i) => i !== droppedAt);
  const [sw0, sh0] = s.source_size, q0 = quadOf(s.transform, sw0, sh0);
  if (dropped && (!dropped.placement.every((v: number, i: number) => Math.abs(v - q0[i]) <= 1e-6 * (1 + Math.abs(v))) || JSON.stringify(dropped.stack) !== JSON.stringify(stackOf(rest))
    || linkKey(dropped.link) !== linkKey(s.link) || JSON.stringify(dropped.size) !== JSON.stringify(s.source_size))) {
    throw new Error(`Cannot export a changed placement with ${dropped.names.join(', ')}.`);
  }
  // PSD lists the stack top first.
  const list = dropped ? [] : rest.map(f => filterOut(f, cx)).reverse();
  prepareList(list);
  if (s.filters.some(f => f.mask)) warn('per-filter smart filter masks are not stored in PSD');
  if (s.warp) warn('smart object warps are not stored in PSD yet');
  const embedded = s.link.type === 'embedded';
  const id = embedded && GUID.test(s.link.id) ? s.link.id : `00000000-0000-4000-8000-${n.id.toString(16).padStart(12, '0')}`;
  if (!embedded) warn('linked smart objects are saved without their source file');
  if (!embedded) files.set(id, { id, name: s.link.name });
  else if (s.source.blob != null && !files.has(id)) files.set(id, { id, name: n.name, data: e.tile_bytes(BigInt(s.source.blob)) });
  const [sw, sh] = s.source_size, q = quadOf(s.transform, sw, sh);
  const sm = s.stack_mask;
  const filter: PlacedLayerFilter | undefined = list.length ? {
    enabled: true, validAtPosition: true, maskEnabled: sm?.enabled ?? true, maskLinked: true, maskExtendWithWhite: (sm?.default ?? 255) !== 0, list,
  } : undefined;
  const rect = sm && tileBounds(sm.tiles, w, h);
  const [txN, tyN] = [Math.ceil(w / 256), Math.ceil(h / 256)];
  if (sm?.tiles?.some(([tx, ty]) => tx < 0 || ty < 0 || tx >= txN || ty >= tyN)) warn('smart filter mask areas outside the canvas are not stored in PSD');
  if (sm && rect && e.depth() !== 8) warn('smart filter masks of 16-bit and 32-bit documents are not stored in PSD');
  else if (sm && rect) {
    const data = assembleImage((tx, ty) => tileAt(e, tileMap(sm.tiles), tx, ty), rect, 1, sm.default);
    // Channels: the user mask then the sheet mask, no color channels.
    fx.push({ id, ...rect, depth: 8, channels: [{ compressionMode: 0, data }, undefined] });
  }
  return {
    placedLayer: { id, placed: id, type: 'raster', transform: q, nonAffineTransform: q, width: sw, height: sh, ...(filter ? { filter } : {}) },
    ...(dropped ? { rawSoLd: e.tile_bytes(BigInt(dropped.raw.$blob)) } : {}),
  };
}

function exportNode(x: ExportCtx, n: ManifestNode): Layer {
  const { e, w, h, warn } = x;
  if (n.shape && n.vector_mask) warn('vector masks on shape layers are not stored in PSD');
  if ([n.shape, n.vector_mask].some(v => v?.path.fill_rule === 'evenodd')) warn('the even-odd fill rule of shapes and vector masks is not stored in PSD');
  const mf = maskFields(e, n, w, h, !!x.hi);
  const masks = n.vector_mask && !n.shape ? vectorMaskOut(n.vector_mask, mf.mask, w, h) : mf;
  const common = {
    name: n.name, hidden: !n.visible, opacity: n.opacity, fillOpacity: n.fill, blendMode: n.blend as BlendMode, clipping: n.clipping,
    protected: { transparency: n.locks.transparency, composite: n.locks.pixels, position: n.locks.position, ...(n.artboard ? { artboards: x.artboardsLocked } : {}) },
    ...masks, ...blendingOut(n.blending, warn), ...(n.style ? { effects: styleOut(n.style, x.names, warn) } : {}),
    // ag-psd needs a layer id on every layer of a document with comps.
    ...(x.comps.length ? { id: n.id, comps: compsOut(n, x.comps, w, h) } : {}),
  };
  const hi = (l: Layer, rect: Rect | null = null) => (x.hi ? hiLayer(x, n, l, rect) : l);
  if (n.kind === 'group') {
    return hi({ ...common, ...(n.artboard ? { artboard: artboardOut(n.artboard, x.guides) } : {}), children: (n.children ?? []).map(c => exportNode(x, c)) });
  }
  if (n.shape) return hi({ ...common, top: 0, left: 0, ...shapeOut(n.shape, x.res, w, h, c => fillOut(c, x.names, warn), warn) });
  if (n.adjustment) return hi({ ...common, top: 0, left: 0, adjustment: adjustmentOut(e, n.adjustment, warn) });
  if (n.content) return hi({ ...common, top: 0, left: 0, vectorFill: fillOut(n.content, x.names, warn) });
  const { rawSoLd, ...placed } = n.smart ? smartOut(x, n) : n.text ? { text: textOut(n.text, x.res, warn) } : ({} as { rawSoLd?: Uint8Array });
  const done = (l: Layer) => { if (rawSoLd) x.raws.set(l.placedLayer!, rawSoLd); return l; };
  const rect = tileBounds(n.tiles, w, h);
  if (!rect || x.hi) return done(hi({ ...common, ...placed, top: 0, left: 0 }, rect));
  const map = tileMap(n.tiles);
  const data = assembleImage((tx, ty) => tileAt(e, map, tx, ty), rect, 4, 0);
  const rw = rect.right - rect.left, rh = rect.bottom - rect.top;
  return done({ ...common, ...placed, top: rect.top, left: rect.left, imageData: { width: rw, height: rh, data: new Uint8ClampedArray(data.buffer) } });
}

const grayDoc = (e: Engine) => {
  const v = JSON.parse(e.vector_json()) as { gray?: boolean; mode?: unknown };
  return !!v.gray && !v.mode;
};

/** The profile to embed in `e`'s PSD: at 32 bits the linear twin the values are written in, in
 * Grayscale the Gray profile (none when untagged), else the RGB profile. */
export function psdIcc(e: Engine): Uint8Array {
  const twin = e.depth() === 32 ? e.linear_twin_icc() : new Uint8Array(0);
  if (twin.length) return twin;
  return grayIcc(e) ?? e.profile_icc();
}

/** The Gray profile of a Grayscale document (empty when untagged); null for other modes. */
export function grayIcc(e: Engine): Uint8Array | null {
  if (!grayDoc(e)) return null;
  return JSON.parse(e.profile_json()) ? e.pixels_profile_icc() : new Uint8Array(0);
}

// ag-psd writes RGB/8-bit; Grayscale, 16/32 bits and saved channels are finished by psd/depth.ts.
// `psb` writes the large document format (smart object sources, D5).
export function exportPsd(e: Engine, opts: { psb?: boolean } = {}): { bytes: Uint8Array<ArrayBuffer>; warnings: string[] } {
  ensureCanvas();
  const w = e.width(), h = e.height();
  const depth = e.depth() as Depth, gray = grayDoc(e);
  const manifest = JSON.parse(e.manifest()) as {
    layers: ManifestNode[]; global_light: { angle: number; altitude: number };
    patterns: { id: string; name: string; width: number; height: number; blob: number }[];
    layer_comps: LayerCompOut[];
    resolution: number; guides: ExportCtx['guides']; grid: { spacing_x: number; spacing_y: number };
    paths: { name: string; work: boolean; path: any }[]; artboards_locked: boolean; channels: ChannelOut[];
  };
  const warnings: string[] = [];
  const warn = (m: string) => { if (!warnings.includes(m)) warnings.push(m); };
  const composite = compositeRgba(e);
  const x: ExportCtx = { e, w, h, warn, names: new Map(manifest.patterns.map(p => [p.id, p.name])), files: new Map(), comps: manifest.layer_comps, fx: [], raws: new Map(),
    res: manifest.resolution, guides: manifest.guides, artboardsLocked: manifest.artboards_locked, hi: gray || depth !== 8 ? { depth, gray } : null,
  };
  const { angle, altitude } = manifest.global_light;
  if (manifest.layer_comps.length) warn('layer comp appearance is not stored in PSD');
  const psd: Psd = {
    width: w, height: h, colorMode: 3, bitsPerChannel: 8,
    children: manifest.layers.map(n => exportNode(x, n)),
    imageData: { width: w, height: h, data: new Uint8ClampedArray(composite.buffer) },
    imageResources: {
      globalAngle: Math.round(angle), globalAltitude: Math.round(altitude), ...layoutOut(manifest),
      ...(manifest.layer_comps.length ? { layerComps: { list: manifest.layer_comps.map(c => ({
        // ag-psd writes a `comment` key even when undefined, which throws.
        id: c.id, name: c.name, ...(c.comment ? { comment: c.comment } : {}),
        capturedInfo: (c.apply_visibility ? 1 : 0) | (c.apply_position ? 2 : 0) | (c.apply_appearance ? 4 : 0),
      })) } } : {}),
    },
    patterns: manifest.patterns.map(p => ({
      id: p.id, name: p.name, x: 0, y: 0, bounds: { x: 0, y: 0, w: p.width, h: p.height }, data: e.tile_bytes(BigInt(p.blob)),
    })),
  };
  if (x.files.size) psd.linkedFiles = [...x.files.values()];
  if (x.fx.length) psd.filterEffectsMasks = x.fx;
  const artboards = manifest.layers.filter(n => n.artboard).length;
  if (artboards) psd.artboards = { count: artboards };
  const out = x.hi || manifest.channels.length ? compositeOut(e, depth, gray, composite) : null;
  let saved = manifest.channels;
  const room = PSD_MAX_CHANNELS - (gray ? 1 : 3) - (out && psdTransparency(composite, out.alpha, depth) ? 1 : 0);
  if (saved.length > room) {
    warn(`${saved.length - room} alpha and spot channels beyond Photoshop's ${PSD_MAX_CHANNELS}-channel limit were not saved`);
    saved = saved.slice(0, room);
  }
  const extras = channelsOut(e, saved, depth);
  if (extras.length) Object.assign(psd.imageResources!, { alphaChannelNames: extras.map(c => c.name), alphaIdentifiers: saved.map(c => c.id) });
  if (JSON.parse(e.vector_json()).variables) warn('variables and data sets are not stored in PSD');
  let bytes: Uint8Array<ArrayBuffer> = new Uint8Array(writePsdRaw(psd, { generateThumbnail: false, psb: !!opts.psb }, x.raws));
  if (out) {
    bytes = finishPsd(bytes, { psb: !!opts.psb, depth, gray, width: w, height: h, ...out, extras }) as Uint8Array<ArrayBuffer>;
  }
  return { bytes: manifest.paths.length ? writeSavedPaths(bytes, manifest.paths, w, h) : bytes, warnings };
}
