import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { client } from './client.ts';
import { Viewer, type ToolPointerEvent } from './viewer.ts';
import { createRenderer } from './render/renderer.ts';
import { makeTileSource, gpuTestHook } from './render/tiles.ts';
import { perfTestHook, type PerfProbe } from './render/perf.ts';
import { flatNodes, nodeById } from './layers.ts';
import { LayersPanel, type Active } from './LayersPanel.tsx';
import { HistoryPanel } from './HistoryPanel.tsx';
import { LayerCompsPanel } from './LayerCompsPanel.tsx';
import { PathsPanel } from './PathsPanel.tsx';
import { ArtboardPanel, PropertiesPanel, ShapePanel, SmartFiltersPanel, VectorMaskPanel, type PickLookupFile } from './PropertiesPanel.tsx';
import { AdjustmentsPanel } from './AdjustmentsPanel.tsx';
import { LayerStyleDialog, type StylePage } from './LayerStyleDialog.tsx';
import { StyleLibrary, styleRefusal, type SavedStyle } from './layerStyle.ts';
import { GradientsPanel, PatternsPanel, StylesPanel, adoptPatterns } from './PresetPanels.tsx';
import type { SampleCanvas } from './LevelsCurvesBody.tsx';
import { COMMAND_LABEL, DESTRUCTIVE_LABEL, MENU_LABEL, defaultAdjustment, defaultDestructive, uiToGradientDef, type DestructiveKind, type Kind } from './adjustments.ts';
import type { Adjustment, AutosaveState, DestructiveAdjustment, DocInfo, FillContent, FillParams, GradientParams, LayerNode } from './engine.worker.ts';
import type { ContentAwareOpts, FaceInfo } from './worker/types.ts';
import { ToolBar } from './shell/ToolBar.tsx';
import { OptionsBar, type ToolOptions } from './shell/OptionsBar.tsx';
import { ColorPanel } from './shell/ColorPanel.tsx';
import { SwatchesPanel } from './shell/SwatchesPanel.tsx';
import { ColorPicker, type ColorPickerHandle } from './shell/ColorPicker.tsx';
import { TOOLS, initialLastUsed, keyToTool, loadToolOptions, saveToolOptions, slotForKey } from './shell/tools.ts';
import { BrushesPanel, BrushSettingsPanel } from './shell/BrushPanels.tsx';
import { hexToRgb, type Rgb } from './shell/color.ts';
import type { DigitState } from './shell/brushKeys.ts';
import { HANDLE_CURSORS, SelectionOverlay, boxHandles } from './shell/SelectionOverlay.ts';
import { Rulers, hitGuide, rulerDragToDoc, type DragGuide } from './shell/rulers.ts';
import { loadPreferences } from './shell/preferences.ts';
import { setGridShown, setSnapSettings, snapAxis, snapGrid, snapSettings, type AxisLock, type Rect, type SnapSettings } from './shell/snapping.ts';
import { MODES, TransformBar, TransformBarStore } from './shell/TransformBar.tsx';
import type { Mat3 } from './transform/matrix.ts';
import { setNumeric, setReferenceNormalized } from './transform/session.ts';
import { pickStyle, presetMesh, setGrid } from './transform/warp.ts';
import { antsLevel, contour, MagneticLasso, PolygonLasso, type SelectMode } from './shell/selecttools.ts';
import { levelFor } from './view.ts';
import { BrushLibrary } from './brushes/store.ts';
import { EngineAssets } from './brushes/engineAssets.ts';
import { presetOptions, presetStrokeParams, pushRecent, type PaintTool } from './brushes/brushParams.ts';
import { parseAbrOffThread } from './brushes/abr.ts';
import type { BrushPreset, Dynamics } from './brushes/preset.ts';
import { GradientEditor, type GradientEditorHandle } from './shell/GradientEditor.tsx';
import { rampCss, type Method } from './gradients/gradient.ts';
import { BUILTIN_GRADIENTS, GradientLibrary, resolvePreset, type GradientPreset } from './gradients/presets.ts';
import {
  AUTOSAVE_TEXT, FILL_KEY, FILL_LAYERS, MODIFY_OPS, SELECT_TOOLS, STROKE_DEFAULT, VIEWER_TOOL, fallbackActive,
  fillContentFromForm, formFromFillContent, loadFillForm, pickPlaceFile, saveBlob, selectAfterDelete, selectCreated,
  type FillContentForm, type FillDialogMode, type FillForm, type Item, type Rgba, type SelectAfter, type StrokeForm,
} from './app/helpers.ts';
import { buildMenus } from './app/menus.ts';
import { layerContextItems } from './app/vectorCommands.ts';
import { ShapesPanel } from './ShapesPanel.tsx';
import { CharacterPanel, ParagraphPanel, TextStylesPanel, TypeProperties, WarpTextDialog } from './TypePanels.tsx';
import { loadTypePrefs, typeContextItems, typeMenuItems, type TypeCtx, type TypePanel } from './app/typeMenu.ts';
import { shapeLibrary } from './shell/customShapes.ts';
import { transformSession, type TSession } from './app/transform.ts';
import { useBrushCursor, useBucket, useEyedropper, useGradientTool, useMoveTool, useSelectionTools, useShapeTools } from './app/toolEffects.ts';
import { usePenTools, type PathSel } from './app/penTools.ts';
import { TYPE_TOOLS, useTypeTools, type TypeApi } from './app/typeTools.ts';
import { loadFonts, loadLocalFamily, localFontsSupported, localMatches, queryLocalFonts, uploadFont, withLocal, type LocalFont } from './fonts/sources.ts';
import { MissingFontsDialog, type FontDialog } from './MissingFonts.tsx';
import { GlyphsPanel } from './GlyphsPanel.tsx';
import type { TextJson } from './psd/text.ts';
import { fontUses, missingRows } from './shell/typecommands.ts';
import { useCropTool, usePerspectiveCropTool } from './app/cropTools.ts';
import { usePaintTool } from './app/paintTool.ts';
import { useCloneOverlay, useRetouchTools } from './app/retouchTools.ts';
import { CloneSourcePanel } from './CloneSourcePanel.tsx';
import { useShortcuts } from './app/shortcuts.ts';
import { FilterDialog, runFilter, type FilterDialogHandle } from './filters/FilterDialog.tsx';
import { repeatLastFilter } from './filters/lastFilter.ts';
import { schema, setSchema, type FilterSpec } from './filters/schema.ts';
import {
  AdjustDialog, ColorRangeDialog, ContentAwareFillDialog, FeatherDialog, FillContentDialog, FillDialog, FilterBlendDialog, GlobalLightDialog,
  LoadSelectionDialog, ModifyDialog, ArtboardDialog, NewGuideDialog, NewGuideLayoutDialog, NewImageDialog, AboutDialog, DonateDialog, type ArtboardMode, RotateDialog, SaveSelectionDialog,
  ScaleEffectsDialog, StrokeDialog, TrimDialog,
} from './app/Dialogs.tsx';

// Set by vite.config.ts from CHANGELOG.md.
declare const __APP_VERSION__: string;
// The SEO title from index.html, shown while no document is open.
const PAGE_TITLE = document.title;

