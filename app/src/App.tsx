import { useEffect, useRef, useState, type FormEvent } from 'react';
import { client } from './client.ts';
import { Viewer, type ToolPointerEvent, type ViewerTool } from './viewer.ts';
import { createRenderer } from './render/renderer.ts';
import { makeTileSource, gpuTestHook } from './render/tiles.ts';
import { locate, nodeById } from './layers.ts';
import { LayersPanel, type Active } from './LayersPanel.tsx';
import { HistoryPanel } from './HistoryPanel.tsx';
import type { AutosaveState, DocInfo } from './engine.worker.ts';
import { ToolBar } from './shell/ToolBar.tsx';
import { OptionsBar, type ToolOptions } from './shell/OptionsBar.tsx';
import { ColorPanel } from './shell/ColorPanel.tsx';
import { SwatchesPanel } from './shell/SwatchesPanel.tsx';
import { ColorPicker, type ColorPickerHandle } from './shell/ColorPicker.tsx';
import { TOOLS, initialLastUsed, keyToTool, loadToolOptions, slotForKey } from './shell/tools.ts';
import { hexToRgb, type Rgb } from './shell/color.ts';
import { SelectionOverlay } from './shell/SelectionOverlay.ts';
import { antsLevel, contour, marqueeRect, MagneticLasso, PolygonLasso, selectMode, snap45, type SelectMode } from './shell/selecttools.ts';
import { levelFor } from './view.ts';

const SAMPLE_SIZES: Record<string, number> = { point: 1, '3x3': 3, '5x5': 5, '11x11': 11, '31x31': 31, '51x51': 51, '101x101': 101 };
const VIEWER_TOOL: Record<string, ViewerTool> = { hand: 'hand', rotate: 'rotate', zoom: 'zoom' };
const SELECT_TOOLS = ['marqueeRect', 'marqueeEllipse', 'marqueeRow', 'marqueeColumn', 'lasso', 'polygonalLasso', 'magneticLasso', 'quickSelection', 'magicWand'];

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
  const [optionsByTool, setOptionsByTool] = useState<Record<string, ToolOptions>>({});
  const [dockTab, setDockTab] = useState<'color' | 'swatches'>('color');
  const [showAnts, setShowAnts] = useState(true);
  const activeTool = TOOLS[tool];
  const toolOptions = optionsByTool[tool] ?? loadToolOptions(activeTool);
  const setToolOptions = (v: ToolOptions) => setOptionsByTool(o => ({ ...o, [tool]: v }));
  const [active, setActive] = useState<Active | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const toolOptionsRef = useRef(toolOptions);
  toolOptionsRef.current = toolOptions;
  const dragRef = useRef<Record<string, unknown> | null>(null);
  const polygonRef = useRef<PolygonLasso | null>(null);
  const polygonModeRef = useRef<SelectMode>('new');
  const lastPolyDownRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const polygonActionsRef = useRef<{ active: () => boolean; commit: () => void; cancel: () => void; removeLast: () => void } | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const magneticRef = useRef<{ lasso: MagneticLasso; handle: number | null; mode: SelectMode } | null>(null);

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
      await saveBlob(await client.call('savePsd'), `${d.name}.psd`, 'image/vnd.adobe.photoshop', 'psd');
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
      { label: 'Fill with foreground color', keys: 'Alt+Backspace', run: () => run('Filling…', () => client.call('command', 'fill', active!.id, active!.target, [...fg, 255] as Rgba)), off: !has },
      { label: 'Clear', keys: 'Delete', run: () => active && run('Clearing…', () => client.call('clearSelected', active.id, active.target)), off: !doc?.selection || !active },
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
      { label: 'Invert', keys: 'Ctrl+I', run: () => run('Inverting…', () => client.call('command', 'invert', active!.id, active!.target)), off: !has },
    ],
    Select: [
      { label: 'All', keys: 'Ctrl+A', run: () => run(null, () => client.call('selectCommand', 'all')), off: !has },
      { label: 'Deselect', keys: 'Ctrl+D', run: () => run(null, () => client.call('selectCommand', 'deselect')), off: !doc?.selection },
      { label: 'Reselect', keys: 'Shift+Ctrl+D', run: () => run(null, () => client.call('selectCommand', 'reselect')), off: !doc?.hasLastSelection },
      { label: 'Inverse', keys: 'Shift+Ctrl+I', run: () => run(null, () => client.call('selectCommand', 'inverse')), off: !doc?.selection },
      { label: 'Feather…', keys: 'Shift+F6', run: () => { setMenu(null); featherDialog.current?.showModal(); }, off: !doc?.selection },
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
        (window as unknown as { photobaer: unknown }).photobaer = { viewer: v, client, ...gpuTestHook(client, r) };
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

  const dpr = viewer.current?.dpr ?? (window.devicePixelRatio || 1);
  const antsLevelValue = doc ? antsLevel(levelFor(view.zoom, dpr, doc.maxLevel), doc.width, doc.height, doc.maxLevel) : 0;

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (!doc?.selection) { overlay.setAnts(null, 1); redrawOverlay(); return; }
    const docId = doc.docId;
    let alive = true;
    client.call('selectionMask', antsLevelValue).then(r => {
      if (!alive || r.docId !== docId || docRef.current?.docId !== docId) return;
      overlay.setAnts(r.data ? contour(new Uint8Array(r.data), r.w, r.h) : null, 1 << antsLevelValue);
      redrawOverlay();
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.selGen, antsLevelValue, doc?.docId]);

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
      client.call('bucket', active.id, 'pixels', e.x, e.y, [...rgb, 255], o.mode as string, Number(o.opacity) / 100, Number(o.tolerance), !!o.antiAlias, !!o.contiguous, !!o.allLayers).then(show);
    };
    return () => { v.onPointer = () => {}; };
  }, [tool, active, fg, bg]);

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
      if (e.target instanceof Element && e.target.closest('input, select, dialog')) return;
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
      else if (!ctrl && !e.altKey && !e.metaKey) selectByKey(k, e.shiftKey);
    };
    const up = (e: KeyboardEvent) => { if (e.key === ' ') viewer.current?.setSpring(null); };
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
          </div>
          {dockTab === 'color'
            ? <ColorPanel fg={fg} bg={bg} setFg={setFg} setBg={setBg} swap={swapColors} reset={resetColors} />
            : <SwatchesPanel fg={fg} setFg={setFg} setBg={setBg} />}
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
    </div>
  );
}
