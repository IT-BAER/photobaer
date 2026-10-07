// Layer styles and blending options (docs/M3.md section 5): engine JSON types (field names verbatim),
// per-effect defaults, the 18 contour presets and the effect catalogue the dialog and Layers panel share.
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { FillContent, GradientDef } from './engine.worker.ts';

type Rgb = [number, number, number];
export interface Contour { name: string; points: [number, number][]; mode: 'point' | 'pencil'; anti_alias: boolean }
interface Switch { present: boolean; enabled: boolean }
export interface Shadow extends Switch {
  blend: string; opacity: number; color: Rgb; use_global_light: boolean; angle: number; distance: number;
  spread: number; size: number; contour: Contour; noise: number; knocks_out: boolean;
}
export type GlowFill = { type: 'color'; color: Rgb } | { type: 'gradient'; gradient: GradientDef };
export interface Glow extends Switch {
  blend: string; opacity: number; fill: GlowFill; technique: 'softer' | 'precise'; spread: number; size: number;
  range: number; jitter: number; noise: number; contour: Contour; source: 'edge' | 'center';
}
export interface Bevel extends Switch {
  style: 'outer' | 'inner' | 'emboss' | 'pillow' | 'stroke_emboss'; technique: 'smooth' | 'chisel_hard' | 'chisel_soft';
  depth: number; direction: 'up' | 'down'; size: number; soften: number; use_global_light: boolean; angle: number;
  altitude: number; gloss_contour: Contour; highlight_blend: string; highlight_color: Rgb; highlight_opacity: number;
  shadow_blend: string; shadow_color: Rgb; shadow_opacity: number;
}
export interface BevelContour extends Switch { contour: Contour; range: number }
export interface BevelTexture extends Switch { pattern_id: string; scale: number; depth: number; invert: boolean; linked: boolean; offset: [number, number] }
export interface Satin extends Switch { blend: string; opacity: number; color: Rgb; angle: number; distance: number; size: number; contour: Contour; invert: boolean }
export interface ColorOverlay extends Switch { blend: string; opacity: number; color: Rgb }
export type GradientParams = Omit<Extract<FillContent, { type: 'gradient' }>, 'type'>;
export type PatternParams = Omit<Extract<FillContent, { type: 'pattern' }>, 'type'>;
export interface GradientOverlay extends Switch { blend: string; opacity: number; gradient: GradientParams }
export interface PatternOverlay extends Switch { blend: string; opacity: number; pattern: PatternParams }
export interface Stroke extends Switch { size: number; position: 'outside' | 'inside' | 'center'; blend: string; opacity: number; overprint: boolean; fill: FillContent }
export interface LayerStyle {
  enabled: boolean; scale: number;
  drop_shadows: Shadow[]; inner_shadows: Shadow[]; color_overlays: ColorOverlay[]; gradient_overlays: GradientOverlay[];
  pattern_overlays: PatternOverlay[]; strokes: Stroke[];
  outer_glow: Glow | null; inner_glow: Glow | null; bevel: Bevel | null; contour: BevelContour | null; texture: BevelTexture | null; satin: Satin | null;
}
export type Quad = [number, number, number, number];
export interface BlendRange { source: Quad; destination: Quad }
export interface Blending {
  blend_if: { gray: BlendRange; red: BlendRange; green: BlendRange; blue: BlendRange };
  channels: [boolean, boolean, boolean]; knockout: 'none' | 'shallow' | 'deep';
  blend_interior: boolean; blend_clipped: boolean; transparency_shapes: boolean;
  layer_mask_hides_effects: boolean; vector_mask_hides_effects: boolean;
}

