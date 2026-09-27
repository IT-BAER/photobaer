// The 16 adjustment layer kinds (docs/M3.md section 3, B5): catalogue order, undo labels (B5-5),
// neutral defaults and the generic per-field renderer's field lists (m3-inv-a.md section 7 ranges).
import type { Adjustment, GradientDef, HueRange } from './engine.worker.ts';
import type { Gradient } from './gradients/gradient.ts';

export type Kind = Adjustment['kind'];

// Catalogue order everywhere: menu, panel, PSD mapping (docs/M3.md section 3).
export const ADJUSTMENT_KINDS: Kind[] = [
  'brightness_contrast', 'levels', 'curves', 'exposure', 'vibrance', 'hue_saturation', 'color_balance',
  'black_white', 'photo_filter', 'channel_mixer', 'color_lookup', 'invert', 'posterize', 'threshold',
  'gradient_map', 'selective_color',
];

// B5-5: creation and destructive apply undo under the plain menu label (also the layer's default
// name); a Properties edit undoes under the spaced label for the two kinds with a slash.
export const MENU_LABEL: Record<Kind, string> = {
  brightness_contrast: 'Brightness/Contrast', levels: 'Levels', curves: 'Curves', exposure: 'Exposure',
  vibrance: 'Vibrance', hue_saturation: 'Hue/Saturation', color_balance: 'Color Balance',
  black_white: 'Black & White', photo_filter: 'Photo Filter', channel_mixer: 'Channel Mixer',
  color_lookup: 'Color Lookup', invert: 'Invert', posterize: 'Posterize', threshold: 'Threshold',
  gradient_map: 'Gradient Map', selective_color: 'Selective Color',
};
export const EDIT_LABEL: Record<Kind, string> = {
  ...MENU_LABEL, brightness_contrast: 'Brightness / Contrast', hue_saturation: 'Hue / Saturation',
};

// Image > Adjustments shortcuts (docs/M3.md section 3); Invert's Ctrl+I already exists elsewhere.
export const SHORTCUT: Partial<Record<Kind, string>> = {
  levels: 'Ctrl+L', curves: 'Ctrl+M', hue_saturation: 'Ctrl+U', color_balance: 'Ctrl+B', black_white: 'Ctrl+Alt+Shift+B',
};

const DEFAULT_GRADIENT_MAP_GRADIENT: GradientDef = {
  method: 'classic',
  color_stops: [{ position: 0, color: [0, 0, 0], midpoint: 0.5 }, { position: 1, color: [255, 255, 255], midpoint: 0.5 }],
  opacity_stops: [{ position: 0, opacity: 1, midpoint: 0.5 }, { position: 1, opacity: 1, midpoint: 0.5 }],
};

const HUE_BANDS: [number, number, number, number][] = [
  [315, 345, 15, 45], [15, 45, 75, 105], [75, 105, 135, 165], [135, 165, 195, 225], [195, 225, 255, 285], [255, 285, 315, 345],
];
const zeroHsl = () => ({ hue: 0, saturation: 0, lightness: 0 });

/** Neutral params for a new layer or an Image > Adjustments dialog (docs/M3.md section 3 defaults). */
export function defaultAdjustment(kind: Kind): Adjustment {
  switch (kind) {
    case 'brightness_contrast': return { kind, params: { brightness: 0, contrast: 0, legacy: false } };
    case 'levels': return { kind, params: { composite: { input_black: 0, input_white: 255, gamma: 1, output_black: 0, output_white: 255 } } };
    case 'curves': return { kind, params: { mode: 'point', composite: [[0, 0], [255, 255]] } };
    case 'exposure': return { kind, params: { exposure: 0, offset: 0, gamma: 1 } };
    case 'vibrance': return { kind, params: { vibrance: 0, saturation: 0 } };
    case 'hue_saturation': {
      const ranges = HUE_BANDS.map(bands => ({ bands, ...zeroHsl() })) as [HueRange, HueRange, HueRange, HueRange, HueRange, HueRange];
      return { kind, params: { master: zeroHsl(), colorize: false, colorize_values: { hue: 0, saturation: 25, lightness: 0 }, ranges } };
    }
    case 'color_balance': return { kind, params: { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserve_luminosity: true } };
    case 'black_white': return { kind, params: { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tint_color: [206, 185, 155] } };
    case 'photo_filter': return { kind, params: { color: [236, 138, 0], density: 25, preserve_luminosity: true } };
    case 'channel_mixer': return { kind, params: { red: [100, 0, 0, 0], green: [0, 100, 0, 0], blue: [0, 0, 100, 0], gray: [40, 40, 20, 0], monochrome: false } };
    case 'color_lookup': return { kind, params: { name: '', format: 'cube', table: null, interpolation: 'tetrahedral', dither: false } };
    case 'invert': return { kind, params: {} };
    case 'posterize': return { kind, params: { levels: 4 } };
    case 'threshold': return { kind, params: { level: 128 } };
    case 'gradient_map': return { kind, params: { gradient: DEFAULT_GRADIENT_MAP_GRADIENT, reverse: false, dither: false } };
    case 'selective_color': {
      const zero: [number, number, number, number] = [0, 0, 0, 0];
      return { kind, params: { mode: 'relative', reds: zero, yellows: zero, greens: zero, cyans: zero, blues: zero, magentas: zero, whites: zero, neutrals: zero, blacks: zero } };
    }
  }
}