// Menus are fixed so the scrolling menubar does not clip them; both stay inside the viewport.
function placeMenu(ul: HTMLUListElement | null) {
  if (!ul) return;
  const r = ul.parentElement!.getBoundingClientRect();
  ul.style.left = `${Math.max(0, Math.min(r.left, innerWidth - ul.offsetWidth))}px`;
  ul.style.top = `${r.bottom + 2}px`;
  ul.style.maxHeight = `${innerHeight - r.bottom - 6}px`;
}

function placeSubmenu(li: HTMLElement) {
  const ul = li.querySelector<HTMLElement>(':scope > ul');
  if (!ul) return;
  const r = li.getBoundingClientRect(), w = ul.offsetWidth;
  ul.style.left = `${r.right + 2 + w <= innerWidth ? r.right + 2 : Math.max(0, r.left - 2 - w)}px`;
  ul.style.top = `${Math.max(4, Math.min(r.top - 5, innerHeight - 4 - ul.offsetHeight))}px`;
}

export function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<SelectionOverlay | null>(null);
  // Registered font faces (bundled, uploaded, local) for the type tools' family and style pickers.
  const [faces, setFaces] = useState<FaceInfo[]>([]);
  // System fonts (Local Font Access): listed in the pickers, loaded into the registry when a name needs them.
  const [localFonts, setLocalFonts] = useState<LocalFont[]>([]);
  const localRef = useRef(localFonts);
  localRef.current = localFonts;
  const pickFaces = useMemo(() => withLocal(faces, localFonts), [faces, localFonts]);
  const [fontDialog, setFontDialog] = useState<FontDialog | null>(null);
  const fontInput = useRef<HTMLInputElement>(null);
  // Documents already checked for missing fonts (the Resolve dialog opens once per document).
  const fontChecked = useRef(new Set<number>());
  const rulerTop = useRef<HTMLCanvasElement>(null);
  const rulerLeft = useRef<HTMLCanvasElement>(null);
  const pixelGridCanvas = useRef<HTMLCanvasElement>(null);
  const rulersRef = useRef<Rulers | null>(null);
  const prefs = useRef(loadPreferences());
  const dragGuideRef = useRef<DragGuide | null>(null);
  const newGuideDialog = useRef<HTMLDialogElement>(null);
  const artboardDialog = useRef<HTMLDialogElement>(null);
  const [artboardMode, setArtboardMode] = useState<ArtboardMode>('new');
  const newGuideLayoutDialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const newDialog = useRef<HTMLDialogElement>(null);
  const aboutDialog = useRef<HTMLDialogElement>(null);
  const donateDialog = useRef<HTMLDialogElement>(null);
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
  const [dragOver, setDragOver] = useState(false);
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
  const [showRulers, setShowRulers] = useState(false);
  const [showPixelGrid, setShowPixelGrid] = useState(false);
  const [showGuides, setShowGuides] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  setGridShown(showGrid);
  const [snap, setSnapState] = useState(snapSettings);
  const setSnap = (patch: Partial<SnapSettings>) => { setSnapSettings(patch); setSnapState(snapSettings()); };
  // Mirrors the ruler/guide/grid toggles for the mount-frozen guide-drag closures below (docRef pattern).
  const rulerFlagsRef = useRef({ showRulers, showPixelGrid, showGuides, showGrid });
  rulerFlagsRef.current = { showRulers, showPixelGrid, showGuides, showGrid };
  const [showLayerComps, setShowLayerComps] = useState(false);
  const [showPaths, setShowPaths] = useState(false);
  const [pathSel, setPathSel] = useState<PathSel>({ selected: null, cleared: false });
  const pathSelRef = useRef(pathSel);
  pathSelRef.current = pathSel;
  const [showProperties, setShowProperties] = useState(false);
  const [showAdjustments, setShowAdjustments] = useState(false);
  const [showStyles, setShowStyles] = useState(false);
  const [showPatterns, setShowPatterns] = useState(false);
  const [showGradients, setShowGradients] = useState(false);
  const [showShapes, setShowShapes] = useState(false);
  const [showCloneSource, setShowCloneSource] = useState(false);
  const [typePanels, setTypePanels] = useState<Record<TypePanel, boolean>>({ character: false, paragraph: false, characterStyles: false, paragraphStyles: false, glyphs: false });
  const [typePrefs, setTypePrefs] = useState(loadTypePrefs);
  // Changes with the type session and its selection, so the type panels re-read it.
  const [, setTypeSel] = useState('');
  const typeRef = useRef<TypeApi | null>(null);
  const warpDialog = useRef<HTMLDialogElement>(null);
  const styleLib = useRef<StyleLibrary | null>(null);
  styleLib.current ??= new StyleLibrary();
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
  // Layers picked with Ctrl/Shift+click; the pick counts only while it includes the active layer.
  const [picked, setPicked] = useState<number[]>([]);
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
  const contentAwareDialog = useRef<HTMLDialogElement>(null);
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
  // The Filter menu's generic dialog (also Edit > Fade) and Layer > Smart Filter > Blending Options.
  const filterDialog = useRef<FilterDialogHandle>(null);
  const [filterSpecs, setFilterSpecs] = useState<FilterSpec[]>(schema);
  const filterBlendDialog = useRef<HTMLDialogElement>(null);
  const [filterBlend, setFilterBlend] = useState<{ id: number; fid: number; blend: string; opacity: number } | null>(null);
  const gradLib = useRef<GradientLibrary | null>(null);
  gradLib.current ??= new GradientLibrary();

  function redrawOverlay() {
    const v = viewer.current;
    if (!v) return;
    const [w, h] = v.size;
    overlayRef.current?.draw(v.view, w, h, v.dpr);
  }

  function redrawRulers() {
    const v = viewer.current, d = docRef.current;
    if (!v || !d) return;
    const { showRulers, showPixelGrid, showGuides, showGrid } = rulerFlagsRef.current;
    const [w, h] = v.size;
    rulersRef.current?.setUnit(prefs.current.rulerUnit);
    rulersRef.current?.setResolution(d.resolution);
    rulersRef.current?.setShowRulers(showRulers);
    rulersRef.current?.setShowPixelGrid(showPixelGrid);
    rulersRef.current?.setShowGuides(showGuides);
    rulersRef.current?.setGuideColor(prefs.current.guideColor);
    rulersRef.current?.setGuides(d.guides);
    rulersRef.current?.setDragGuide(dragGuideRef.current);
    rulersRef.current?.setShowGrid(showGrid);
    rulersRef.current?.setGridColor(prefs.current.gridColor);
    rulersRef.current?.setGrid(d.grid.spacing_x, d.grid.spacing_y, prefs.current.subdivisions);
    rulersRef.current?.draw(v.view, w, h, v.dpr, d.width, d.height);
  }

  // A guide grab (docs/M4.md section 12): hit-test on pointerdown, then a modal drag session that
  // previews the live position and commits (move/add) or deletes (dropped back onto its ruler) on release.
  function guideHit(sx: number, sy: number): boolean {
    const v = viewer.current, d = docRef.current;
    if (!v || !d || d.guidesLocked) return false;
    const [w, h] = v.size;
    const id = hitGuide(d.guides, v.view, sx, sy, w, h);
    if (id === null) return false;
    const guide = d.guides.find(g => g.id === id);
    if (!guide) return false;
    v.intercept = e => {
      if (e.type === 'up' || e.type === 'cancel') {
        v.intercept = null;
        const drag = dragGuideRef.current;
        dragGuideRef.current = null;
        if (e.type === 'up' && drag) {
          const [dsx] = v.docToScreen(e.x, e.y);
          const [, dsy] = v.docToScreen(e.x, e.y);
          const dropped = drag.axis === 'x' ? dsx < 0 : dsy < 0;
          if (dropped) run(null, () => client.call('deleteGuide', guide.id));
          else run(null, () => client.call('moveGuide', guide.id, drag.pos));
        } else {
          redrawRulers();
        }
        return;
      }
      dragGuideRef.current = { id: guide.id, axis: guide.axis, pos: guide.axis === 'x' ? e.x : e.y };
      redrawRulers();
    };
    return true;
  }

  // Ruler drag creates a new guide (docs/M4.md section 12); Alt swaps the ruler's default axis.
  function rulerGuideStart(defaultAxis: 'x' | 'y') {
    return (down: Event) => {
      const e = down as PointerEvent;
      const v = viewer.current, c = canvas.current;
      if (!v || !c || !docRef.current) return;
      const el = e.currentTarget as Element;
      el.setPointerCapture(e.pointerId);
      const axis = e.altKey ? (defaultAxis === 'x' ? 'y' : 'x') : defaultAxis;
      // The new guide snaps to the snap targets on its axis once they arrive.
      let targets: number[] = [], lock: AxisLock | null = null;
      const grid = snapGrid(docRef.current.grid)[axis === 'x' ? 0 : 1];
      if (snapSettings().enabled) client.call('snapTargets', -1, snapSettings()).then(t => { targets = axis === 'x' ? t.x : t.y; }, () => {});
      const track = (raw: Event) => {
        const ev = raw as PointerEvent;
        const r = c.getBoundingClientRect();
        const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
        const [w, h] = v.size;
        const pos = Math.round(rulerDragToDoc(v.view, axis, axis === 'x' ? sx : sy, w, h));
        lock = snapAxis([0], targets, pos, lock, 6 / v.view.zoom, 10 / v.view.zoom, grid);
        dragGuideRef.current = { id: -1, axis, pos: lock ? lock.target : pos };
        redrawRulers();
      };
      const up = (raw: Event) => {
        track(raw);
        const drag = dragGuideRef.current;
        dragGuideRef.current = null;
        el.removeEventListener('pointermove', track);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', cancel);
        if (drag) run(null, () => client.call('addGuide', drag.axis, drag.pos, 0));
        else redrawRulers();
      };
      const cancel = () => {
        dragGuideRef.current = null;
        el.removeEventListener('pointermove', track);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', cancel);
        redrawRulers();
      };
      track(down);
      el.addEventListener('pointermove', track);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', cancel);
    };
  }

  function show(d: DocInfo | null, selectAfter?: SelectAfter) {
    setDoc(d);
    viewer.current?.setDoc(d);
    document.title = d ? `${d.name} - photobaer` : PAGE_TITLE;
    if (!d) { setActive(null); return; }
    // Node ids restart per document: a previous document's active layer never carries over.
    const sameDoc = d.docId === docRef.current?.docId;
    docRef.current = d;
    setActive(prev => selectAfter ? selectAfter(d) : sameDoc && prev && nodeById(d.layers, prev.id) ? prev : fallbackActive(d));
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

  // Edit Contents write-back: PSD export warnings (settings the source cannot store) need a confirm;
  // a close that cannot write back offers to close without saving.
  const lost = (warnings: string[]) => `The source file cannot store:\n- ${warnings.join('\n- ')}`;
  async function editContents(id: number) {
    await run('Opening contents…', async () => {
      const d = await client.call('editContents', id);
      if (d.warnings.length) setError(`Opened with warnings: ${d.warnings.join('; ')}`);
      return d;
    });
  }
  async function saveContents() {
    await run('Saving contents…', async () => {
      const d = await client.call('smartEditSave');
      return d.written || !confirm(`${lost(d.warnings)}\n\nWrite the contents back anyway?`) ? d : client.call('smartEditSave', true);
    });
  }
  async function closeContents() {
    await run('Closing contents…', async () => {
      let d = await client.call('smartEditClose');
      if (!d.closed && !d.error && confirm(`${lost(d.warnings)}\n\nWrite the contents back anyway?`)) d = await client.call('smartEditClose', 'accept');
      if (!d.closed && confirm(`${d.error ?? 'The contents were not written back.'}\n\nClose without saving the contents?`)) d = await client.call('smartEditClose', 'discard');
      return d;
    });
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
    const adopt = () => (doc ? adoptPatterns(doc, brushLib.current?.library ?? null, content) : Promise.resolve(null));
    if (fillContentMode.kind === 'create') {
      const { type } = fillContentMode;
      run(null, () => adopt().then(() => client.call('newFillLayer', active.id, content, FILL_LAYERS[type].name, FILL_LAYERS[type].label)), selectCreated);
    } else {
      const { id } = fillContentMode;
      run(null, () => adopt().then(() => client.call('setFillContent', [id], content)));
    }
  }

  // Patterns and Gradients panels: a double click adds a fill layer above the active one.
  function panelFillLayer(content: FillContent) {
    if (!active) return;
    const { name } = FILL_LAYERS[content.type];
    const adopt = () => (doc ? adoptPatterns(doc, brushLib.current?.library ?? null, content) : Promise.resolve(null));
    run(null, () => adopt().then(() => client.call('newFillLayer', active.id, content, name, name)), selectCreated);
  }

  function gradientFillLayer(p: GradientPreset) {
    const o = gradOptions;
    panelFillLayer({
      type: 'gradient', gradient: uiToGradientDef(resolvePreset(p, fg, bg)), style: o.style as GradientParams['style'], angle: 90, scale: 1,
      reverse: !!o.reverse, dither: !!o.dither, align_with_layer: true, offset: [0, 0],
    });
  }

  // Styles panel: a saved style (effects and blending) replaces the active layer's as one "Layer Style" step.
  function applySavedStyle(saved: SavedStyle) {
    if (!doc || !node) return;
    const why = styleRefusal(node);
    if (why) { setError(why); return; }
    const { id, fill } = node;
    run(null, () => adoptPatterns(doc, brushLib.current?.library ?? null, saved.style).then(() => client.call('setLayerStyle', id, saved.style, saved.blending, fill, null)));
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

  // Edit > Content-Aware Fill, Delete and Fill Selection and the Fill dialog's Content-Aware contents.
  function contentAwareRefusal(): string | null {
    if (active?.target === 'mask') return 'Select the layer pixels to use Content-Aware Fill.';
    return doc?.selection?.bounds ? null : 'Select the area to fill.';
  }

  function contentAwareCall(id: number, structure: number, color: number, opts: ContentAwareOpts | null, deselect: boolean, label: string) {
    return client.call('contentAwareFill', id, structure, color, opts, deselect, label);
  }

  function contentAwareFill(dialog: boolean) {
    setMenu(null);
    if (!active) return;
    const why = contentAwareRefusal();
    if (why) { setError(why); return; }
    if (dialog) { contentAwareDialog.current?.showModal(); return; }
    const id = active.id;
    run('Filling…', () => contentAwareCall(id, 4, 5, null, true, 'Delete and Fill Selection'));
  }

  async function fillParams(f: FillForm): Promise<FillParams> {
    const base = { mode: f.mode, opacity: f.opacity / 100, preserveTransparency: f.preserve };
    if (f.contents === 'history') return { source: 'history', ...base };
    if (f.contents === 'contentAware') throw new Error('Content-Aware Fill has no fill source.');
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
    let then: (() => Promise<DocInfo>) | null = null;
    if (previewDialog === 'fill') {
      const { contents, color, pattern, caStructure, caColor } = fillForm;
      try { localStorage.setItem(FILL_KEY, JSON.stringify({ contents, color, pattern, caStructure, caColor })); } catch { /* session-only */ }
      if (st.commit && contents === 'contentAware' && active) {
        const why = contentAwareRefusal();
        const id = active.id, opts = { mode: fillForm.mode, opacity: fillForm.opacity / 100, preserveTransparency: fillForm.preserve };
        then = () => (why ? Promise.reject(new Error(why)) : contentAwareCall(id, caStructure, caColor, opts, false, 'Content-Aware Fill'));
      }
    }
    setPreviewDialog(null);
    run(null, () => st.pending.catch(() => {}).then(() => client.call('previewEnd', st.commit)).then(d => (then ? then() : d)));
  }

  // Filter menu commands (docs/M5.md section 2) on the active target; a smart object appends a smart filter.
  function openFilter(spec: FilterSpec) {
    setMenu(null);
    if (!active) return;
    if (transformRef.current) endTransform(false);
    runFilter(spec, active.id, editTarget(active), filterDialog.current, d => show(d)).catch(e => setError((e as Error).message));
  }

  function lastFilter() {
    setMenu(null);
    if (!active) return;
    const a = active;
    if (transformRef.current) endTransform(false);
    repeatLastFilter(f => client.call('applyFilter', a.id, editTarget(a), { kind: f.kind, params: f.params }, f.label).then(d => show(d)), m => setError(m))
      .catch(e => setError((e as Error).message));
  }

  function openFade() {
    setMenu(null);
    if (active && doc?.undoLabel) filterDialog.current?.open({ type: 'fade', id: active.id, step: doc.undoLabel });
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
    run(null, () => client.call('newFillLayer', active.id, content, FILL_LAYERS[type].name, FILL_LAYERS[type].label), selectCreated);
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
  const selectedNodes = doc && active
    ? (picked.includes(active.id) ? picked : [active.id]).map(id => nodeById(doc.layers, id)).filter((n): n is LayerNode => !!n)
    : [];
  // The artboard the active layer is (or is inside); artboards are always top level.
  const activeArtboard = (doc && active && doc.layers.find(n => n.artboard && (n.id === active.id || nodeById(n.children ?? [], active.id)))) || null;
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
  // ---------- smart filters (docs/M3.md section 7) ----------
  const filters = smart?.filters ?? [];
  const filterMasks = !!smart?.stack_mask || filters.some(f => f.mask);
  const masksOn = !!smart?.stack_mask?.enabled || filters.some(f => f.mask?.enabled);
  const toggleLabel = filters.some(f => f.enabled) ? 'Disable Smart Filters' : 'Enable Smart Filters';
  const maskLabel = masksOn ? 'Disable Filter Mask' : 'Enable Filter Mask';
  const filterCommand = (op: 'toggle' | 'clear' | 'deleteMasks' | 'toggleMasks', label: string) =>
    () => node && run(null, () => client.call('smartFilterCommand', node.id, op, label));
  function openFilterBlend() {
    setMenu(null);
    const top = filters.at(-1);
    if (!node || !top) return;
    setFilterBlend({ id: node.id, fid: top.id, blend: top.blend, opacity: Math.round(top.opacity * 100) });
    filterBlendDialog.current?.showModal();
  }
  const styled = doc ? flatNodes(doc.layers).filter(n => n.style) : [];
  const anyStyled = styled.length > 0;
  const allEffectsHidden = anyStyled && styled.every(n => !n.style!.enabled);
  // Destructive adjustments need a pixel layer's pixels as the target.
  const pixelsOff = node?.kind !== 'pixel' || active?.target !== 'pixels' || quickMask;
  // The 16 layer kinds also run on a smart object, where they add a smart filter.
  const hostOff = pixelsOff && !(node?.kind === 'smart' && active?.target === 'pixels' && !quickMask);

  const {
    transformChange, warpChange, warpBar, withTransform, transformCommand, setTransformMode, endTransform, closeTransform, transformKey,
    warpMenuSplit, transformMode, transformRemap, transformAgain, startTransform,
  } = transformSession({
    overlayRef, perfRef, transformRef, show, setError, viewer, setMenu, activeRef, run, againRef, docRef, canvas, setTransformMenu,
    setTransformStore, redrawOverlay,
  });
  const docTexts = (): [number, TextJson][] =>
    flatNodes(docRef.current?.layers ?? []).flatMap(n => (n.kind === 'text' && n.text ? [[n.id, n.text] as [number, TextJson]] : []));
  // Missing (family, style) rows over the whole document or the given layers.
  async function missingFonts(layerIds?: number[]) {
    const texts = docTexts().filter(([id]) => !layerIds || layerIds.includes(id));
    const pairs = [...new Map(texts.flatMap(([, t]) => fontUses(t)).map(p => [p.join('\0'), p])).values()];
    if (!pairs.length) return [];
    await ensureFamilies(pairs.map(p => p[0]));
    return missingRows(texts, await client.call('fontMissing', pairs));
  }
  // Loads the system faces the names ask for (family or PostScript name) before an edit uses them.
  async function ensureFamilies(names: string[]) {
    const fams = [...new Set(localMatches(localRef.current, await client.call('fontFaces'), names).map(f => f.family))];
    if (!fams.length) return;
    for (const f of fams) await loadLocalFamily(client, localRef.current, f);
    setFaces(await client.call('fontFaces'));
  }
  async function loadSystemFonts() {
    setMenu(null);
    try { setLocalFonts(await queryLocalFonts()); } catch (e) { setError(`System fonts are not available: ${(e as Error).message}`); }
  }
  async function openFontDialog(kind: 'resolve' | 'replace') {
    setMenu(null);
    const rows = await missingFonts();
    if (!rows.length) { setError('Every font this document uses is installed.'); return; }
    setFontDialog({ kind, rows });
  }
  const typeCtx: TypeCtx = {
    typeRef, selected: selectedNodes, anyText: !!doc && flatNodes(doc.layers).some(n => n.kind === 'text'), run, setError,
    openWarp: () => { setMenu(null); warpDialog.current?.querySelector('form')?.reset(); warpDialog.current?.showModal(); },
    prefs: typePrefs, setPrefs: setTypePrefs, panels: typePanels, togglePanel: k => { setMenu(null); setTypePanels(v => ({ ...v, [k]: !v[k] })); },
    fontDialog: k => void openFontDialog(k),
    ensureFamilies, loadSystemFonts: localFontsSupported() ? () => void loadSystemFonts() : null,
  };
  const typeTool = TYPE_TOOLS.includes(tool) ? tool : 'horizontalType';
  const menus = buildMenus({
    setMenu, newDialog, aboutDialog, fileInput, placeFile, has, active, saveProject, savePsd, exportAs, exportLayerComps, doc, closeContents, run,
    openPreviewDialog, contentAwareFill, quickFill, fg, bg, quickMask, startTransform, transformAgain, transformStore, transformMode, warping, warpMenuSplit,
    transformRemap, newLayer, newGroup, duplicateLayer, deleteLayer, deleteDisabled, groupLayers, ungroupLayers, node, toggleClipping, addMask,
    deleteMask, toggleMaskEnabled, openNewFillLayer, newAdjustmentLayer, openLayerContentOptions, smart, editContents, replaceContents,
    exportContents, convertToLinked, anyLinked, toggleLabel, filterCommand, filters, filterMasks, maskLabel, openFilterBlend, openLayerStyle,
    globalLightDialog, allEffectsHidden, anyStyled, scaleEffectsDialog, openAdjust, hostOff, pixelsOff, applyDestructive, rotateDialog, trimDialog,
    openColorRange, openModify, featherDialog, growOrSimilar, setQuickMask, loadSelDialog, saveSelDialog, viewer, showAnts, setShowAnts,
    showAdjustments, setShowAdjustments, showLayerComps, setShowLayerComps, showPaths, setShowPaths, showProperties, setShowProperties, showStyles, setShowStyles,
    showPatterns, setShowPatterns, showGradients, setShowGradients, showRulers, setShowRulers, showPixelGrid, setShowPixelGrid,
    showGuides, setShowGuides, showGrid, setShowGrid, newGuideDialog, newGuideLayoutDialog, snap, setSnap, filterSpecs, openFilter, lastFilter, openFade,
    openArtboard: mode => { setMenu(null); setArtboardMode(mode); artboardDialog.current?.showModal(); }, activeArtboard,
    selectedNodes, showShapes, setShowShapes, showCloneSource, setShowCloneSource, typeItems: typeMenuItems(typeCtx),
  });
  const menusRef = useRef(menus);
  menusRef.current = menus;

  useEffect(() => {
    let alive = true;
    client.onEvent = e => {
      if (e.event === 'autosave') setAutosave(e.state);
      else if (e.event === 'transformCancelled' && closeTransform()) show(e.doc);
      else if (e.event === 'typeCommitted') { if (typeRef.current) typeRef.current.ended(e.doc); else show(e.doc); }
    };
    (async () => {
      try {
        const r = await createRenderer(canvas.current!, new URLSearchParams(location.search).get('renderer'));
        if (!alive) return;
        setRenderer(r.kind === 'webgpu' ? 'WebGPU' : 'WebGL2');
        const v = new Viewer(canvas.current!, r, makeTileSource(client, r));
        overlayRef.current = new SelectionOverlay(overlayCanvas.current!);
        rulersRef.current = new Rulers(rulerTop.current!, rulerLeft.current!, pixelGridCanvas.current!);
        v.onView = x => { setView({ zoom: x.zoom * v.dpr, rot: x.rot }); redrawOverlay(); redrawRulers(); };
        v.guideHit = guideHit;
        rulerTop.current?.addEventListener('pointerdown', rulerGuideStart('y'));
        rulerLeft.current?.addEventListener('pointerdown', rulerGuideStart('x'));
        viewer.current = v;
        perfRef.current = perfTestHook(v);
        (window as unknown as { photobaer: unknown }).photobaer = { viewer: v, client, ...gpuTestHook(client, r), ...(perfRef.current ? { perf: perfRef.current } : {}) };
        show(await client.call('init'));
        client.call('filterSchema').then(f => { setSchema(f as FilterSpec[]); setFilterSpecs(f as FilterSpec[]); }, err => setError((err as Error).message));
        loadFonts(client).then(f => { if (alive) setFaces(f); }, err => setError((err as Error).message));
        // A granted permission lists system fonts without a click; otherwise Type > Load System Fonts asks.
        if (localFontsSupported()) navigator.permissions?.query({ name: 'local-fonts' as PermissionName })
          .then(p => (p.state === 'granted' ? queryLocalFonts() : []))
          .then(l => { if (alive && l.length) setLocalFonts(l); }, () => {});
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

  useEyedropper({
    viewer, tool, toolOptions, active, setBg, setFg,
  });

  useEffect(() => {
    if (!canvas.current) return;
    const ro = new ResizeObserver(() => { redrawOverlay(); redrawRulers(); });
    ro.observe(canvas.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => { overlayRef.current?.setHidden(!showAnts); redrawOverlay(); }, [showAnts]);
  useEffect(redrawRulers, [showRulers, showPixelGrid, showGuides, showGrid, doc]);

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
    if ((previewDialog !== 'fill' && previewDialog !== 'stroke') || !active || !st.open) return;
    const a = active;
    st.pending = (async () => {
      // Content-Aware has no live preview: the fill runs on OK.
      if (previewDialog === 'fill' && fillForm.contents === 'contentAware') { show(await client.call('previewEnd', false)); return; }
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

  useSelectionTools({
    viewer, dragRef, polygonRef, lastPolyDownRef, overlayRef, magneticRef, tool, polygonActionsRef, toolOptionsRef, polygonModeRef, show, docRef,
    activeRef, doc,
  });

  useBucket({
    viewer, tool, active, setFg, toolOptionsRef, bg, fg, quickMask, show,
  });

  const toolRef = useRef(tool);
  toolRef.current = tool;
  const lastUsedRef = useRef(lastUsed);
  lastUsedRef.current = lastUsed;
  const fgRef = useRef(fg);
  fgRef.current = fg;
  const bgRef = useRef(bg);
  bgRef.current = bg;

  useGradientTool({
    viewer, tool, active, overlayRef, toolOptionsRef, gradLib, fgRef, bgRef, run, editTarget, quickMask,
  });
  useShapeTools({ viewer, tool, active, overlayRef, toolOptionsRef, fgRef, run, docRef });
  const penKeysRef = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  const penRedrawRef = useRef<(() => void) | null>(null);
  usePenTools({
    viewer, canvas, tool, doc, docRef, activeRef, overlayRef, redrawOverlay, toolOptionsRef, fgRef, bgRef, run, pathSelRef,
    selectPath: id => setPathSel({ selected: id, cleared: false }), setError, penKeysRef, redrawRef: penRedrawRef,
  });
  useEffect(() => { penRedrawRef.current?.(); }, [doc?.version, active?.id, pathSel]);
  const typeKeysRef = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  const [typeEditing, setTypeEditing] = useState(false);
  useTypeTools({
    viewer, tool, doc, docRef, activeRef, overlayRef, redrawOverlay, toolOptions, toolOptionsRef, fgRef, show, setError, typeKeysRef, typeRef,
    setEditing: setTypeEditing, setTypeSel,
    missingGate: async (id, resume) => {
      const rows = await missingFonts([id]);
      if (rows.length) setFontDialog({ kind: 'layer', id, rows, resume });
      return rows.length > 0;
    },
  });

  // A document with missing fonts opens Resolve Missing Fonts once, after the fonts are registered.
  useEffect(() => {
    if (!doc || !faces.length || fontChecked.current.has(doc.docId)) return;
    fontChecked.current.add(doc.docId);
    const id = doc.docId;
    missingFonts().then(rows => { if (rows.length && docRef.current?.docId === id) setFontDialog(f => f ?? { kind: 'resolve', rows }); }, () => {});
  }, [doc?.docId, faces.length]);

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
  useCropTool({
    viewer, canvas, tool, doc, docRef, cropOptionsRef, overlayRef, redrawOverlay, run, setOptionsOf, transformRef, cropSession, toolRef,
  });
  // A canvas size change (undo, redo, Image menu) drops a pending box or quad: its doc coords are stale.
  const cropCanvasSize = useRef('');
  useEffect(() => {
    const size = `${doc?.width}x${doc?.height}`, changed = cropCanvasSize.current !== '' && cropCanvasSize.current !== size;
    cropCanvasSize.current = size;
    if (changed) cropSession.current?.cancel(); else cropSession.current?.draw();
  }, [doc?.width, doc?.height, cropOptions.overlay]);

  usePerspectiveCropTool({
    viewer, tool, doc, docRef, overlayRef, redrawOverlay, perspOptionsRef, run, setOptionsOf, cropSession, toolRef,
  });

  const moveKeysRef = useRef<{ nudge: (dx: number, dy: number, alt: boolean) => void } | null>(null);
  useMoveTool({
    viewer, tool, docRef, activeRef, toolOptionsRef, setActive, setError, show, overlayRef, redrawOverlay, run, moveKeysRef, doc,
  });

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

  usePaintTool({
    viewer, tool, toolOptionsRef, currentPreset, selectedPresetRef, brushLib, bgRef, fgRef, active, docRef, strokeCounter, quickMask, perfRef,
    setError, lastStrokePoint, run,
  });

  const retouch = { viewer, canvas, overlayRef, redrawOverlay, tool, active, docRef, toolOptionsRef, run, setError };
  useRetouchTools(retouch);
  useCloneOverlay(retouch);

  useBrushCursor({
    viewer, canvas, overlayRef, tool, redrawOverlay, toolOptionsRef, capsLockRef, patchToolOptions,
  });

  function openPicker(which: 'fg' | 'bg') {
    picker.current?.open(which === 'fg' ? fg : bg, which === 'fg' ? 'Foreground Color' : 'Background Color', v => (which === 'fg' ? setFg : setBg)(v));
  }
  const swapColors = () => { setFg(bg); setBg(fg); };
  const resetColors = () => { setFg([0, 0, 0]); setBg([255, 255, 255]); };

  function selectByKey(key: string, shift: boolean): boolean {
    const id = keyToTool(key, shift, toolRef.current, lastUsedRef.current);
    if (!id) return false;
    const slot = slotForKey(key)!;
    setLastUsed(u => ({ ...u, [slot.id]: id }));
    setTool(id);
    return true;
  }

  useShortcuts({
    menusRef, capsLockRef, polygonActionsRef, transformKey, cropSession, setDockTab, setMenu, viewer, setFg, setBg, bgRef, fgRef, setQuickMask,
    toolRef, toolOptionsRef, patchToolOptions, flowDigitRef, opacityDigitRef, moveKeysRef, selectByKey, open, penKeysRef, typeKeysRef,
  });

  // Brush presets: the selected preset (with a protected texture carried over) and the Brushes/Brush Settings panels.
  function currentPreset(id: string | null): BrushPreset | null {
    const lib = brushLib.current;
    const p = id !== null && lib ? lib.library.list().find(x => x.id === id) ?? null : null;
    const tex = protectedTexture.current;
    return p && tex && p.dynamics.texture.enabled ? { ...p, dynamics: { ...p.dynamics, texture: tex } } : p;
  }
  const brushTarget = (['brush', 'pencil', 'eraser'].includes(tool) ? tool : 'brush') as PaintTool;
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
  const patternSelect = (
    <select aria-label="Pattern" value={String(toolOptions.pattern ?? '')} onChange={e => setToolOptions({ ...toolOptions, pattern: e.currentTarget.value })}>
      {(brushLib.current?.library.patterns() ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
  const gradientButton = (
    <button type="button" className="gradient-ramp-button" aria-label="Edit gradient" title="Click to edit the gradient"
      style={{ backgroundImage: `${rampCss(gradPreset, gradOptions.method as Method)}, var(--checker)` }} onClick={editGradient} />
  );
  // Shapes panel click: the Custom Shape tool with that shape.
  const armShape = (id: string) => {
    patchToolOptions('customShape', { customShape: id });
    setLastUsed(u => ({ ...u, shape: 'customShape' }));
    setTool('customShape');
  };
  const shapeChoices = shapeLibrary().list();
  const customShapeSelect = (
    <label>Shape <select aria-label="Shape" value={String(toolOptions.customShape || shapeChoices[0]?.id)}
      onChange={e => setToolOptions({ ...toolOptions, customShape: e.currentTarget.value })}>
      {shapeChoices.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select></label>
  );
  const families = [...new Set(pickFaces.map(f => f.family))].sort();
  const typeFont = (
    <span className="type-font">
      <select aria-label="Font family" value={String(toolOptions.family)} onChange={e => {
        const family = e.currentTarget.value, styles = pickFaces.filter(f => f.family === family).map(f => f.style);
        setToolOptions({ ...toolOptions, family, style: styles.includes(String(toolOptions.style)) ? toolOptions.style : styles[0] ?? 'Regular' });
        void ensureFamilies([family]);
      }}>
        {!families.includes(String(toolOptions.family)) && <option value={String(toolOptions.family)}>{String(toolOptions.family)}</option>}
        {families.map(f => <option key={f} value={f}>{f}</option>)}
      </select>
    </span>
  );
  const typeStyles = pickFaces.filter(f => f.family === toolOptions.family).map(f => f.style);
  const typeStyle = (
    <select aria-label="Font style" value={String(toolOptions.style)} onChange={e => setToolOptions({ ...toolOptions, style: e.currentTarget.value })}>
      {!typeStyles.includes(String(toolOptions.style)) && <option value={String(toolOptions.style)}>{String(toolOptions.style)}</option>}
      {typeStyles.map(st => <option key={st} value={st}>{st}</option>)}
    </select>
  );
  const typeActions = typeEditing && (
    <span className="crop-actions">
      <button type="button" aria-label="Cancel type edit" onClick={() => typeRef.current?.cancel()}>Cancel</button>
      <button type="button" className="primary" aria-label="Commit type edit" onClick={() => typeRef.current?.commit()}>Commit</button>
    </span>
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
      <li className={i.sub ? 'has-sub' : undefined} onMouseEnter={i.sub ? e => placeSubmenu(e.currentTarget) : undefined} onFocus={i.sub ? e => placeSubmenu(e.currentTarget) : undefined}>
        <button role="menuitem" aria-haspopup={i.sub ? 'menu' : undefined} disabled={i.off} onClick={() => { if (!i.sub) setMenu(null); i.run(); }}><span>{i.label}</span><kbd>{i.keys}</kbd></button>
        {i.sub && !i.off && <ul role="menu" aria-label={i.label}>{menuItems(i.sub)}</ul>}
      </li>
    </Fragment>
  ));
  return (
    <div className="app">
      <header className="menubar">
        <img className="brand" src="./logo-light.png" alt="photobaer" width={24} height={24} />
        {Object.entries(menus).map(([name, items]) => (
          <div key={name} className="menu">
            <button className={menu === name ? 'open' : ''} onClick={() => setMenu(menu === name ? null : name)} onMouseEnter={() => menu && setMenu(name)}>{name}</button>
            {menu === name && (
              <ul role="menu" ref={placeMenu}>{menuItems(items)}</ul>
            )}
          </div>
        ))}
        {doc?.parents.length ? (
          <span className="breadcrumb" aria-label="Smart object contents">
            {[...doc.parents, doc.name].join(' › ')}
            <button type="button" onClick={() => saveContents()}>Save</button>
            <button type="button" onClick={() => closeContents()}>Close</button>
          </span>
        ) : null}
        <span className="menubar-end">
          <button type="button" onClick={() => donateDialog.current?.showModal()}>
            <svg className="heart" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 21s-7.5-4.6-9.6-9.3C.9 8.3 3 4.5 6.6 4.5c2.1 0 3.8 1.2 5.4 3.1 1.6-1.9 3.3-3.1 5.4-3.1 3.6 0 5.7 3.8 4.2 7.2C19.5 16.4 12 21 12 21z" /></svg>
            Donate
          </button>
          <button type="button" title="Fullscreen" aria-label="Fullscreen" onClick={() => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.5" d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" /></svg>
          </button>
        </span>
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
      <main className={`workspace${doc ? ' with-sidebar' : ' no-doc'}`}>
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
          ) : <OptionsBar tool={activeTool} values={toolOptions} setValues={setToolOptions} custom={{ pattern: patternSelect, gradient: gradientButton, actions: cropActions, customShape: customShapeSelect, family: typeFont, style: typeStyle, typeActions }} fg={fg} />}
          <div className={`stage${showRulers ? ' with-rulers' : ''}`}>
            <canvas ref={canvas} style={{ cursor: tool === 'gradient' ? 'crosshair' : undefined }} />
            <canvas ref={pixelGridCanvas} className="overlay" />
            <canvas ref={overlayCanvas} className="overlay" />
            <canvas ref={rulerTop} className="ruler ruler-top" style={{ display: showRulers ? 'block' : 'none' }} />
            <canvas ref={rulerLeft} className="ruler ruler-left" style={{ display: showRulers ? 'block' : 'none' }} />
            {showRulers && <div className="ruler-corner" />}
            {!doc && !busy && (
              <div className="welcome">
                <h1><img src="./logo-light.png" alt="" width={64} height={64} />photobaer</h1>
                <p className="tagline">Image editing in your browser</p>
                <div className="actions">
                  <button className="primary" onClick={() => fileInput.current?.click()}>Open image…</button>
                  <button onClick={() => newDialog.current?.showModal()}>New image</button>
                </div>
                <div
                  className={`drop-hint${dragOver ? ' over' : ''}`}
                  onDragEnter={() => setDragOver(true)}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false); }}
                  onDrop={() => setDragOver(false)}
                >
                  Drop an image here
                  <small>PNG, JPEG, WebP, GIF, BMP, AVIF, PSD or .pbaer</small>
                </div>
                <small className="copyright">
                  © 2026 IT-BAER ·{' '}
                  <a href={`https://github.com/IT-BAER/photobaer/releases/tag/v${__APP_VERSION__}`} target="_blank" rel="noreferrer">What's new</a> · v{__APP_VERSION__} ·{' '}
                  <a href="https://github.com/IT-BAER/photobaer" target="_blank" rel="noreferrer" aria-label="photobaer on GitHub" title="GitHub">
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
                  </a>
                  <br />
                  <a href="/impressum/" target="_blank" rel="noreferrer">Impressum</a> · <a href="/privacy/" target="_blank" rel="noreferrer">Privacy</a> ·{' '}
                  <a href="/terms/" target="_blank" rel="noreferrer">Terms</a> · <a href="/licenses/" target="_blank" rel="noreferrer">License</a>
                </small>
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
          {doc && showStyles && <StylesPanel styles={styleLib.current} node={node ?? null} apply={applySavedStyle} />}
          {doc && active && showPatterns && (
            <PatternsPanel doc={doc} library={brushLib.current?.library ?? null} onDoc={d => show(d)} onError={setError}
              fill={id => panelFillLayer({ type: 'pattern', pattern_id: id, scale: 1, angle: 0, linked: true, offset: [0, 0] })} />
          )}
          {doc && active && showGradients && <GradientsPanel presets={gradLib.current.list()} fg={fg} bg={bg} fill={gradientFillLayer} />}
          {doc && showCloneSource && <CloneSourcePanel docId={doc.docId} />}
          {doc && showShapes && (
            <ShapesPanel selected={String((optionsByTool.customShape ?? loadToolOptions(TOOLS.customShape)).customShape ?? '')} arm={armShape} />
          )}
          {doc && showProperties && node?.kind === 'adjustment' && node.adjustment && (
            <PropertiesPanel doc={doc} node={node} run={run} openGradientEditor={(g, ok) => gradEditor.current?.open(g, ok)} pickLookupFile={pickLookupFile} sampleCanvas={sampleCanvas} />
          )}
          {doc && typePanels.character && (
            <CharacterPanel c={typeCtx} faces={pickFaces} eastAsian={typePrefs.language === 'eastAsian'}
              toolOptions={optionsByTool[typeTool] ?? loadToolOptions(TOOLS[typeTool])} setToolOption={(k, v) => patchToolOptions(typeTool, { [k]: v as string | number })} />
          )}
          {doc && typePanels.paragraph && <ParagraphPanel c={typeCtx} />}
          {doc && typePanels.characterStyles && <TextStylesPanel kind="character" c={typeCtx} />}
          {doc && typePanels.paragraphStyles && <TextStylesPanel kind="paragraph" c={typeCtx} />}
          {doc && typePanels.glyphs && <GlyphsPanel c={typeCtx} faces={pickFaces} />}
          {doc && showProperties && node?.kind === 'text' && node.text && <TypeProperties c={typeCtx} faces={pickFaces} />}
          {doc && showProperties && node?.artboard && <ArtboardPanel node={node} run={run} />}
          {doc && showProperties && node?.kind === 'shape' && node.shape && <ShapePanel key={node.id} node={node} run={run} fg={fg} selected={selectedNodes} />}
          {doc && showProperties && node?.vector_mask && <VectorMaskPanel key={`vm${node.id}`} node={node} run={run} />}
          {doc && showProperties && node?.kind === 'smart' && node.smart && (
            <SmartFiltersPanel key={node.id} node={node} run={run} openGradientEditor={(g, ok) => gradEditor.current?.open(g, ok)} pickLookupFile={pickLookupFile} sampleCanvas={sampleCanvas} />
          )}
          {doc && active && (
            <>
              <LayersPanel
                doc={doc} active={active} setActive={setActive} run={run}
                selected={selectedNodes.map(n => n.id)} setPicked={setPicked}
                contextItems={(n, nodes) => [...typeContextItems(n, { ...typeCtx, selected: nodes }), ...layerContextItems(n, nodes, run, setError)]}
                newLayer={newLayer} newGroup={newGroup}
                deleteLayer={deleteLayer} deleteDisabled={deleteDisabled} addMask={addMask}
                openProperties={() => setShowProperties(true)}
                openLayerStyle={(id, page) => openLayerStyle(page, id)}
              />
              <HistoryPanel history={doc.history} goto={n => run(null, () => client.call('historyGoto', n))} />
              {showLayerComps && <LayerCompsPanel doc={doc} run={run} />}
              {showPaths && <PathsPanel doc={doc} node={node ?? null} fg={fg} run={run} selected={pathSel.selected} setSelected={(id, cleared = false) => setPathSel({ selected: id, cleared })} />}
            </>
          )}
        </aside>
      </main>
      <footer className="status">
        <span>{doc ? `${doc.width} × ${doc.height} px, ${doc.depth}-bit` : 'No document'}</span>
        <span>{Math.round(view.zoom * 1000) / 10}%</span>
        <span>{deg ? `${deg}°` : ''}</span>
        <span className="grow">{doc ? (SELECT_TOOLS.includes(tool) ? 'drag to select, Shift add, Alt subtract' : `${activeTool.label}: drag to use, Space to pan, wheel to zoom`) : ''}</span>
        <span className="shrink">{AUTOSAVE_TEXT[autosave]}</span>
        <span>{renderer}</span>
      </footer>
      <ColorPicker ref={picker} />
      <GradientEditor ref={gradEditor} presets={gradLib.current.list()} fg={fg} bg={bg} pickColor={(rgb, title, commit) => picker.current?.open(rgb, title, commit)} />
      <FillDialog
        fillDialog={fillDialog} endPreviewDialog={endPreviewDialog} previewRef={previewRef} fillForm={fillForm} setFillForm={setFillForm}
        picker={picker} brushLib={brushLib}
      />
      <StrokeDialog
        strokeDialog={strokeDialog} endPreviewDialog={endPreviewDialog} previewRef={previewRef} strokeForm={strokeForm} setStrokeForm={setStrokeForm}
        picker={picker}
      />
      <AdjustDialog
        adjustDialog={adjustDialog} adjustForm={adjustForm} endPreviewDialog={endPreviewDialog} previewRef={previewRef} adjustSession={adjustSession}
        setAdjustForm={setAdjustForm} gradEditor={gradEditor} pickLookupFile={pickLookupFile} active={active}
      />
      <input ref={lutInput} type="file" hidden accept=".cube,.3dl" onChange={e => { const f = e.currentTarget.files?.[0]; if (f) void loadLookupFile(f); }} />
      <FillContentDialog
        fillContentDialog={fillContentDialog} submitFillContent={submitFillContent} fillContentForm={fillContentForm}
        setFillContentForm={setFillContentForm} picker={picker} doc={doc} brushLib={brushLib} show={show} setError={setError}
      />
      {fontDialog && doc && (
        <MissingFontsDialog key={fontDialog.kind} d={fontDialog} c={{
          faces: pickFaces, docName: doc.name, texts: docTexts, close: () => setFontDialog(null), ensure: ensureFamilies,
          commit: async (edits, label) => {
            try { show(await client.call('typeSetMany', edits, label)); return true; } catch (e) { setError((e as Error).message); return false; }
          },
          upload: async () => fontInput.current?.click(),
          manage: () => void missingFonts().then(rows => setFontDialog(rows.length ? { kind: 'resolve', rows } : null)),
        }} />
      )}
      <input ref={fontInput} type="file" hidden accept=".ttf,.otf,.ttc,font/ttf,font/otf,font/collection" onChange={async e => {
        const f = e.currentTarget.files?.[0];
        e.currentTarget.value = '';
        if (!f) return;
        try { await uploadFont(client, f); setFaces(await client.call('fontFaces')); } catch (err) { setError((err as Error).message); }
      }} />
      <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,.pbaer,.psd"
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) open(f); }} />
      <NewImageDialog newDialog={newDialog} createNew={createNew} />
      <AboutDialog aboutDialog={aboutDialog} />
      <DonateDialog donateDialog={donateDialog} />
      <FeatherDialog featherDialog={featherDialog} run={run} />
      <ContentAwareFillDialog dialog={contentAwareDialog} submit={(structure, color) => {
        const id = active?.id;
        if (id !== undefined) run('Filling…', () => contentAwareCall(id, structure, color, null, false, 'Content-Aware Fill'));
      }} />
      <WarpTextDialog dialog={warpDialog} c={typeCtx} />
      <ModifyDialog modifyDialog={modifyDialog} run={run} modifyOp={modifyOp} />
      <SaveSelectionDialog saveSelDialog={saveSelDialog} run={run} doc={doc} />
      <LoadSelectionDialog loadSelDialog={loadSelDialog} run={run} doc={doc} />
      <TrimDialog trimDialog={trimDialog} run={run} />
      <NewGuideDialog newGuideDialog={newGuideDialog} run={run} doc={doc} rulerUnit={prefs.current.rulerUnit} />
      <NewGuideLayoutDialog newGuideLayoutDialog={newGuideLayoutDialog} run={run} doc={doc} />
      <ArtboardDialog artboardDialog={artboardDialog} mode={artboardMode} run={run} doc={doc} selected={activeArtboard} layer={node?.id ?? null} />
      {doc && styleDialog && nodeById(doc.layers, styleDialog.id) && (
        <LayerStyleDialog
          key={styleDialog.n} doc={doc} node={nodeById(doc.layers, styleDialog.id)!} page={styleDialog.page}
          library={brushLib.current?.library ?? null} styles={styleLib.current}
          onDoc={d => show(d)} onError={m => setError(m)} onClose={() => setStyleDialog(null)}
          openGradientEditor={(g, ok) => gradEditor.current?.open(g, ok)} pickColor={(rgb, title, commit) => picker.current?.open(rgb, title, commit)}
        />
      )}
      <GlobalLightDialog globalLightDialog={globalLightDialog} doc={doc} run={run} />
      <FilterDialog ref={filterDialog} viewer={viewer} show={d => show(d)} setError={m => setError(m)} />
      <FilterBlendDialog
        filterBlendDialog={filterBlendDialog} setFilterBlend={setFilterBlend} filterBlend={filterBlend} run={run} filters={filters}
      />
      <ScaleEffectsDialog scaleEffectsDialog={scaleEffectsDialog} node={node} run={run} />
      <RotateDialog rotateDialog={rotateDialog} run={run} />
      <ColorRangeDialog
        colorRangeDialog={colorRangeDialog} setColorRangeOpen={setColorRangeOpen} active={active} colorRangeSamples={colorRangeSamples}
        closeColorRange={closeColorRange} run={run} colorRange={colorRange} setColorRange={setColorRange} colorRangeCanvas={colorRangeCanvas}
        colorRangePreview={colorRangePreview} setColorRangeSamples={setColorRangeSamples}
      />
    </div>
  );
}