// Control points in 0..1 (pencil presets are linear segments between whole levels).
const PRESET_POINTS: [string, number[][], ('pencil')?][] = [
  ['Linear', [[0, 0], [1, 1]]],
  ['Cosine', [[0, 0], [0.25, 0.1464], [0.5, 0.5], [0.75, 0.8536], [1, 1]]],
  ['Cone', [[0, 0], [0.25, 0.0625], [0.5, 0.25], [0.75, 0.5625], [1, 1]]],
  ['Cone - Inverted', [[0, 0], [0.25, 0.4375], [0.5, 0.75], [0.75, 0.9375], [1, 1]]],
  ['Cove - Deep', [[0, 0], [0.5, 0.04], [0.75, 0.16], [0.9, 0.45], [1, 1]]],
  ['Cove - Shallow', [[0, 0], [0.35, 0.08], [0.6, 0.26], [0.82, 0.62], [1, 1]]],
  ['Gaussian', [[0, 0], [0.2, 0.02], [0.35, 0.09], [0.5, 0.5], [0.65, 0.91], [0.8, 0.98], [1, 1]]],
  ['Half Round', [[0, 0], [0.25, 0.6614], [0.5, 0.866], [0.75, 0.9682], [1, 1]]],
  ['Ring', [[0, 0], [0.3, 1], [0.55, 0.08], [0.8, 0.5], [1, 1]]],
  ['Ring - Double', [[0, 0], [0.18, 1], [0.33, 0.12], [0.52, 1], [0.68, 0.1], [0.85, 0.6], [1, 1]]],
  ['Rolling Slope - Descending', [[0, 0], [0.32, 0.78], [0.6, 0.62], [0.82, 0.8], [1, 1]]],
  ['Rounded Steps', [[0, 0], [0.22, 0.02], [0.32, 0.33], [0.55, 0.35], [0.62, 0.66], [0.85, 0.68], [0.92, 1], [1, 1]]],
  ['Sawtooth 1', [[0, 0], [127 / 255, 1], [128 / 255, 0], [1, 1]], 'pencil'],
  ['Sawtooth 2', [[0, 0], [63 / 255, 1], [64 / 255, 0], [127 / 255, 1], [128 / 255, 0], [191 / 255, 1], [192 / 255, 0], [1, 1]], 'pencil'],
  ['Shallow Slope - Valley', [[0, 0], [0.3, 0.52], [0.5, 0.34], [0.7, 0.52], [1, 1]]],
  ['Sloping Frame', [[0, 0], [0.14, 0.8], [0.5, 0.86], [0.86, 0.9], [1, 1]]],
  ['Steps', [[0, 0], [63 / 255, 0], [64 / 255, 1 / 3], [127 / 255, 1 / 3], [128 / 255, 2 / 3], [191 / 255, 2 / 3], [192 / 255, 1], [1, 1]], 'pencil'],
  ['Valley - Low', [[0, 0], [0.22, 0.86], [0.48, 0.12], [0.74, 0.55], [1, 1]]],
];
export const CONTOUR_PRESETS: Contour[] = PRESET_POINTS.map(([name, pts, mode]) => ({
  name, points: pts.map(([x, y]) => [Math.round(x * 255), Math.round(y * 255)]), mode: mode ?? 'point', anti_alias: false,
}));
export const contour = (name = 'Linear', antiAlias = false): Contour => ({ ...structuredClone(CONTOUR_PRESETS.find(c => c.name === name) ?? CONTOUR_PRESETS[0]), anti_alias: antiAlias });

const BLACK_WHITE: GradientDef = {
  method: 'classic',
  color_stops: [{ position: 0, color: [0, 0, 0], midpoint: 0.5 }, { position: 1, color: [255, 255, 255], midpoint: 0.5 }],
  opacity_stops: [{ position: 0, opacity: 1, midpoint: 0.5 }, { position: 1, opacity: 1, midpoint: 0.5 }],
};
export const defaultGradientParams = (): GradientParams => ({
  gradient: structuredClone(BLACK_WHITE), style: 'linear', angle: 90, scale: 1, reverse: false, dither: false, align_with_layer: true, offset: [0, 0],
});

// Effect kinds in the dialog's list order; `multi` kinds hold up to 10 instances.
export type EffectKind =
  | 'bevel' | 'contour' | 'texture' | 'strokes' | 'inner_shadows' | 'inner_glow' | 'satin' | 'color_overlays'
  | 'gradient_overlays' | 'pattern_overlays' | 'outer_glow' | 'drop_shadows';
export const EFFECT_KINDS: EffectKind[] = [
  'bevel', 'contour', 'texture', 'strokes', 'inner_shadows', 'inner_glow', 'satin', 'color_overlays',
  'gradient_overlays', 'pattern_overlays', 'outer_glow', 'drop_shadows',
];
export const EFFECT_LABEL: Record<EffectKind, MessageDescriptor> = {
  bevel: msg`Bevel & Emboss`, contour: msg`Contour`, texture: msg`Texture`, strokes: msg({ message: 'Stroke', context: 'layer effect' }),
  inner_shadows: msg`Inner Shadow`, inner_glow: msg`Inner Glow`, satin: msg`Satin`, color_overlays: msg`Color Overlay`,
  gradient_overlays: msg`Gradient Overlay`, pattern_overlays: msg`Pattern Overlay`, outer_glow: msg`Outer Glow`, drop_shadows: msg`Drop Shadow`,
};
export const MULTI: EffectKind[] = ['strokes', 'inner_shadows', 'color_overlays', 'gradient_overlays', 'drop_shadows'];
export const MAX_INSTANCES = 10;
type AnyEffect = Switch & Record<string, unknown>;

