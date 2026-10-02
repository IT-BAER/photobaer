// The filter registry schema from the engine (docs/M5.md section 1): menu entries, dialog fields, defaults.
import type { FieldSpec } from '../adjustments.ts';
import type { ParamValue } from './lastFilter.ts';

export interface FilterParam {
  key: string; label: string;
  kind: 'number' | 'int' | 'percent' | 'angle' | 'select' | 'bool' | 'blob' | 'seed' | 'point' | 'kernel' | 'curve' | 'color' | 'lights' | 'path' | 'pins' | 'paths' | 'stack' | 'rig' | 'quads' | 'stamps';
  min: number; max: number; step: number; unit: string; default: ParamValue | null; choices?: string[];
}
export interface FilterSpec {
  id: string; label: string; group: string; params: FilterParam[];
  exec: 'point' | 'local' | 'global'; alpha: 'kept' | 'processed'; preview: boolean; rgb_only: boolean; editor?: 'adjustment';
  // The output can leave the source rect (a scale or warp): the preview covers the whole layer.
  whole?: boolean;
}

// Filter menu submenus in reference order; registry groups not listed here (adjust) stay out of the menu.
export const GROUPS: [string, string][] = [
  ['blur', 'Blur'], ['blurGallery', 'Blur Gallery'], ['distort', 'Distort'], ['noise', 'Noise'], ['pixelate', 'Pixelate'],
  ['render', 'Render'], ['sharpen', 'Sharpen'], ['stylize', 'Stylize'], ['video', 'Video'], ['other', 'Other'],
];

let specs: FilterSpec[] = [];
export const setSchema = (s: FilterSpec[]) => { specs = s; };
export const schema = () => specs;
export const specOf = (id: string) => specs.find(s => s.id === id);

// Blob, seed and color params are carried in the filter but never shown.
export const visibleParams = (s: FilterSpec) => s.params.filter(p => p.kind !== 'blob' && p.kind !== 'seed' && p.kind !== 'color');
export const menuLabel = (s: FilterSpec) => (visibleParams(s).length ? `${s.label}…` : s.label);

// Color params (`foreground`, `background`) take the current colors as #rrggbb.
let colors = () => ({ foreground: '#000000', background: '#ffffff' });
export const setColorSource = (f: typeof colors) => { colors = f; };

// Seed params get a fresh random seed per dialog open.
export function defaults(s: FilterSpec): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const p of s.params) {
    if (p.kind === 'seed') out[p.key] = p.min + Math.floor(Math.random() * (p.max - p.min + 1));
    else if (p.kind === 'color') out[p.key] = colors()[p.key as 'foreground' | 'background'] ?? p.default ?? '#000000';
    else if (p.default !== null) out[p.key] = p.default;
  }
  return out;
}

const words = (c: string) => c.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, m => m.toUpperCase());
const withUnit = (p: FilterParam) => (p.unit ? `${p.label} (${p.unit})` : p.label);

// A point param is two fields, its x and y as fractions of the layer bounds; a kernel is 25 fields, row by
// row; a curve, lights, paths, pins, a gallery stack, a rig and quads have no fields (the dialog or the canvas overlay edits them).
export function fieldSpecs(s: FilterSpec): FieldSpec[] {
  return visibleParams(s).flatMap((p): FieldSpec[] => {
    if (p.kind === 'bool') return [{ type: 'checkbox', label: p.label, path: p.key }];
    if (p.kind === 'select') return [{ type: 'select', label: p.label, path: p.key, options: (p.choices ?? []).map(c => [c, words(c)]) }];
    if (p.kind === 'curve' || p.kind === 'lights' || p.kind === 'path' || p.kind === 'paths' || p.kind === 'pins' || p.kind === 'stack' || p.kind === 'rig' || p.kind === 'quads' || p.kind === 'stamps') return [];
    if (p.kind === 'kernel') return Array.from({ length: 25 }, (_, i) => ({ type: 'number', label: `${p.label} ${Math.floor(i / 5) + 1},${(i % 5) + 1}`, path: `${p.key}.${i}`, min: p.min, max: p.max, step: p.step }));
    if (p.kind === 'point') return (['x', 'y'] as const).map(k => ({ type: 'number', label: `${p.label} ${k.toUpperCase()}`, path: `${p.key}.${k}`, min: p.min, max: p.max, step: p.step }));
    return [{ type: 'number', label: withUnit(p), path: p.key, min: p.min, max: p.max, step: p.step }];
  });
}

// A live preview over more than 512 x 512 visible px runs on a proxy at this scale (docs/M5.md section 2).
export const previewScale = (w: number, h: number) => Math.min(1, Math.sqrt(262144 / Math.max(1, w * h)));