export type FieldSpec =
  | { type: 'number'; label: string; path: string; min: number; max: number; step: number }
  | { type: 'checkbox'; label: string; path: string }
  | { type: 'select'; label: string; path: string; options: [string, string][] };

const num = (label: string, path: string, min: number, max: number, step = 1): FieldSpec => ({ type: 'number', label, path, min, max, step });
const check = (label: string, path: string): FieldSpec => ({ type: 'checkbox', label, path });
const quad = (prefix: string, path: string, min: number, max: number): FieldSpec[] =>
  (['C', 'M', 'Y', 'K'] as const).map((ch, i) => num(`${prefix} ${ch}`, `${path}.${i}`, min, max));
const row4 = (label: string, path: string): FieldSpec[] => [0, 1, 2, 3].map(i => num(`${label} ${['R', 'G', 'B', 'Const'][i]}`, `${path}.${i}`, -200, 200));
const rangeFields = (i: number, name: string): FieldSpec[] => [
  num(`${name} Hue`, `ranges.${i}.hue`, -100, 100), num(`${name} Saturation`, `ranges.${i}.saturation`, -100, 100), num(`${name} Lightness`, `ranges.${i}.lightness`, -100, 100),
];

// Every kind but invert (a note), gradient map (its own body) and color lookup (file-picker body).
export const FIELD_SPECS: Partial<Record<Kind, FieldSpec[]>> = {
  brightness_contrast: [num('Brightness', 'brightness', -150, 150), num('Contrast', 'contrast', -50, 100), check('Use legacy', 'legacy')],
  levels: [
    num('Input black', 'composite.input_black', 0, 255), num('Input white', 'composite.input_white', 0, 255),
    num('Gamma', 'composite.gamma', 0.01, 9.99, 0.01), num('Output black', 'composite.output_black', 0, 255), num('Output white', 'composite.output_white', 0, 255),
  ],
  curves: [
    { type: 'select', label: 'Mode', path: 'mode', options: [['point', 'Point'], ['pencil', 'Pencil']] },
    num('Point 1 input', 'composite.0.0', 0, 255), num('Point 1 output', 'composite.0.1', 0, 255),
    num('Point 2 input', 'composite.1.0', 0, 255), num('Point 2 output', 'composite.1.1', 0, 255),
  ],
  exposure: [num('Exposure', 'exposure', -20, 20, 0.01), num('Offset', 'offset', -0.5, 0.5, 0.001), num('Gamma', 'gamma', 0.1, 9.99, 0.01)],
  vibrance: [num('Vibrance', 'vibrance', -100, 100), num('Saturation', 'saturation', -100, 100)],
  hue_saturation: [
    num('Master Hue', 'master.hue', -180, 180), num('Master Saturation', 'master.saturation', -100, 100), num('Master Lightness', 'master.lightness', -100, 100),
    check('Colorize', 'colorize'), num('Colorize Hue', 'colorize_values.hue', 0, 360), num('Colorize Saturation', 'colorize_values.saturation', 0, 100), num('Colorize Lightness', 'colorize_values.lightness', -100, 100),
    ...rangeFields(0, 'Reds'), ...rangeFields(1, 'Yellows'), ...rangeFields(2, 'Greens'), ...rangeFields(3, 'Cyans'), ...rangeFields(4, 'Blues'), ...rangeFields(5, 'Magentas'),
  ],
  color_balance: [
    num('Shadows Cyan-Red', 'shadows.0', -100, 100), num('Shadows Magenta-Green', 'shadows.1', -100, 100), num('Shadows Yellow-Blue', 'shadows.2', -100, 100),
    num('Midtones Cyan-Red', 'midtones.0', -100, 100), num('Midtones Magenta-Green', 'midtones.1', -100, 100), num('Midtones Yellow-Blue', 'midtones.2', -100, 100),
    num('Highlights Cyan-Red', 'highlights.0', -100, 100), num('Highlights Magenta-Green', 'highlights.1', -100, 100), num('Highlights Yellow-Blue', 'highlights.2', -100, 100),
    check('Preserve luminosity', 'preserve_luminosity'),
  ],
  black_white: [
    num('Reds', 'reds', -200, 300), num('Yellows', 'yellows', -200, 300), num('Greens', 'greens', -200, 300),
    num('Cyans', 'cyans', -200, 300), num('Blues', 'blues', -200, 300), num('Magentas', 'magentas', -200, 300),
    check('Tint', 'tint'), num('Tint R', 'tint_color.0', 0, 255), num('Tint G', 'tint_color.1', 0, 255), num('Tint B', 'tint_color.2', 0, 255),
  ],
  photo_filter: [num('Color R', 'color.0', 0, 255), num('Color G', 'color.1', 0, 255), num('Color B', 'color.2', 0, 255), num('Density', 'density', 0, 100), check('Preserve luminosity', 'preserve_luminosity')],
  channel_mixer: [...row4('Red', 'red'), ...row4('Green', 'green'), ...row4('Blue', 'blue'), ...row4('Gray', 'gray'), check('Monochrome', 'monochrome')],
  posterize: [num('Levels', 'levels', 2, 255)],
  threshold: [num('Level', 'level', 1, 255)],
  selective_color: [
    { type: 'select', label: 'Mode', path: 'mode', options: [['relative', 'Relative'], ['absolute', 'Absolute']] },
    ...quad('Reds', 'reds', -100, 100), ...quad('Yellows', 'yellows', -100, 100), ...quad('Greens', 'greens', -100, 100), ...quad('Cyans', 'cyans', -100, 100),
    ...quad('Blues', 'blues', -100, 100), ...quad('Magentas', 'magentas', -100, 100), ...quad('Whites', 'whites', -100, 100), ...quad('Neutrals', 'neutrals', -100, 100), ...quad('Blacks', 'blacks', -100, 100),
  ],
};