/** A new effect of `kind` with the section 5 defaults; the pattern kinds take `patternId`. */
export function defaultEffect(kind: EffectKind, patternId = ''): AnyEffect {
  const on = { present: true, enabled: true };
  const shadow = (inner: boolean): Shadow => ({
    ...on, blend: 'multiply', opacity: 0.75, color: [0, 0, 0], use_global_light: true, angle: 120, distance: 5,
    spread: 0, size: 5, contour: contour(), noise: 0, knocks_out: !inner,
  });
  const glow = (): Glow => ({
    ...on, blend: 'screen', opacity: 0.75, fill: { type: 'color', color: [255, 255, 190] }, technique: 'softer', spread: 0,
    size: 5, range: 0.5, jitter: 0, noise: 0, contour: contour(), source: 'edge',
  });
  const effects: Record<EffectKind, () => object> = {
    drop_shadows: () => shadow(false),
    inner_shadows: () => shadow(true),
    outer_glow: glow,
    inner_glow: glow,
    bevel: (): Bevel => ({
      ...on, style: 'inner', technique: 'smooth', depth: 1, direction: 'up', size: 5, soften: 0, use_global_light: true,
      angle: 120, altitude: 30, gloss_contour: contour(), highlight_blend: 'screen', highlight_color: [255, 255, 255],
      highlight_opacity: 0.75, shadow_blend: 'multiply', shadow_color: [0, 0, 0], shadow_opacity: 0.75,
    }),
    contour: (): BevelContour => ({ ...on, contour: contour('Linear', true), range: 1 }),
    texture: (): BevelTexture => ({ ...on, pattern_id: patternId, scale: 1, depth: 1, invert: false, linked: true, offset: [0, 0] }),
    satin: (): Satin => ({ ...on, blend: 'multiply', opacity: 0.5, color: [0, 0, 0], angle: 19, distance: 11, size: 14, contour: contour(), invert: true }),
    color_overlays: (): ColorOverlay => ({ ...on, blend: 'normal', opacity: 1, color: [128, 128, 128] }),
    gradient_overlays: (): GradientOverlay => ({ ...on, blend: 'normal', opacity: 1, gradient: defaultGradientParams() }),
    pattern_overlays: (): PatternOverlay => ({ ...on, blend: 'normal', opacity: 1, pattern: { pattern_id: patternId, scale: 1, angle: 0, linked: true, offset: [0, 0] } }),
    strokes: (): Stroke => ({ ...on, size: 3, position: 'outside', blend: 'normal', opacity: 1, overprint: false, fill: { type: 'solid', color: [0, 0, 0] } }),
  };
  return effects[kind]() as AnyEffect;
}

export const emptyStyle = (): LayerStyle => ({
  enabled: true, scale: 1, drop_shadows: [], inner_shadows: [], color_overlays: [], gradient_overlays: [], pattern_overlays: [],
  strokes: [], outer_glow: null, inner_glow: null, bevel: null, contour: null, texture: null, satin: null,
});

export const defaultBlending = (): Blending => {
  const r = (): BlendRange => ({ source: [0, 0, 255, 255], destination: [0, 0, 255, 255] });
  return {
    blend_if: { gray: r(), red: r(), green: r(), blue: r() }, channels: [true, true, true], knockout: 'none',
    blend_interior: false, blend_clipped: true, transparency_shapes: true, layer_mask_hides_effects: false, vector_mask_hides_effects: false,
  };
};

/** The instances of `kind` in a style as a list (singles: zero or one). */
export function instances(s: LayerStyle, kind: EffectKind): AnyEffect[] {
  const v = s[kind] as unknown;
  return (Array.isArray(v) ? v : v ? [v] : []) as AnyEffect[];
}

/** Returns a copy of `s` with the instances of `kind` replaced (singles keep the first or null). */
export function withInstances(s: LayerStyle, kind: EffectKind, list: AnyEffect[]): LayerStyle {
  return { ...s, [kind]: MULTI.includes(kind) || kind === 'pattern_overlays' ? list : list[0] ?? null };
}

/** One row per present effect in Layers panel order, named "<label>" or "<label> N" for the Nth instance. */
export function effectRows(s: LayerStyle): { kind: EffectKind; index: number; name: string; enabled: boolean }[] {
  return EFFECT_KINDS.filter(k => k !== 'contour' && k !== 'texture').flatMap(kind => instances(s, kind)
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.present)
    .map(({ e, index }) => ({ kind, index, name: index > 0 ? `${EFFECT_LABEL[kind].message} ${index + 1}` : EFFECT_LABEL[kind].message!, enabled: e.enabled })));
}

