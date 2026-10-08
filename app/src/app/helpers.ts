import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { i18n } from '../i18n/index.ts';
import type { Active } from '../LayersPanel.tsx';
import { locate, nodeById } from '../layers.ts';
import type { Rgb } from '../shell/color.ts';
import type { ViewerTool } from '../viewer.ts';
import type { AlignMode, AutosaveState, DocInfo, FillContent, StrokeSelectionParams } from '../worker/types.ts';

const SAMPLE_SIZES: Record<string, number> = { point: 1, '3x3': 3, '5x5': 5, '11x11': 11, '31x31': 31, '51x51': 51, '101x101': 101 };
const VIEWER_TOOL: Record<string, ViewerTool> = { hand: 'hand', rotate: 'rotate', zoom: 'zoom' };
const SELECT_TOOLS = ['marqueeRect', 'marqueeEllipse', 'marqueeRow', 'marqueeColumn', 'lasso', 'polygonalLasso', 'magneticLasso', 'quickSelection', 'magicWand'];
const PAINT_LABELS: Record<string, MessageDescriptor> = {
  brush: msg`Brush`, pencil: msg`Pencil`, eraser: msg`Eraser`, cloneStamp: msg`Clone Stamp`, patternStamp: msg`Pattern Stamp`,
  spotHealing: msg`Spot Healing Brush`, healingBrush: msg`Healing Brush`, historyBrush: msg`History Brush`, artHistoryBrush: msg`Art History Brush`,
  blur: msg`Blur`, sharpen: msg`Sharpen`, smudge: msg`Smudge`, dodge: msg`Dodge`, burn: msg`Burn`, sponge: msg`Sponge`,
  colorReplacement: msg`Color Replacement`, mixerBrush: msg`Mixer Brush`, backgroundEraser: msg`Background Eraser`,
};
const PAINT_TOOLS = new Set(Object.keys(PAINT_LABELS));
const SHAPE_NAMES: Record<string, string> = { rectangle: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle', polygon: 'Polygon', line: 'Line', customShape: 'Shape' };
const LAYER_TOOLS = new Set(['magneticLasso', 'bucket', 'magicEraser', 'gradient']);

// Tools whose gesture changes or samples the active layer; with no active layer they report it and do not start.
// Move with Auto-Select (Ctrl/Cmd inverts it) picks the clicked layer instead.
function needsLayer(tool: string, o: Record<string, unknown>, key: { ctrlKey: boolean; metaKey: boolean }): boolean {
  if (tool === 'move') return !o.autoSelect === !(key.ctrlKey || key.metaKey);
  if (tool === 'magicWand' || tool === 'quickSelection') return !o.sampleAllLayers;
  if (tool in SHAPE_NAMES) return o.mode === 'pixels';
  return PAINT_TOOLS.has(tool) || LAYER_TOOLS.has(tool);
}

// Select > Modify (docs/M2.md section 3): op -> [min, max, default].
const MODIFY_OPS: Record<'border' | 'smooth' | 'expand' | 'contract', { label: MessageDescriptor; min: number; max: number; default: number }> = {
  border: { label: msg`Border`, min: 1, max: 200, default: 10 },
  smooth: { label: msg`Smooth`, min: 1, max: 100, default: 2 },
  expand: { label: msg`Expand`, min: 1, max: 500, default: 5 },
  contract: { label: msg`Contract`, min: 1, max: 500, default: 5 },
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
const FILL_CONTENTS = { foreground: msg`Foreground Color`, background: msg`Background Color`, color: msg`Color…`, contentAware: msg`Content-Aware`, pattern: msg`Pattern`, history: msg`History`, black: msg`Black`, gray: msg`50% Gray`, white: msg`White` };
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
  solid: { title: msg`Solid Color`, label: msg`Solid Color`, name: 'Color Fill' },
  gradient: { title: msg`Gradient Fill`, label: msg`Gradient`, name: 'Gradient Fill' },
  pattern: { title: msg`Pattern Fill`, label: msg`Pattern`, name: 'Pattern Fill' },
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
type SelectAfter = (d: DocInfo) => Active | null;
// `sep` draws a separator line above the item. `id` is the English label: shortcuts, context menus, command
// search and WebMCP find items by it, so a translated `label` does not break them.
interface Item { id?: string; label: string; keys?: string; run: () => void; off?: boolean; sub?: Item[]; sep?: boolean }
export const itemId = (i: Item) => i.id ?? i.label;
/** Translated menu text: `tl(msg\`Snap\`, on)` gives the English id and the label in the active language. */
export const tl = (d: MessageDescriptor, on?: boolean) => ({ id: d.message!, label: `${on ? '✓ ' : ''}${i18n._(d)}` });

/** The first item of any menu or its direct submenus whose id matches, in menu order. */
export function findMenuItem(menus: Record<string, Item[]>, pred: (id: string) => boolean): Item | undefined {
  return Object.values(menus).flat().flatMap(i => [i, ...(i.sub ?? [])]).find(i => pred(itemId(i)));
}

// Default and undo/redo fallback: the topmost root layer, pixels target.
function fallbackActive(d: DocInfo): Active {
  return { id: d.layers.at(-1)!.id, target: 'pixels' };
}

// Active layer after a worker reply. No active layer (Deselect Layers) survives replies on the same document
// and tab restores; a new document starts on its top layer.
function nextActive(d: DocInfo, sameDoc: boolean, cur: Active | null, saved: { active: Active | null } | undefined,
  selectAfter?: SelectAfter): Active | null {
  if (selectAfter) return selectAfter(d);
  const keep = saved ? saved.active : sameDoc ? cur : undefined;
  if (keep === null) return null;
  return keep && nodeById(d.layers, keep.id) ? keep : fallbackActive(d);
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

const AUTOSAVE_TEXT: Record<AutosaveState, MessageDescriptor> = {
  off: msg`Autosave unavailable in this browser`,
  'other-tab': msg`Autosave off: open in another tab`,
  idle: msg`Autosave on`,
  saving: msg`Saving…`,
  saved: msg`All changes saved locally`,
  error: msg`Autosave failed`,
};

// Place/Replace/Relink file choice: the File System Access picker (with a handle, D7) or a plain file input.
type OpenPicker = (o: object) => Promise<FileSystemFileHandle[]>;
const PLACE_TYPES = [{ description: msg`Images`, accept: { 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'], 'image/vnd.adobe.photoshop': ['.psd', '.psb'] } }];
async function pickPlaceFile(): Promise<{ file: File; handle: FileSystemFileHandle | null } | null> {
  const picker = (window as unknown as { showOpenFilePicker?: OpenPicker }).showOpenFilePicker;
  if (picker) {
    try {
      const [handle] = await picker({ types: PLACE_TYPES.map(p => ({ ...p, description: i18n._(p.description) })), multiple: false });
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
const EDGES = [msg`Top Edges`, msg`Vertical Centers`, msg`Bottom Edges`, msg`Left Edges`, msg`Horizontal Centers`, msg`Right Edges`];
const ALIGN_ITEMS: [AlignMode, MessageDescriptor][] = [
  ['align-top', EDGES[0]], ['align-vcenter', EDGES[1]], ['align-bottom', EDGES[2]], ['align-left', EDGES[3]], ['align-hcenter', EDGES[4]], ['align-right', EDGES[5]],
  ['distribute-top', EDGES[0]], ['distribute-vcenter', EDGES[1]], ['distribute-bottom', EDGES[2]], ['distribute-left', EDGES[3]], ['distribute-hcenter', EDGES[4]], ['distribute-right', EDGES[5]],
];
const STACK_MODES: [string | null, MessageDescriptor][] = [
  [null, msg`None`], ['entropy', msg`Entropy`], ['kurtosis', msg`Kurtosis`], ['maximum', msg`Maximum`], ['mean', msg`Mean`], ['median', msg`Median`],
  ['minimum', msg`Minimum`], ['range', msg`Range`], ['skewness', msg`Skewness`], ['standard_deviation', msg`Standard Deviation`],
  ['summation', msg`Summation`], ['variance', msg`Variance`],
];

// False when the user cancels the file picker.
async function saveBlob(blob: Blob, name: string, mime: string, ext: string): Promise<boolean> {
  const picker = (window as unknown as { showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker) {
    try {
      const h = await picker({ suggestedName: name, types: [{ description: ext.toUpperCase(), accept: { [mime]: [`.${ext}`] } }] });
      const w = await (h as unknown as { createWritable(): Promise<WritableStream & { write(b: Blob): Promise<void>; close(): Promise<void> }> }).createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;
      throw e;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  return true;
}
// A floating Move drag lands with one step and the commit (or cancel) sent right behind it, so a
// later press reaches the worker after them; `landed` never waits for the view to draw, `drawn` does,
// `settled` waits for both and never rejects.
export function landFloat<D, E>(step: () => Promise<D>, end: () => Promise<E>, shown: (d: D) => Promise<void> | void, failed: (e: unknown) => void = () => {}) {
  const s = step();
  const landed = end();
  const drawn = s.then(shown, failed);
  return { landed, drawn, settled: Promise.allSettled([landed, drawn]).then(() => {}) };
}

// Background reads (Layers panel thumbnails) wait while a Move drag holds, so they never queue in the
// worker ahead of its commit. A hold's release runs once.
let holds = 0;
let idle: (() => void)[] = [];
export function holdBackground(): () => void {
  holds++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--holds) return;
    const w = idle;
    idle = [];
    for (const f of w) f();
  };
}
export const whenBackground = (): Promise<void> => (holds ? new Promise(r => idle.push(r)) : Promise.resolve());

type Run = (label: string | null, p: () => Promise<DocInfo | null>, selectAfter?: SelectAfter) => Promise<void>;
type Show = (d: DocInfo | null, selectAfter?: SelectAfter) => void;

export {
  SAMPLE_SIZES, VIEWER_TOOL, SELECT_TOOLS, PAINT_LABELS, PAINT_TOOLS, SHAPE_NAMES, needsLayer, MODIFY_OPS, COLOR_RANGE_PRESETS, makeLatch, FILL_KEY, FILL_CONTENTS,
  loadFillForm, STROKE_DEFAULT, FILL_LAYERS, fillContentFromForm, formFromFillContent, fallbackActive, nextActive, selectCreated, selectAfterDelete,
  AUTOSAVE_TEXT, pickPlaceFile, STACK_MODES, ALIGN_ITEMS, saveBlob,
};
export type { Rgba, TrimBase, FillContents, FillForm, StrokeForm, FillContentForm, FillDialogMode, SelectAfter, Item, Run, Show };
