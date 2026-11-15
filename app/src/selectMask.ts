// Select and Mask helpers: the preview per view mode, the brush edit codes and the remembered settings.
import type { RefineSettings } from './worker/types.ts';

export type RefineView = 'onion' | 'overlay' | 'black' | 'white' | 'bw' | 'layers';
export const VIEWS: RefineView[] = ['onion', 'overlay', 'black', 'white', 'bw', 'layers'];
export const OUTPUTS = ['selection', 'layerMask', 'newLayer', 'newLayerMask', 'newDocument', 'newDocumentMask'] as const;
export type RefineOutput = typeof OUTPUTS[number];

// Working-size brush codes, as the engine reads them.
export const EDIT = { subtract: 0, refine: 64, none: 128, keepEdge: 192, add: 255 } as const;

export interface Remembered {
  view: RefineView;
  // Per view mode, 0..100.
  opacity: Record<RefineView, number>;
  settings: RefineSettings;
  decontaminate: boolean;
  amount: number;
  output: RefineOutput;
}

export const DEFAULTS: Remembered = {
  view: 'onion',
  opacity: { onion: 50, overlay: 50, black: 100, white: 100, bw: 100, layers: 100 },
  settings: { radius: 0, smart_radius: false, smooth: 0, feather: 0, contrast: 0, shift_edge: 0 },
  decontaminate: false,
  amount: 100,
  output: 'selection',
};

// [min, max] per setting.
export const RANGES: Record<Exclude<keyof RefineSettings, 'smart_radius'>, [number, number]> = {
  radius: [0, 250], smooth: [0, 100], feather: [0, 1000], contrast: [0, 100], shift_edge: [-100, 100],
};

const CHECK = [255, 204];

// RGBA preview of the opaque working image `img` (w wide) with the refined coverage `alpha`, the edge `band` and the
// starting selection `orig` (0..255 each). Brush codes in `edits` show added and subtracted strokes before the next
// preview arrives. `opacity` (0..1) is how much of the unselected area the view covers.
export function refineView(img: Uint8Array, w: number, alpha: Uint8Array, band: Uint8Array, orig: Uint8Array, edits: Uint8Array | null,
  o: { view: RefineView; opacity: number; showEdge: boolean; showOriginal: boolean }): Uint8ClampedArray<ArrayBuffer> {
  const n = alpha.length, out = new Uint8ClampedArray(n * 4), op = o.view === 'layers' ? 1 : o.opacity;
  for (let i = 0; i < n; i++) {
    const e = edits ? edits[i] : EDIT.none;
    let m = (o.showOriginal ? orig[i] : alpha[i]) / 255;
    if (!o.showOriginal && e === EDIT.add) m = 1;
    if (!o.showOriginal && e === EDIT.subtract) m = 0;
    if (o.showEdge && !band[i]) m = 0;
    const chk = CHECK[((Math.floor((i % w) / 8) + Math.floor(Math.floor(i / w) / 8)) & 1)];
    for (let c = 0; c < 3; c++) {
      const v = img[i * 4 + c];
      const under = o.view === 'overlay' ? (c === 0 ? 255 : 0) : o.view === 'black' ? 0 : o.view === 'white' ? 255 : chk;
      out[i * 4 + c] = o.view === 'bw' ? 255 * m : v * m + (v * (1 - op) + under * op) * (1 - m);
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}

// Invert: added strokes become subtracted ones and back.
export function invertEdits(edits: Uint8Array) {
  return edits.map(v => (v === EDIT.add ? EDIT.subtract : v === EDIT.subtract ? EDIT.add : v));
}

const num = (v: unknown, [lo, hi]: [number, number], d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

// Remember Settings: the stored JSON, each value checked; anything missing or invalid is the default.
export function parseRemembered(json: string | null): Remembered {
  let v: Record<string, unknown> = {};
  try { const p = json ? JSON.parse(json) : null; if (p && typeof p === 'object') v = p; } catch { /* defaults */ }
  const s = (v.settings && typeof v.settings === 'object' ? v.settings : {}) as Record<string, unknown>;
  const op = (v.opacity && typeof v.opacity === 'object' ? v.opacity : {}) as Record<string, unknown>;
  const d = DEFAULTS.settings;
  return {
    view: VIEWS.includes(v.view as RefineView) ? v.view as RefineView : DEFAULTS.view,
    opacity: Object.fromEntries(VIEWS.map(k => [k, num(op[k], [0, 100], DEFAULTS.opacity[k])])) as Record<RefineView, number>,
    settings: {
      radius: num(s.radius, RANGES.radius, d.radius), smart_radius: typeof s.smart_radius === 'boolean' ? s.smart_radius : d.smart_radius,
      smooth: num(s.smooth, RANGES.smooth, d.smooth), feather: num(s.feather, RANGES.feather, d.feather),
      contrast: num(s.contrast, RANGES.contrast, d.contrast), shift_edge: num(s.shift_edge, RANGES.shift_edge, d.shift_edge),
    },
    decontaminate: typeof v.decontaminate === 'boolean' ? v.decontaminate : DEFAULTS.decontaminate,
    amount: num(v.amount, [0, 100], DEFAULTS.amount),
    output: OUTPUTS.includes(v.output as RefineOutput) ? v.output as RefineOutput : DEFAULTS.output,
  };
}
