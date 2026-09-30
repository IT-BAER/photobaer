import type { Active } from '../LayersPanel.tsx';
import { locate, nodeById } from '../layers.ts';
import type { Rgb } from '../shell/color.ts';
import type { ViewerTool } from '../viewer.ts';
import type { AutosaveState, DocInfo, FillContent, StrokeSelectionParams } from '../worker/types.ts';

const SAMPLE_SIZES: Record<string, number> = { point: 1, '3x3': 3, '5x5': 5, '11x11': 11, '31x31': 31, '51x51': 51, '101x101': 101 };
const VIEWER_TOOL: Record<string, ViewerTool> = { hand: 'hand', rotate: 'rotate', zoom: 'zoom' };
const SELECT_TOOLS = ['marqueeRect', 'marqueeEllipse', 'marqueeRow', 'marqueeColumn', 'lasso', 'polygonalLasso', 'magneticLasso', 'quickSelection', 'magicWand'];
const PAINT_LABELS: Record<string, string> = { brush: 'Brush', pencil: 'Pencil', eraser: 'Eraser' };
const PAINT_TOOLS = new Set(['brush', 'pencil', 'eraser']);

// Select > Modify (docs/M2.md section 3): op -> [min, max, default].
const MODIFY_OPS: Record<'border' | 'smooth' | 'expand' | 'contract', { label: string; min: number; max: number; default: number }> = {
  border: { label: 'Border', min: 1, max: 200, default: 10 },
  smooth: { label: 'Smooth', min: 1, max: 100, default: 2 },
  expand: { label: 'Expand', min: 1, max: 500, default: 5 },
  contract: { label: 'Contract', min: 1, max: 500, default: 5 },
};
const COLOR_RANGE_PRESETS = ['sampled', 'reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'highlights', 'midtones', 'shadows', 'skin tones'];

// True only after `held` was seen released once during the drag, so a modifier already held at
// pointer-down (consumed for add/subtract) must be released and re-pressed to engage constrain/etc.
function makeLatch(held: boolean) {
  let latched = !held;
  return (down: boolean) => {
    if (!down) latched = true;
    return latched && down;
  };
}

type Rgba = [number, number, number, number];
type TrimBase = 'transparent' | 'topLeftPixel' | 'bottomRightPixel';

// Edit > Fill: only contents, color and pattern persist across openings.
const FILL_KEY = 'photobaer:fill';
const FILL_CONTENTS = { foreground: 'Foreground Color', background: 'Background Color', color: 'Color…', contentAware: 'Content-Aware', pattern: 'Pattern', history: 'History', black: 'Black', gray: '50% Gray', white: 'White' };
type FillContents = keyof typeof FILL_CONTENTS;
interface FillForm { contents: FillContents; color: Rgb; pattern: string; caStructure: number; caColor: number; mode: string; opacity: number; preserve: boolean }
function loadFillForm(): FillForm {
  const f: FillForm = { contents: 'foreground', color: [0, 0, 0], pattern: '', caStructure: 4, caColor: 5, mode: 'normal', opacity: 100, preserve: false };
  try {
    const s = JSON.parse(localStorage.getItem(FILL_KEY) ?? 'null') as Partial<FillForm> | null;
    if (s && typeof s.contents === 'string' && s.contents in FILL_CONTENTS) f.contents = s.contents;
    if (Array.isArray(s?.color) && s.color.length === 3 && s.color.every(c => Number.isInteger(c) && c >= 0 && c <= 255)) f.color = s.color;
    if (typeof s?.pattern === 'string') f.pattern = s.pattern;
    if (Number.isInteger(s?.caStructure) && s!.caStructure! >= 1 && s!.caStructure! <= 7) f.caStructure = s!.caStructure!;
    if (Number.isInteger(s?.caColor) && s!.caColor! >= 0 && s!.caColor! <= 10) f.caColor = s!.caColor!;
  } catch { /* unavailable or corrupt: defaults */ }
  return f;
}
interface StrokeForm { width: number; color: Rgb; location: StrokeSelectionParams['location']; mode: string; opacity: number; preserve: boolean }
const STROKE_DEFAULT: StrokeForm = { width: 3, color: [0, 0, 0], location: 'inside', mode: 'normal', opacity: 100, preserve: false };

// Layer > New Fill Layer / Layer Content Options (docs/M3.md section 4): per fill type the dialog title,
// the undo label and the new layer's name. The dialog's gradient is black to white, classic, two stops;
// it never edits the stops.
const FILL_LAYERS = {
  solid: { title: 'Solid Color', label: 'Solid Color', name: 'Color Fill' },
  gradient: { title: 'Gradient Fill', label: 'Gradient', name: 'Gradient Fill' },
  pattern: { title: 'Pattern Fill', label: 'Pattern', name: 'Pattern Fill' },
} as const;
const DEFAULT_GRADIENT = {
  method: 'classic' as const,
  color_stops: [{ position: 0, color: [0, 0, 0] as [number, number, number], midpoint: 0.5 }, { position: 1, color: [255, 255, 255] as [number, number, number], midpoint: 0.5 }],
  opacity_stops: [{ position: 0, opacity: 1, midpoint: 0.5 }, { position: 1, opacity: 1, midpoint: 0.5 }],
};
interface FillContentForm {
  type: keyof typeof FILL_LAYERS;
  color: Rgb; style: 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond'; angle: number; scalePct: number;
  reverse: boolean; dither: boolean; alignWithLayer: boolean; patternId: string; linked: boolean;
}
type FillDialogMode = { kind: 'create'; type: FillContentForm['type'] } | { kind: 'edit'; id: number };
function fillContentFromForm(f: FillContentForm): FillContent {
  if (f.type === 'solid') return { type: 'solid', color: f.color };
  if (f.type === 'gradient') {
    return {
      type: 'gradient', gradient: DEFAULT_GRADIENT, style: f.style, angle: f.angle, scale: f.scalePct / 100,
      reverse: f.reverse, dither: f.dither, align_with_layer: f.alignWithLayer, offset: [0, 0],
    };
  }
  return { type: 'pattern', pattern_id: f.patternId, scale: f.scalePct / 100, angle: f.angle, linked: f.linked, offset: [0, 0] };
}
function formFromFillContent(c: FillContent, fallbackColor: Rgb, fallbackPattern: string): FillContentForm {
  const base: FillContentForm = { type: c.type, color: fallbackColor, style: 'linear', angle: 0, scalePct: 100, reverse: false, dither: false, alignWithLayer: true, patternId: fallbackPattern, linked: true };
  if (c.type === 'solid') return { ...base, color: c.color };
  if (c.type === 'gradient') return { ...base, style: c.style, angle: c.angle, scalePct: c.scale * 100, reverse: c.reverse, dither: c.dither, alignWithLayer: c.align_with_layer };
  return { ...base, patternId: c.pattern_id, scalePct: c.scale * 100, angle: c.angle, linked: c.linked };
}
type CreateResult = DocInfo & { created: number };
type SelectAfter = (d: DocInfo) => Active;
// `sep` draws a separator line above the item.
interface Item { label: string; keys?: string; run: () => void; off?: boolean; sub?: Item[]; sep?: boolean }

// Default and undo/redo fallback: the topmost root layer, pixels target.
function fallbackActive(d: DocInfo): Active {
  return { id: d.layers.at(-1)!.id, target: 'pixels' };
}

const selectCreated: SelectAfter = d => ({ id: (d as CreateResult).created, target: 'pixels' });

// The node now at the deleted node's place in its old parent list, else the topmost root layer.
function selectAfterDelete(before: DocInfo, id: number): SelectAfter {
  const loc = locate(before.layers, id);
  return d => {
    if (loc) {
      const siblings = loc.parent === 0 ? d.layers : nodeById(d.layers, loc.parent)?.children ?? [];
      if (siblings.length) return { id: siblings[Math.min(loc.index, siblings.length - 1)].id, target: 'pixels' };
    }
    return fallbackActive(d);
  };
}

const AUTOSAVE_TEXT: Record<AutosaveState, string> = {
  off: 'Autosave unavailable in this browser',
  'other-tab': 'Autosave off: open in another tab',
  idle: 'Autosave on',
  saving: 'Saving…',
  saved: 'All changes saved locally',
  error: 'Autosave failed',
};

// Place/Replace/Relink file choice: the File System Access picker (with a handle, D7) or a plain file input.
type OpenPicker = (o: object) => Promise<FileSystemFileHandle[]>;
const PLACE_TYPES = [{ description: 'Images', accept: { 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'], 'image/vnd.adobe.photoshop': ['.psd', '.psb'] } }];
async function pickPlaceFile(): Promise<{ file: File; handle: FileSystemFileHandle | null } | null> {
  const picker = (window as unknown as { showOpenFilePicker?: OpenPicker }).showOpenFilePicker;
  if (picker) {
    try {
      const [handle] = await picker({ types: PLACE_TYPES, multiple: false });
      return { file: await handle.getFile(), handle };
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
      throw e;
    }
  }
  return new Promise(res => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = 'image/png,image/jpeg,image/webp,.psd,.psb';
    i.onchange = () => { const f = i.files?.[0]; res(f ? { file: f, handle: null } : null); };
    i.click();
  });
}
const STACK_MODES: [string | null, string][] = [
  [null, 'None'], ['entropy', 'Entropy'], ['kurtosis', 'Kurtosis'], ['maximum', 'Maximum'], ['mean', 'Mean'], ['median', 'Median'],
  ['minimum', 'Minimum'], ['range', 'Range'], ['skewness', 'Skewness'], ['standard_deviation', 'Standard Deviation'],
  ['summation', 'Summation'], ['variance', 'Variance'],
];

async function saveBlob(blob: Blob, name: string, mime: string, ext: string) {
  const picker = (window as unknown as { showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker) {
    try {
      const h = await picker({ suggestedName: name, types: [{ description: ext.toUpperCase(), accept: { [mime]: [`.${ext}`] } }] });
      const w = await (h as unknown as { createWritable(): Promise<WritableStream & { write(b: Blob): Promise<void>; close(): Promise<void> }> }).createWritable();
      await w.write(blob);
      await w.close();
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      throw e;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}
type Run = (label: string | null, p: () => Promise<DocInfo | null>, selectAfter?: SelectAfter) => Promise<void>;
type Show = (d: DocInfo | null, selectAfter?: SelectAfter) => void;

export {
  SAMPLE_SIZES, VIEWER_TOOL, SELECT_TOOLS, PAINT_LABELS, PAINT_TOOLS, MODIFY_OPS, COLOR_RANGE_PRESETS, makeLatch, FILL_KEY, FILL_CONTENTS,
  loadFillForm, STROKE_DEFAULT, FILL_LAYERS, fillContentFromForm, formFromFillContent, fallbackActive, selectCreated, selectAfterDelete,
  AUTOSAVE_TEXT, pickPlaceFile, STACK_MODES, saveBlob,
};
export type { Rgba, TrimBase, FillContents, FillForm, StrokeForm, FillContentForm, FillDialogMode, SelectAfter, Item, Run, Show };
