import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { client } from './client.ts';
import { Viewer, type ToolPointerEvent, type ViewerTool } from './viewer.ts';
import { createRenderer } from './render/renderer.ts';
import { makeTileSource, gpuTestHook } from './render/tiles.ts';
import { perfTestHook, type PerfProbe } from './render/perf.ts';
import { flatNodes, locate, nodeById } from './layers.ts';
import { LayersPanel, type Active } from './LayersPanel.tsx';
import { HistoryPanel } from './HistoryPanel.tsx';
import { LayerCompsPanel } from './LayerCompsPanel.tsx';
import { AdjustmentBody, PropertiesPanel, type PickLookupFile } from './PropertiesPanel.tsx';
import { AdjustmentsPanel } from './AdjustmentsPanel.tsx';
import { LayerStyleDialog, type StylePage } from './LayerStyleDialog.tsx';
import { EFFECT_KINDS, EFFECT_LABEL, styleRefusal } from './layerStyle.ts';
import type { SampleCanvas } from './LevelsCurvesBody.tsx';
import { ADJUSTMENT_KINDS, COMMAND_LABEL, DESTRUCTIVE_LABEL, MENU_LABEL, SHORTCUT, defaultAdjustment, defaultDestructive, type DestructiveKind, type Kind } from './adjustments.ts';
import type { Adjustment, AutosaveState, DestructiveAdjustment, DocInfo, FillContent, FillParams, GradientParams, StrokeParams, StrokeSelectionParams } from './engine.worker.ts';
import { Smoother } from './shell/smoothing.ts';
import { ToolBar } from './shell/ToolBar.tsx';
import { OptionsBar, type ToolOptions } from './shell/OptionsBar.tsx';
import { ColorPanel } from './shell/ColorPanel.tsx';
import { SwatchesPanel } from './shell/SwatchesPanel.tsx';
import { ColorPicker, type ColorPickerHandle } from './shell/ColorPicker.tsx';
import { PAINT_MODES, TOOLS, initialLastUsed, keyToTool, loadToolOptions, saveToolOptions, slotForKey } from './shell/tools.ts';
import { BrushesPanel, BrushSettingsPanel } from './shell/BrushPanels.tsx';
import { hexToRgb, rgbToHex, type Rgb } from './shell/color.ts';
import { digitOption, dragResize, showCrosshair, stepHardness, stepSize, type DigitState } from './shell/brushKeys.ts';
import { HANDLE_CURSORS, SelectionOverlay, boxHandles, type TransformImage } from './shell/SelectionOverlay.ts';
import { constrainedSnap, snapOffset, type Rect, type SnapAxes } from './shell/snapping.ts';
import { MODES, TransformBar, TransformBarStore, type WarpBarState, type WarpSplit } from './shell/TransformBar.tsx';
import { IDENTITY, isIdentity, normalize, type Mat3, type Pt } from './transform/matrix.ts';
import {
  commandState, drag as dragState, handlePoints, hitTest, initialState, matrixOf, numericValues, opFor, refPoint, setNumeric, setReference,
  setReferenceNormalized, type Command, type Hit, type Mode, type Mods, type TState,
} from './transform/session.ts';
import {
  defaultPreset, dragPoint, dragSurface, engineMesh, evaluate, gridOf, hitPoint, identityMesh, meshModified, pickStyle, presetMesh,
  removeSplitAt, setGrid, splitAt, surfaceWeights, type Mesh, type Warp,
} from './transform/warp.ts';
import { antsLevel, contour, marqueeRect, MagneticLasso, PolygonLasso, selectMode, snap45, snap45Length, type SelectMode } from './shell/selecttools.ts';
import { levelFor } from './view.ts';
import { BrushLibrary } from './brushes/store.ts';
import { EngineAssets } from './brushes/engineAssets.ts';
import { buildUpFor, presetOptions, presetStrokeParams, pushRecent, smoothingFor, type PaintTool } from './brushes/brushParams.ts';
import { parseAbrOffThread } from './brushes/abr.ts';
import type { BrushPreset, Dynamics } from './brushes/preset.ts';
import { BuildUp, inputFields, strideFor, strokeSeed, type Stride } from './brushes/strokeInput.ts';
import { GradientEditor, type GradientEditorHandle } from './shell/GradientEditor.tsx';
import { engineStops, rampCss, type Method } from './gradients/gradient.ts';
import { BUILTIN_GRADIENTS, GradientLibrary, resolvePreset } from './gradients/presets.ts';
import {
  HANDLES, cropActive, cropBox, cropCancel, cropCommit, cropDown, cropMove, cropPointerCancel, cropRatio, cropUp, croppedSize, hitCrop,
  newCropState, newPerspState, overlayLines, perspDown, perspMove, perspSize, perspUp, type CropCtx,
} from './crop/geometry.ts';

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
const FILL_CONTENTS = { foreground: 'Foreground Color', background: 'Background Color', color: 'Color…', pattern: 'Pattern', history: 'History', black: 'Black', gray: '50% Gray', white: 'White' };
type FillContents = keyof typeof FILL_CONTENTS;
interface FillForm { contents: FillContents; color: Rgb; pattern: string; mode: string; opacity: number; preserve: boolean }
function loadFillForm(): FillForm {
  const f: FillForm = { contents: 'foreground', color: [0, 0, 0], pattern: '', mode: 'normal', opacity: 100, preserve: false };
  try {
    const s = JSON.parse(localStorage.getItem(FILL_KEY) ?? 'null') as Partial<FillForm> | null;
    if (s && typeof s.contents === 'string' && s.contents in FILL_CONTENTS) f.contents = s.contents;
    if (Array.isArray(s?.color) && s.color.length === 3 && s.color.every(c => Number.isInteger(c) && c >= 0 && c <= 255)) f.color = s.color;
    if (typeof s?.pattern === 'string') f.pattern = s.pattern;
  } catch { /* unavailable or corrupt: defaults */ }
  return f;
}
interface StrokeForm { width: number; color: Rgb; location: StrokeSelectionParams['location']; mode: string; opacity: number; preserve: boolean }
const STROKE_DEFAULT: StrokeForm = { width: 3, color: [0, 0, 0], location: 'inside', mode: 'normal', opacity: 100, preserve: false };

// Layer > New Fill Layer / Layer Content Options (docs/M3.md section 4). The dialog title differs
// from the undo label for gradient and pattern (gap B7-3); the gradient itself is fixed black to
// white, classic, two stops (gap B7-1) -- this dialog never edits the stops.
const FILL_LAYER_TITLES = { solid: 'Solid Color', gradient: 'Gradient Fill', pattern: 'Pattern Fill' } as const;
const FILL_LAYER_LABELS = { solid: 'Solid Color', gradient: 'Gradient', pattern: 'Pattern' } as const;
const FILL_LAYER_NAMES = { solid: 'Color Fill', gradient: 'Gradient Fill', pattern: 'Pattern Fill' } as const;
const DEFAULT_GRADIENT = {
  method: 'classic' as const,
  color_stops: [{ position: 0, color: [0, 0, 0] as [number, number, number], midpoint: 0.5 }, { position: 1, color: [255, 255, 255] as [number, number, number], midpoint: 0.5 }],
  opacity_stops: [{ position: 0, opacity: 1, midpoint: 0.5 }, { position: 1, opacity: 1, midpoint: 0.5 }],
};
interface FillContentForm {
  type: keyof typeof FILL_LAYER_TITLES;
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

export function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<SelectionOverlay | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const newDialog = useRef<HTMLDialogElement>(null);
  const featherDialog = useRef<HTMLDialogElement>(null);
  const modifyDialog = useRef<HTMLDialogElement>(null);
  const colorRangeDialog = useRef<HTMLDialogElement>(null);
  const saveSelDialog = useRef<HTMLDialogElement>(null);
  const loadSelDialog = useRef<HTMLDialogElement>(null);
  const trimDialog = useRef<HTMLDialogElement>(null);
  const rotateDialog = useRef<HTMLDialogElement>(null);
  const colorRangeCanvas = useRef<HTMLCanvasElement>(null);
  const picker = useRef<ColorPickerHandle>(null);
  const viewer = useRef<Viewer | null>(null);
  const [doc, setDoc] = useState<DocInfo | null>(null);
  const [view, setView] = useState({ zoom: 1, rot: 0 });
  const [autosave, setAutosave] = useState<AutosaveState>('off');
  const [renderer, setRenderer] = useState('');
  const [busy, setBusy] = useState<string | null>('Starting…');
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [fg, setFg] = useState<Rgb>(hexToRgb('#e8a23a')!);
  const [bg, setBg] = useState<Rgb>([255, 255, 255]);
  const [tool, setTool] = useState('move');
  const [lastUsed, setLastUsed] = useState(initialLastUsed());
  const [quickMask, setQuickMask] = useState(false);
  const [modifyOp, setModifyOp] = useState<keyof typeof MODIFY_OPS>('expand');
  const [colorRange, setColorRange] = useState({ preset: 'sampled', fuzziness: 40, range: 100, localized: false, invert: false });
  const [colorRangeSamples, setColorRangeSamples] = useState<{ rgb: [number, number, number]; x: number; y: number }[]>([]);
  const [colorRangePreview, setColorRangePreview] = useState<{ w: number; h: number; data: Uint8Array; level: number } | null>(null);
  const [colorRangeOpen, setColorRangeOpen] = useState(false);
  const [optionsByTool, setOptionsByTool] = useState<Record<string, ToolOptions>>({});
  const [dockTab, setDockTab] = useState<'color' | 'swatches' | 'brushSettings' | 'brushes'>('color');
  const [recentPresets, setRecentPresets] = useState<string[]>([]);
  const [, setLibVersion] = useState(0);
  const protectedTexture = useRef<Dynamics['texture'] | null>(null);
  const [showAnts, setShowAnts] = useState(true);
  const [showLayerComps, setShowLayerComps] = useState(false);
  const [showProperties, setShowProperties] = useState(false);
  const [showAdjustments, setShowAdjustments] = useState(false);
  // Brush library (opened at mount) and the selected preset; null paints with the plain options-bar brush.
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const brushLib = useRef<{ library: BrushLibrary; assets: EngineAssets } | null>(null);
  const selectedPresetRef = useRef(selectedPresetId);
  selectedPresetRef.current = selectedPresetId;
  const strokeCounter = useRef(0);
  const activeTool = TOOLS[tool];
  const toolOptions = optionsByTool[tool] ?? loadToolOptions(activeTool);
  const setToolOptions = (v: ToolOptions) => setOptionsByTool(o => ({ ...o, [tool]: v }));
  const [active, setActive] = useState<Active | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const toolOptionsRef = useRef(toolOptions);
  toolOptionsRef.current = toolOptions;
  function patchToolOptions(toolId: string, patch: Record<string, number | string | boolean>) {
    setOptionsByTool(o => ({ ...o, [toolId]: { ...(o[toolId] ?? loadToolOptions(TOOLS[toolId])), ...patch } }));
  }
  // Digit-combo state (docs/M2.md section 4): a second digit within 0.8s combines with the first
  // into an exact value; opacity and flow track their own combo independently.
  const opacityDigitRef = useRef<DigitState | null>(null);
  const flowDigitRef = useRef<DigitState | null>(null);
  const capsLockRef = useRef(false);
  const dragRef = useRef<Record<string, unknown> | null>(null);
  const polygonRef = useRef<PolygonLasso | null>(null);
  const polygonModeRef = useRef<SelectMode>('new');
  const lastPolyDownRef = useRef<{ t: number; x: number; y: number } | null>(null);
  // Warp editing inside a transform session; `initial` is the unmodified mesh over the source bounds,
  // `last` the last pointer-down point (where the menu split commands act).
  type WState = {
    w: Warp; initial: Mesh; undo: Warp[]; split: WarpSplit | null; last: Pt | null;
    drag: { start: Warp; from: Pt; index: number | null; weights: number[] | null } | null;
  };
  type TSession = {
    warp: WState | null; switching: boolean;
    s: TState; mode: Mode; linked: boolean; snap: boolean; kind: 'layer' | 'pixels' | 'selection'; img: TransformImage | null;
    // Earlier states for Ctrl+Z inside the session.
    undo: TState[];
    gen: number; refine: 'none' | 'pending' | 'done'; timer: ReturnType<typeof setTimeout> | undefined; frame: number;
    drag: { hit: Exclude<Hit, null>; start: TState; from: Pt; to: Pt; mods: Mods } | null;
    tx: number[]; ty: number[]; lock: SnapAxes; store: TransformBarStore; off: () => void;
  };
  const transformRef = useRef<TSession | null>(null);
  // The last committed transform relative to the unit square of its source bounds.
  const againRef = useRef<{ n: Mat3; interp: string } | null>(null);
  const [transformStore, setTransformStore] = useState<TransformBarStore | null>(null);
  const [transformMenu, setTransformMenu] = useState<[number, number] | null>(null);
  const polygonActionsRef = useRef<{ active: () => boolean; commit: () => void; cancel: () => void; removeLast: () => void } | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const magneticRef = useRef<{ lasso: MagneticLasso; handle: number | null; mode: SelectMode } | null>(null);
  // Last dab of the previous stroke per layer, so Shift+click can draw a straight line from it
  // (the engine has no last-dab accessor).
  const lastStrokePoint = useRef<Record<number, [number, number]>>({});
  const perfRef = useRef<PerfProbe | null>(null);
  // Fill/Stroke dialogs preview live; closing ends the preview session, committing only after OK.
  const fillDialog = useRef<HTMLDialogElement>(null);
  const strokeDialog = useRef<HTMLDialogElement>(null);
  const [fillForm, setFillForm] = useState<FillForm>(loadFillForm);
  const [strokeForm, setStrokeForm] = useState<StrokeForm>(STROKE_DEFAULT);
  const fillContentDialog = useRef<HTMLDialogElement>(null);
  const [fillContentForm, setFillContentForm] = useState<FillContentForm>({ type: 'solid', color: [0, 0, 0], style: 'linear', angle: 90, scalePct: 100, reverse: false, dither: false, alignWithLayer: true, patternId: '', linked: true });
  const [fillContentMode, setFillContentMode] = useState<FillDialogMode | null>(null);
  const [previewDialog, setPreviewDialog] = useState<'fill' | 'stroke' | 'adjust' | null>(null);
  // Image > Adjustments: the dialog's params; its live preview reruns debounced (`adjustTimer`).
  const adjustDialog = useRef<HTMLDialogElement>(null);
  const [adjustForm, setAdjustForm] = useState<Adjustment | DestructiveAdjustment | null>(null);
  // Bumped per dialog open so the body refetches its histogram and resets its channel.
  const [adjustSession, setAdjustSession] = useState(0);
  const adjustTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lutInput = useRef<HTMLInputElement>(null);
  const lutLoaded = useRef<Parameters<PickLookupFile>[0] | null>(null);
  const previewRef = useRef<{ open: boolean; commit: boolean; pending: Promise<unknown> }>({ open: false, commit: false, pending: Promise.resolve() });
  const gradEditor = useRef<GradientEditorHandle>(null);
  // Layer > Layer Style dialog (`n` remounts it per open) and its two small companion dialogs.
  const [styleDialog, setStyleDialog] = useState<{ id: number; page: StylePage; n: number } | null>(null);
  const globalLightDialog = useRef<HTMLDialogElement>(null);
  const scaleEffectsDialog = useRef<HTMLDialogElement>(null);
  const gradLib = useRef<GradientLibrary | null>(null);
  gradLib.current ??= new GradientLibrary();

  function redrawOverlay() {
    const v = viewer.current;
    if (!v) return;
    const [w, h] = v.size;
    overlayRef.current?.draw(v.view, w, h, v.dpr);
  }

  function show(d: DocInfo | null, selectAfter?: SelectAfter) {
    setDoc(d);
    viewer.current?.setDoc(d);
    document.title = d ? `${d.name} - Photobaer` : 'Photobaer';
    if (!d) { setActive(null); return; }
    setActive(prev => selectAfter ? selectAfter(d) : prev && nodeById(d.layers, prev.id) ? prev : fallbackActive(d));
  }

  async function run(label: string | null, p: () => Promise<DocInfo | null>, selectAfter?: SelectAfter) {
    setMenu(null);
    // Any other worker call cancels an open transform session.
    if (transformRef.current) endTransform(false);
    if (label) setBusy(label);
    try {
      show(await p(), selectAfter);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (label) setBusy(null);
    }
  }

