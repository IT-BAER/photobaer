import { useEffect, useRef, useState, type FormEvent } from 'react';
import { client } from './client.ts';
import { Viewer, type ToolPointerEvent, type ViewerTool } from './viewer.ts';
import { createRenderer } from './render/renderer.ts';
import { makeTileSource, gpuTestHook } from './render/tiles.ts';
import { perfTestHook, type PerfProbe } from './render/perf.ts';
import { locate, nodeById } from './layers.ts';
import { LayersPanel, type Active } from './LayersPanel.tsx';
import { HistoryPanel } from './HistoryPanel.tsx';
import type { AutosaveState, DocInfo, StrokeParams } from './engine.worker.ts';
import { Smoother } from './shell/smoothing.ts';
import { ToolBar } from './shell/ToolBar.tsx';
import { OptionsBar, type ToolOptions } from './shell/OptionsBar.tsx';
import { ColorPanel } from './shell/ColorPanel.tsx';
import { SwatchesPanel } from './shell/SwatchesPanel.tsx';
import { ColorPicker, type ColorPickerHandle } from './shell/ColorPicker.tsx';
import { TOOLS, initialLastUsed, keyToTool, loadToolOptions, saveToolOptions, slotForKey } from './shell/tools.ts';
import { BrushesPanel, BrushSettingsPanel } from './shell/BrushPanels.tsx';
import { hexToRgb, type Rgb } from './shell/color.ts';
import { digitOption, dragResize, showCrosshair, stepHardness, stepSize, type DigitState } from './shell/brushKeys.ts';
import { SelectionOverlay } from './shell/SelectionOverlay.ts';
import { antsLevel, contour, marqueeRect, MagneticLasso, PolygonLasso, selectMode, snap45, type SelectMode } from './shell/selecttools.ts';
import { levelFor } from './view.ts';
import { BrushLibrary } from './brushes/store.ts';
import { EngineAssets } from './brushes/engineAssets.ts';
import { buildUpFor, presetOptions, presetStrokeParams, pushRecent, smoothingFor, type PaintTool } from './brushes/brushParams.ts';
import { parseAbrOffThread } from './brushes/abr.ts';
import type { BrushPreset, Dynamics } from './brushes/preset.ts';
import { BuildUp, inputFields, strideFor, strokeSeed, type Stride } from './brushes/strokeInput.ts';

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
type CreateResult = DocInfo & { created: number };
type SelectAfter = (d: DocInfo) => Active;
interface Item { label: string; keys?: string; run: () => void; off?: boolean }

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
  const polygonActionsRef = useRef<{ active: () => boolean; commit: () => void; cancel: () => void; removeLast: () => void } | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const magneticRef = useRef<{ lasso: MagneticLasso; handle: number | null; mode: SelectMode } | null>(null);
  // Last dab of the previous stroke per layer, so Shift+click can draw a straight line from it
  // (the engine has no last-dab accessor).
  const lastStrokePoint = useRef<Record<number, [number, number]>>({});
  const perfRef = useRef<PerfProbe | null>(null);

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

  const menus: Record<string, Item[]> = {
    File: [
      { label: 'New…', keys: 'Alt+Ctrl+N', run: () => { setMenu(null); newDialog.current?.showModal(); } },
      { label: 'Open…', keys: 'Ctrl+O', run: () => { setMenu(null); fileInput.current?.click(); } },
      { label: 'Save project…', keys: 'Ctrl+S', run: saveProject, off: !has },
      { label: 'Save as PSD…', run: savePsd, off: !has },
      { label: 'Export PNG…', run: () => exportAs('image/png', 'png'), off: !has },
      { label: 'Export JPEG…', run: () => exportAs('image/jpeg', 'jpg'), off: !has },
      { label: 'Export WebP…', run: () => exportAs('image/webp', 'webp'), off: !has },
      { label: 'Close', run: () => run(null, () => client.call('closeDoc')), off: !has },
    ],
    Edit: [
      { label: doc?.undoLabel ? `Undo ${doc.undoLabel}` : 'Undo', keys: 'Ctrl+Z', run: () => run(null, () => client.call('undo')), off: !doc?.undoLabel },
      { label: doc?.redoLabel ? `Redo ${doc.redoLabel}` : 'Redo', keys: 'Shift+Ctrl+Z', run: () => run(null, () => client.call('redo')), off: !doc?.redoLabel },
      { label: 'Fill with foreground color', keys: 'Alt+Backspace', run: () => run('Filling…', () => client.call('command', 'fill', active!.id, quickMask ? 'selection' : active!.target, [...fg, 255] as Rgba)), off: !has },
      { label: 'Clear', keys: 'Delete', run: () => active && run('Clearing…', () => client.call('clearSelected', active.id, quickMask ? 'selection' : active.target)), off: !doc?.selection || !active },
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
    ],
    Image: [
      { label: 'Invert', keys: 'Ctrl+I', run: () => run('Inverting…', () => client.call('command', 'invert', active!.id, quickMask ? 'selection' : active!.target)), off: !has },
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
    ],
    View: [
      { label: 'Zoom in', keys: 'Ctrl++', run: () => { setMenu(null); viewer.current?.zoomBy(2); }, off: !has },
      { label: 'Zoom out', keys: 'Ctrl+-', run: () => { setMenu(null); viewer.current?.zoomBy(0.5); }, off: !has },
      { label: 'Fit on screen', keys: 'Ctrl+0', run: () => { setMenu(null); viewer.current?.fit(); }, off: !has },
      { label: '100%', keys: 'Ctrl+1', run: () => { setMenu(null); viewer.current?.actualPixels(); }, off: !has },
      { label: 'Reset rotation', keys: 'Esc', run: () => { setMenu(null); viewer.current?.resetRotation(); }, off: !has },
      { label: showAnts ? 'Hide selection edges' : 'Show selection edges', keys: 'Ctrl+H', run: () => { setMenu(null); setShowAnts(v => !v); }, off: !has },
    ],
  };
  const menusRef = useRef(menus);
  menusRef.current = menus;

  useEffect(() => {
    let alive = true;
    client.onEvent = e => { if (e.event === 'autosave') setAutosave(e.state); };
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
    if (!viewer.current) return;
    if (tool !== 'eyedropper') { viewer.current.onPointer = () => {}; return; }
    viewer.current.onPointer = (e: ToolPointerEvent) => {
      if (e.type !== 'down') return;
      const size = SAMPLE_SIZES[toolOptions.sampleSize as string] ?? 1;
      const layerId = toolOptions.sample === 'current layer' ? active?.id ?? null : null;
      client.call('sample', e.x, e.y, size, layerId).then(([r, g, b]) => {
        if (e.altKey) setBg([r, g, b]); else setFg([r, g, b]);
      });
    };
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
    const find = (pred: (label: string) => boolean) => Object.values(menusRef.current).flat().find(i => pred(i.label));
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
      if (ctrl && e.altKey && k === 'n') trigger('New', e);
      else if (ctrl && k === 'o') trigger('Open', e);
      else if (ctrl && k === 's') trigger('Save project', e);
      else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) trigger('Redo', e);
      else if (ctrl && k === 'z') trigger('Undo', e);
      else if (ctrl && k === 'a') trigger('All', e);
      else if (ctrl && e.shiftKey && k === 'd') trigger('Reselect', e);
      else if (ctrl && k === 'd') trigger('Deselect', e);
      else if (ctrl && e.shiftKey && k === 'i') trigger('Inverse', e);
      else if (ctrl && k === 'i') trigger('Invert', e);
      else if (e.shiftKey && k === 'f6') trigger('Feather', e);
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
      else if (e.altKey && k === 'backspace') trigger('Fill', e);
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
  return (
    <div className="app">
      <header className="menubar">
        <span className="brand">Photobaer</span>
        {Object.entries(menus).map(([name, items]) => (
          <div key={name} className="menu">
            <button className={menu === name ? 'open' : ''} onClick={() => setMenu(menu === name ? null : name)} onMouseEnter={() => menu && setMenu(name)}>{name}</button>
            {menu === name && (
              <ul role="menu">
                {items.map(i => (
                  <li key={i.label}>
                    <button role="menuitem" disabled={i.off} onClick={i.run}><span>{i.label}</span><kbd>{i.keys}</kbd></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </header>
      {menu && <div className="scrim" onClick={() => setMenu(null)} />}
      <main className="workspace with-sidebar">
        <ToolBar
          active={tool} setActive={setTool} lastUsed={lastUsed} setLastUsed={setLastUsed}
          fg={fg} bg={bg} openPicker={openPicker} swap={swapColors} reset={resetColors}
          quickMask={quickMask} setQuickMask={setQuickMask}
        />
        <div className="stage-column">
          <OptionsBar tool={activeTool} values={toolOptions} setValues={setToolOptions} />
          <div className="stage">
            <canvas ref={canvas} />
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
          {doc && active && (
            <>
              <LayersPanel
                doc={doc} active={active} setActive={setActive} run={run}
                newLayer={newLayer} newGroup={newGroup}
                deleteLayer={deleteLayer} deleteDisabled={deleteDisabled} addMask={addMask}
              />
              <HistoryPanel history={doc.history} goto={n => run(null, () => client.call('historyGoto', n))} />
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