/** Sets `enabled` on one effect instance. */
export function setEffectEnabled(s: LayerStyle, kind: EffectKind, index: number, enabled: boolean): LayerStyle {
  const list = instances(s, kind).map((e, i) => (i === index ? { ...e, enabled } : e));
  return withInstances(s, kind, list);
}

/** Returns a copy of `obj` with the dot `path` (numeric segments index arrays) set to `value`. */
export function setIn<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const put = (v: unknown, i: number): unknown => {
    if (i === keys.length) return value;
    const child: Record<string, unknown> = Array.isArray(v) ? [...v] as unknown as Record<string, unknown> : { ...(v as object) };
    child[keys[i]] = put((v as Record<string, unknown>)?.[keys[i]], i + 1);
    return child;
  };
  return put(obj, 0) as T;
}

// Make Default / Reset to Default: one stored effect per kind.
const DEFAULTS_KEY = 'photobaer.layerStyleDefaults';
function storedDefaults(): Partial<Record<EffectKind, AnyEffect>> {
  try { return JSON.parse(localStorage.getItem(DEFAULTS_KEY) ?? '{}'); } catch { return {}; }
}
/** The stored default of `kind` (Make Default), else the section 5 default. */
export function effectDefault(kind: EffectKind, patternId = ''): AnyEffect {
  const e = storedDefaults()[kind];
  return e ? { ...structuredClone(e), present: true, enabled: true } : defaultEffect(kind, patternId);
}
export function saveEffectDefault(kind: EffectKind, effect: AnyEffect) {
  try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify({ ...storedDefaults(), [kind]: effect })); } catch { /* session-only */ }
}

/** Why a layer cannot take a layer style, or null. */
export function styleRefusal(n: { kind: string; locks: { transparency: boolean; pixels: boolean; position: boolean } }): string | null {
  if (n.kind === 'adjustment') return 'Adjustment layers do not support layer styles.';
  if (n.locks.transparency && n.locks.pixels && n.locks.position) return 'Could not use the layer style because the layer is fully locked.';
  return null;
}

/** Every `pattern_id` inside a style or fill content. */
export function patternRefs(value: unknown): string[] {
  const ids: string[] = [];
  JSON.stringify(value, (k, v) => { if (k === 'pattern_id' && typeof v === 'string') ids.push(v); return v; });
  return ids;
}

/** Picker entries: document patterns, then presets whose id the document lacks; `query` matches names case-insensitively. */
export function patternChoices(doc: { id: string; name: string }[], presets: { id: string; name: string }[], query: string) {
  const q = query.trim().toLowerCase();
  const have = new Set(doc.map(p => p.id));
  return [...doc.map(p => ({ id: p.id, name: p.name, preset: false })), ...presets.filter(p => !have.has(p.id)).map(p => ({ id: p.id, name: p.name, preset: true }))]
    .filter(c => c.name.toLowerCase().includes(q));
}

// Saved styles (Styles page, New Style, Styles panel) in localStorage, oldest first; no built-in presets.
// A storage that throws keeps them in memory for the session. Every read and write deep-copies.
export interface SavedStyle { id: string; name: string; style: LayerStyle; blending: Blending }
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const STYLES_KEY = 'photobaer.styles';

export class StyleLibrary {
  #store: Store | undefined;
  #styles: SavedStyle[] = [];

  constructor(store?: Store) {
    try {
      this.#store = store ?? globalThis.localStorage;
      const raw = this.#store?.getItem(STYLES_KEY);
      const list: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(list)) this.#styles = list.filter(s => typeof s?.id === 'string' && typeof s.name === 'string' && s.style && s.blending);
    } catch { /* unavailable or corrupt: start empty */ }
  }

  /** Saved styles whose name contains `query` (case-insensitive). */
  list(query = ''): SavedStyle[] {
    const q = query.trim().toLowerCase();
    return structuredClone(this.#styles.filter(s => s.name.toLowerCase().includes(q)));
  }

  save(name: string, style: LayerStyle, blending: Blending): SavedStyle {
    const s: SavedStyle = { id: crypto.randomUUID(), name: name.trim() || `Style ${this.#styles.length + 1}`, style: structuredClone(style), blending: structuredClone(blending) };
    this.#styles.push(s);
    this.#write();
    return structuredClone(s);
  }

  remove(id: string) { this.#styles = this.#styles.filter(s => s.id !== id); this.#write(); }
  clear() { this.#styles = []; this.#write(); }

  #write() { try { this.#store?.setItem(STYLES_KEY, JSON.stringify(this.#styles)); } catch { /* session-only */ } }

  apply(id: string): { style: LayerStyle; blending: Blending } | undefined {
    const s = this.#styles.find(x => x.id === id);
    return s && structuredClone({ style: s.style, blending: s.blending });
  }
}