  async function open(f: File) {
    setMenu(null);
    setBusy(`Opening ${f.name}…`);
    try {
      const d = await client.call('openFile', f);
      show(d);
      if (d.warnings.length) setError(`Opened with warnings: ${d.warnings.join('; ')}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function savePsd() {
    setMenu(null);
    const d = docRef.current;
    if (!d) return;
    setBusy('Saving PSD…');
    try {
      const { blob, warnings } = await client.call('savePsd');
      await saveBlob(blob, `${d.name}.psd`, 'image/vnd.adobe.photoshop', 'psd');
      if (warnings.length) setError(`Saved with warnings: ${warnings.join('; ')}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function exportAs(mime: 'image/png' | 'image/jpeg' | 'image/webp', ext: string) {
    setMenu(null);
    const d = docRef.current;
    if (!d) return;
    setBusy('Exporting…');
    try {
      await saveBlob(await client.call('exportImage', mime, 0.92), `${d.name}.${ext}`, mime, ext);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // File > Export > Layer Comps to Files: one flattened image per comp; TIFF is not available in the browser encoder.
  async function exportLayerComps(mime: 'image/png' | 'image/jpeg' | 'image/webp', ext: string) {
    setMenu(null);
    const d = docRef.current;
    if (!d) return;
    setBusy('Exporting…');
    try {
      const files = await client.call('exportLayerCompsToFiles', mime, 0.92);
      for (const f of files) await saveBlob(f.blob, `${f.name}.${ext}`, mime, ext);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function saveProject() {
    setMenu(null);
    const d = docRef.current;
    if (!d) return;
    setBusy('Saving project…');
    try {
      await saveBlob(await client.call('saveProject'), `${d.name}.pbaer`, 'application/x-photobaer', 'pbaer');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function editTarget(a: Active) { return quickMask ? 'selection' as const : a.target; }

  function openNewFillLayer(type: FillContentForm['type']) {
    setMenu(null);
    if (!active) return;
    setFillContentForm({ type, color: fg, style: 'linear', angle: 90, scalePct: 100, reverse: false, dither: false, alignWithLayer: true, patternId: doc?.patterns[0]?.id ?? '', linked: true });
    setFillContentMode({ kind: 'create', type });
    fillContentDialog.current?.showModal();
  }

  function openLayerContentOptions() {
    setMenu(null);
    if (!active || !node || node.kind !== 'fill' || !node.content) return;
    setFillContentForm(formFromFillContent(node.content, fg, doc?.patterns[0]?.id ?? ''));
    setFillContentMode({ kind: 'edit', id: active.id });
    fillContentDialog.current?.showModal();
  }

  function submitFillContent() {
    if (!active || !fillContentMode) return;
    const content = fillContentFromForm(fillContentForm);
    fillContentDialog.current?.close();
    if (fillContentMode.kind === 'create') {
      const { type } = fillContentMode;
      run(null, () => client.call('newFillLayer', active.id, content, FILL_LAYER_NAMES[type], FILL_LAYER_LABELS[type]), selectCreated);
    } else {
      run(null, () => client.call('setFillContent', [fillContentMode.id], content));
    }
  }

  function openPreviewDialog(which: 'fill' | 'stroke') {
    setMenu(null);
    if (!active || !node) return;
    if (node.locks.pixels) { setError('Could not use the layer because it is locked.'); return; }
    if (which === 'fill') setFillForm(loadFillForm());
    else setStrokeForm(f => ({ ...f, mode: 'normal', opacity: 100, preserve: false }));
    previewRef.current = { open: true, commit: false, pending: Promise.resolve() };
    setPreviewDialog(which);
    (which === 'fill' ? fillDialog : strokeDialog).current?.showModal();
  }

  async function fillParams(f: FillForm): Promise<FillParams> {
    const base = { mode: f.mode, opacity: f.opacity / 100, preserveTransparency: f.preserve };
    if (f.contents === 'history') return { source: 'history', ...base };
    if (f.contents === 'pattern') {
      const lib = brushLib.current;
      const ref = f.pattern || lib?.library.patterns()[0]?.id;
      const id = ref && lib ? await lib.assets.pattern(ref) : undefined;
      if (id === undefined) throw new Error('The pattern is not available.');
      return { source: 'pattern', patternId: id, ...base };
    }
    const rgb = { foreground: fg, background: bg, color: f.color, black: [0, 0, 0], gray: [128, 128, 128], white: [255, 255, 255] }[f.contents] as Rgb;
    return { source: 'solid', rgba: [...rgb, 255], ...base };
  }

  // Closing by OK, Cancel or Escape: wait for the last preview rerun, then commit or restore.
  function endPreviewDialog() {
    const st = previewRef.current;
    if (!st.open) return;
    if (adjustTimer.current !== undefined) {
      clearTimeout(adjustTimer.current);
      adjustTimer.current = undefined;
      if (st.commit && adjustForm) adjustPreview(adjustForm);
    }
    st.open = false;
    if (previewDialog === 'fill') {
      const { contents, color, pattern } = fillForm;
      try { localStorage.setItem(FILL_KEY, JSON.stringify({ contents, color, pattern })); } catch { /* session-only */ }
    }
    setPreviewDialog(null);
    run(null, () => st.pending.catch(() => {}).then(() => client.call('previewEnd', st.commit)));
  }

  function openAdjust(kind: Kind | DestructiveKind) {
    setMenu(null);
    if (!active || !node) return;
    if (node.locks.pixels) { setError('Could not use the layer because it is locked.'); return; }
    const start = (a: Adjustment | DestructiveAdjustment) => {
      previewRef.current = { open: true, commit: false, pending: Promise.resolve() };
      setAdjustForm(a);
      setAdjustSession(n => n + 1);
      setPreviewDialog('adjust');
      adjustDialog.current?.showModal();
    };
    // Color Lookup picks its table first (D9); cancelling the picker opens nothing.
    if (kind === 'color_lookup') pickLookupFile((name, table, format) => start({ kind, params: { name, format, table, interpolation: 'tetrahedral', dither: false } }));
    else start(kind in DESTRUCTIVE_LABEL ? defaultDestructive(kind as DestructiveKind) : defaultAdjustment(kind as Kind));
  }

  // Destructive kinds without params apply at once as one undo step.
  function applyDestructive(kind: DestructiveKind) {
    setMenu(null);
    if (!active) return;
    run(`${DESTRUCTIVE_LABEL[kind]}…`,() => client.call('adjust', active.id, defaultDestructive(kind), DESTRUCTIVE_LABEL[kind]));
  }

  function adjustPreview(a: Adjustment | DestructiveAdjustment) {
    const st = previewRef.current, id = activeRef.current?.id;
    if (!st.open || id === undefined) return;
    st.pending = client.call('adjust', id, a, COMMAND_LABEL[a.kind], true).then(d => show(d), e => setError((e as Error).message));
  }

  // Levels/Curves eyedroppers: the next canvas click samples the composite (one pixel) instead of
  // reaching the tool; only this handler is ever removed, so a transform session's intercept stays.
  const sampler = useRef<((e: ToolPointerEvent) => void) | null>(null);
  const sampleCanvas = useRef<SampleCanvas>(onSample => {
    const v = viewer.current;
    if (!v) return;
    if (v.intercept === sampler.current) v.intercept = null;
    sampler.current = null;
    if (!onSample || v.intercept) return;
    const h = sampler.current = (e: ToolPointerEvent) => {
      if (e.type !== 'down') return;
      if (v.intercept === h) v.intercept = null;
      sampler.current = null;
      client.call('sample', e.x, e.y, 1, null).then(([r, g, b]) => onSample([r, g, b]), err => setError((err as Error).message));
    };
    v.intercept = h;
  }).current;

  const pickLookupFile: PickLookupFile = onLoaded => {
    lutLoaded.current = onLoaded;
    if (lutInput.current) { lutInput.current.value = ''; lutInput.current.click(); }
  };

  async function loadLookupFile(f: File) {
    const onLoaded = lutLoaded.current;
    lutLoaded.current = null;
    if (!onLoaded) return;
    try {
      const table = await client.call('loadLookupTable', new Uint8Array(await f.arrayBuffer()));
      onLoaded(f.name, table, /\.3dl$/i.test(f.name) ? '3dl' : 'cube');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Opens the Layer Style dialog on `page` for layer `id`; refused on adjustment and fully locked layers.
  function openLayerStyle(page: StylePage, id = active?.id) {
    setMenu(null);
    const n = doc && id !== undefined ? nodeById(doc.layers, id) : undefined;
    if (!n) return;
    const why = styleRefusal(n);
    if (why) { setError(why); return; }
    if (transformRef.current) endTransform(false);
    setStyleDialog(d => ({ id: n.id, page, n: (d?.n ?? 0) + 1 }));
  }

  // Layer > New Adjustment Layer and the Adjustments panel: the new layer is selected and shown in Properties.
  function newAdjustmentLayer(kind: Kind) {
    if (!active) return;
    setShowProperties(true);
    run(null, () => client.call('newAdjustmentLayer', active.id, defaultAdjustment(kind), MENU_LABEL[kind]), selectCreated);
  }

  // Adjustments panel fill row: solid with the foreground color, gradient black to white, the first pattern.
  function quickFillLayer(type: FillContentForm['type']) {
    if (!active) return;
    const content = fillContentFromForm({ type, color: fg, style: 'linear', angle: 90, scalePct: 100, reverse: false, dither: false, alignWithLayer: true, patternId: doc?.patterns[0]?.id ?? '', linked: true });
    run(null, () => client.call('newFillLayer', active.id, content, FILL_LAYER_NAMES[type], FILL_LAYER_LABELS[type]), selectCreated);
  }

  function quickFill(rgb: Rgb, label: string) {
    if (!active) return;
    run(null, () => client.call('fillEx', active.id, editTarget(active), { source: 'solid', rgba: [...rgb, 255], mode: 'normal', opacity: 1, preserveTransparency: false }, label));
  }

  function openModify(op: keyof typeof MODIFY_OPS) {
    setMenu(null);
    setModifyOp(op);
    modifyDialog.current?.showModal();
  }

  // Grow/Similar (docs/M2.md section 3) reuse the magic wand tool's tolerance/sample-all-layers
  // options; there is no dialog for them.
  function growOrSimilar(op: 'grow' | 'similar') {
    return () => {
      if (!active) return;
      const o = optionsByTool.magicWand ?? loadToolOptions(TOOLS.magicWand);
      run(op === 'grow' ? 'Growing…' : 'Selecting similar…', () => client.call(op, active.id, Number(o.tolerance), !!o.sampleAllLayers));
    };
  }

  function openColorRange() {
    if (!active) return;
    setMenu(null);
    setColorRangeSamples([]);
    setColorRangePreview(null);
    setColorRangeOpen(true);
    colorRangeDialog.current?.showModal();
  }

  function closeColorRange() {
    setColorRangeOpen(false);
    colorRangeDialog.current?.close();
  }

  // Smallest level keeping the preview's longer side at or under 400px.
  function previewLevel(w: number, h: number) {
    return Math.max(0, Math.ceil(Math.log2(Math.max(w, h) / 400)));
  }

  function createNew(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const bg = String(f.get('bg'));
    const fill: Rgba | null = bg === 'white' ? [255, 255, 255, 255] : bg === 'black' ? [0, 0, 0, 255] : null;
    newDialog.current?.close();
    run('Creating…', () => client.call('newDoc', Number(f.get('w')), Number(f.get('h')), Number(f.get('depth')), fill));
  }

  const has = !!doc;
  const warping = transformStore?.get().mode === 'warp';
  const node = doc && active ? nodeById(doc.layers, active.id) : undefined;
  const deleteDisabled = !doc || !active || (doc.layers.length === 1 && doc.layers[0].id === active.id);

  const newLayer = () => active && run('New layer', () => client.call('addLayer', active.id), selectCreated);
  const newGroup = () => active && run('New group', () => client.call('addGroup', active.id), selectCreated);
  const duplicateLayer = () => active && run('Duplicate layer', () => client.call('duplicateNode', active.id), selectCreated);
  const deleteLayer = () => doc && active && run('Delete layer', () => client.call('deleteNode', active.id), selectAfterDelete(doc, active.id));
  const groupLayers = () => active && run('Group layers', () => client.call('groupNodes', [active.id]), selectCreated);
  const ungroupLayers = () => active && run('Ungroup layers', () => client.call('ungroup', active.id));
  const toggleClipping = () => node && run(null, () => client.call('setProps', node.id, { clipping: !node.clipping }));
  const addMask = () => active && run('Add layer mask', () => client.call('addMask', active.id, true));
  const deleteMask = () => active && run('Delete layer mask', () => client.call('deleteMask', active.id));
  const toggleMaskEnabled = () => node?.mask && run(null, () => client.call('setProps', node.id, { mask_enabled: !node.mask!.enabled }));

  // ---------- smart objects (docs/M3.md section 6) ----------
  const smart = node?.smart;
  const anyLinked = doc ? flatNodes(doc.layers).some(n => n.smart?.link.type === 'linked') : false;
  async function placeFile(linked: boolean) {
    setMenu(null);
    const a = activeRef.current;
    if (!a) return;
    let picked;
    try { picked = await pickPlaceFile(); } catch (e) { setError((e as Error).message); return; }
    if (!picked) return;
    const link = linked && !!picked.handle;
    await run(`Placing ${picked.file.name}…`, () => client.call('placeSmart', a.id, picked.file, link, link ? picked.handle : null), selectCreated);
    if (linked && !link) setError('This browser cannot link files, so the file was placed embedded.');
  }
  async function replaceContents(relink: boolean) {
    setMenu(null);
    const n = node;
    if (!n) return;
    let picked;
    try { picked = await pickPlaceFile(); } catch (e) { setError((e as Error).message); return; }
    if (!picked) return;
    if (relink && !picked.handle) { setError('Relinking needs a browser with file system access.'); return; }
    await run('Replacing contents…', () => relink ? client.call('relinkToFile', n.id, picked.file, picked.handle!) : client.call('replaceContents', n.id, picked.file));
  }
  async function exportContents() {
    setMenu(null);
    if (!node) return;
    try {
      const { name, blob } = await client.call('exportContents', node.id);
      const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : 'bin';
      await saveBlob(blob, name, 'application/octet-stream', ext);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function convertToLinked() {
    setMenu(null);
    const n = node;
    const picker = (window as unknown as { showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
    if (!n) return;
    if (!picker) { setError('Linking needs a browser with file system access.'); return; }
    let h: FileSystemFileHandle;
    try { h = await picker({ suggestedName: `${n.name}.psb` }); } catch (e) { if ((e as Error).name !== 'AbortError') setError((e as Error).message); return; }
    await run('Converting to linked…', () => client.call('convertToLinked', n.id, h));
  }
  const smartItems: Item[] = [
    { label: 'Convert to Smart Object', run: () => node && run('Converting…', () => client.call('convertToSmart', [node.id]), selectCreated), off: !node },
    { label: 'New Smart Object via Copy', run: () => node && run(null, () => client.call('smartViaCopy', node.id), selectCreated), off: !smart },
    { label: 'Edit Contents', sep: true, run: () => node && run('Opening contents…', () => client.call('editContents', node.id)), off: !smart },
    { label: 'Replace Contents…', run: () => void replaceContents(false), off: !smart },
    { label: 'Export Contents…', run: () => void exportContents(), off: !smart },
    { label: 'Convert to Linked…', sep: true, run: () => void convertToLinked(), off: !smart || smart.link.type === 'linked' },
    { label: 'Convert to Embedded', run: () => node && run('Embedding…', () => client.call('convertToEmbedded', node.id)), off: smart?.link.type !== 'linked' },
    { label: 'Relink to File…', run: () => void replaceContents(true), off: !smart },
    { label: 'Update Modified Content', run: () => node && run('Updating…', () => client.call('updateModified', node.id)), off: smart?.link.type !== 'linked' },
    { label: 'Update All Modified Content', run: () => run('Updating…', () => client.call('updateModified', null)), off: !anyLinked },
    {
      label: 'Stack Mode', keys: '›', sep: true, run: () => {}, off: !smart, sub: STACK_MODES.map(([mode, label]) => ({
        label: (smart?.stack_mode ?? null) === mode ? `✓ ${label}` : label, run: () => node && run(null, () => client.call('setStackMode', node.id, mode)),
      })),
    },
    { label: 'Rasterize', sep: true, run: () => node && run('Rasterizing…', () => client.call('rasterizeSmart', node.id, 'Rasterize')), off: !smart },
  ];

  const styled = doc ? flatNodes(doc.layers).filter(n => n.style) : [];
  const anyStyled = styled.length > 0;
  const allEffectsHidden = anyStyled && styled.every(n => !n.style!.enabled);
  // Destructive adjustments need a pixel layer's pixels as the target.
  const pixelsOff = node?.kind !== 'pixel' || active?.target !== 'pixels' || quickMask;

  const menus: Record<string, Item[]> = {
    File: [
      { label: 'New…', keys: 'Alt+Ctrl+N', run: () => { setMenu(null); newDialog.current?.showModal(); } },
      { label: 'Open…', keys: 'Ctrl+O', run: () => { setMenu(null); fileInput.current?.click(); } },
      { label: 'Place Embedded…', run: () => void placeFile(false), off: !has || !active },
      { label: 'Place Linked…', run: () => void placeFile(true), off: !has || !active },
      { label: 'Save project…', keys: 'Ctrl+S', run: saveProject, off: !has },
      { label: 'Save as PSD…', run: savePsd, off: !has },
      { label: 'Export PNG…', run: () => exportAs('image/png', 'png'), off: !has },
      { label: 'Export JPEG…', run: () => exportAs('image/jpeg', 'jpg'), off: !has },
      { label: 'Export WebP…', run: () => exportAs('image/webp', 'webp'), off: !has },
      { label: 'Layer Comps to Files (PNG)…', run: () => exportLayerComps('image/png', 'png'), off: !has || !doc?.layerComps.length },
      { label: 'Layer Comps to Files (JPEG)…', run: () => exportLayerComps('image/jpeg', 'jpg'), off: !has || !doc?.layerComps.length },
      { label: 'Layer Comps to Files (WebP)…', run: () => exportLayerComps('image/webp', 'webp'), off: !has || !doc?.layerComps.length },
      { label: 'Close', run: () => run(null, () => client.call('closeDoc')), off: !has },
    ],
    Edit: [
      { label: doc?.undoLabel ? `Undo ${doc.undoLabel}` : 'Undo', keys: 'Ctrl+Z', run: () => run(null, () => client.call('undo')), off: !doc?.undoLabel },
      { label: doc?.redoLabel ? `Redo ${doc.redoLabel}` : 'Redo', keys: 'Shift+Ctrl+Z', run: () => run(null, () => client.call('redo')), off: !doc?.redoLabel },
      { label: 'Fill…', keys: 'Shift+F5', run: () => openPreviewDialog('fill'), off: !has || !active },
      { label: 'Fill with Foreground Color', keys: 'Alt+Backspace', run: () => quickFill(fg, 'Fill with Foreground Color'), off: !has || !active },
      { label: 'Fill with Background Color', keys: 'Ctrl+Backspace', run: () => quickFill(bg, 'Fill with Background Color'), off: !has || !active },
      { label: 'Stroke…', run: () => openPreviewDialog('stroke'), off: !doc?.selection || !active },
      { label: 'Clear', keys: 'Delete', run: () => active && run('Clearing…', () => client.call('clearSelected', active.id, quickMask ? 'selection' : active.target)), off: !doc?.selection || !active },
      { label: 'Free Transform', keys: 'Ctrl+T', run: () => void startTransform(), off: !has || !active },
      {
        label: 'Transform', keys: '›', run: () => {}, off: !has || !active, sub: [
          { label: 'Again', keys: 'Shift+Ctrl+T', run: transformAgain, off: !!transformStore },
          ...MODES.filter(([m]) => m !== 'free').map(([m, label]) => ({ label, run: () => transformMode(m), off: warping && m !== 'warp' })),
          ...([['horizontal', 'Split Warp Horizontally'], ['vertical', 'Split Warp Vertically'], ['both', 'Split Warp Crosswise'], ['remove', 'Remove Warp Split']] as [WarpSplit, string][])
            .map(([m, label]) => ({ label, run: () => warpMenuSplit(m) })),
          ...([['180', 'Rotate 180°'], ['cw', 'Rotate 90° Clockwise'], ['ccw', 'Rotate 90° Counter Clockwise'], ['flipH', 'Flip Horizontal'], ['flipV', 'Flip Vertical']] as [Command, string][])
            .map(([c, label]) => ({ label, run: () => transformRemap(c, label), off: warping })),
        ],
      },
    ],
    Layer: [
      { label: 'New Layer', run: newLayer, off: !has },
      { label: 'New Group', run: newGroup, off: !has },
      { label: 'Duplicate Layer', keys: 'Ctrl+J', run: duplicateLayer, off: !has },
      { label: 'Delete Layer', run: deleteLayer, off: deleteDisabled },
      { label: 'Group Layers', keys: 'Ctrl+G', run: groupLayers, off: !has },
      { label: 'Ungroup Layers', keys: 'Shift+Ctrl+G', run: ungroupLayers, off: !has || node?.kind !== 'group' },
      { label: node?.clipping ? 'Release Clipping Mask' : 'Create Clipping Mask', keys: 'Alt+Ctrl+G', run: toggleClipping, off: !has },
      { label: 'Add Layer Mask', run: addMask, off: !has || !!node?.mask },
      { label: 'Delete Layer Mask', run: deleteMask, off: !has || !node?.mask },
      { label: node?.mask?.enabled === false ? 'Enable Layer Mask' : 'Disable Layer Mask', run: toggleMaskEnabled, off: !has || !node?.mask },
      {
        label: 'New Fill Layer', keys: '›', run: () => {}, off: !has || !active, sep: true, sub: [
          { label: 'Solid Color…', run: () => openNewFillLayer('solid') },
          { label: 'Gradient…', run: () => openNewFillLayer('gradient') },
          { label: 'Pattern…', run: () => openNewFillLayer('pattern') },
        ],
      },
      {
        label: 'New Adjustment Layer', keys: '›', run: () => {}, off: !has || !active, sub: ADJUSTMENT_KINDS.map(kind => ({
          label: MENU_LABEL[kind], sep: kind === 'invert', run: () => newAdjustmentLayer(kind),
        })),
      },
      { label: 'Layer Content Options…', run: openLayerContentOptions, off: !has || node?.kind !== 'fill' },
      { label: 'Smart Objects', keys: '›', run: () => {}, off: !has || !node, sub: smartItems },
      {
        label: 'Layer Style', keys: '›', run: () => {}, off: !has || !node, sub: [
          { label: 'Blending Options…', run: () => openLayerStyle('blending') },
          ...EFFECT_KINDS.filter(k => k !== 'contour' && k !== 'texture').map(kind => ({ label: `${EFFECT_LABEL[kind]}…`, run: () => openLayerStyle({ kind, index: 0 }) })),
          { label: 'Copy Layer Style', sep: true, run: () => node && run(null, () => client.call('copyLayerStyle', node.id)), off: !node?.style },
          { label: 'Paste Layer Style', run: () => node && run(null, () => client.call('pasteLayerStyle', [node.id])) },
          { label: 'Clear Layer Style', run: () => node && run(null, () => client.call('clearLayerStyle', [node.id])), off: !node?.style },
          { label: 'Global Light…', sep: true, run: () => { setMenu(null); globalLightDialog.current?.showModal(); } },
          { label: 'Create Layers', run: () => node && run('Creating layers…', () => client.call('createLayersFromStyle', node.id)), off: !node?.style },
          { label: allEffectsHidden ? 'Show All Effects' : 'Hide All Effects', run: () => run(null, () => client.call('hideAllEffects')), off: !anyStyled },
          { label: 'Scale Effects…', run: () => { setMenu(null); scaleEffectsDialog.current?.showModal(); }, off: !node?.style },
        ],
      },
      {
        label: 'Rasterize', keys: '›', run: () => {}, off: !has || (node?.kind !== 'fill' && node?.kind !== 'smart'), sub: [
          { label: 'Fill Content', run: () => active && run('Rasterizing…', () => client.call('rasterizeFill', active.id)), off: node?.kind !== 'fill' },
          { label: 'Smart Object', run: () => active && run('Rasterizing…', () => client.call('rasterizeSmart', active.id, 'Smart Object')), off: node?.kind !== 'smart' },
        ],
      },
    ],
    Image: [
      {
        label: 'Adjustments', keys: '›', run: () => {}, off: !has || !active, sub: ADJUSTMENT_KINDS.map<Item>(kind => kind === 'invert'
          ? { label: 'Invert', keys: 'Ctrl+I', sep: true, run: () => run('Inverting…', () => client.call('command', 'invert', active!.id, quickMask ? 'selection' : active!.target)) }
          : { label: `${MENU_LABEL[kind]}…`, keys: SHORTCUT[kind], run: () => openAdjust(kind), off: pixelsOff }).concat([
          { label: 'Shadows/Highlights…', sep: true, run: () => openAdjust('shadows_highlights'), off: pixelsOff },
          { label: 'HDR Toning…', run: () => openAdjust('hdr_toning'), off: pixelsOff },
          { label: 'Desaturate', keys: 'Ctrl+Shift+U', sep: true, run: () => applyDestructive('desaturate'), off: pixelsOff },
          { label: 'Match Color…', run: () => openAdjust('match_color'), off: pixelsOff },
          { label: 'Replace Color…', run: () => openAdjust('replace_color'), off: pixelsOff },
          { label: 'Equalize', run: () => applyDestructive('equalize'), off: pixelsOff },
        ]),
      },
      { label: 'Auto Tone', keys: 'Ctrl+Shift+L', run: () => applyDestructive('auto_tone'), off: !has || !active || pixelsOff },
      { label: 'Auto Contrast', keys: 'Ctrl+Alt+Shift+L', run: () => applyDestructive('auto_contrast'), off: !has || !active || pixelsOff },
      { label: 'Auto Color', keys: 'Ctrl+Shift+B', run: () => applyDestructive('auto_color'), off: !has || !active || pixelsOff },
      {
        label: 'Image Rotation', keys: '›', run: () => {}, off: !has, sep: true, sub: [
          ...([['180', '180°'], ['cw', '90° Clockwise'], ['ccw', '90° Counter Clockwise']] as [Command, string][])
            .map(([c, label]) => ({ label, run: () => run('Rotating…', () => client.call('rotateCanvas', c)) })),
          { label: 'Arbitrary…', run: () => { setMenu(null); rotateDialog.current?.showModal(); } },
          ...([['flipH', 'Flip Canvas Horizontal'], ['flipV', 'Flip Canvas Vertical']] as [Command, string][])
            .map(([c, label], i) => ({ label, sep: i === 0, run: () => run('Flipping…', () => client.call('rotateCanvas', c)) })),
        ],
      },
      { label: 'Crop', run: () => run('Cropping…', () => client.call('cropToSelection')), off: !doc?.selection },
      { label: 'Trim…', run: () => { setMenu(null); trimDialog.current?.showModal(); }, off: !has },
      { label: 'Reveal All', run: () => run('Revealing…', () => client.call('revealAll')), off: !has },
    ],
    Select: [
      { label: 'All', keys: 'Ctrl+A', run: () => run(null, () => client.call('selectCommand', 'all')), off: !has },
      { label: 'Deselect', keys: 'Ctrl+D', run: () => run(null, () => client.call('selectCommand', 'deselect')), off: !doc?.selection },
      { label: 'Reselect', keys: 'Shift+Ctrl+D', run: () => run(null, () => client.call('selectCommand', 'reselect')), off: !doc?.hasLastSelection },
      { label: 'Inverse', keys: 'Shift+Ctrl+I', run: () => run(null, () => client.call('selectCommand', 'inverse')), off: !doc?.selection },
      { label: 'Color Range…', run: () => openColorRange(), off: !has },
      { label: 'Border…', run: () => openModify('border'), off: !doc?.selection },
      { label: 'Smooth…', run: () => openModify('smooth'), off: !doc?.selection },
      { label: 'Expand…', run: () => openModify('expand'), off: !doc?.selection },
      { label: 'Contract…', run: () => openModify('contract'), off: !doc?.selection },
      { label: 'Feather…', keys: 'Shift+F6', run: () => { setMenu(null); featherDialog.current?.showModal(); }, off: !doc?.selection },
      { label: 'Grow', run: growOrSimilar('grow'), off: !doc?.selection },
      { label: 'Similar', run: growOrSimilar('similar'), off: !doc?.selection },
      { label: quickMask ? 'Exit Quick Mask Mode' : 'Edit in Quick Mask Mode', keys: 'Q', run: () => { setMenu(null); setQuickMask(v => !v); }, off: !has },
      { label: 'Load Selection…', run: () => { setMenu(null); loadSelDialog.current?.showModal(); }, off: !doc?.channels.length },
      { label: 'Save Selection…', run: () => { setMenu(null); saveSelDialog.current?.showModal(); }, off: !doc?.selection },
      { label: 'Transform Selection', run: () => void startTransform('free', true), off: !has || !!transformStore },
    ],
    View: [
      { label: 'Zoom in', keys: 'Ctrl++', run: () => { setMenu(null); viewer.current?.zoomBy(2); }, off: !has },
      { label: 'Zoom out', keys: 'Ctrl+-', run: () => { setMenu(null); viewer.current?.zoomBy(0.5); }, off: !has },
      { label: 'Fit on screen', keys: 'Ctrl+0', run: () => { setMenu(null); viewer.current?.fit(); }, off: !has },
      { label: '100%', keys: 'Ctrl+1', run: () => { setMenu(null); viewer.current?.actualPixels(); }, off: !has },
      { label: 'Reset rotation', keys: 'Esc', run: () => { setMenu(null); viewer.current?.resetRotation(); }, off: !has },
      { label: showAnts ? 'Hide selection edges' : 'Show selection edges', keys: 'Ctrl+H', run: () => { setMenu(null); setShowAnts(v => !v); }, off: !has },
    ],
    Window: [
      { label: showAdjustments ? 'Hide Adjustments' : 'Show Adjustments', run: () => { setMenu(null); setShowAdjustments(v => !v); } },
      { label: showLayerComps ? 'Hide Layer Comps' : 'Show Layer Comps', run: () => { setMenu(null); setShowLayerComps(v => !v); } },
      { label: showProperties ? 'Hide Properties' : 'Show Properties', run: () => { setMenu(null); setShowProperties(v => !v); } },
    ],
  };
  const menusRef = useRef(menus);
  menusRef.current = menus;

  useEffect(() => {
    let alive = true;
    client.onEvent = e => {
      if (e.event === 'autosave') setAutosave(e.state);
      else if (e.event === 'transformCancelled' && closeTransform()) show(e.doc);
    };
    (async () => {
      try {
        const r = await createRenderer(canvas.current!, new URLSearchParams(location.search).get('renderer'));
        if (!alive) return;
        setRenderer(r.kind === 'webgpu' ? 'WebGPU' : 'WebGL2');
        const v = new Viewer(canvas.current!, r, makeTileSource(client, r));
        overlayRef.current = new SelectionOverlay(overlayCanvas.current!);
        v.onView = x => { setView({ zoom: x.zoom * v.dpr, rot: x.rot }); redrawOverlay(); };
        viewer.current = v;
        perfRef.current = perfTestHook(v);
        (window as unknown as { photobaer: unknown }).photobaer = { viewer: v, client, ...gpuTestHook(client, r), ...(perfRef.current ? { perf: perfRef.current } : {}) };
        show(await client.call('init'));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
      const lq = (window as unknown as { launchQueue?: { setConsumer(f: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
      lq?.setConsumer(async p => { if (p.files.length) open(await p.files[0].getFile()); });
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    const flush = () => { void brushLib.current?.library.flush().catch(e => console.error('brush library save failed', e)); };
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    BrushLibrary.open().then(library => {
      if (!alive) return;
      const assets = new EngineAssets({
        tipAdd: (w, h, alpha) => client.call('tipAdd', w, h, alpha),
        patternAdd: (w, h, data, channels) => client.call('patternAdd', w, h, data, channels),
      }, library);
      brushLib.current = { library, assets };
      setLibVersion(v => v + 1);
    }, e => console.error('brush library unavailable', e));
    addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => { alive = false; removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', hidden); };
  }, []);

  useEffect(() => { viewer.current?.setTool(VIEWER_TOOL[tool] ?? null); }, [tool]);

  useEffect(() => {
    const v = viewer.current;
    if (!v || tool !== 'eyedropper') return;
    v.onPointer = (e: ToolPointerEvent) => {
      if (e.type !== 'down') return;
      const size = SAMPLE_SIZES[toolOptions.sampleSize as string] ?? 1;
      const layerId = toolOptions.sample === 'current layer' ? active?.id ?? null : null;
      client.call('sample', e.x, e.y, size, layerId).then(([r, g, b]) => {
        if (e.altKey) setBg([r, g, b]); else setFg([r, g, b]);
      });
    };
    return () => { v.onPointer = () => {}; };
  }, [tool, toolOptions.sampleSize, toolOptions.sample, active]);

  useEffect(() => {
    if (!canvas.current) return;
    const ro = new ResizeObserver(redrawOverlay);
    ro.observe(canvas.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => { overlayRef.current?.setHidden(!showAnts); redrawOverlay(); }, [showAnts]);

  useEffect(() => {
    if (!colorRangeOpen || !doc || !active) return;
    const level = previewLevel(doc.width, doc.height);
    // Nothing sampled yet selects nothing: a black preview the user clicks to take the first sample.
    if (colorRange.preset === 'sampled' && !colorRangeSamples.length) {
      const w = Math.ceil(doc.width / (1 << level)), h = Math.ceil(doc.height / (1 << level));
      setColorRangePreview({ w, h, data: new Uint8Array(w * h), level });
      return;
    }
    const samplesFlat = colorRangeSamples.flatMap(s => s.rgb);
    const centerFlat = colorRangeSamples.flatMap(s => [s.x, s.y]);
    let alive = true;
    client.call('colorRangePreview', level, active.id, false, colorRange.preset, samplesFlat, colorRange.fuzziness, colorRange.range, centerFlat, colorRange.localized, colorRange.invert).then(r => {
      if (!alive) return;
      setColorRangePreview({ w: r.w, h: r.h, data: new Uint8Array(r.data), level });
    }, e => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [colorRangeOpen, doc?.docId, doc?.selGen, active?.id, colorRange, colorRangeSamples]);

  useEffect(() => {
    const st = previewRef.current;
    if (!previewDialog || !active || !st.open) return;
    const a = active;
    st.pending = (async () => {
      const d = previewDialog === 'fill'
        ? await fillParams(fillForm).then(p => (st.open ? client.call('fillEx', a.id, editTarget(a), p, 'Fill', true) : null))
        : st.open ? await client.call('strokeSelection', a.id, {
          width: Math.min(250, Math.max(1, Math.round(strokeForm.width) || 1)), rgba: [...strokeForm.color, 255], location: strokeForm.location,
          mode: strokeForm.mode, opacity: strokeForm.opacity / 100, preserveTransparency: strokeForm.preserve,
        }, true) : null;
      if (d) show(d);
    })().catch(e => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewDialog, fillForm, strokeForm]);

  useEffect(() => {
    if (previewDialog !== 'adjust' || !adjustForm) return;
    const t = setTimeout(() => { adjustTimer.current = undefined; adjustPreview(adjustForm); }, adjustForm.kind === 'curves' ? 50 : 100);
    adjustTimer.current = t;
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewDialog, adjustForm]);

  useEffect(() => {
    const c = colorRangeCanvas.current;
    if (!c || !colorRangePreview) return;
    const { w, h, data } = colorRangePreview;
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      img.data[i * 4] = data[i]; img.data[i * 4 + 1] = data[i]; img.data[i * 4 + 2] = data[i]; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [colorRangePreview]);

  const dpr = viewer.current?.dpr ?? (window.devicePixelRatio || 1);
  const antsLevelValue = doc ? antsLevel(levelFor(view.zoom, dpr, doc.maxLevel), doc.width, doc.height, doc.maxLevel) : 0;

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (!doc) { overlay.setAnts(null, 1); overlay.setMaskOverlay(null, 0, 0, 1); redrawOverlay(); return; }
    if (!quickMask && !doc.selection) { overlay.setAnts(null, 1); overlay.setMaskOverlay(null, 0, 0, 1); redrawOverlay(); return; }
    const docId = doc.docId;
    let alive = true;
    client.call('selectionMask', antsLevelValue).then(r => {
      if (!alive || r.docId !== docId || docRef.current?.docId !== docId) return;
      const bytes = r.data ? new Uint8Array(r.data) : new Uint8Array(r.w * r.h).fill(255);
      if (quickMask) { overlay.setMaskOverlay(bytes, r.w, r.h, 1 << antsLevelValue); overlay.setAnts(null, 1); } else {
        overlay.setMaskOverlay(null, 0, 0, 1);
        overlay.setAnts(r.data ? contour(bytes, r.w, r.h) : null, 1 << antsLevelValue);
      }
      redrawOverlay();
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.selGen, antsLevelValue, doc?.docId, quickMask]);

  // Rectangular/elliptical marquees, row/column marquees, freehand lasso, the polygonal lasso,
  // the magnetic lasso, quick selection and the magic wand all drive the viewer's raw pointer
  // events and the overlay preview; everything else forwards through onPointer as a no-op.
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    const cancelAll = () => {
      dragRef.current = null;
      polygonRef.current = null;
      lastPolyDownRef.current = null;
      overlayRef.current?.setPreview(null);
      if (magneticRef.current) {
        if (magneticRef.current.handle !== null) client.call('magneticEnd', magneticRef.current.handle);
        magneticRef.current = null;
      }
    };
    cancelAll();
    if (!SELECT_TOOLS.includes(tool)) {
      v.onPointer = () => {};
      polygonActionsRef.current = null;
      return cancelAll;
    }

    const shapeKind = () => (tool === 'marqueeEllipse' ? 'ellipse' as const : 'rect' as const);
    const marqueeOpts = () => {
      const o = toolOptionsRef.current;
      return { style: o.style as 'normal' | 'fixed ratio' | 'fixed size', ratioW: Number(o.ratioW), ratioH: Number(o.ratioH), fixedW: Number(o.fixedW), fixedH: Number(o.fixedH) };
    };

    function commitPolygon() {
      const lasso = polygonRef.current;
      polygonRef.current = null;
      lastPolyDownRef.current = null;
      overlayRef.current?.setPreview(null);
      if (!lasso) return;
      const o = toolOptionsRef.current;
      client.call('select', { kind: 'polygon', points: lasso.flat() }, polygonModeRef.current, !!o.antiAlias, Number(o.feather), 'Polygonal Lasso').then(show);
    }

    if (tool === 'marqueeRect' || tool === 'marqueeEllipse') {
      v.onPointer = e => {
        if (e.type === 'down') {
          dragRef.current = { start: [e.x, e.y], mode: selectMode(toolOptionsRef.current.mode as string, e.shiftKey, e.altKey), shiftLatch: makeLatch(e.shiftKey), altLatch: makeLatch(e.altKey) };
        } else {
          const d = dragRef.current as { start: [number, number]; mode: SelectMode; shiftLatch: (b: boolean) => boolean; altLatch: (b: boolean) => boolean } | null;
          if (!d) return;
          const r = marqueeRect(d.start, [e.x, e.y], { ...marqueeOpts(), constrain: d.shiftLatch(e.shiftKey), fromCenter: d.altLatch(e.altKey) });
          if (e.type === 'move') { overlayRef.current?.setPreview({ kind: shapeKind(), ...r }); return; }
          dragRef.current = null;
          overlayRef.current?.setPreview(null);
          if (e.type === 'cancel') return;
          const o = toolOptionsRef.current;
          client.call('select', { kind: shapeKind(), ...r }, d.mode, tool === 'marqueeEllipse' && !!o.antiAlias, Number(o.feather), TOOLS[tool].label).then(show);
        }
      };
    } else if (tool === 'marqueeRow' || tool === 'marqueeColumn') {
      v.onPointer = e => {
        if (e.type !== 'down') return;
        const d = docRef.current;
        if (!d) return;
        const mode = selectMode(toolOptionsRef.current.mode as string, e.shiftKey, e.altKey);
        const shape = tool === 'marqueeRow'
          ? { kind: 'rect' as const, x: 0, y: Math.floor(e.y), w: d.width, h: 1 }
          : { kind: 'rect' as const, x: Math.floor(e.x), y: 0, w: 1, h: d.height };
        client.call('select', shape, mode, false, 0, TOOLS[tool].label).then(show);
      };
    } else if (tool === 'lasso') {
      v.onPointer = e => {
        if (e.type === 'down') {
          dragRef.current = { points: [e.x, e.y], mode: selectMode(toolOptionsRef.current.mode as string, e.shiftKey, e.altKey), altLatch: makeLatch(e.altKey), straight: null };
          return;
        }
        const d = dragRef.current as { points: number[]; mode: SelectMode; altLatch: (b: boolean) => boolean; straight: [number, number] | null } | null;
        if (!d) return;
        if (e.type === 'move') {
          if (d.altLatch(e.altKey)) { d.straight = [e.x, e.y]; } else {
            if (d.straight) { d.points.push(d.straight[0], d.straight[1]); d.straight = null; }
            const lx = d.points[d.points.length - 2], ly = d.points[d.points.length - 1];
            if (Math.hypot(e.x - lx, e.y - ly) >= 0.5) d.points.push(e.x, e.y);
          }
          const pts = d.straight ? [...d.points, d.straight[0], d.straight[1]] : d.points;
          overlayRef.current?.setPreview({ kind: 'path', points: pts, closed: false });
          return;
        }
        dragRef.current = null;
        overlayRef.current?.setPreview(null);
        if (e.type === 'cancel') return;
        if (d.straight) d.points.push(d.straight[0], d.straight[1]);
        const o = toolOptionsRef.current;
        client.call('select', { kind: 'polygon', points: d.points }, d.mode, !!o.antiAlias, Number(o.feather), 'Lasso').then(show);
      };
    } else if (tool === 'polygonalLasso') {
      v.onPointer = e => {
        if (e.type === 'move') {
          const lasso = polygonRef.current;
          if (lasso && lasso.points.length) overlayRef.current?.setPreview({ kind: 'path', points: [...lasso.flat(), e.x, e.y], closed: false });
          return;
        }
        if (e.type !== 'down') return;
        const zoom = v.view.zoom;
        const lasso = polygonRef.current ?? (polygonRef.current = new PolygonLasso());
        if (lasso.points.length === 0) polygonModeRef.current = selectMode(toolOptionsRef.current.mode as string, e.shiftKey, e.altKey);
        const now = performance.now();
        const last = lastPolyDownRef.current;
        const dbl = !!last && now - last.t < 300 && Math.hypot(e.x - last.x, e.y - last.y) <= 3 / zoom;
        lastPolyDownRef.current = { t: now, x: e.x, y: e.y };
        if (lasso.points.length && (lasso.closesAt([e.x, e.y], 6 / zoom) || dbl)) { commitPolygon(); return; }
        const prev = lasso.points.at(-1);
        lasso.add(e.shiftKey && prev ? snap45(prev, [e.x, e.y]) : [e.x, e.y]);
        overlayRef.current?.setPreview({ kind: 'path', points: lasso.flat(), closed: false });
      };
    } else if (tool === 'magneticLasso') {
      const finish = (points: number[], mode: SelectMode, handle: number) => {
        const o = toolOptionsRef.current;
        client.call('select', { kind: 'polygon', points }, mode, !!o.antiAlias, Number(o.feather), 'Magnetic Lasso').then(show);
        client.call('magneticEnd', handle);
        magneticRef.current = null;
        overlayRef.current?.setPreview(null);
      };
      v.onPointer = e => {
        const o = toolOptionsRef.current;
        if (e.type === 'move') {
          const st = magneticRef.current;
          if (!st || st.handle === null) return;
          const [lx, ly] = st.lasso.last();
          client.call('magneticPath', st.handle, lx, ly, e.x, e.y, Number(o.width), Number(o.contrast)).then(path => {
            if (magneticRef.current !== st) return;
            client.call('magneticSuggestAnchor', path, Number(o.frequency)).then(idx => {
              if (magneticRef.current !== st) return;
              const split = idx > 0 && idx * 2 < path.length;
              if (split) st.lasso.addAnchor(Array.from(path.subarray(2, idx * 2)), path[idx * 2], path[idx * 2 + 1]);
              const tail = split ? path.subarray(idx * 2) : path;
              overlayRef.current?.setPreview({ kind: 'path', points: [...st.lasso.committed, ...tail], closed: false });
            });
          });
          return;
        }
        if (e.type !== 'down' || !activeRef.current) return;
        const st = magneticRef.current;
        if (!st) {
          const lasso = new MagneticLasso();
          lasso.start(e.x, e.y);
          magneticRef.current = { lasso, handle: null, mode: selectMode(o.mode as string, e.shiftKey, e.altKey) };
          client.call('magneticBegin', activeRef.current.id, false).then(handle => {
            if (magneticRef.current) magneticRef.current.handle = handle;
          });
          overlayRef.current?.setPreview({ kind: 'path', points: lasso.committed, closed: false });
          return;
        }
        const zoom = v.view.zoom;
        if (st.lasso.closesAt(e.x, e.y, 6 / zoom) && st.handle !== null) { finish(st.lasso.committed, st.mode, st.handle); return; }
        if (st.handle === null) return;
        client.call('magneticPath', st.handle, ...st.lasso.last(), e.x, e.y, Number(o.width), Number(o.contrast)).then(path => {
          if (magneticRef.current !== st) return;
          st.lasso.addAnchor(Array.from(path.subarray(2, -2)), e.x, e.y);
          overlayRef.current?.setPreview({ kind: 'path', points: st.lasso.committed, closed: false });
        });
      };
      polygonActionsRef.current = {
        active: () => !!magneticRef.current?.lasso.anchors.length,
        commit: () => { const st = magneticRef.current; if (st?.handle !== null && st) finish(st.lasso.committed, st.mode, st.handle); },
        cancel: cancelAll,
        removeLast: () => {
          const st = magneticRef.current;
          st?.lasso.removeLast();
          overlayRef.current?.setPreview(st?.lasso.anchors.length ? { kind: 'path', points: st.lasso.committed, closed: false } : null);
        },
      };
      return cancelAll;
    } else if (tool === 'quickSelection') {
      const circle = (x: number, y: number, r: number) => ({ kind: 'ellipse' as const, x: x - r, y: y - r, w: r * 2, h: r * 2 });
      v.onPointer = e => {
        const o = toolOptionsRef.current;
        const r = Number(o.size) / 2;
        if (e.type === 'down') {
          dragRef.current = { points: [e.x, e.y], mode: e.altKey ? 'subtract' : (o.mode as string) };
          overlayRef.current?.setPreview(circle(e.x, e.y, r));
          return;
        }
        const d = dragRef.current as { points: number[]; mode: string } | null;
        if (e.type === 'move') {
          if (d) {
            const lx = d.points[d.points.length - 2], ly = d.points[d.points.length - 1];
            if (Math.hypot(e.x - lx, e.y - ly) >= 1) d.points.push(e.x, e.y);
          }
          overlayRef.current?.setPreview(circle(e.x, e.y, r));
          return;
        }
        dragRef.current = null;
        overlayRef.current?.setPreview(null);
        if (e.type === 'cancel' || !d || !activeRef.current) return;
        client.call('quickSelect', activeRef.current.id, d.points, r, !!o.sampleAllLayers, d.mode, !!o.autoEnhance).then(show);
      };
    } else if (tool === 'magicWand') {
      v.onPointer = e => {
        if (e.type !== 'down' || !activeRef.current) return;
        const o = toolOptionsRef.current;
        const mode = selectMode('new', e.shiftKey, e.altKey);
        client.call('magicWand', activeRef.current.id, e.x, e.y, Number(o.tolerance), !!o.antiAlias, !!o.contiguous, !!o.sampleAllLayers, mode).then(show);
      };
    }

    polygonActionsRef.current = {
      active: () => !!polygonRef.current?.points.length,
      commit: commitPolygon,
      cancel: cancelAll,
      removeLast: () => {
        polygonRef.current?.removeLast();
        overlayRef.current?.setPreview(polygonRef.current?.points.length ? { kind: 'path', points: polygonRef.current.flat(), closed: false } : null);
      },
    };
    return cancelAll;
  }, [tool, doc?.docId]);

  // Paint bucket: click fills; Alt springs to the eyedropper (sets the foreground color) instead.
  // Runs after the selection effect above so it is not left as a no-op by that effect's early return.
  useEffect(() => {
    const v = viewer.current;
    if (!v || tool !== 'bucket') return;
    v.onPointer = e => {
      if (e.type !== 'down' || !active) return;
      if (e.altKey) {
        client.call('sample', e.x, e.y, 1, null).then(([r, g, b]) => setFg([r, g, b]));
        return;
      }
      const o = toolOptionsRef.current;
      const rgb = o.source === 'background' ? bg : fg;
      client.call('bucket', active.id, quickMask ? 'selection' : 'pixels', e.x, e.y, [...rgb, 255], o.mode as string, Number(o.opacity) / 100, Number(o.tolerance), !!o.antiAlias, !!o.contiguous, !!o.allLayers).then(show);
    };
    return () => { v.onPointer = () => {}; };
  }, [tool, active, fg, bg, quickMask]);

  // Gradient: drag from start to end with a live line; Shift snaps to 45 degrees keeping the length.
  useEffect(() => {
    const v = viewer.current;
    if (!v || tool !== 'gradient') return;
    let start: [number, number] | null = null;
    const endOf = (e: ToolPointerEvent) => (e.shiftKey ? snap45Length(start!, [e.x, e.y]) : [e.x, e.y] as [number, number]);
    v.onPointer = e => {
      if (e.type === 'down') { start = active ? [e.x, e.y] : null; return; }
      if (!start) return;
      const end = endOf(e);
      if (e.type === 'move') { overlayRef.current?.setPreview({ kind: 'path', points: [...start, ...end], closed: false }); return; }
      const from = start;
      start = null;
      overlayRef.current?.setPreview(null);
      if (e.type === 'cancel' || !active || Math.hypot(end[0] - from[0], end[1] - from[1]) < 1e-6) return;
      const o = toolOptionsRef.current;
      const g = resolvePreset(gradLib.current!.get(String(o.gradient)) ?? BUILTIN_GRADIENTS[0], fgRef.current, bgRef.current);
      run(null, () => client.call('gradient', active.id, editTarget(active), {
        ...engineStops(g), method: o.method as Method, style: o.style as GradientParams['style'], start: { x: from[0], y: from[1] }, end: { x: end[0], y: end[1] },
        reverse: !!o.reverse, dither: !!o.dither, transparency: !!o.transparency, opacity: Number(o.opacity) / 100,
      }));
    };
    return () => { v.onPointer = () => {}; overlayRef.current?.setPreview(null); };
  }, [tool, active, quickMask]);

  // Crop and perspective crop: pointer state in crop/geometry.ts; Enter, Esc, the bar buttons and a
  // tool switch reach the pending crop through `cropSession`.
  const cropSession = useRef<{ active: () => boolean; commit: () => void; cancel: () => void; draw: () => void } | null>(null);
  const cropOptions = optionsByTool.crop ?? loadToolOptions(TOOLS.crop);
  const cropOptionsRef = useRef(cropOptions);
  cropOptionsRef.current = cropOptions;
  const perspOptionsRef = useRef(optionsByTool.perspectiveCrop ?? loadToolOptions(TOOLS.perspectiveCrop));
  perspOptionsRef.current = optionsByTool.perspectiveCrop ?? loadToolOptions(TOOLS.perspectiveCrop);
  function setOptionsOf(toolId: 'crop' | 'perspectiveCrop', patch: Record<string, number | boolean>) {
    patchToolOptions(toolId, patch);
    saveToolOptions(TOOLS[toolId], { ...(toolId === 'crop' ? cropOptionsRef : perspOptionsRef).current, ...patch });
  }
  useEffect(() => {
    const v = viewer.current, c = canvas.current;
    if (!v || !c || tool !== 'crop' || !doc) return;
    const s = newCropState();
    const ctx = (): CropCtx => {
      const d = docRef.current!, o = cropOptionsRef.current;
      return { docW: d.width, docH: d.height, zoom: v.view.zoom, ratio: cropRatio(o, d.width, d.height), straighten: !!o.straighten };
    };
    const draw = () => {
      const d = docRef.current, o = overlayRef.current;
      if (!d || !o) return;
      const rect = cropBox(s, d.width, d.height), [w, h] = croppedSize(rect, s.angle, d.width, d.height);
      o.setCrop(rect.w > 0 && rect.h > 0 ? {
        rect, canvas: { x: 0, y: 0, w: d.width, h: d.height }, lines: overlayLines(rect, String(cropOptionsRef.current.overlay)),
        dims: `${w} × ${h} px`, line: s.line && [...s.line[0], ...s.line[1]],
      } : null);
      redrawOverlay();
    };
    const commit = () => {
      const d = docRef.current;
      if (!d) return;
      const r = cropCommit(s, d.width, d.height);
      draw();
      if (!r) return;
      const del = !!cropOptionsRef.current.deleteCroppedPixels;
      void run('Cropping…', () => client.call('cropTool', r.rect.x, r.rect.y, r.rect.w, r.rect.h, r.angle, del));
    };
    const cancel = () => { cropCancel(s); setOptionsOf('crop', { straighten: false }); draw(); };
    v.onPointer = e => {
      const p: Pt = [e.x, e.y], mods = { shift: e.shiftKey, alt: e.altKey };
      if (e.type === 'down') cropDown(s, p, ctx());
      else if (e.type === 'move') cropMove(s, p, mods, ctx());
      else if (e.type === 'cancel') cropPointerCancel(s);
      else if (cropUp(s, p, mods, ctx()) !== null) setOptionsOf('crop', { straighten: false });
      draw();
    };
    const hover = (e: PointerEvent) => {
      const d = docRef.current;
      if (!d || s.active) return;
      const r = c.getBoundingClientRect(), p = v.screenToDoc(e.clientX - r.left, e.clientY - r.top);
      const hit = cropOptionsRef.current.straighten ? null : hitCrop(cropBox(s, d.width, d.height), p, 11 / v.view.zoom);
      c.style.cursor = hit === 'body' ? 'move' : hit ? HANDLE_CURSORS[HANDLES.indexOf(hit)] : 'crosshair';
    };
    const dbl = () => { if (!transformRef.current) commit(); };
    c.addEventListener('pointermove', hover);
    c.addEventListener('dblclick', dbl);
    cropSession.current = { active: () => cropActive(s), commit, cancel, draw };
    draw();
    return () => {
      v.onPointer = () => {};
      c.removeEventListener('pointermove', hover);
      c.removeEventListener('dblclick', dbl);
      c.style.cursor = '';
      cropSession.current = null;
      // Leaving the tool applies a pending crop (a new document drops it).
      if (toolRef.current !== 'crop' && cropActive(s)) commit();
      overlayRef.current?.setCrop(null);
      redrawOverlay();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, doc?.docId]);
  // A canvas size change (undo, redo, Image menu) drops a pending box or quad: its doc coords are stale.
  const cropCanvasSize = useRef('');
  useEffect(() => {
    const size = `${doc?.width}x${doc?.height}`, changed = cropCanvasSize.current !== '' && cropCanvasSize.current !== size;
    cropCanvasSize.current = size;
    if (changed) cropSession.current?.cancel(); else cropSession.current?.draw();
  }, [doc?.width, doc?.height, cropOptions.overlay]);

  useEffect(() => {
    const v = viewer.current;
    if (!v || tool !== 'perspectiveCrop' || !doc) return;
    const s = newPerspState();
    const ctx = () => ({ docW: docRef.current!.width, docH: docRef.current!.height, zoom: v.view.zoom });
    const draw = () => { overlayRef.current?.setCorners(s.corners.length ? [...s.corners] : null); redrawOverlay(); };
    const commit = () => {
      if (s.corners.length !== 4) return;
      const o = perspOptionsRef.current, corners = s.corners, [w, h] = perspSize(corners, Number(o.outputWidth), Number(o.outputHeight));
      // Cleared before the call so a second commit cannot resend the quad; a refused (degenerate)
      // quad gets its corners back for another try.
      s.corners = [];
      draw();
      void run('Cropping…', async () => {
        try {
          return await client.call('perspectiveCrop', corners.flat(), w, h);
        } catch (e) {
          if (!s.corners.length) { s.corners = corners; draw(); }
          throw e;
        }
      });
    };
    const cancel = () => { s.corners = []; s.active = false; s.dragging = -1; draw(); };
    v.onPointer = e => {
      const p: Pt = [e.x, e.y];
      if (e.type === 'down') perspDown(s, p, ctx());
      else if (e.type === 'move') perspMove(s, p, ctx());
      else if (e.type === 'cancel') { s.active = false; s.dragging = -1; }
      else {
        const o = perspOptionsRef.current, size = perspUp(s, p, ctx(), Number(o.outputWidth), Number(o.outputHeight));
        if (size) setOptionsOf('perspectiveCrop', { outputWidth: size[0], outputHeight: size[1] });
      }
      draw();
    };
    cropSession.current = { active: () => s.active || s.corners.length > 0, commit, cancel, draw };
    return () => {
      v.onPointer = () => {};
      cropSession.current = null;
      if (toolRef.current !== 'perspectiveCrop') commit();
      overlayRef.current?.setCorners(null);
      redrawOverlay();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, doc?.docId]);

  // Move tool: drags or arrow-nudges the active (or auto-selected) layer, or the selected pixels
  // under the pointer, as one undo step; the worker previews every offset from the gesture start.
  const moveKeysRef = useRef<{ nudge: (dx: number, dy: number, alt: boolean) => void } | null>(null);
  useEffect(() => {
    const v = viewer.current;
    if (!v || tool !== 'move') return;
    type Plan = { pixels: boolean; id: number; alt: boolean };
    type Drag = {
      origin: [number, number]; pos: [number, number]; shift: boolean; plan: Plan | null; ready: boolean; busy: boolean; failed: boolean;
      want: [number, number]; sent: [number, number]; end: 'up' | 'cancel' | null; moving: Rect; tx: number[]; ty: number[]; lock: SnapAxes;
    };
    let drag: Drag | null = null;

    // What a gesture moves, or null (after a message) when it cannot start. Nudges pass no point.
    async function plan(pt: [number, number] | null, alt: boolean, auto: boolean): Promise<Plan | null> {
      const d = docRef.current, a = activeRef.current;
      if (!d || !a) return null;
      let id = a.id;
      let pixels = !!d.selection && (!pt || await client.call('selectionAt', pt[0], pt[1]) >= 128);
      if (!pixels && auto && pt) {
        const hit = await client.call('hitTestLayer', pt[0], pt[1], toolOptionsRef.current.autoSelectTarget === 'group');
        if (hit !== null && hit !== a.id) { id = hit; setActive({ id: hit, target: 'pixels' }); }
      }
      const n = nodeById(d.layers, id);
      if (!n) return null;
      if (n.kind !== 'pixel') pixels = false;
      if (pixels && n.locks.pixels) { setError('Could not use the layer because it is locked.'); return null; }
      if (!pixels && n.locks.position) { setError(`${n.name} is locked and can't be moved.`); return null; }
      return { pixels, id, alt };
    }
    function begin(p: Plan) {
      return p.pixels ? client.call('movePixelsBegin', p.id, p.alt ? 'Move Selection Copy' : 'Move Selection', p.alt) : client.call('moveLayerBegin', p.id, p.alt, p.alt ? 'Move Copy' : 'Move');
    }
    const step = (p: Plan, dx: number, dy: number) => (p.pixels ? client.call('movePixelsStep', dx, dy) : client.call('moveLayerStep', dx, dy));
    const commit = (p: Plan) => (p.pixels ? client.call('movePixelsCommit') : client.call('moveLayerCommit'));
    const cancel = (p: Plan) => (p.pixels ? client.call('movePixelsCancel') : client.call('moveLayerCancel'));
    const movedId = (d: DocInfo, p: Plan) => ('activeId' in d ? (d as { activeId: number }).activeId : p.id);
    const afterBegin = (d: DocInfo, p: Plan) => show(d, p.alt ? () => ({ id: movedId(d, p), target: 'pixels' }) : undefined);

    function aim(g: Drag) {
      const r = constrainedSnap(g.moving, g.tx, g.ty, Math.round(g.pos[0] - g.origin[0]), Math.round(g.pos[1] - g.origin[1]), g.lock, v!.view.zoom, g.shift);
      g.lock = r.lock;
      g.want = [Math.round(r.dx), Math.round(r.dy)];
      const d = docRef.current!;
      const lines: [number, number, number, number][] = [];
      if (r.lock.x) lines.push([r.lock.x.target, 0, r.lock.x.target, d.height]);
      if (r.lock.y) lines.push([0, r.lock.y.target, d.width, r.lock.y.target]);
      overlayRef.current?.setGuides(lines);
      redrawOverlay();
    }
    // One step in flight at a time, always the latest offset; the end commits after the last step.
    function pump(g: Drag) {
      if (!g.ready || g.busy) return;
      if (!g.failed && (g.want[0] !== g.sent[0] || g.want[1] !== g.sent[1])) {
        g.busy = true;
        g.sent = g.want;
        step(g.plan!, ...g.want).then(show, err => { g.failed = true; setError((err as Error).message); }).finally(() => { g.busy = false; pump(g); });
        return;
      }
      if (!g.end && !g.failed) return;
      if (drag === g) drag = null;
      overlayRef.current?.setGuides([]);
      redrawOverlay();
      const p = g.plan!;
      run(null, () => (g.failed || g.end === 'cancel' ? cancel(p) : commit(p)));
    }
    async function start(g: Drag, e: ToolPointerEvent) {
      const o = toolOptionsRef.current;
      const p = await plan(g.origin, e.altKey, !!o.autoSelect !== (e.ctrlKey || e.metaKey));
      if (!p) { if (drag === g) drag = null; return; }
      g.plan = p;
      try {
        const d = await begin(p);
        afterBegin(d, p);
        if (o.snap) {
          const id = movedId(d, p);
          const [t, b] = await Promise.all([client.call('snapTargets', id), p.pixels ? docRef.current?.selection?.bounds ?? null : client.call('movingBounds', id)]);
          g.tx = t.x;
          g.ty = t.y;
          if (b) g.moving = { x: b[0], y: b[1], w: b[2], h: b[3] };
        }
      } catch (err) {
        setError((err as Error).message);
        g.failed = true;
      }
      g.ready = true;
      if (!g.failed) aim(g);
      pump(g);
    }

    v.onPointer = e => {
      if (e.type === 'down') {
        if (drag) return;
        const g: Drag = {
          origin: [e.x, e.y], pos: [e.x, e.y], shift: e.shiftKey, plan: null, ready: false, busy: false, failed: false,
          want: [0, 0], sent: [0, 0], end: null, moving: { x: 0, y: 0, w: 0, h: 0 }, tx: [], ty: [], lock: { x: null, y: null },
        };
        drag = g;
        void start(g, e);
        return;
      }
      const g = drag;
      if (!g) return;
      g.pos = [e.x, e.y];
      g.shift = e.shiftKey;
      if (g.ready && !g.failed) aim(g);
      if (e.type !== 'move') g.end = e.type === 'cancel' ? 'cancel' : 'up';
      pump(g);
    };
    moveKeysRef.current = {
      nudge(dx, dy, alt) {
        if (drag) return;
        void plan(null, alt, false).then(p => {
          if (!p) return;
          // Sent back to back so no other move call can land inside this one.
          const b = begin(p), s = step(p, dx, dy), c = commit(p);
          return run(null, async () => { afterBegin(await b, p); await s.catch(() => {}); return c; });
        });
      },
    };
    return () => {
      v.onPointer = () => {};
      moveKeysRef.current = null;
      const g = drag;
      drag = null;
      if (g) { g.end = 'cancel'; pump(g); }
      overlayRef.current?.setGuides([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, doc?.docId]);

  // Show transform controls: the active layer's bounding box with 8 handles; hovering a handle
  // only shows a scale cursor.
  const showTransform = tool === 'move' && !!toolOptions.showTransform;
  useEffect(() => {
    const v = viewer.current, c = canvas.current, overlay = overlayRef.current;
    if (!v || !c || !overlay || !showTransform || !active || !doc) { overlay?.setBox(null); redrawOverlay(); return; }
    let box: Rect | null = null, alive = true;
    client.call('movingBounds', active.id).then(b => {
      if (!alive) return;
      box = b && { x: b[0], y: b[1], w: b[2], h: b[3] };
      overlay.setBox(box);
      redrawOverlay();
    });
    const hover = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      const i = box ? boxHandles(box).findIndex(([x, y]) => {
        const [sx, sy] = v.docToScreen(x, y);
        return Math.hypot(sx - (e.clientX - r.left), sy - (e.clientY - r.top)) <= 7;
      }) : -1;
      c.style.cursor = i < 0 ? '' : HANDLE_CURSORS[i];
    };
    c.addEventListener('pointermove', hover);
    return () => {
      alive = false;
      c.removeEventListener('pointermove', hover);
      c.style.cursor = '';
      overlay.setBox(null);
      redrawOverlay();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTransform, active?.id, doc?.version]);

  // Free transform session (Ctrl+T): pointer, keys, options bar and context menu edit a TState; the
  // overlay previews the lifted pixels and 500 ms after the last change the worker renders the result.
  function transformDraw(t: TSession) {
    t.frame = 0;
    const t0 = performance.now(), m = matrixOf(t.s), o = overlayRef.current!, g = t.drag;
    if (t.warp) {
      const mesh = t.warp.w.mesh, b = mesh.bounds;
      o.setImage(t.img && t.refine !== 'done' ? { ...t.img, m: IDENTITY, map: (x, y) => evaluate(mesh, (x - b.x) / b.w, (y - b.y) / b.h) } : null);
      o.setAntsMatrix(null);
      o.setTransform(null);
      o.setWarp(mesh);
      redrawOverlay();
      perfRef.current?.recordPreview(performance.now() - t0);
      return;
    }
    o.setImage(t.img && t.refine !== 'done' ? { ...t.img, m } : null);
    o.setAntsMatrix(t.kind !== 'layer' ? m : null);
    const b = t.s.bounds, scaling = g?.hit.kind === 'handle' && g.hit.i % 2 === 0 && opFor(g.hit, g.mods, t.mode) === 'scale';
    const dims = scaling ? { text: `${Math.round(Math.abs(t.s.p.sx) * b.w)} × ${Math.round(Math.abs(t.s.p.sy) * b.h)} px`, at: g!.to } : null;
    o.setTransform({ handles: handlePoints(t.s), ref: refPoint(t.s), dims });
    redrawOverlay();
    perfRef.current?.recordPreview(performance.now() - t0);
  }
  function transformRefine(t: TSession) {
    if (transformRef.current !== t) return;
    const gen = t.gen;
    t.refine = 'pending';
    client.call('transformRefine', t.warp ? engineMesh(t.warp.w.mesh) : matrixOf(t.s)).then(d => {
      if (transformRef.current !== t || t.gen !== gen) return;
      t.refine = 'done';
      show(d);
      transformDraw(t);
    }, err => {
      if (t.gen === gen) t.refine = 'none';
      setError((err as Error).message);
    });
  }
  function transformChange(t: TSession, s: TState, checkpoint: boolean) {
    if (checkpoint) t.undo.push(t.s);
    t.s = s;
    t.store.set({ values: numericValues(s) });
    transformTouched(t);
  }
  // Drops a refined result and schedules the preview frame and the next refine.
  function transformTouched(t: TSession) {
    t.gen++;
    if (t.refine !== 'none') {
      t.refine = 'none';
      client.call('transformUnrefine').then(d => { if (transformRef.current === t) show(d); }, err => setError((err as Error).message));
    }
    t.frame ||= requestAnimationFrame(() => transformDraw(t));
    clearTimeout(t.timer);
    t.timer = setTimeout(() => transformRefine(t), 500);
  }
  const warpBar = (ws: WState): WarpBarState => ({ preset: ws.w.preset, grid: gridOf(ws.w.mesh), split: ws.split });
  function warpChange(t: TSession, w: Warp, checkpoint: boolean) {
    const ws = t.warp!;
    if (w === ws.w) return;
    if (checkpoint) ws.undo.push(ws.w);
    ws.w = w;
    t.store.set({ warp: warpBar(ws) });
    transformTouched(t);
  }
  // An armed split mode places (or removes) a split at the click; otherwise a control point within
  // 8 screen px or the surface within 2 screen px is dragged. A click elsewhere does nothing.
  function warpPointer(t: TSession, ws: WState, e: ToolPointerEvent) {
    const v = viewer.current!;
    if (e.type === 'down') {
      ws.last = [e.x, e.y];
      if (ws.split) {
        const mode = ws.split, mesh = ws.w.mesh;
        ws.split = null;
        const next = mode === 'remove' ? removeSplitAt(mesh, e.x, e.y) : splitAt(mesh, e.x, e.y, mode);
        if (next && next !== mesh) warpChange(t, { ...ws.w, mesh: next }, true);
        else t.store.set({ warp: warpBar(ws) });
        return;
      }
      const toScreen = (p: Pt) => v.docToScreen(p[0], p[1]);
      const index = hitPoint(ws.w.mesh, toScreen, toScreen([e.x, e.y]), 8);
      const weights = index === null ? surfaceWeights(ws.w.mesh, e.x, e.y, 2 / v.view.zoom) : null;
      if (index !== null || weights) ws.drag = { start: ws.w, from: [e.x, e.y], index, weights };
      return;
    }
    const g = ws.drag;
    if (!g) return;
    const dx = e.x - g.from[0], dy = e.y - g.from[1];
    const next = e.type === 'cancel' || (!dx && !dy) ? g.start : g.index !== null ? dragPoint(g.start, g.index, dx, dy) : dragSurface(g.start, g.weights!, dx, dy);
    warpChange(t, next, false);
    if (e.type === 'move') return;
    ws.drag = null;
    if (e.type === 'up' && ws.w !== g.start) ws.undo.push(g.start);
  }
  // Edit > Transform > Split Warp / Remove Warp Split: at the last click, else the source centre.
  function warpMenuSplit(mode: WarpSplit) {
    setMenu(null);
    const t = transformRef.current, ws = t?.warp;
    if (!t || !ws) { setError('Splits belong to a warp: open one with Edit > Transform > Warp.'); return; }
    const b = ws.w.mesh.bounds, [x, y] = ws.last ?? [b.x + b.w / 2, b.y + b.h / 2];
    const next = mode === 'remove' ? removeSplitAt(ws.w.mesh, x, y) : splitAt(ws.w.mesh, x, y, mode);
    if (!next) { setError('This warp has no split to remove.'); return; }
    warpChange(t, { ...ws.w, mesh: next }, true);
  }
  // A smart object's warp starts from its current look (`start`, over the source parameter box `b`).
  const newWarp = (b: Rect, start?: Omit<Mesh, 'bounds'> | null): WState => {
    const mesh = start ? { ...start, bounds: b } : identityMesh(b);
    return { w: { mesh, preset: defaultPreset('custom') }, initial: mesh, undo: [], split: null, last: null, drag: null };
  };
  // Free transform -> warp: the worker renders the pending matrix and lifts the result as the warp source.
  async function warpSwitch(t: TSession) {
    const m = isIdentity(matrixOf(t.s)) ? null : matrixOf(t.s);
    t.switching = true;
    t.drag = null;
    clearTimeout(t.timer);
    t.gen++;
    let r;
    try {
      r = await client.call('transformWarp', m);
    } catch (err) {
      t.switching = false;
      setError((err as Error).message);
      if (transformRef.current === t) { t.refine = 'done'; transformTouched(t); }
      return;
    }
    t.switching = false;
    if (transformRef.current !== t) return;
    t.img = sourceImage(r);
    t.refine = 'none';
    t.warp = newWarp({ x: r.bounds[0], y: r.bounds[1], w: r.bounds[2], h: r.bounds[3] }, r.mesh);
    t.mode = 'warp';
    t.store.set({ mode: 'warp', warp: warpBar(t.warp) });
    show(r);
    transformDraw(t);
  }
  function transformDragStep(t: TSession) {
    const g = t.drag!, zoom = viewer.current!.view.zoom;
    const next = dragState(g.start, g.hit, opFor(g.hit, g.mods, t.mode), g.mods, g.from, g.to, {
      linked: t.linked,
      snapMove: t.snap ? (box, dx, dy) => { const r = snapOffset(box, t.tx, t.ty, dx, dy, t.lock, zoom); t.lock = r.lock; return [r.dx, r.dy]; } : undefined,
      snapPoint: t.snap ? p => { const r = snapOffset({ x: p[0], y: p[1], w: 0, h: 0 }, t.tx, t.ty, 0, 0, { x: null, y: null }, zoom); return [p[0] + r.dx, p[1] + r.dy]; } : undefined,
    });
    if (next) transformChange(t, next, false);
  }
  const eventMods = (e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): Mods => ({ shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey });
  function transformPointer(t: TSession, e: ToolPointerEvent) {
    if (t.switching) return;
    if (t.warp) { warpPointer(t, t.warp, e); return; }
    if (e.type === 'down') {
      const v = viewer.current!, toScreen = (p: Pt) => v.docToScreen(p[0], p[1]);
      const hit = hitTest(t.s, toScreen, toScreen([e.x, e.y]));
      if (!hit) { endTransform(true); return; }
      t.lock = { x: null, y: null };
      t.drag = { hit, start: t.s, from: [e.x, e.y], to: [e.x, e.y], mods: eventMods(e) };
      return;
    }
    const g = t.drag;
    if (!g) return;
    g.to = [e.x, e.y];
    g.mods = eventMods(e);
    if (e.type === 'cancel') transformChange(t, g.start, false);
    else transformDragStep(t);
    if (e.type === 'move') return;
    t.drag = null;
    if (e.type === 'up' && t.s !== g.start) t.undo.push(g.start);
    t.frame ||= requestAnimationFrame(() => transformDraw(t));
  }
  // A modifier pressed or released mid-drag re-evaluates the operation.
  function transformModifier(e: KeyboardEvent) {
    const t = transformRef.current;
    if (!t?.drag || !/^(Shift|Alt|Control|Meta)$/.test(e.key)) return false;
    e.preventDefault();
    t.drag.mods = eventMods(e);
    transformDragStep(t);
    return true;
  }
  function transformKey(e: KeyboardEvent, k: string, ctrl: boolean): boolean {
    const t = transformRef.current;
    if (!t) return false;
    if (transformModifier(e)) return true;
    if (k === 'enter') { e.preventDefault(); endTransform(true); }
    else if (k === 'escape') { e.preventDefault(); endTransform(false); }
    else if (ctrl && !e.shiftKey && k === 'z') {
      e.preventDefault();
      if (t.warp) {
        const prev = t.warp.drag ? undefined : t.warp.undo.pop();
        if (prev) warpChange(t, prev, false);
        return true;
      }
      const prev = t.drag ? undefined : t.undo.pop();
      if (prev) transformChange(t, prev, false);
    } else if (!ctrl && k.startsWith('arrow')) {
      e.preventDefault();
      if (t.warp || t.switching) return true;
      const n = e.shiftKey ? 10 : 1, [x, y] = refPoint(t.s);
      transformChange(t, setReference(t.s, [x + (k === 'arrowleft' ? -n : k === 'arrowright' ? n : 0), y + (k === 'arrowup' ? -n : k === 'arrowdown' ? n : 0)]), true);
    } else if (k === ' ' || (ctrl && ['+', '=', '-', '0', '1'].includes(k))) return false;
    // Any other shortcut could reach the worker, which cancels the session behind the UI's back.
    else if (ctrl || e.altKey) e.preventDefault();
    return true;
  }
  function withTransform(f: (t: TSession) => void) {
    const t = transformRef.current;
    setTransformMenu(null);
    if (t) f(t);
  }
  const transformCommand = (c: Command) => withTransform(t => { if (!t.warp && !t.switching) transformChange(t, commandState(t.s, c), true); });
  // A warp session stays a warp.
  const setTransformMode = (t: TSession, m: Mode) => {
    if (t.warp || t.switching) return;
    if (m === 'warp') void warpSwitch(t);
    else { t.mode = m; t.store.set({ mode: m }); }
  };
  // The session preview source as a canvas.
  function sourceImage(r: { image: { x: number; y: number; w: number; h: number; f: number } | null; data: ArrayBuffer | null }): TransformImage | null {
    if (!r.image || !r.data) return null;
    const src = document.createElement('canvas');
    src.width = r.image.w;
    src.height = r.image.h;
    src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.image.w, r.image.h), 0, 0);
    return { source: src, ...r.image, m: IDENTITY };
  }
  // Edit > Transform: inside a session these change it, outside they start one or act directly.
  function transformMode(m: Mode) {
    if (transformRef.current) withTransform(t => setTransformMode(t, m));
    else void startTransform(m);
  }
  function transformRemap(c: Command, label: string) {
    setMenu(null);
    const a = activeRef.current;
    if (transformRef.current) transformCommand(c);
    else if (a) void run(null, () => client.call('rotateExact', a.id, c, label));
  }
  function transformAgain() {
    const g = againRef.current, a = activeRef.current;
    if (!g) { setMenu(null); setError('There is no transform to repeat.'); return; }
    if (a) void run(null, () => client.call('transformAgain', a.id, g.n, g.interp));
  }

  async function startTransform(mode: Mode = 'free', selection = false) {
    setMenu(null);
    const d = docRef.current, a = activeRef.current, v = viewer.current, c = canvas.current;
    if (!d || !a || !v || !c || transformRef.current) return;
    const n = nodeById(d.layers, a.id);
    if (!n) return;
    const kind = selection ? 'selection' : d.selection ? 'pixels' : 'layer';
    if (mode === 'warp') {
      if (n.kind !== 'pixel' && n.kind !== 'smart') { setError('Only pixel layers and smart objects can be warped.'); return; }
      if (kind !== 'layer') { setError('Warp bends a whole layer; deselect to warp it.'); return; }
      if (n.locks.pixels) { setError('Could not use the layer because it is locked.'); return; }
    }
    if (kind === 'pixels' && n.locks.pixels) { setError('Could not use the layer because it is locked.'); return; }
    if (kind === 'layer' && n.locks.position) { setError(`${n.name} is locked and can't be moved.`); return; }
    let r;
    try {
      r = await client.call('transformBegin', a.id, kind, selection ? 'Transform Selection' : mode === 'warp' ? 'Warp' : 'Free Transform', 2048, mode === 'warp');
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    const img = sourceImage(r), b = { x: r.bounds[0], y: r.bounds[1], w: r.bounds[2], h: r.bounds[3] };
    const s = initialState(b), warp = mode === 'warp' ? newWarp(b, r.mesh) : null;
    const store = new TransformBarStore({ mode, values: numericValues(s), linked: true, snap: true, warp: warp && warpBar(warp) });
    const dbl = () => endTransform(true);
    const ctx = (e: MouseEvent) => { e.preventDefault(); setTransformMenu([e.clientX, e.clientY]); };
    const keyUp = (e: KeyboardEvent) => { transformModifier(e); };
    c.addEventListener('dblclick', dbl);
    c.addEventListener('contextmenu', ctx);
    addEventListener('keyup', keyUp);
    const t: TSession = {
      warp, switching: false, s, mode, linked: true, snap: true, kind, img, undo: [], gen: 0, refine: 'none', timer: undefined, frame: 0, drag: null,
      tx: [], ty: [], lock: { x: null, y: null }, store,
      off: () => { c.removeEventListener('dblclick', dbl); c.removeEventListener('contextmenu', ctx); removeEventListener('keyup', keyUp); },
    };
    transformRef.current = t;
    v.intercept = e => transformPointer(t, e);
    setTransformStore(store);
    show(r);
    transformDraw(t);
    client.call('snapTargets', a.id).then(g => { t.tx = g.x; t.ty = g.y; }, () => {});
  }
  // Tears down the session UI only; the caller settles the worker side.
  function closeTransform() {
    const t = transformRef.current;
    if (!t) return null;
    transformRef.current = null;
    clearTimeout(t.timer);
    cancelAnimationFrame(t.frame);
    t.off();
    if (viewer.current) viewer.current.intercept = null;
    const o = overlayRef.current;
    o?.setImage(null);
    o?.setTransform(null);
    o?.setWarp(null);
    o?.setAntsMatrix(null);
    redrawOverlay();
    setTransformStore(null);
    setTransformMenu(null);
    return t;
  }
  // Commits (one undo step, nothing when unmodified) or cancels the open session.
  function endTransform(commit: boolean) {
    // A commit waits until a switch to warp has landed.
    if (commit && transformRef.current?.switching) return;
    const t = closeTransform();
    if (!t) return;
    const m = t.warp || isIdentity(matrixOf(t.s)) ? null : matrixOf(t.s);
    const op = t.warp ? meshModified(t.warp.w.mesh, t.warp.initial) ? engineMesh(t.warp.w.mesh) : null : m;
    void run(null, async () => {
      if (!commit) return client.call('transformCancel');
      const d = await client.call('transformCommit', op);
      if (m) againRef.current = { n: normalize(m, t.s.bounds), interp: 'bicubic' };
      return d;
    });
  }

  // Brush, pencil and eraser: pointermove samples are coalesced and sent as one strokeTo per
  // animation frame; the smoother runs on the document-space samples before they are queued.
  // Samples carry x, y, pressure (stride 3) or also tiltX, tiltY, twist for pen strokes (stride 6).
  useEffect(() => {
    const v = viewer.current;
    if (!v || !(tool === 'brush' || tool === 'pencil' || tool === 'eraser')) return;
    const st: {
      smoother: Smoother | null; layerId: number | null; raf: number; stride: Stride;
      pending: number[]; last: number[] | null; lastSampleAt: number;
      buildUp: BuildUp | null; frame: number; begun: Promise<void> | null;
    } = { smoother: null, layerId: null, raf: 0, stride: 3, pending: [], last: null, lastSampleAt: 0, buildUp: null, frame: 0, begun: null };

    function flush() {
      if (!st.pending.length) return;
      const samples = Float64Array.from(st.pending.splice(0));
      const sampled = st.lastSampleAt;
      const sent = performance.now();
      client.call('strokeTo', samples).then(r => {
        const resolved = performance.now();
        viewer.current?.invalidate(r.version, r.dirty);
        perfRef.current?.recordSample(r.version, { sampled, sent, resolved });
      }, e => setError((e as Error).message));
    }
    function schedule() {
      if (st.raf) return;
      st.raf = requestAnimationFrame(() => { st.raf = 0; flush(); });
    }
    function push(p: [number, number], fields: number[]) {
      st.last = [p[0], p[1], ...fields];
      st.lastSampleAt = performance.now();
      st.pending.push(...st.last);
      schedule();
    }

    // The selected preset drives every paint tool except the block eraser.
    function presetFor() {
      if (tool === 'eraser' && toolOptionsRef.current.mode === 'block') return null;
      return currentPreset(selectedPresetRef.current);
    }

    async function paramsFor(x: number, y: number, stride: Stride, seed: number): Promise<StrokeParams | Record<string, unknown>> {
      const o = toolOptionsRef.current;
      const input = { stride, seed };
      const pencilParams = async (rgb: Rgb, mode: string) => {
        const preset = presetFor(), lib = brushLib.current;
        if (preset && lib) await lib.assets.prepare(preset);
        return presetStrokeParams(preset, o, { tool: 'pencil', rgba: [...rgb, 255], mode, bg: [...bgRef.current, 255], seed, stride, resolve: lib?.assets.resolve });
      };
      if (tool === 'pencil') {
        let rgb = fgRef.current;
        if (o.autoErase && active) {
          const [r, g, b] = await client.call('sample', x, y, 1, active.id);
          if (r === fgRef.current[0] && g === fgRef.current[1] && b === fgRef.current[2]) rgb = bgRef.current;
        }
        return pencilParams(rgb, o.mode as string);
      }
      const preset = presetFor();
      const lib = brushLib.current;
      if (preset && lib) await lib.assets.prepare(preset);
      if (tool === 'eraser') {
        // Looked up fresh (not a dep) so a doc update mid-drag never tears down the running stroke.
        const activeNode = active && docRef.current ? nodeById(docRef.current.layers, active.id) : undefined;
        const locked = !!activeNode?.locks.transparency;
        const mode = locked ? 'normal' : 'clear';
        const rgb = locked ? bgRef.current : fgRef.current;
        if (o.mode === 'block') return { rgba: [...rgb, 255], mode, size: 16 / (viewer.current?.view.zoom || 1), tip: 'square', aliased: true, ...input };
        return presetStrokeParams(preset, o, { tool: 'eraser', rgba: [...rgb, 255], mode, bg: [...bgRef.current, 255], seed, stride, resolve: lib?.assets.resolve });
      }
      return presetStrokeParams(preset, o, { tool: 'brush', rgba: [...fgRef.current, 255], mode: o.mode as string, bg: [...bgRef.current, 255], seed, stride, resolve: lib?.assets.resolve });
    }

    // One animation-frame loop per stroke while build-up or smoothing catch-up needs time-driven samples.
    function startFrames(buildUp: boolean) {
      st.buildUp = buildUp ? new BuildUp(performance.now()) : null;
      const loop = (now: number) => {
        const s = st.smoother, last = st.last;
        if (!s || !last) { st.frame = 0; return; }
        const caught = s.catchUp(now);
        if (caught) push(caught, last.slice(2));
        const n = st.buildUp?.tick(now) ?? 0;
        for (let i = 0; i < n; i++) st.pending.push(...st.last!);
        if (n) schedule();
        st.frame = requestAnimationFrame(loop);
      };
      st.frame = requestAnimationFrame(loop);
    }
    function stopFrames() {
      if (st.frame) { cancelAnimationFrame(st.frame); st.frame = 0; }
      st.buildUp = null;
    }
    function strokeParams(x: number, y: number, stride: Stride) {
      return paramsFor(x, y, stride, strokeSeed(active!.id, ++strokeCounter.current));
    }

    async function begin(e: ToolPointerEvent) {
      if (!active) return;
      const stride = strideFor(e.pointerType);
      const p = await strokeParams(e.x, e.y, stride);
      await client.call('strokeBegin', active.id, quickMask ? 'selection' : 'pixels', p, PAINT_LABELS[tool]);
      st.layerId = active.id;
      st.stride = stride;
      const preset = presetFor();
      const o = toolOptionsRef.current;
      const smoothing = smoothingFor(preset, o), buildUp = buildUpFor(preset, o, tool as PaintTool);
      st.smoother = new Smoother(smoothing, viewer.current?.view.zoom || 1);
      push(st.smoother.start([e.x, e.y], e.timeStamp), inputFields(e, stride));
      if (buildUp || smoothing.catchUp) startFrames(buildUp);
    }
    function move(e: ToolPointerEvent) {
      if (!st.smoother) return;
      st.buildUp?.moved(e.timeStamp);
      push(st.smoother.move([e.x, e.y], e.timeStamp), inputFields(e, st.stride));
    }
    async function end(e: ToolPointerEvent) {
      // A quick click releases before strokeBegin has answered; finish the begin first.
      await st.begun;
      if (!st.smoother) return;
      push(st.smoother.end([e.x, e.y], e.timeStamp), inputFields(e, st.stride));
      flush();
      stopFrames();
      st.smoother = null;
      if (st.layerId != null && st.last) lastStrokePoint.current[st.layerId] = [st.last[0], st.last[1]];
      st.layerId = null;
      run(null, () => client.call('strokeEnd'));
    }
    async function shiftLine(e: ToolPointerEvent) {
      if (!active) return;
      const from = lastStrokePoint.current[active.id];
      if (!from) return begin(e).then(() => end(e));
      const stride = strideFor(e.pointerType);
      const fields = inputFields(e, stride);
      const p = await strokeParams(from[0], from[1], stride);
      await client.call('strokeBegin', active.id, quickMask ? 'selection' : 'pixels', p, PAINT_LABELS[tool]);
      const r = await client.call('strokeTo', Float64Array.from([from[0], from[1], ...fields, e.x, e.y, ...fields]));
      viewer.current?.invalidate(r.version, r.dirty);
      lastStrokePoint.current[active.id] = [e.x, e.y];
      run(null, () => client.call('strokeEnd'));
    }

    v.onPointer = e => {
      if (!active) return;
      if (e.type === 'down') {
        if (e.shiftKey && lastStrokePoint.current[active.id]) { void shiftLine(e); return; }
        st.begun = begin(e).catch(err => setError((err as Error).message));
      } else if (e.type === 'move') {
        move(e);
      } else {
        void end(e);
      }
    };
    return () => {
      v.onPointer = () => {};
      if (st.raf) cancelAnimationFrame(st.raf);
      stopFrames();
    };
  }, [tool, active, quickMask]);

  // Brush cursor outline (tracks the pointer independent of any drag) and Ctrl+Alt+right-drag
  // resize/hardness, with the outline doubling as the drag's live preview.
  useEffect(() => {
    const v = viewer.current, c = canvas.current;
    overlayRef.current?.setCursor(null);
    if (!v || !c || !PAINT_TOOLS.has(tool)) { redrawOverlay(); return; }
    let pos: [number, number] | null = null;
    let drag: { x: number; y: number; size: number; hardness: number } | null = null;
    const local = (e: PointerEvent): [number, number] => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const cursorFor = () => {
      if (!pos) return null;
      const [x, y] = v.screenToDoc(pos[0], pos[1]);
      const o = toolOptionsRef.current;
      const zoom = v.view.zoom;
      const block = tool === 'eraser' && o.mode === 'block';
      const sizeDoc = block ? 16 / zoom : Number(o.size);
      return { x, y, sizeDoc, shape: block ? 'square' as const : 'round' as const, crosshair: showCrosshair(sizeDoc * zoom, capsLockRef.current) };
    };
    const update = () => { overlayRef.current?.setCursor(cursorFor()); redrawOverlay(); };
    const move = (e: PointerEvent) => {
      pos = local(e);
      if (drag) {
        const r = dragResize(drag.size, drag.hardness, e.clientX - drag.x, e.clientY - drag.y);
        const patch: Record<string, number> = { size: r.size };
        if (toolOptionsRef.current.hardness !== undefined) patch.hardness = r.hardness;
        patchToolOptions(tool, patch);
      }
      update();
    };
    const leave = () => { if (!drag) { pos = null; update(); } };
    const down = (e: PointerEvent) => {
      if (e.button !== 2 || !e.ctrlKey || !e.altKey) return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const o = toolOptionsRef.current;
      drag = { x: e.clientX, y: e.clientY, size: Number(o.size), hardness: Number(o.hardness ?? 100) };
    };
    const up = () => { drag = null; };
    const context = (e: MouseEvent) => { if (e.ctrlKey && e.altKey) e.preventDefault(); };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerleave', leave);
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('contextmenu', context);
    return () => {
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerleave', leave);
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointercancel', up);
      c.removeEventListener('contextmenu', context);
      overlayRef.current?.setCursor(null);
      redrawOverlay();
    };
  }, [tool]);

  function openPicker(which: 'fg' | 'bg') {
    picker.current?.open(which === 'fg' ? fg : bg, which === 'fg' ? 'Foreground Color' : 'Background Color', v => (which === 'fg' ? setFg : setBg)(v));
  }
  const swapColors = () => { setFg(bg); setBg(fg); };
  const resetColors = () => { setFg([0, 0, 0]); setBg([255, 255, 255]); };

  const toolRef = useRef(tool);
  toolRef.current = tool;
  const lastUsedRef = useRef(lastUsed);
  lastUsedRef.current = lastUsed;
  const fgRef = useRef(fg);
  fgRef.current = fg;
  const bgRef = useRef(bg);
  bgRef.current = bg;

  function selectByKey(key: string, shift: boolean): boolean {
    const id = keyToTool(key, shift, toolRef.current, lastUsedRef.current);
    if (!id) return false;
    const slot = slotForKey(key)!;
    setLastUsed(u => ({ ...u, [slot.id]: id }));
    setTool(id);
    return true;
  }

  useEffect(() => {
    const find = (pred: (label: string) => boolean) => Object.values(menusRef.current).flat().flatMap(i => [i, ...(i.sub ?? [])]).find(i => pred(i.label));
    const trigger = (label: string, e: KeyboardEvent) => {
      const it = find(l => l.startsWith(label));
      e.preventDefault();
      if (it && !it.off) it.run();
    };
    const triggerBy = (pred: (label: string) => boolean, e: KeyboardEvent) => {
      const it = find(pred);
      e.preventDefault();
      if (it && !it.off) it.run();
    };
    // Image > Adjustments items only: Layer > New Adjustment Layer carries the same kind names.
    const adjustment = (label: string, e: KeyboardEvent) => {
      const sub = menusRef.current.Image.find(i => i.label === 'Adjustments');
      const it = sub?.sub?.find(i => i.label === label);
      e.preventDefault();
      if (it && !sub!.off && !it.off) it.run();
    };
    const down = (e: KeyboardEvent) => {
      // A closed <dialog> can keep focus on its OK button; only an open dialog or a live field swallows keys.
      const t = e.target instanceof Element ? e.target : null;
      if (t && (t.closest('dialog[open]') || (t.closest('input, select') && !t.closest('dialog:not([open])')))) return;
      capsLockRef.current = e.getModifierState('CapsLock');
      const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
      if (polygonActionsRef.current?.active()) {
        if (k === 'escape') { e.preventDefault(); polygonActionsRef.current.cancel(); return; }
        if (k === 'backspace') { e.preventDefault(); polygonActionsRef.current.removeLast(); return; }
        if (k === 'enter') { e.preventDefault(); polygonActionsRef.current.commit(); return; }
      }
      if (transformKey(e, k, ctrl)) return;
      if (!ctrl && (k === 'enter' || k === 'escape') && cropSession.current?.active()) {
        e.preventDefault();
        if (e.repeat) return;
        if (k === 'enter') cropSession.current.commit(); else cropSession.current.cancel();
        return;
      }
      if (ctrl && e.altKey && k === 'n') trigger('New', e);
      else if (ctrl && k === 'o') trigger('Open', e);
      else if (ctrl && k === 's') trigger('Save project', e);
      else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) trigger('Redo', e);
      else if (ctrl && k === 'z') trigger('Undo', e);
      else if (ctrl && k === 'a') trigger('All', e);
      else if (ctrl && e.shiftKey && k === 'd') trigger('Reselect', e);
      else if (ctrl && k === 'd') trigger('Deselect', e);
      else if (ctrl && e.shiftKey && k === 'i') trigger('Inverse', e);
      else if (ctrl && k === 'i') adjustment('Invert', e);
      else if (ctrl && e.altKey && e.shiftKey && k === 'l') trigger('Auto Contrast', e);
      else if (ctrl && e.shiftKey && !e.altKey && k === 'l') trigger('Auto Tone', e);
      else if (ctrl && e.shiftKey && !e.altKey && k === 'u') adjustment('Desaturate', e);
      else if (ctrl && e.shiftKey && !e.altKey && k === 'b') trigger('Auto Color', e);
      else if (ctrl && !e.altKey && k === 'l') adjustment('Levels…', e);
      else if (ctrl && !e.altKey && k === 'm') adjustment('Curves…', e);
      else if (ctrl && !e.altKey && k === 'u') adjustment('Hue/Saturation…', e);
      else if (ctrl && e.altKey && e.shiftKey && k === 'b') adjustment('Black & White…', e);
      else if (ctrl && !e.altKey && !e.shiftKey && k === 'b') adjustment('Color Balance…', e);
      else if (ctrl && e.shiftKey && k === 't') triggerBy(l => l === 'Again', e);
      else if (ctrl && k === 't') trigger('Free Transform', e);
      else if (e.shiftKey && k === 'f6') trigger('Feather', e);
      else if (e.shiftKey && !ctrl && k === 'f5') triggerBy(l => l === 'Fill…', e);
      else if (k === 'f5' && !ctrl) { e.preventDefault(); setDockTab(t => (t === 'brushSettings' ? 'color' : 'brushSettings')); }
      else if (ctrl && k === 'h') triggerBy(l => l.endsWith('selection edges'), e);
      else if (ctrl && k === 'j') trigger('Duplicate Layer', e);
      else if (ctrl && e.altKey && k === 'g') triggerBy(l => l.endsWith('Clipping Mask'), e);
      else if (ctrl && e.shiftKey && k === 'g') trigger('Ungroup Layers', e);
      else if (ctrl && k === 'g') trigger('Group Layers', e);
      else if (ctrl && (k === '+' || k === '=')) trigger('Zoom in', e);
      else if (ctrl && k === '-') trigger('Zoom out', e);
      else if (ctrl && k === '0') trigger('Fit', e);
      else if (ctrl && k === '1') trigger('100%', e);
      else if (e.altKey && !ctrl && (k === 'backspace' || k === 'delete')) triggerBy(l => l === 'Fill with Foreground Color', e);
      else if (ctrl && !e.altKey && (k === 'backspace' || k === 'delete')) triggerBy(l => l === 'Fill with Background Color', e);
      else if (e.shiftKey && k === 'backspace') triggerBy(l => l === 'Fill…', e);
      else if (k === 'delete' || k === 'backspace') trigger('Clear', e);
      else if (k === 'escape') { setMenu(null); viewer.current?.resetRotation(); }
      else if (k === ' ' && ctrl && e.altKey) { e.preventDefault(); viewer.current?.setSpring('zoomOut'); }
      else if (k === ' ' && ctrl) { e.preventDefault(); viewer.current?.setSpring('zoom'); }
      else if (k === ' ') { e.preventDefault(); viewer.current?.setSpring('hand'); }
      else if (!ctrl && !e.altKey && k === 'x') { e.preventDefault(); setFg(bgRef.current); setBg(fgRef.current); }
      else if (!ctrl && !e.altKey && k === 'd') { e.preventDefault(); setFg([0, 0, 0]); setBg([255, 255, 255]); }
      else if (!ctrl && !e.altKey && k === 'q') { e.preventDefault(); setQuickMask(v => !v); }
      else if (!ctrl && !e.altKey && (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}' || /^Digit[0-9]$/.test(e.code))) {
        // Brush shortcuts (docs/M2.md section 4): only mutate options for the active paint tool,
        // but always swallow these keys so they never reach selectByKey (no slot uses them anyway).
        e.preventDefault();
        if (PAINT_TOOLS.has(toolRef.current)) {
          const o = toolOptionsRef.current;
          if (e.key === '[' || e.key === ']') patchToolOptions(toolRef.current, { size: stepSize(Number(o.size), e.key === ']') });
          else if ((e.key === '{' || e.key === '}') && o.hardness !== undefined) {
            patchToolOptions(toolRef.current, { hardness: stepHardness(Number(o.hardness), e.key === '}') });
          } else {
            const digit = e.code.slice(5);
            const now = performance.now();
            if (e.shiftKey && o.flow !== undefined) {
              const r = digitOption(flowDigitRef.current, digit, now);
              flowDigitRef.current = r.state;
              patchToolOptions(toolRef.current, { flow: r.value });
            } else if (!e.shiftKey) {
              const r = digitOption(opacityDigitRef.current, digit, now);
              opacityDigitRef.current = r.state;
              patchToolOptions(toolRef.current, { opacity: r.value });
            }
          }
        }
      }
      else if (moveKeysRef.current && !ctrl && k.startsWith('arrow')) {
        e.preventDefault();
        const n = e.shiftKey ? 10 : 1;
        moveKeysRef.current.nudge(k === 'arrowleft' ? -n : k === 'arrowright' ? n : 0, k === 'arrowup' ? -n : k === 'arrowdown' ? n : 0, e.altKey);
      }
      else if (!ctrl && !e.altKey && !e.metaKey) selectByKey(k, e.shiftKey);
    };
    const up = (e: KeyboardEvent) => {
      capsLockRef.current = e.getModifierState('CapsLock');
      if (e.key === ' ') viewer.current?.setSpring(null);
    };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const f = e.dataTransfer?.files[0];
      if (f) open(f);
    };
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    addEventListener('dragover', over);
    addEventListener('drop', drop);
    return () => {
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
      removeEventListener('dragover', over);
      removeEventListener('drop', drop);
    };
  }, []);

  // Brush presets: the selected preset (with a protected texture carried over) and the Brushes/Brush Settings panels.
  function currentPreset(id: string | null): BrushPreset | null {
    const lib = brushLib.current;
    const p = id !== null && lib ? lib.library.list().find(x => x.id === id) ?? null : null;
    const tex = protectedTexture.current;
    return p && tex && p.dynamics.texture.enabled ? { ...p, dynamics: { ...p.dynamics, texture: tex } } : p;
  }
  const brushTarget = (PAINT_TOOLS.has(tool) ? tool : 'brush') as PaintTool;
  const targetOptions = optionsByTool[brushTarget] ?? loadToolOptions(TOOLS[brushTarget]);
  const presets = brushLib.current?.library.list() ?? [];
  const selectedPreset = currentPreset(selectedPresetId);
  const bumpLib = () => setLibVersion(v => v + 1);
  function setTargetOption(k: string, v: number | boolean) {
    patchToolOptions(brushTarget, { [k]: v });
    saveToolOptions(TOOLS[brushTarget], { ...targetOptions, [k]: v });
  }
  function selectPreset(p: BrushPreset) {
    const old = selectedPreset?.dynamics;
    protectedTexture.current = old?.protectTexture && old.texture.enabled ? old.texture : null;
    setSelectedPresetId(p.id);
    setRecentPresets(r => pushRecent(r, p.id));
    const patch = presetOptions(p, brushTarget);
    patchToolOptions(brushTarget, patch);
    saveToolOptions(TOOLS[brushTarget], { ...targetOptions, ...patch });
    const c = p.captured?.color;
    if (c) setFg([c[0], c[1], c[2]]);
  }
  function deletePreset(id: string) {
    const lib = brushLib.current;
    if (!lib) return;
    lib.library.delete(id);
    setRecentPresets(r => r.filter(x => x !== id));
    if (selectedPresetId === id) {
      const first = lib.library.list()[0];
      if (first) selectPreset(first); else setSelectedPresetId(null);
    }
    bumpLib();
  }
  function editDynamics(fn: (d: Dynamics) => void) {
    const lib = brushLib.current, p = selectedPresetId !== null ? lib?.library.list().find(x => x.id === selectedPresetId) : undefined;
    if (!lib || !p) return;
    const next = structuredClone(p);
    fn(next.dynamics);
    lib.library.save(next);
    bumpLib();
  }
  const preparedPreviews = useRef(new Set<string>());
  function previewFor(p: BrushPreset | null, o: Record<string, unknown> = {}): Record<string, unknown> {
    const lib = brushLib.current;
    if (p && lib && !preparedPreviews.current.has(p.id)) {
      preparedPreviews.current.add(p.id);
      void lib.assets.prepare(p).then(bumpLib);
    }
    const params = presetStrokeParams(p, o, { tool: brushTarget, rgba: [222, 224, 227, 255], mode: 'normal', bg: [255, 255, 255, 255], seed: 0, stride: 3, resolve: lib?.assets.resolve });
    params.size = Math.min(Number(params.size), 40);
    return params;
  }
  async function importAbr(f: File) {
    const lib = brushLib.current;
    if (!lib) return { error: 'The brush library is not available.' };
    try {
      const r = await parseAbrOffThread(await f.arrayBuffer());
      const { added, warnings } = lib.library.import(r);
      bumpLib();
      return { added, name: f.name, report: { ...r.report, warnings: [...r.report.warnings, ...warnings] } };
    } catch (e) {
      return { error: `Could not read ${f.name}: ${(e as Error).message}` };
    }
  }
  const preview = useRef((params: Record<string, unknown>, w: number, h: number) => client.call('brushPreview', params, w, h)).current;
  const tipBitmap = useRef((ref: string) => brushLib.current?.library.tip(ref)).current;

  const deg = Math.round(((view.rot * 180) / Math.PI) % 360);
  const gradOptions = optionsByTool.gradient ?? loadToolOptions(TOOLS.gradient);
  const gradPreset = resolvePreset(gradLib.current.get(String(gradOptions.gradient)) ?? BUILTIN_GRADIENTS[0], fg, bg);
  function editGradient() {
    gradEditor.current?.open(gradPreset, g => {
      const p = gradLib.current!.add(g);
      const next = { ...gradOptions, gradient: p.id, method: g.interpolation };
      patchToolOptions('gradient', next);
      saveToolOptions(TOOLS.gradient, next);
    });
  }
  const gradientButton = (
    <button type="button" className="gradient-ramp-button" aria-label="Edit gradient" title="Click to edit the gradient"
      style={{ backgroundImage: `${rampCss(gradPreset, gradOptions.method as Method)}, var(--checker)` }} onClick={editGradient} />
  );
  const cropActions = (
    <span className="crop-actions">
      <button type="button" onClick={() => cropSession.current?.cancel()}>Cancel</button>
      <button type="button" className="primary" onClick={() => cropSession.current?.commit()}>Apply</button>
    </span>
  );
  const menuItems = (items: Item[]): ReactNode => items.map(i => (
    <Fragment key={i.label}>
      {i.sep && <li role="separator" className="menu-sep" />}
      <li className={i.sub ? 'has-sub' : undefined}>
        <button role="menuitem" aria-haspopup={i.sub ? 'menu' : undefined} disabled={i.off} onClick={i.run}><span>{i.label}</span><kbd>{i.keys}</kbd></button>
        {i.sub && !i.off && <ul role="menu" aria-label={i.label}>{menuItems(i.sub)}</ul>}
      </li>
    </Fragment>
  ));
  return (
    <div className="app">
      <header className="menubar">
        <img className="brand" src="./logo-light.png" alt="Photobaer" width={24} height={24} />
        {Object.entries(menus).map(([name, items]) => (
          <div key={name} className="menu">
            <button className={menu === name ? 'open' : ''} onClick={() => setMenu(menu === name ? null : name)} onMouseEnter={() => menu && setMenu(name)}>{name}</button>
            {menu === name && (
              <ul role="menu">{menuItems(items)}</ul>
            )}
          </div>
        ))}
        {doc?.parents.length ? (
          <span className="breadcrumb" aria-label="Smart object contents">
            {[...doc.parents, doc.name].join(' › ')}
            <button type="button" onClick={() => run('Saving contents…', () => client.call('smartEditSave'))}>Save</button>
            <button type="button" onClick={() => run('Closing contents…', () => client.call('smartEditClose'))}>Close</button>
          </span>
        ) : null}
      </header>
      {menu && <div className="scrim" onClick={() => setMenu(null)} />}
      {transformMenu && transformStore && (
        <>
          <div className="scrim" onClick={() => setTransformMenu(null)} onContextMenu={e => { e.preventDefault(); setTransformMenu(null); }} />
          <div className="menu context-menu" style={{ left: transformMenu[0], top: transformMenu[1] }}>
            <ul role="menu" aria-label="Transform">
              {([
                ...MODES.map(([m, label]) => ({ label, run: () => withTransform(t => setTransformMode(t, m)), off: warping && m !== 'warp' })),
                { label: 'Rotate 180°', run: () => transformCommand('180'), off: warping },
                { label: 'Rotate 90° CW', run: () => transformCommand('cw'), off: warping },
                { label: 'Rotate 90° CCW', run: () => transformCommand('ccw'), off: warping },
                { label: 'Flip Horizontal', run: () => transformCommand('flipH'), off: warping },
                { label: 'Flip Vertical', run: () => transformCommand('flipV'), off: warping },
                { label: 'Apply', run: () => endTransform(true) },
                { label: 'Cancel', run: () => endTransform(false) },
              ] as { label: string; run: () => void; off?: boolean }[]).map(i => (
                <li key={i.label}><button role="menuitem" disabled={i.off} onClick={i.run}><span>{i.label}</span></button></li>
              ))}
            </ul>
          </div>
        </>
      )}
      <main className="workspace with-sidebar">
        <ToolBar
          active={tool} setActive={setTool} lastUsed={lastUsed} setLastUsed={setLastUsed}
          fg={fg} bg={bg} openPicker={openPicker} swap={swapColors} reset={resetColors}
          quickMask={quickMask} setQuickMask={setQuickMask}
        />
        <div className="stage-column">
          {transformStore ? (
            <TransformBar
              store={transformStore}
              setMode={m => withTransform(t => setTransformMode(t, m))}
              setSnap={b => withTransform(t => { t.snap = b; t.store.set({ snap: b }); })}
              setLinked={b => withTransform(t => { t.linked = b; t.store.set({ linked: b }); })}
              setReference={(u, v) => withTransform(t => transformChange(t, setReferenceNormalized(t.s, u, v), true))}
              setNumeric={(f, v) => withTransform(t => transformChange(t, setNumeric(t.s, f, v, t.linked), true))}
              apply={() => endTransform(true)} cancel={() => endTransform(false)}
              warpStyle={st => withTransform(t => {
                const ws = t.warp;
                if (!ws) return;
                if (st === 'custom') { warpChange(t, { ...ws.w, preset: { ...ws.w.preset, style: 'custom' } }, false); return; }
                const preset = pickStyle(ws.w.preset, st);
                warpChange(t, { preset, mesh: presetMesh(preset, ws.w.mesh.bounds) }, true);
              })}
              warpPreset={p => withTransform(t => {
                const ws = t.warp;
                if (!ws) return;
                const preset = { ...ws.w.preset, ...p };
                warpChange(t, { preset, mesh: presetMesh(preset, ws.w.mesh.bounds) }, true);
              })}
              warpGrid={n => withTransform(t => { if (t.warp) warpChange(t, setGrid(t.warp.w, n), true); })}
              warpSplit={m => withTransform(t => {
                const ws = t.warp;
                if (!ws) return;
                ws.split = ws.split === m ? null : m;
                t.store.set({ warp: warpBar(ws) });
              })}
            />
          ) : <OptionsBar tool={activeTool} values={toolOptions} setValues={setToolOptions} custom={{ gradient: gradientButton, actions: cropActions }} />}
          <div className="stage">
            <canvas ref={canvas} style={{ cursor: tool === 'gradient' ? 'crosshair' : undefined }} />
            <canvas ref={overlayCanvas} className="overlay" />
            {!doc && !busy && (
              <div className="welcome">
                <h1>Photobaer</h1>
                <div className="actions">
                  <button onClick={() => newDialog.current?.showModal()}>New image</button>
                  <button onClick={() => fileInput.current?.click()}>Open…</button>
                </div>
                <p>Or drop a PNG, JPEG, WebP, PSD or .pbaer file here.</p>
              </div>
            )}
            {busy && <div className="busy">{busy}</div>}
            {error && <div className="error" role="alert" onClick={() => setError(null)}>{error}</div>}
          </div>
        </div>
        <aside className="sidebar">
          <div className="panel-tabs dock-tabs">
            <button className={`panel-tab${dockTab === 'color' ? ' active' : ''}`} onClick={() => setDockTab('color')}>Color</button>
            <button className={`panel-tab${dockTab === 'swatches' ? ' active' : ''}`} onClick={() => setDockTab('swatches')}>Swatches</button>
            <button className={`panel-tab${dockTab === 'brushSettings' ? ' active' : ''}`} title="Brush Settings (F5)" onClick={() => setDockTab('brushSettings')}>Brush Settings</button>
            <button className={`panel-tab${dockTab === 'brushes' ? ' active' : ''}`} onClick={() => setDockTab('brushes')}>Brushes</button>
          </div>
          {dockTab === 'color' && <ColorPanel fg={fg} bg={bg} setFg={setFg} setBg={setBg} swap={swapColors} reset={resetColors} />}
          {dockTab === 'swatches' && <SwatchesPanel fg={fg} setFg={setFg} setBg={setBg} />}
          {dockTab === 'brushSettings' && (
            <BrushSettingsPanel
              tool={brushTarget} options={targetOptions} setOption={setTargetOption} preset={selectedPreset} presets={presets}
              selectPreset={selectPreset} editDynamics={editDynamics} patterns={brushLib.current?.library.patterns() ?? []}
              tipBitmap={tipBitmap} preview={preview} previewParams={previewFor(selectedPreset, targetOptions)}
            />
          )}
          {dockTab === 'brushes' && (
            <BrushesPanel
              presets={presets} selected={selectedPreset} recent={recentPresets} selectPreset={selectPreset} deletePreset={deletePreset}
              options={targetOptions} setOption={setTargetOption} tipBitmap={tipBitmap}
              preview={preview} previewFor={p => previewFor(p, p === selectedPreset ? targetOptions : {})} importAbr={importAbr}
              openSettings={() => setDockTab('brushSettings')}
            />
          )}
          {doc && active && showAdjustments && <AdjustmentsPanel create={newAdjustmentLayer} fill={quickFillLayer} patternOff={!doc.patterns.length} />}
          {doc && showProperties && node?.kind === 'adjustment' && node.adjustment && (
            <PropertiesPanel doc={doc} node={node} run={run} openGradientEditor={(g, ok) => gradEditor.current?.open(g, ok)} pickLookupFile={pickLookupFile} sampleCanvas={sampleCanvas} />
          )}
          {doc && active && (
            <>
              <LayersPanel
                doc={doc} active={active} setActive={setActive} run={run}
                newLayer={newLayer} newGroup={newGroup}
                deleteLayer={deleteLayer} deleteDisabled={deleteDisabled} addMask={addMask}
                openProperties={() => setShowProperties(true)}
                openLayerStyle={(id, page) => openLayerStyle(page, id)}
              />
              <HistoryPanel history={doc.history} goto={n => run(null, () => client.call('historyGoto', n))} />
              {showLayerComps && <LayerCompsPanel doc={doc} run={run} />}
            </>
          )}
        </aside>
      </main>
      <footer className="status">
        <span>{doc ? `${doc.width} × ${doc.height} px, ${doc.depth}-bit` : 'No document'}</span>
        <span>{Math.round(view.zoom * 1000) / 10}%</span>
        <span>{deg ? `${deg}°` : ''}</span>
        <span className="grow">{doc ? (SELECT_TOOLS.includes(tool) ? 'drag to select, Shift add, Alt subtract' : `${activeTool.label}: drag to use, Space to pan, wheel to zoom`) : ''}</span>
        <span>{AUTOSAVE_TEXT[autosave]}</span>
        <span>{renderer}</span>
      </footer>
      <ColorPicker ref={picker} />
      <GradientEditor ref={gradEditor} presets={gradLib.current.list()} fg={fg} bg={bg} pickColor={(rgb, title, commit) => picker.current?.open(rgb, title, commit)} />
      <dialog ref={fillDialog} aria-label="Fill" onClose={endPreviewDialog}>
        <form onSubmit={e => { e.preventDefault(); previewRef.current.commit = true; fillDialog.current?.close(); }}>
          <h2>Fill</h2>
          <label>Contents <select name="contents" value={fillForm.contents} onChange={e => setFillForm({ ...fillForm, contents: e.currentTarget.value as FillContents })}>
            {Object.entries(FILL_CONTENTS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select></label>
          <label>Custom color <button type="button" className="gradient-swatch" aria-label="Custom fill color" style={{ background: rgbToHex(fillForm.color) }}
            onClick={() => picker.current?.open(fillForm.color, 'Fill Color', c => setFillForm(f => ({ ...f, color: c, contents: 'color' })))} /></label>
          {fillForm.contents === 'pattern' && (
            <label>Pattern <select name="pattern" value={fillForm.pattern || brushLib.current?.library.patterns()[0]?.id} onChange={e => setFillForm({ ...fillForm, pattern: e.currentTarget.value })}>
              {brushLib.current?.library.patterns().map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
          )}
          <label>Mode <select name="mode" value={fillForm.mode} onChange={e => setFillForm({ ...fillForm, mode: e.currentTarget.value })}>
            {PAINT_MODES.map(m => <option key={m} value={m}>{m}</option>)}
          </select></label>
          <label>Opacity <input name="opacity" type="number" min={0} max={100} value={fillForm.opacity}
            onChange={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) setFillForm({ ...fillForm, opacity: Math.min(100, Math.max(0, v)) }); }} /> %</label>
          <label><input name="preserve" type="checkbox" checked={fillForm.preserve} onChange={e => setFillForm({ ...fillForm, preserve: e.currentTarget.checked })} /> Preserve Transparency</label>
          <div className="actions">
            <button type="button" onClick={() => fillDialog.current?.close()}>Cancel</button>
            <button type="submit" className="primary">OK</button>
          </div>
        </form>
      </dialog>
      <dialog ref={strokeDialog} aria-label="Stroke" onClose={endPreviewDialog}>
        <form onSubmit={e => { e.preventDefault(); previewRef.current.commit = true; strokeDialog.current?.close(); }}>
          <h2>Stroke</h2>
          <label>Width <input name="width" type="number" min={1} max={250} value={strokeForm.width}
            onChange={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) setStrokeForm({ ...strokeForm, width: Math.min(250, Math.max(1, Math.round(v))) }); }} /> px</label>
          <label>Color <button type="button" className="gradient-swatch" aria-label="Stroke color" style={{ background: rgbToHex(strokeForm.color) }}
            onClick={() => picker.current?.open(strokeForm.color, 'Stroke Color', c => setStrokeForm(f => ({ ...f, color: c })))} /></label>
          <fieldset className="stroke-location">
            <legend>Location</legend>
            {(['inside', 'center', 'outside'] as const).map(l => (
              <label key={l}><input type="radio" name="location" value={l} checked={strokeForm.location === l} onChange={() => setStrokeForm({ ...strokeForm, location: l })} /> {l[0].toUpperCase() + l.slice(1)}</label>
            ))}
          </fieldset>
          <label>Mode <select name="mode" value={strokeForm.mode} onChange={e => setStrokeForm({ ...strokeForm, mode: e.currentTarget.value })}>
            {PAINT_MODES.map(m => <option key={m} value={m}>{m}</option>)}
          </select></label>
          <label>Opacity <input name="opacity" type="number" min={0} max={100} value={strokeForm.opacity}
            onChange={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) setStrokeForm({ ...strokeForm, opacity: Math.min(100, Math.max(0, v)) }); }} /> %</label>
          <label><input name="preserve" type="checkbox" checked={strokeForm.preserve} onChange={e => setStrokeForm({ ...strokeForm, preserve: e.currentTarget.checked })} /> Preserve Transparency</label>
          <div className="actions">
            <button type="button" onClick={() => strokeDialog.current?.close()}>Cancel</button>
            <button type="submit" className="primary">OK</button>
          </div>
        </form>
      </dialog>
      <dialog ref={adjustDialog} aria-label={adjustForm ? COMMAND_LABEL[adjustForm.kind] : 'Adjustment'} onClose={endPreviewDialog}>
        <form onSubmit={e => { e.preventDefault(); previewRef.current.commit = true; adjustDialog.current?.close(); }}>
          <h2>{adjustForm && COMMAND_LABEL[adjustForm.kind]}</h2>
          {adjustForm && (
            <AdjustmentBody key={adjustSession} adjustment={adjustForm} onChange={a => setAdjustForm(a)} openGradientEditor={(g, ok) => gradEditor.current?.open(g, ok)} pickLookupFile={pickLookupFile} histogramId={active?.id ?? 0} />
          )}
          <div className="actions">
            <button type="button" onClick={() => adjustDialog.current?.close()}>Cancel</button>
            <button type="submit" className="primary">OK</button>
          </div>
        </form>
      </dialog>
      <input ref={lutInput} type="file" hidden accept=".cube,.3dl" onChange={e => { const f = e.currentTarget.files?.[0]; if (f) void loadLookupFile(f); }} />
      <dialog ref={fillContentDialog}>
        <form onSubmit={e => { e.preventDefault(); submitFillContent(); }}>
          <h2>{FILL_LAYER_TITLES[fillContentForm.type]}</h2>
          {fillContentForm.type === 'solid' && (
            <label>Color <button type="button" className="gradient-swatch" aria-label="Fill color" style={{ background: rgbToHex(fillContentForm.color) }}
              onClick={() => picker.current?.open(fillContentForm.color, 'Fill Color', c => setFillContentForm(f => ({ ...f, color: c })))} /></label>
          )}
          {fillContentForm.type === 'gradient' && (
            <>
              <label>Style <select value={fillContentForm.style} onChange={e => setFillContentForm({ ...fillContentForm, style: e.currentTarget.value as FillContentForm['style'] })}>
                {(['linear', 'radial', 'angle', 'reflected', 'diamond'] as const).map(s => <option key={s} value={s}>{s}</option>)}
              </select></label>
              <label>Angle <input type="number" value={fillContentForm.angle} onChange={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) setFillContentForm({ ...fillContentForm, angle: v }); }} /> °</label>
              <label>Scale <input type="number" min={10} max={150} value={fillContentForm.scalePct} onChange={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) setFillContentForm({ ...fillContentForm, scalePct: Math.min(150, Math.max(10, v)) }); }} /> %</label>
              <label><input type="checkbox" checked={fillContentForm.reverse} onChange={e => setFillContentForm({ ...fillContentForm, reverse: e.currentTarget.checked })} /> Reverse</label>
              <label><input type="checkbox" checked={fillContentForm.dither} onChange={e => setFillContentForm({ ...fillContentForm, dither: e.currentTarget.checked })} /> Dither</label>
              <label><input type="checkbox" checked={fillContentForm.alignWithLayer} onChange={e => setFillContentForm({ ...fillContentForm, alignWithLayer: e.currentTarget.checked })} /> Align with layer</label>
            </>
          )}
          {fillContentForm.type === 'pattern' && (
            <>
              {doc?.patterns.length ? (
                <label>Pattern <select value={fillContentForm.patternId || doc.patterns[0].id} onChange={e => setFillContentForm({ ...fillContentForm, patternId: e.currentTarget.value })}>
                  {doc.patterns.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select></label>
              ) : <p>This document has no patterns.</p>}
              <label>Scale <input type="number" min={1} max={1000} value={fillContentForm.scalePct} onChange={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) setFillContentForm({ ...fillContentForm, scalePct: Math.min(1000, Math.max(1, v)) }); }} /> %</label>
              <label>Angle <input type="number" value={fillContentForm.angle} onChange={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) setFillContentForm({ ...fillContentForm, angle: v }); }} /> °</label>
              <label><input type="checkbox" checked={fillContentForm.linked} onChange={e => setFillContentForm({ ...fillContentForm, linked: e.currentTarget.checked })} /> Link with layer</label>
            </>
          )}
          <div className="actions">
            <button type="button" onClick={() => fillContentDialog.current?.close()}>Cancel</button>
            <button type="submit" className="primary" disabled={fillContentForm.type === 'pattern' && !doc?.patterns.length}>OK</button>
          </div>
        </form>
      </dialog>
      <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,.pbaer,.psd"
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) open(f); }} />
      <dialog ref={newDialog}>
        <form onSubmit={createNew}>
          <h2>New image</h2>
          <label>Width <input name="w" type="number" min={1} max={65536} defaultValue={1920} required /> px</label>
          <label>Height <input name="h" type="number" min={1} max={65536} defaultValue={1080} required /> px</label>
          <label>Bit depth <select name="depth" defaultValue="8"><option value="8">8-bit</option><option value="16">16-bit</option></select></label>
          <label>Background <select name="bg" defaultValue="white"><option value="white">White</option><option value="black">Black</option><option value="transparent">Transparent</option></select></label>
          <div className="actions">
            <button type="button" onClick={() => newDialog.current?.close()}>Cancel</button>
            <button type="submit" className="primary">Create</button>
          </div>
        </form>
      </dialog>
      <dialog ref={featherDialog}>
        <form onSubmit={e => {
          e.preventDefault();
          const r = Number(new FormData(e.currentTarget).get('radius'));
          featherDialog.current?.close();
          run(null, () => client.call('selectCommand', 'feather', r));
        }}>
          <h2>Feather Selection</h2>
          <label>Feather radius <input name="radius" type="number" min={0.1} max={1000} step={0.1} defaultValue={1} required /> px</label>
          <div className="actions">
            <button type="button" onClick={() => featherDialog.current?.close()}>Cancel</button>
            <button type="submit" className="primary">OK</button>
          </div>
        </form>
      </dialog>
      <dialog ref={modifyDialog}>
        <form onSubmit={e => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          modifyDialog.current?.close();
          run(null, () => client.call('modifySelection', modifyOp, Number(f.get('radius')), f.get('canvasBounds') === 'on'));
        }}>
          <h2>{MODIFY_OPS[modifyOp].label} Selection</h2>
          <label>Radius <input name="radius" type="number" min={MODIFY_OPS[modifyOp].min} max={MODIFY_OPS[modifyOp].max} defaultValue={MODIFY_OPS[modifyOp].default} required /> px</label>
          <label><input name="canvasBounds" type="checkbox" /> Apply effect at canvas bounds</label>
          <div className="actions">
            <button type="button" onClick={() => modifyDialog.current?.close()}>Cancel</button>
            <button type="submit" className="primary">OK</button>
          </div>
        </form>
      </dialog>
      <dialog ref={saveSelDialog}>
        <form onSubmit={e => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const channel = f.get('channel');
          saveSelDialog.current?.close();
          run(null, () => client.call('saveSelection', channel ? null : String(f.get('name')), channel ? Number(channel) : null, String(f.get('mode'))));
        }}>
          <h2>Save Selection</h2>
          <label>Channel
            <select name="channel" defaultValue="">
              <option value="">New channel</option>
              {doc?.channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>Name <input name="name" type="text" defaultValue={`Selection ${(doc?.channels.length ?? 0) + 1}`} /></label>
          <label>Operation <select name="mode" defaultValue="new">
            <option value="new">Replace</option><option value="add">Add to channel</option>
            <option value="subtract">Subtract from channel</option><option value="intersect">Intersect with channel</option>
          </select></label>
          <div className="actions">
            <button type="button" onClick={() => saveSelDialog.current?.close()}>Cancel</button>
            <button type="submit" className="primary">OK</button>
          </div>
        </form>
      </dialog>
      <dialog ref={loadSelDialog}>
        <form onSubmit={e => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          loadSelDialog.current?.close();
          run(null, () => client.call('loadSelection', Number(f.get('channel')), f.get('invert') === 'on', String(f.get('mode'))));
        }}>
          <h2>Load Selection</h2>
          <label>Channel <select name="channel" defaultValue={doc?.channels[0]?.id}>
            {doc?.channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>
          <label><input name="invert" type="checkbox" /> Invert</label>
          <label>Operation <select name="mode" defaultValue="new">
            <option value="new">New Selection</option><option value="add">Add to Selection</option>
            <option value="subtract">Subtract from Selection</option><option value="intersect">Intersect with Selection</option>
          </select></label>
          <div className="actions">
            <button type="button" onClick={() => loadSelDialog.current?.close()}>Cancel</button>
            <button type="submit" className="primary">OK</button>
          </div>
        </form>
      </dialog>
      <dialog ref={trimDialog}>
        <form onSubmit={e => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const on = (k: string) => f.get(k) === 'on';
          trimDialog.current?.close();
          run('Trimming…', () => client.call('trim', String(f.get('basedOn')) as TrimBase, on('top'), on('bottom'), on('left'), on('right')));
        }}>
          <h2>Trim</h2>
          <fieldset className="stroke-location trim-group">
            <legend>Based On</legend>
            {([['transparent', 'Transparent Pixels'], ['topLeftPixel', 'Top Left Pixel Color'], ['bottomRightPixel', 'Bottom Right Pixel Color']] as [TrimBase, string][]).map(([v, l]) => (
              <label key={v}><input type="radio" name="basedOn" value={v} defaultChecked={v === 'transparent'} /> {l}</label>
            ))}
          </fieldset>
          <fieldset className="stroke-location">
            <legend>Trim Away</legend>
            {['Top', 'Bottom', 'Left', 'Right'].map(l => (
              <label key={l}><input type="checkbox" name={l.toLowerCase()} defaultChecked /> {l}</label>
            ))}
          </fieldset>
          <div className="actions">
            <button type="button" onClick={() => trimDialog.current?.close()}>Cancel</button>
            <button type="submit" className="primary">OK</button>
          </div>
        </form>
      </dialog>
      {doc && styleDialog && nodeById(doc.layers, styleDialog.id) && (
        <LayerStyleDialog
          key={styleDialog.n} doc={doc} node={nodeById(doc.layers, styleDialog.id)!} page={styleDialog.page}
          onDoc={d => show(d)} onError={m => setError(m)} onClose={() => setStyleDialog(null)}
          openGradientEditor={(g, ok) => gradEditor.current?.open(g, ok)} pickColor={(rgb, title, commit) => picker.current?.open(rgb, title, commit)}
        />
      )}
      <dialog ref={globalLightDialog}>
        <form key={doc ? `${doc.globalLight.angle}/${doc.globalLight.altitude}` : ''} onSubmit={e => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          globalLightDialog.current?.close();
          run(null, () => client.call('setGlobalLight', { angle: Number(f.get('angle')), altitude: Number(f.get('altitude')) }));
        }}>
          <h2>Global Light</h2>
          <label>Angle <input name="angle" type="number" min={-360} max={360} step="any" defaultValue={doc?.globalLight.angle ?? 120} required /> °</label>
          <label>Altitude <input name="altitude" type="number" min={0} max={90} step="any" defaultValue={doc?.globalLight.altitude ?? 30} required /> °</label>
          <div className="actions">
            <button type="button" onClick={() => globalLightDialog.current?.close()}>Cancel</button>
            <button type="submit" className="primary">OK</button>
          </div>
        </form>
      </dialog>
      <dialog ref={scaleEffectsDialog}>
        <form key={node?.style ? `${node.id}/${node.style.scale}` : ''} onSubmit={e => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          scaleEffectsDialog.current?.close();
          if (node) run(null, () => client.call('scaleEffects', node.id, Number(f.get('scale'))));
        }}>
          <h2>Scale Layer Effects</h2>
          <label>Scale <input name="scale" type="number" min={1} max={1000} step={1} defaultValue={Math.round((node?.style?.scale ?? 1) * 100)} required /> %</label>
          <div className="actions">
            <button type="button" onClick={() => scaleEffectsDialog.current?.close()}>Cancel</button>
            <button type="submit" className="primary">OK</button>
          </div>
        </form>
      </dialog>
      <dialog ref={rotateDialog}>
        <form onSubmit={e => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          rotateDialog.current?.close();
          run('Rotating…', () => client.call('rotateCanvasArbitrary', Number(f.get('angle')), String(f.get('interp')) as 'nearest' | 'bilinear' | 'bicubic'));
        }}>
          <h2>Rotate Canvas</h2>
          <label>Angle <input name="angle" type="number" min={-360} max={360} step="any" defaultValue={0} required /> ° clockwise</label>
          <label>Interpolation <select name="interp" defaultValue="bicubic">
            <option value="nearest">Nearest Neighbor</option><option value="bilinear">Bilinear</option><option value="bicubic">Bicubic</option>
          </select></label>
          <div className="actions">
            <button type="button" onClick={() => rotateDialog.current?.close()}>Cancel</button>
            <button type="submit" className="primary">OK</button>
          </div>
        </form>
      </dialog>
      <dialog ref={colorRangeDialog} onClose={() => setColorRangeOpen(false)}>
        <form onSubmit={e => {
          e.preventDefault();
          if (!active) return;
          const samplesFlat = colorRangeSamples.flatMap(s => s.rgb);
          const centerFlat = colorRangeSamples.flatMap(s => [s.x, s.y]);
          closeColorRange();
          run(null, () => client.call('colorRange', active.id, false, colorRange.preset, samplesFlat, colorRange.fuzziness, colorRange.range, centerFlat, colorRange.localized, colorRange.invert));
        }}>
          <h2>Color Range</h2>
          <label>Select <select value={colorRange.preset} onChange={e => setColorRange({ ...colorRange, preset: e.target.value })}>
            {COLOR_RANGE_PRESETS.map(p => <option key={p} value={p}>{p}</option>)}
          </select></label>
          <canvas
            ref={colorRangeCanvas} className="color-range-preview"
            onClick={e => {
              if (!colorRangePreview) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const cx = Math.round((e.clientX - rect.left) * (colorRangePreview.w / rect.width));
              const cy = Math.round((e.clientY - rect.top) * (colorRangePreview.h / rect.height));
              const x = cx * (1 << colorRangePreview.level), y = cy * (1 << colorRangePreview.level);
              if (e.altKey) {
                setColorRangeSamples(s => {
                  if (!s.length) return s;
                  let best = 0, bestD = Infinity;
                  s.forEach((p, i) => { const d = Math.hypot(p.x - x, p.y - y); if (d < bestD) { bestD = d; best = i; } });
                  return s.filter((_, i) => i !== best);
                });
                return;
              }
              client.call('sample', x, y, 1, null).then(([r, g, b]) => {
                setColorRangeSamples(s => (e.shiftKey ? [...s, { rgb: [r, g, b], x, y }] : [{ rgb: [r, g, b], x, y }]));
              });
            }}
          />
          <label>Fuzziness <input type="range" min={0} max={200} value={colorRange.fuzziness} onChange={e => setColorRange({ ...colorRange, fuzziness: Number(e.target.value) })} /> {colorRange.fuzziness}</label>
          <label>Range <input type="range" min={0} max={100} value={colorRange.range} onChange={e => setColorRange({ ...colorRange, range: Number(e.target.value) })} /> {colorRange.range}%</label>
          <label><input type="checkbox" checked={colorRange.localized} onChange={e => setColorRange({ ...colorRange, localized: e.target.checked })} /> Localized color clusters</label>
          <label><input type="checkbox" checked={colorRange.invert} onChange={e => setColorRange({ ...colorRange, invert: e.target.checked })} /> Invert</label>
          <div className="actions">
            <button type="button" onClick={closeColorRange}>Cancel</button>
            <button type="submit" className="primary" disabled={colorRange.preset === 'sampled' && !colorRangeSamples.length}>OK</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