/** Reads a dot path (numeric segments index arrays) out of an adjustment's params. */
export function getPath(params: object, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], params);
}

/** Returns a new adjustment with `path` set to `value`, cloning only the touched branch. */
export function setPath(adjustment: Adjustment, path: string, value: unknown): Adjustment {
  const keys = path.split('.');
  const clone = (v: unknown, i: number): unknown => {
    if (i === keys.length) return value;
    const k = keys[i];
    const child = Array.isArray(v) ? [...v] : { ...(v as object) };
    (child as Record<string, unknown>)[k] = clone((v as Record<string, unknown>)?.[k], i + 1);
    return child;
  };
  return { ...adjustment, params: clone(adjustment.params, 0) } as Adjustment;
}

export const gradientDefToUi = (g: GradientDef): Gradient => ({
  stops: g.color_stops.map(s => ({ position: s.position, color: s.color, midpoint: s.midpoint })),
  opacityStops: g.opacity_stops.map(s => ({ position: s.position, opacity: s.opacity, midpoint: s.midpoint })),
  kind: 'solid', interpolation: g.method === 'classic' || g.method === 'linear' || g.method === 'perceptual' ? g.method : 'classic',
});

export const uiToGradientDef = (g: Gradient): GradientDef => ({
  method: g.interpolation,
  color_stops: g.stops.map(s => ({ position: s.position, color: s.color, midpoint: s.midpoint })),
  opacity_stops: g.opacityStops.map(s => ({ position: s.position, opacity: s.opacity, midpoint: s.midpoint })),
});
