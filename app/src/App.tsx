import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { LanguagePicker } from './shell/LanguagePicker.tsx';
import { client } from './client.ts';
import { Viewer, type ToolPointerEvent } from './viewer.ts';
import { createRenderer } from './render/renderer.ts';
import { makeTileSource, gpuTestHook } from './render/tiles.ts';
import { perfTestHook, type PerfProbe } from './render/perf.ts';
import { flatNodes, nodeById } from './layers.ts';
import { LayersPanel, type Active } from './LayersPanel.tsx';
import { HistoryPanel } from './HistoryPanel.tsx';
import { LayerCompsPanel } from './LayerCompsPanel.tsx';
import { ChannelsPanel } from './ChannelsPanel.tsx';
import { ActionsPanel, playSteps } from './ActionsPanel.tsx';
import { BatchDialog, type BatchDialogHandle, type BatchOptions } from './BatchDialog.tsx';
import { assetOptions, canFolder, EXT, ExportAsDialog, exportPrefs, ExportPrefsDialog, FilesExportDialog, SaveForWebDialog, type ExportDialogHandle, type ExportRow, type ExportTarget, type FilesDialogHandle, type FilesOptions, type WebOptions } from './ExportDialogs.tsx';
import { assetSpecs, fileStem, pathsSvg } from './app/webExport.ts';
import { FileInfoDialog, PrintDialog, type FileInfoHandle, type PrintHandle } from './FileDialogs.tsx';
import { ApplyDataSetDialog, ImportDataSetsDialog, VariablesDialog, type ApplySetHandle, type ImportSetsHandle, type VariablesHandle } from './VariablesDialogs.tsx';
import { exportCsv, type Variables } from './app/variables.ts';
import { defaultPrint, printHtml, printLayout, printPage, type PrintSettings } from './app/print.ts';
import { ImageProcessorDialog, LoadStackDialog, type ImageProcessorOptions, type ScriptDialogHandle } from './ScriptDialogs.tsx';
import { WorkspaceDialog, type WorkspaceDialogAction, type WorkspaceDialogHandle } from './WorkspaceDialog.tsx';
import { AnalysisDialogs, type AnalysisDialogHandle } from './AnalysisDialogs.tsx';
import { DocumentArrangement } from './DocumentArrangement.tsx';
import { HistogramPanel, InfoPanel } from './InspectionPanels.tsx';
import { ToolPresetsPanel } from './ToolPresetsPanel.tsx';
import { MeasurementLogPanel, NotesPanel } from './NotesPanels.tsx';
import { useMeasureTools } from './app/measureTools.tsx';
import { runScript } from './app/scripting.ts';
import { DOCK_DEFAULT_ORDER, PANEL_KEYS, addWorkspace, deleteWorkspace, loadWorkspaces, lockWorkspace, resetWorkspace, resizeDock, saveWorkspaces, selectWorkspace, toggleDock, type DockKey, type WorkspaceSettings, type WorkspaceState } from './app/workspaces.ts';
import { loadOrder, moveItem, saveOrder } from './app/panelOrder.ts';
import { matchDocumentViews, type ArrangeMode, type MatchKind } from './app/arrange.ts';
import { addToolPreset, applyToolPreset, deleteToolPreset, exportToolPresets, importToolPresets, loadToolPresets, renameToolPreset, saveToolPresets, snapshotToolPreset, validateBrushPresetAssets, validateToolOptionAssets } from './app/toolPresets.ts';
import type { ActionStep } from './actions.ts';
import { actions } from './app/actionsStore.ts';
import { ImageCalcDialog, type ImageCalcHandle } from './ImageCalcDialog.tsx';
import { ModeDialog, type ModeDialogHandle } from './ModeDialog.tsx';
import { ColorDialog, type ColorDialogHandle } from './ColorDialog.tsx';
import { PdfDialog, type PdfDialogHandle } from './PdfDialog.tsx';
import { SvgDialog, type SvgDialogHandle } from './SvgDialog.tsx';
import type { OpenAction } from './app/colorSettings.ts';
import { COMPOSITE, editChannels, GRAY_MATRIX, paintColor, viewState, type ChannelView } from './app/channels.ts';
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
import { AlignButtons, OptionsBar, type ToolOptions } from './shell/OptionsBar.tsx';
import { ColorPanel } from './shell/ColorPanel.tsx';
import { DockSection } from './shell/DockSection.tsx';
import { SwatchesPanel } from './shell/SwatchesPanel.tsx';
import { ColorPicker, type ColorPickerHandle } from './shell/ColorPicker.tsx';
import { SLOTS, TOOLS, initialLastUsed, keyToTool, loadToolOptions, saveToolOptions, slotForKey } from './shell/tools.ts';
import { BrushesPanel, BrushSettingsPanel } from './shell/BrushPanels.tsx';
import { hexToRgb, intensityOf, rgbToHex, type Rgb } from './shell/color.ts';
import { grayOf, inGray, rgbOfGray, type Convert } from './shell/colorModes.ts';
import type { DigitState } from './shell/brushKeys.ts';
import { HANDLE_CURSORS, SelectionOverlay, boxHandles } from './shell/SelectionOverlay.ts';
import { Rulers, hitGuide, rulerDragToDoc, type DragGuide } from './shell/rulers.ts';
import { loadPreferences, savePreferences } from './shell/preferences.ts';
import { setGridShown, setSnapSettings, snapAxis, snapGrid, snapSettings, type AxisLock, type Rect, type SnapSettings } from './shell/snapping.ts';
import { MODES, TransformBar, TransformBarStore } from './shell/TransformBar.tsx';
import type { Mat3 } from './transform/matrix.ts';
import { setNumeric, setReferenceNormalized } from './transform/session.ts';
import { pickStyle, presetMesh, setGrid } from './transform/warp.ts';
import { antsLevel, contour, MagneticLasso, PolygonLasso, type SelectMode } from './shell/selecttools.ts';
import { TabBar } from './TabBar.tsx';
import { levelFor, type View } from './view.ts';
import { BrushLibrary } from './brushes/store.ts';
import { EngineAssets } from './brushes/engineAssets.ts';
import { presetOptions, presetStrokeParams, pushRecent, type PaintTool } from './brushes/brushParams.ts';
import { parseAbrOffThread } from './brushes/abr.ts';
import type { BrushPreset, Dynamics } from './brushes/preset.ts';
import { GradientEditor, type GradientEditorHandle } from './shell/GradientEditor.tsx';
import { rampCss, type Method } from './gradients/gradient.ts';
import { BUILTIN_GRADIENTS, GradientLibrary, resolvePreset, type GradientPreset } from './gradients/presets.ts';
import {
  AUTOSAVE_TEXT, FILL_KEY, FILL_LAYERS, MODIFY_OPS, PAINT_TOOLS, SELECT_TOOLS, STROKE_DEFAULT, VIEWER_TOOL, fallbackActive,
  fillContentFromForm, formFromFillContent, itemId, loadFillForm, pickPlaceFile, saveBlob, selectAfterDelete, selectCreated,
  type FillContentForm, type FillDialogMode, type FillForm, type Item, type Rgba, type SelectAfter, type StrokeForm,
} from './app/helpers.ts';
import { buildMenus, type ExportKind } from './app/menus.ts';
import { addRecent, baseName, fsAccess, kindOf, loadRecent, permit, pickOpen, pickSave, rasterSvg, saveFormat, saveRoute, storeRecent, writeFile, type Origin, type Recent, type SaveFormat } from './app/files.ts';
import { agentTools, registerWebMcp, type ModelContext, type WebMcpCtx } from './app/webmcp.ts';
import { layerContextItems } from './app/vectorCommands.ts';
import { canvasItems, layerRowItems } from './app/contextMenus.ts';
import { ShapesPanel } from './ShapesPanel.tsx';
import { CharacterPanel, ParagraphPanel, TextStylesPanel, TypeProperties, WarpTextDialog } from './TypePanels.tsx';
import { loadTypePrefs, typeContextItems, typeMenuItems, type TypeCtx, type TypePanel } from './app/typeMenu.ts';
import { shapeLibrary } from './shell/customShapes.ts';
import { transformSession, type TSession } from './app/transform.ts';
import { useBrushCursor, useBucket, useCanvasCursor, useEyedropper, useGradientTool, useMoveTool, useSelectionTools, useShapeTools } from './app/toolEffects.ts';
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
import { NavigatorPanel } from './NavigatorPanel.tsx';
import { useShortcuts } from './app/shortcuts.ts';
import { FilterDialog, runFilter, type FilterDialogHandle } from './filters/FilterDialog.tsx';
import { LiquifyDialog, type LiquifyDialogHandle } from './filters/LiquifyDialog.tsx';
import { VanishingPointDialog, type VanishingPointDialogHandle } from './filters/VanishingPointDialog.tsx';
import { DeformSession, type DeformRequest } from './shell/DeformSession.tsx';
import type { Grid } from './transform/puppet.ts';
import { applyFilter, repeatLastFilter, type ParamValue } from './filters/lastFilter.ts';
import { connectBridge, pairing, toBase64, type Format } from './app/agentBridge.ts';
import { schema, setColorSource, setSchema, type FilterSpec } from './filters/schema.ts';
import {
  AdjustDialog, ColorRangeDialog, ContentAwareFillDialog, FeatherDialog, FillContentDialog, FillDialog, FilterBlendDialog, GlobalLightDialog,
  LoadSelectionDialog, ModifyDialog, ArtboardDialog, CursorPrefsDialog, NewGuideDialog, NewGuideLayoutDialog, NewImageDialog, CloseDialog, type CloseChoice, MergeDialog, type MergeChoice, AboutDialog, AgentDialog, DonateDialog, SearchDialog, type ArtboardMode, type AutomateKind, RotateDialog, SaveSelectionDialog,
  AutomateDialog, ScaleEffectsDialog, StrokeDialog, TrimDialog, CanvasSizeDialog, ImageSizeDialog,
} from './app/Dialogs.tsx';

// Set by vite.config.ts from CHANGELOG.md.
declare const __APP_VERSION__: string;
// The SEO title from index.html, shown while no document is open.
const PAGE_TITLE = document.title;
// File > Generate > Image Assets on/off.
const ASSETS_KEY = 'photobaer.imageAssets';

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
  const fontChecked = useRef(new Set<string>());
  const rulerTop = useRef<HTMLCanvasElement>(null);
  const rulerLeft = useRef<HTMLCanvasElement>(null);
  const pixelGridCanvas = useRef<HTMLCanvasElement>(null);
  const inkCanvas = useRef<HTMLCanvasElement>(null);
  const rulersRef = useRef<Rulers | null>(null);
  const prefs = useRef(loadPreferences());
  const dragGuideRef = useRef<DragGuide | null>(null);
  const newGuideDialog = useRef<HTMLDialogElement>(null);
  const cursorPrefsDialog = useRef<HTMLDialogElement>(null);
  const [cursorRev, setCursorRev] = useState(0);
  const artboardDialog = useRef<HTMLDialogElement>(null);
  const [artboardMode, setArtboardMode] = useState<ArtboardMode>('new');
  const newGuideLayoutDialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Each tab's file (File System Access), by document key; Save writes back to it, Revert re-reads it.
  const origins = useRef(new Map<string, Origin>());
  const [recent, setRecent] = useState<Recent[]>([]);
  const recentRef = useRef<Recent[]>([]);
  const recentQueue = useRef(Promise.resolve());
  const newDialog = useRef<HTMLDialogElement>(null);
  const closeDialog = useRef<HTMLDialogElement>(null);
  const [renameTick, setRenameTick] = useState(0);
  const [closeName, setCloseName] = useState('');
  const closeAnswer = useRef<((c: CloseChoice) => void) | null>(null);
  const mergeDialog = useRef<HTMLDialogElement>(null);
  const [mergeDepth, setMergeDepth] = useState(16);
  const mergeAnswer = useRef<((c: MergeChoice) => void) | null>(null);
  // Set while the HDR Toning dialog converts out of 32-bit instead of adjusting the layer.
  const hdrConvert = useRef<{ depth: 8 | 16; merge: boolean } | null>(null);
  const aboutDialog = useRef<HTMLDialogElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const donateDialog = useRef<HTMLDialogElement>(null);
  const agentDialog = useRef<HTMLDialogElement>(null);
  const featherDialog = useRef<HTMLDialogElement>(null);
  const modifyDialog = useRef<HTMLDialogElement>(null);
  const colorRangeDialog = useRef<HTMLDialogElement>(null);
  const saveSelDialog = useRef<HTMLDialogElement>(null);
  const loadSelDialog = useRef<HTMLDialogElement>(null);
  const trimDialog = useRef<HTMLDialogElement>(null);
  const imageSizeDialog = useRef<HTMLDialogElement>(null);
  const canvasSizeDialog = useRef<HTMLDialogElement>(null);
  const rotateDialog = useRef<HTMLDialogElement>(null);
  const automateDialog = useRef<HTMLDialogElement>(null);
  const workspaceDialog = useRef<WorkspaceDialogHandle>(null);
  const [automate, setAutomate] = useState<AutomateKind>('align');
  const colorRangeCanvas = useRef<HTMLCanvasElement>(null);
  const picker = useRef<ColorPickerHandle>(null);
  const viewer = useRef<Viewer | null>(null);
  const [doc, setDoc] = useState<DocInfo | null>(null);
  const [view, setView] = useState({ zoom: 1, rot: 0 });
  const [fullView, setFullView] = useState<View>({ zoom: 1, rot: 0, cx: 0, cy: 0 });
  const [autosave, setAutosave] = useState<AutosaveState>('off');
  const [renderer, setRenderer] = useState('');
  const [busy, setBusy] = useState<string | null>('Starting…');
  const [workspaceStart] = useState(() => {
    try { return { state: loadWorkspaces(), error: null }; }
    catch (e) {
      return {
        state: loadWorkspaces({ getItem: () => null, setItem: () => {} }),
        error: `Workspace settings could not be loaded. Changes will stay in this session: ${(e as Error).message}`,
      };
    }
  });
  const [toolPresetStart] = useState(() => {
    try { return { library: loadToolPresets(), error: null }; }
    catch (e) {
      return {
        library: loadToolPresets({ getItem: () => null, setItem: () => {} }),
        error: `Tool presets could not be loaded. Changes will stay in this session: ${(e as Error).message}`,
      };
    }
  });
  const [error, setError] = useState<string | null>(workspaceStart.error ?? toolPresetStart.error);
  const [dragOver, setDragOver] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [fg, setFg] = useState<Rgb>(hexToRgb('#e8a23a')!);
  const [bg, setBg] = useState<Rgb>([255, 255, 255]);
  const convertColor: Convert = useMemo(() => (v, from, to) => client.call('convertColor', v, from, to), []);
  const [tool, setTool] = useState('move');
  const [lastUsed, setLastUsed] = useState(initialLastUsed());
  const [quickMask, setQuickMask] = useState(false);
  const [modifyOp, setModifyOp] = useState<keyof typeof MODIFY_OPS>('expand');
  const [colorRange, setColorRange] = useState({ preset: 'sampled', fuzziness: 40, range: 100, localized: false, invert: false });
  const [colorRangeSamples, setColorRangeSamples] = useState<{ rgb: [number, number, number]; x: number; y: number }[]>([]);
  const [colorRangePreview, setColorRangePreview] = useState<{ w: number; h: number; data: Uint8Array; level: number } | null>(null);
  const [colorRangeOpen, setColorRangeOpen] = useState(false);
  const [optionsByTool, setOptionsByTool] = useState<Record<string, ToolOptions>>({});
  const [workspace, setWorkspace] = useState(workspaceStart.state);
  const [toolPresetLibrary, setToolPresetLibrary] = useState(toolPresetStart.library);
  const [dockTab, setDockTab] = useState(workspace.settings.dockTab);
  const [dock, setDock] = useState(workspace.settings.dock);
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
  const [showLayerComps, setShowLayerComps] = useState(workspace.settings.layerComps);
  const [showChannels, setShowChannels] = useState(workspace.settings.channels);
  const [showActions, setShowActions] = useState(workspace.settings.actions);
  const [channelView, setChannelView] = useState<ChannelView>(COMPOSITE);
  const [showPaths, setShowPaths] = useState(workspace.settings.paths);
  const [pathSel, setPathSel] = useState<PathSel>({ selected: null, cleared: false });
  const pathSelRef = useRef(pathSel);
  pathSelRef.current = pathSel;
  const [showProperties, setShowProperties] = useState(workspace.settings.properties);
  const [showAdjustments, setShowAdjustments] = useState(workspace.settings.adjustments);
  const [showStyles, setShowStyles] = useState(workspace.settings.styles);
  const [showPatterns, setShowPatterns] = useState(workspace.settings.patterns);
  const [showGradients, setShowGradients] = useState(workspace.settings.gradients);
  const [showShapes, setShowShapes] = useState(workspace.settings.shapes);
  const [showCloneSource, setShowCloneSource] = useState(workspace.settings.cloneSource);
  const [showNavigator, setShowNavigator] = useState(workspace.settings.navigator);
  const [showHistogram, setShowHistogram] = useState(workspace.settings.histogram);
  const [showInfo, setShowInfo] = useState(workspace.settings.info);
  const [showToolPresets, setShowToolPresets] = useState(workspace.settings.toolPresets);
  const [showNotes, setShowNotes] = useState(workspace.settings.notes);
  const [showMeasurementLog, setShowMeasurementLog] = useState(workspace.settings.measurementLog);
  const [typePanels, setTypePanels] = useState<Record<TypePanel, boolean>>({
    character: workspace.settings.character, paragraph: workspace.settings.paragraph,
    characterStyles: workspace.settings.characterStyles, paragraphStyles: workspace.settings.paragraphStyles, glyphs: workspace.settings.glyphs,
  });
  const workspaceLockedRef = useRef(workspace.locked);
  workspaceLockedRef.current = workspace.locked;
  const currentWorkspaceSettings = (): WorkspaceSettings => ({
    actions: showActions, adjustments: showAdjustments, channels: showChannels, cloneSource: showCloneSource, navigator: showNavigator,
    layerComps: showLayerComps, paths: showPaths, properties: showProperties, styles: showStyles, patterns: showPatterns,
    gradients: showGradients, shapes: showShapes, character: typePanels.character, paragraph: typePanels.paragraph,
    characterStyles: typePanels.characterStyles, paragraphStyles: typePanels.paragraphStyles, glyphs: typePanels.glyphs,
    histogram: showHistogram, info: showInfo, toolPresets: showToolPresets, notes: showNotes, measurementLog: showMeasurementLog, dockTab, dock,
  });
  const storeWorkspace = (next: WorkspaceState) => {
    setWorkspace(next);
    if (workspaceStart.error) { setError(workspaceStart.error); return; }
    try { saveWorkspaces(localStorage, next); } catch (e) { setError(`Workspace settings could not be saved: ${(e as Error).message}`); }
  };
  const applyWorkspace = (next: WorkspaceState) => {
    storeWorkspace(next);
    const s = next.settings;
    setShowActions(s.actions); setShowAdjustments(s.adjustments); setShowChannels(s.channels); setShowCloneSource(s.cloneSource);
    setShowNavigator(s.navigator); setShowLayerComps(s.layerComps); setShowPaths(s.paths); setShowProperties(s.properties);
    setShowStyles(s.styles); setShowPatterns(s.patterns); setShowGradients(s.gradients); setShowShapes(s.shapes); setDockTab(s.dockTab); setDock(s.dock);
    setShowHistogram(s.histogram); setShowInfo(s.info); setShowToolPresets(s.toolPresets); setShowNotes(s.notes); setShowMeasurementLog(s.measurementLog);
    setTypePanels({ character: s.character, paragraph: s.paragraph, characterStyles: s.characterStyles, paragraphStyles: s.paragraphStyles, glyphs: s.glyphs });
  };
  const guardedSetDockTab: typeof setDockTab = value => { if (!workspaceLockedRef.current) setDockTab(value); };
  const dockResize = (id: DockKey, height: number | null) => { if (!workspaceLockedRef.current) setDock(d => resizeDock(d, id, height)); };
  const dockToggle = (id: DockKey) => { if (!workspaceLockedRef.current) setDock(d => toggleDock(d, id)); };
  const [dockOrder, setDockOrder] = useState(() => loadOrder('photobaer.dockOrder', DOCK_DEFAULT_ORDER));
  const dockMove = (id: DockKey, target: DockKey, after: boolean) => {
    if (workspaceLockedRef.current) return;
    setDockOrder(o => { const next = moveItem(o, id, target, after); saveOrder('photobaer.dockOrder', next); return next; });
  };
  // Sections above Layers resize from their bottom edge, sections below it from their top edge.
  const sec = (id: DockKey, title: string) => {
    const order = dockOrder.indexOf(id), layers = dockOrder.indexOf('layers');
    const edge = id === 'layers' ? 'none' as const : order < layers ? 'bottom' as const : 'top' as const;
    return { id, title, entry: dock[id], locked: workspace.locked, onResize: dockResize, onToggle: dockToggle, order, edge, onMove: dockMove };
  };
  const chooseWorkspace = (name: string) => {
    setMenu(null);
    try { applyWorkspace(selectWorkspace(workspace, name)); } catch (e) { setError((e as Error).message); }
  };
  const resetCurrentWorkspace = () => {
    setMenu(null);
    try { applyWorkspace(resetWorkspace(workspace)); } catch (e) { setError((e as Error).message); }
  };
  const toggleWorkspaceLock = () => { setMenu(null); storeWorkspace(lockWorkspace(workspace, !workspace.locked)); };
  const openWorkspaceDialog = (mode: 'save' | 'delete') => {
    setMenu(null);
    if (mode === 'save') workspaceDialog.current?.open({ mode: 'save' });
    else workspaceDialog.current?.open({ mode: 'delete', custom: workspace.custom.map(w => w.name), selected: workspace.selected });
  };
  const workspaceAction = (action: WorkspaceDialogAction) => {
    try {
      const next = action.kind === 'save'
        ? addWorkspace(workspace, action.name, currentWorkspaceSettings())
        : deleteWorkspace(workspace, action.name);
      applyWorkspace(next);
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => {
    const settings = currentWorkspaceSettings();
    if (workspace.settings.dockTab === settings.dockTab && JSON.stringify(workspace.settings.dock) === JSON.stringify(settings.dock)
      && PANEL_KEYS.every(key => workspace.settings[key] === settings[key])) return;
    storeWorkspace({ ...workspace, settings });
  }, [dockTab, dock, showActions, showAdjustments, showChannels, showCloneSource, showNavigator, showLayerComps, showPaths, showProperties, showStyles, showPatterns, showGradients, showShapes, showHistogram, showInfo, showToolPresets, showNotes, showMeasurementLog, typePanels]);
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
  // Bumped at most every 200 ms while a stroke paints, so quick mask and channel views follow it.
  const [liveTick, setLiveTick] = useState(0);
  const liveTimer = useRef(0);
  const strokeStep = () => {
    if (!liveTimer.current) liveTimer.current = window.setTimeout(() => { liveTimer.current = 0; setLiveTick(t => t + 1); }, 200);
  };
  const activeTool = TOOLS[tool];
  const toolOptions = optionsByTool[tool] ?? loadToolOptions(activeTool);
  const setToolOptions = (v: ToolOptions) => setOptionsByTool(o => ({ ...o, [tool]: v }));
  const [active, setActive] = useState<Active | null>(null);
  // Layers picked with Ctrl/Shift+click; the pick counts only while it includes the active layer.
  const [picked, setPicked] = useState<number[]>([]);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const tabState = useRef(new Map<string, { view: View; active: Active | null; picked: number[] }>());
  const [arrangeMode, setArrangeMode] = useState<ArrangeMode>('tabs');
  const [arrangeRevision, setArrangeRevision] = useState(0);
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
  const [canvasMenu, setCanvasMenu] = useState<[number, number] | null>(null);
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
  const imageCalc = useRef<ImageCalcHandle>(null);
  const modeDialog = useRef<ModeDialogHandle>(null);
  const colorDialog = useRef<ColorDialogHandle>(null);
  const pdfDialog = useRef<PdfDialogHandle>(null);
  const svgDialog = useRef<SvgDialogHandle>(null);
  const batchDialog = useRef<BatchDialogHandle>(null);
  const imageProcessorDialog = useRef<ScriptDialogHandle>(null);
  const loadStackDialog = useRef<ScriptDialogHandle>(null);
  const exportAsDialog = useRef<ExportDialogHandle>(null);
  const saveForWebDialog = useRef<ExportDialogHandle>(null);
  const exportPrefsDialog = useRef<ExportDialogHandle>(null);
  const filesExportDialog = useRef<FilesDialogHandle>(null);
  const fileInfoDialog = useRef<FileInfoHandle>(null);
  const variablesDialog = useRef<VariablesHandle>(null);
  const analysisDialog = useRef<AnalysisDialogHandle>(null);
  const importSetsDialog = useRef<ImportSetsHandle>(null);
  const applySetDialog = useRef<ApplySetHandle>(null);
  const printDialog = useRef<PrintHandle>(null);
  const printSettings = useRef<PrintSettings>(defaultPrint());
  const [assetsOn, setAssetsOn] = useState(() => { try { return localStorage.getItem(ASSETS_KEY) === '1'; } catch { return false; } });
  const assetDirs = useRef(new Map<string, FileSystemDirectoryHandle>());
  const [script, setScript] = useState<AbortController | null>(null);
  const liquifyDialog = useRef<LiquifyDialogHandle>(null);
  const vpDialog = useRef<VanishingPointDialogHandle>(null);
  const [deform, setDeform] = useState<DeformRequest | null>(null);
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
    const prev = docRef.current, v = viewer.current;
    // Switching tabs: the view, active layer and picks of the tab left behind are kept under its key.
    const switched = !!prev && !!d && prev.key !== d.key;
    if (prev && v && switched) {
      tabState.current.set(prev.key, { view: { ...v.view }, active: activeRef.current, picked: pickedRef.current });
    }
    for (const k of tabState.current.keys()) if (!d?.docs.some(t => t.key === k)) tabState.current.delete(k);
    for (const k of origins.current.keys()) if (!d?.docs.some(t => t.key === k)) origins.current.delete(k);
    const saved = switched ? tabState.current.get(d.key) : undefined;
    // An error belongs to the document it came from.
    if (prev?.key !== d?.key) setError(null);
    setDoc(d);
    docRef.current = d;
    setArrangeRevision(n => n + 1);
    if (!d) setArrangeMode('tabs');
    v?.setDoc(d, saved?.view);
    document.title = d ? `${d.name}${d.dirty ? '*' : ''} - photobaer` : PAGE_TITLE;
    if (!d) { setActive(null); return; }
    if (switched) { setQuickMask(false); setPicked(saved ? saved.picked.filter(id => nodeById(d.layers, id)) : []); }
    // Node ids restart per document: a previous document's active layer never carries over.
    const sameDoc = d.docId === prev?.docId;
    const restored = saved?.active && nodeById(d.layers, saved.active.id) ? saved.active : null;
    setActive(cur => selectAfter ? selectAfter(d) : restored ?? (sameDoc && cur && nodeById(d.layers, cur.id) ? cur : fallbackActive(d)));
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

  // Open Recent updates run one after another; the list persists in IndexedDB.
  function updateRecent(f: (l: Recent[]) => Recent[] | Promise<Recent[]>) {
    recentQueue.current = recentQueue.current.then(async () => {
      const next = await f(recentRef.current);
      recentRef.current = next;
      setRecent(next);
      await storeRecent(next);
    }).catch(e => console.error('recent files', e));
  }
  const remember = (h: FileSystemFileHandle) => updateRecent(l => addRecent(l, { name: h.name, kind: kindOf(h.name), handle: h, time: Date.now() }));

  // `handle`: the file's File System Access handle (picker, drop, launch, Open Recent), kept for Save and Revert.
  // True when the file opened as the active document.
  async function open(file: File, handle?: FileSystemFileHandle | null, ppi?: number): Promise<boolean> {
    setMenu(null);
    if (/\.pdf$/i.test(file.name)) {
      // PDF pages open as rasterized documents without the PDF as their file.
      const r = await pdfDialog.current?.ask(file);
      if (!r) return false;
      if (handle) remember(handle);
      for (const p of r.files) {
        if (!await open(p, null, r.ppi)) continue;
        try {
          if (r.mode !== 'rgb') show(await client.call('setColorMode', { mode: r.mode }));
          if (r.depth !== 8) show(await client.call('convertDepth', r.depth));
        } catch (e) { setError((e as Error).message); }
      }
      return true;
    }
    let f = file;
    if (/\.svg$/i.test(file.name) || file.type === 'image/svg+xml') {
      const r = await svgDialog.current?.ask(file);
      if (!r) return false;
      f = r.file;
      ppi = r.ppi;
    }
    let action: OpenAction | undefined;
    try {
      const q = await client.call('openProfileQuestion', f);
      if (q.action === 'ask') {
        const a = await colorDialog.current?.ask(f.name, q.embedded, q.space);
        if (!a) return false;
        action = a;
      }
    } catch { /* unreadable profile: the policy decides in openFile */ }
    setBusy(`Opening ${f.name}…`);
    try {
      const d = await client.call('openFile', f, action, ppi);
      if (handle) {
        origins.current.set(d.key, { handle, kind: kindOf(f.name), warned: d.warnings.length > 0 });
        remember(handle);
      }
      show(d);
      if (d.warnings.length) setError(`Opened with warnings: ${d.warnings.join('; ')}`);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  // File > Open: the File System Access picker (handles kept), else the file input.
  async function openFiles() {
    setMenu(null);
    if (!fsAccess()) { fileInput.current?.click(); return; }
    try {
      for (const h of await pickOpen() ?? []) await open(await h.getFile(), h);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // A recent file that cannot be read (gone, permission denied) leaves the list.
  async function openRecent(r: Recent) {
    setMenu(null);
    let f: File;
    try {
      if (!await permit(r.handle, 'read')) throw new Error('permission denied');
      f = await r.handle.getFile();
    } catch (e) {
      updateRecent(l => l.filter(x => x !== r));
      setError(`Could not open ${r.name}: ${(e as Error).message}`);
      return;
    }
    await open(f, r.handle);
  }

  // Edit Contents write-back: PSD export warnings (settings the source cannot store) need a confirm;
  // a close that cannot write back offers to close without saving.
  const lost = (warnings: string[]) => `The source file cannot store:\n- ${warnings.join('\n- ')}`;
  async function editContents(id: number) {
    let warnings: string[] = [];
    await run('Opening contents…', async () => {
      const d = await client.call('editContents', id);
      warnings = d.warnings;
      return d;
    });
    if (warnings.length) setError(`Opened with warnings: ${warnings.join('; ')}`);
  }
  async function saveContents() {
    await run('Saving contents…', async () => {
      const d = await client.call('smartEditSave');
      return d.written || !confirm(`${lost(d.warnings)}\n\nWrite the contents back anyway?`) ? d : client.call('smartEditSave', true);
    });
  }
  function chooseClose(c: CloseChoice) {
    closeDialog.current?.close();
    closeAnswer.current?.(c);
    closeAnswer.current = null;
  }
  // The active tab closes like File > Close (Edit Contents first, with its own write-back confirm); another tab
  // closes by key. A dirty tab asks first; Save closes only when the save left the document clean.
  async function closeTab(key?: string) {
    const d = docRef.current;
    if (!d) return;
    const k = key ?? d.key;
    if (k === d.key && d.parents.length) return closeContents();
    const tab = d.docs.find(t => t.key === k);
    if (tab?.dirty) {
      setMenu(null);
      setCloseName(tab.name);
      const c = await new Promise<CloseChoice>(r => { closeAnswer.current = r; closeDialog.current?.showModal(); closeDialog.current?.querySelector<HTMLButtonElement>('.primary')?.focus(); });
      if (c === 'cancel') return;
      if (c === 'save') {
        if (k !== d.key) await run(null, () => client.call('switchDoc', k));
        if (!await save()) return;
      }
    }
    await run(null, () => client.call('closeDoc', k));
  }
  // Close All / Close Others: tabs close one by one (the dirty one is shown first); Cancel or a failed save stops the rest.
  async function closeTabs(which: 'all' | 'others') {
    const keep = which === 'others' ? docRef.current?.key : undefined;
    for (const t of docRef.current?.docs ?? []) {
      if (t.key === keep) continue;
      if (t.dirty && docRef.current?.key !== t.key) await run(null, () => client.call('switchDoc', t.key));
      const n = docRef.current?.docs.length;
      await closeTab(t.key);
      if (docRef.current?.docs.length === n) return;
    }
  }
  async function closeContents() {
    await run('Closing contents…', async () => {
      let d = await client.call('smartEditClose');
      if (!d.closed && !d.error && confirm(`${lost(d.warnings)}\n\nWrite the contents back anyway?`)) d = await client.call('smartEditClose', 'accept');
      if (!d.closed && confirm(`${d.error ?? 'The contents were not written back.'}\n\nClose without saving the contents?`)) d = await client.call('smartEditClose', 'discard');
      return d;
    });
  }

  // File > Export. Each export runs under the busy overlay; errors go to the toast.
  async function exporting(body: (d: DocInfo) => Promise<void>) {
    setMenu(null);
    const d = docRef.current;
    if (!d) return;
    setBusy('Exporting…');
    try {
      await body(d);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const saveAsset = (blob: Blob, name: string, ask: boolean) => (ask ? saveBlob(blob, name, blob.type, name.split('.').pop()!) : (downloadBlob(blob, name), Promise.resolve(true)));
  function quickExport(target?: ExportTarget) {
    const p = exportPrefs();
    void exporting(async d => {
      const options = target ? { layers: target.layers, trim: true, reveal: true } : {};
      const { blob } = await client.call('exportAsset', assetOptions(p.format, 1, p.quality, options));
      await saveAsset(blob, `${target?.name ?? d.name}.${EXT[p.format]}`, p.ask);
    });
  }
  function quickExportLayer() {
    if (node) quickExport({ layers: [node.id], name: node.name });
  }
  function openLayerExport() {
    setMenu(null);
    if (doc && selectedNodes.length) exportAsDialog.current?.open({
      layers: selectedNodes.map(n => n.id), name: selectedNodes.length === 1 ? selectedNodes[0].name : doc.name,
    });
  }
  function openExport(k: ExportKind) {
    setMenu(null);
    if (k === 'as') exportAsDialog.current?.open();
    else if (k === 'web') saveForWebDialog.current?.open();
    else if (k === 'prefs') exportPrefsDialog.current?.open();
    else filesExportDialog.current?.open(k);
  }
  // Export As: one row asks for the file; several go into one folder (picked first, while the click still counts)
  // or downloads.
  async function runExportAs(rows: ExportRow[], target?: ExportTarget) {
    let dir: FileSystemDirectoryHandle | null = null;
    if (rows.length > 1 && canFolder()) {
      try { dir = await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'readwrite' }); } catch { return; }
    }
    await exporting(async d => {
      const used = new Set<string>();
      for (const r of rows) {
        const options = target ? { layers: target.layers, trim: true, reveal: true } : {};
        const { blob } = await client.call('exportAsset', assetOptions(r.format, r.scale, r.quality, options));
        const name = `${fileStem((target?.name ?? d.name) + r.suffix, used)}.${EXT[r.format]}`;
        if (rows.length === 1) await saveBlob(blob, name, blob.type, EXT[r.format]);
        else await saveOut(dir ? 'folder' : 'download', dir, name, blob);
      }
    });
  }
  function runSaveForWeb(o: WebOptions) {
    void exporting(async d => {
      const { blob } = await client.call('exportAsset', assetOptions(o.format, o.scale, o.quality, { colors: o.colors, dither: o.dither }));
      await saveBlob(blob, `${d.name}.${EXT[o.format]}`, blob.type, EXT[o.format]);
    });
  }
  // Layers to Files (root layers, or the leaves inside groups too) and Artboards to Files (root artboards); a
  // layer with no pixels is skipped and named in the toast. Artboards to PDF writes one file.
  function runFilesExport(o: FilesOptions) {
    void exporting(async d => {
      if (o.kind === 'datasets') {
        const files = await client.call('exportDataSets', o.setFormat, o.quality / 100);
        const used = new Set<string>(), ext = o.setFormat === 'jpeg' ? 'jpg' : o.setFormat;
        for (const f of files) await saveOut(o.dest, o.folder, `${fileStem(`${d.name}_${f.name}`, used)}.${ext}`, f.blob);
        return;
      }
      if (o.kind === 'pdf') {
        await saveBlob(await client.call('artboardsPdf', o.quality / 100), `${d.name}.pdf`, 'application/pdf', 'pdf');
        return;
      }
      const nodes: LayerNode[] = [];
      const walk = (ls: LayerNode[]) => {
        for (const n of [...ls].reverse()) {
          if (o.skipHidden && !n.visible) continue;
          if (o.kind === 'layers' && o.nested && n.children) walk(n.children);
          else nodes.push(n);
        }
      };
      if (o.kind === 'artboards') nodes.push(...[...d.layers].reverse().filter(n => n.artboard));
      else walk(d.layers);
      const used = new Set<string>(), skipped: string[] = [];
      let n = 0;
      for (const node of nodes) {
        setBusy(`Exporting ${++n} of ${nodes.length}: ${node.name}…`);
        const target = o.kind === 'artboards' ? { artboard: node.id, reveal: true } : { layer: node.id, trim: o.trim, reveal: true };
        try {
          const { blob } = await client.call('exportAsset', assetOptions(o.format, o.scale, o.quality, target));
          await saveOut(o.dest, o.folder, `${fileStem(node.name, used)}.${EXT[o.format]}`, blob);
        } catch (e) {
          skipped.push(`${node.name} (${(e as Error).message})`);
        }
      }
      if (skipped.length) setError(`Skipped ${skipped.length} of ${nodes.length}: ${skipped.join(', ')}`);
    });
  }
  // File > Package: a PSD copy with every linked Smart Object embedded.
  function packageDoc() {
    void exporting(async d => {
      const { blob, warnings, embedded } = await client.call('packagePsd');
      if (!await saveBlob(blob, `${d.name}.psd`, 'image/vnd.adobe.photoshop', 'psd')) return;
      setError(`Packaged ${d.name}.psd with ${embedded} linked file${embedded === 1 ? '' : 's'} embedded.${warnings.length ? ` Warnings: ${warnings.join('; ')}` : ''}`);
    });
  }

  // File > Generate > Image Assets: while on, every save writes the layers named like files ("200% icon.png")
  // into <folder>/<document>-assets; the folder is asked once per document (downloads without folder access).
  function toggleImageAssets() {
    setMenu(null);
    const on = !assetsOn;
    setAssetsOn(on);
    try { localStorage.setItem(ASSETS_KEY, on ? '1' : '0'); } catch { /* storage blocked: on for this session */ }
    if (!on) setError('Image Assets generation is off.');
    else if (docRef.current) void generateAssets();
    else setError('Image Assets generation is on; it runs on every save.');
  }
  // `quiet` (after a save) skips the toast for a document without asset-named layers.
  async function generateAssets(quiet = false) {
    const d = docRef.current;
    if (!d) return;
    if (!flatNodes(d.layers).some(n => assetSpecs(n.name).length)) { if (!quiet) setError('No layer names look like assets (try naming a layer "banner.png").'); return; }
    let dir = assetDirs.current.get(d.key) ?? null;
    if (!dir && canFolder()) {
      try { dir = await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'readwrite' }); }
      catch { setError('Image Assets: no folder was chosen. Turn File > Generate > Image Assets off and on to choose one.'); return; }
      assetDirs.current.set(d.key, dir);
    }
    await exporting(async () => {
      const { files, errors } = await client.call('imageAssets', exportPrefs().icc);
      const folder = `${fileStem(d.name, new Set())}-assets`;
      const out = dir ? await dir.getDirectoryHandle(folder, { create: true }) : null;
      for (const f of files) await saveOut(out ? 'folder' : 'download', out, f.name, f.blob);
      setError(errors.length ? `Generated ${files.length} asset(s); ${errors.length} failed: ${errors.join('; ')}` : `Generated ${files.length} asset(s)${out ? ` into ${folder}` : ''}.`);
    });
  }

  // Image > Variables (Define, Data Sets), Image > Apply Data Set, File > Import > Variable Data Sets.
  async function withVariables(f: (m: Variables, d: DocInfo) => void) {
    setMenu(null);
    const d = docRef.current;
    if (!d) return;
    try { f(await client.call('variables'), d); } catch (e) { setError((e as Error).message); }
  }
  const openVariables = (tab: 'define' | 'sets') => void withVariables((m, d) => variablesDialog.current?.open(tab, m, d.layers, active?.id ?? null));
  const openApplyDataSet = () => void withVariables(m => m.data_sets.length ? applySetDialog.current?.open(m) : setError('There are no data sets to apply.'));
  const importInto = (m: Variables, done: (m: Variables, report: string) => void) => importSetsDialog.current?.open(m, done);
  const openImportSets = () => void withVariables(m => importInto(m, (n, report) =>
    void run(null, () => client.call('setVariables', n, 'Import Data Sets')).then(() => setError(report))));
  async function applySet(name: string) {
    const r = await client.call('applyDataSet', name);
    if (r.errors.length) setError(`Apply Data Set: ${r.errors.join(' ')}`);
    return r.doc;
  }
  const commitVariables = (m: Variables, apply: string | null) =>
    run(null, async () => { const d = await client.call('setVariables', m, 'Variables'); return apply ? applySet(apply) : d; });
  const saveSetsCsv = (m: Variables) => void exporting(async d => { await saveBlob(new Blob([exportCsv(m)], { type: 'text/csv' }), `${d.name}-datasets.csv`, 'text/csv', 'csv'); });

  // File > File Info.
  async function openFileInfo() {
    setMenu(null);
    if (!docRef.current) return;
    try { fileInfoDialog.current?.open(await client.call('fileInfo')); } catch (e) { setError((e as Error).message); }
  }

  // File > Print (dialog) and Print One Copy (the last settings): the image at up to 300 ppi of its printed size.
  function openPrint() {
    setMenu(null);
    const d = docRef.current;
    if (d) printDialog.current?.open({ width: d.width, height: d.height, resolution: d.resolution });
  }
  async function printDoc(s: PrintSettings) {
    setMenu(null);
    printSettings.current = s;
    const d = docRef.current;
    if (!d) return;
    let url = '';
    setBusy('Preparing to print…');
    try {
      const l = printLayout(d.width, d.height, d.resolution, s);
      const scale = Math.min(1, l.widthMm / 25.4 * 300 / d.width);
      const { blob } = await client.call('exportAsset', { format: 'png', quality: 1, scale, colors: 256, dither: 'none', icc: true });
      url = URL.createObjectURL(blob);
      setBusy(null);
      await printPage(printHtml(l, s, url, d.name));
    } catch (e) {
      setError(`The document could not be printed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  function pathsToSvg() {
    void exporting(async d => {
      const svg = pathsSvg(d.width, d.height, d.paths.map(p => ({ name: p.work ? 'Work Path' : p.name, path: p.path })));
      await saveBlob(new Blob([svg], { type: 'image/svg+xml' }), `${d.name}.svg`, 'image/svg+xml', 'svg');
    });
  }

  // A browser download with no picker: the batch runs long after the click, so no user gesture is left.
  function downloadBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // Batch and Image Processor: `body` runs on each open document or opened file; files opened here close
  // afterwards. An error stops (false) or goes to a downloaded report named `title`; body false ends early.
  async function eachDoc(title: string, source: 'opened' | 'files', files: File[], stop: boolean, body: (d: DocInfo) => Promise<boolean>) {
    const items = source === 'opened' ? (docRef.current?.docs ?? []).map(t => ({ key: t.key, name: t.name, file: null as File | null })) : files.map(f => ({ key: null as string | null, name: f.name, file: f }));
    const log: string[] = [];
    let n = 0;
    for (const it of items) {
      setBusy(`${title} ${++n} of ${items.length}: ${it.name}…`);
      let opened: string | null = null;
      try {
        const d: DocInfo | null = it.key ? await client.call('switchDoc', it.key) : await client.call('openFile', await rasterSvg(it.file!));
        if (!d) throw new Error('The document is not open.');
        if (!it.key) opened = d.key;
        show(d);
        const go = await body(d);
        if (opened) { show(await client.call('closeDoc', opened)); opened = null; }
        if (!go) break;
      } catch (e) {
        const m = `${it.name}: ${(e as Error).message}`;
        if (opened) show(await client.call('closeDoc', opened).catch(() => docRef.current));
        if (stop) { setBusy(null); setError(`${title} stopped. ${m}`); return; }
        log.push(m);
      }
    }
    setBusy(null);
    if (log.length) {
      downloadBlob(new Blob([`${title} errors\n\n${log.join('\n')}\n`], { type: 'text/plain' }), `${title} errors.txt`);
      setError(`${title} finished with ${log.length} error${log.length > 1 ? 's' : ''}; see ${title} errors.txt.`);
    }
  }
  // Plays an action on the active document `d` with its top layer as the target; false when a stop ended it.
  async function playOn(d: DocInfo, steps: ActionStep[]) {
    const top = d.layers.at(-1)?.id ?? null;
    return playSteps(steps, async (seg, resume) => { d = await client.call('playAction', seg, top, resume) ?? d; show(d); return true; });
  }
  async function saveOut(dest: 'folder' | 'download', dir: FileSystemDirectoryHandle | null, file: string, blob: Blob) {
    if (dest === 'folder') await writeFile(await dir!.getFileHandle(file, { create: true }), blob);
    else downloadBlob(blob, file);
  }
  const enabledSteps = (setId: string, actionId: string) => actions.sets.find(s => s.id === setId)?.actions.find(a => a.id === actionId)?.steps.filter(s => s.enabled) ?? [];

  // File > Automate > Batch.
  async function runBatch(o: BatchOptions) {
    const steps = enabledSteps(o.setId, o.actionId);
    const ext = o.format === 'jpeg' ? 'jpg' : o.format, mime = o.format === 'psd' ? 'image/vnd.adobe.photoshop' : `image/${o.format}`;
    await eachDoc('Batch', o.source, o.files, o.errors === 'stop', async d => {
      if (!await playOn(d, steps)) return false;
      if (o.dest === 'none') return true;
      let blob: Blob;
      if (o.format === 'psd') { blob = (await client.call('savePsd')).blob; show(await client.call('saveEnd', false)); }
      else blob = await client.call('exportImage', mime as 'image/png' | 'image/jpeg', 0.92);
      await saveOut(o.dest, o.folder, `${docRef.current?.name ?? d.name}.${ext}`, blob);
      return true;
    });
  }

  // File > Scripts > Image Processor: per image the action, then per file type an optional fit and sRGB
  // conversion that are undone after the file is written (counted by version: a full history trims, keeps `current`).
  async function runImageProcessor(o: ImageProcessorOptions) {
    const steps = o.action.on ? enabledSteps(o.action.setId, o.action.actionId) : [];
    const types = [['JPEG', 'jpg', o.jpeg], ['PSD', 'psd', o.psd], ['PNG', 'png', o.png]] as const;
    const dirs = new Map<string, FileSystemDirectoryHandle>();
    for (const [name, , t] of types) if (t.on && o.dest === 'folder') dirs.set(name, await o.folder!.getDirectoryHandle(name, { create: true }));
    await eachDoc('Image Processor', o.source, o.files, false, async d => {
      if (steps.length && !await playOn(d, steps)) return false;
      for (const [name, ext, t] of types) {
        if (!t.on) continue;
        const cur = docRef.current!;
        let undo = 0;
        const step = async (p: Promise<DocInfo>) => { const v = docRef.current!.version, r = await p; show(r); if (r.version !== v) undo++; };
        try {
          if (t.fit.on) {
            const f = Math.min(t.fit.w / cur.width, t.fit.h / cur.height);
            const w = Math.max(1, Math.round(cur.width * f)), h = Math.max(1, Math.round(cur.height * f));
            if (w !== cur.width || h !== cur.height) await step(client.call('imageSize', w, h, 'bicubic', true, null));
          }
          let blob: Blob;
          if (name === 'JPEG') {
            if (o.jpeg.srgb) await step(client.call('convertToProfile', 'sRGB IEC61966-2.1', { intent: 'relativeColorimetric', blackPointCompensation: true, dither: false, flatten: false }));
            blob = await client.call('exportImage', 'image/jpeg', o.jpeg.quality / 12);
          } else if (name === 'PSD') { blob = (await client.call('savePsd')).blob; show(await client.call('saveEnd', false)); }
          else blob = await client.call('exportImage', 'image/png', 1);
          await saveOut(o.dest, dirs.get(name) ?? null, `${cur.name}.${ext}`, blob);
        } finally {
          for (; undo > 0; undo--) show(await client.call('undo'));
        }
      }
      return true;
    });
  }

  // File > Scripts > Load Files into Stack.
  async function loadStack(files: File[], align: boolean, smart: boolean) {
    await run('Loading layers…', async () => {
      const d = await client.call('loadStack', await Promise.all(files.map(f => rasterSvg(f))), align, smart);
      if (d.warnings.length) setError(d.warnings.join('; '));
      return d;
    });
  }

  // File > Scripts > Browse: runs a picked .js file; a second click while it runs stops it.
  function browseScript() {
    setMenu(null);
    if (script) { script.abort(); return; }
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.js,.jsx,text/javascript' });
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const stop = new AbortController();
      setScript(stop);
      try {
        await runScript(await f.text(), {
          doc: () => docRef.current,
          call: async (op, args) => {
            const r = await (client.call as (op: string, ...a: unknown[]) => Promise<unknown>)(op, ...args);
            if (r && typeof r === 'object' && 'docs' in r) show(r as DocInfo);
            return r;
          },
          alert: m => alert(m),
          download: async (name, type, quality) => downloadBlob(await client.call('exportImage', type as 'image/png', quality), name),
        }, stop.signal);
      } catch (e) {
        setError(`${f.name}: ${(e as Error).message}`);
      } finally {
        setScript(null);
      }
    };
    input.click();
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

  // Serializes the active document (PSD/PSB mark it saved); every call is followed by saveEnd.
  const encode = (f: SaveFormat = 'psd') => f === 'psd' ? client.call('savePsd') : client.call('saveFormat', f);

  // Writes the active document to `h`; true when written. `save` (Ctrl+S overwrite) confirms PSD export warnings
  // first; `copy` leaves the dirty state as it was.
  async function writeDoc(h: FileSystemFileHandle, how: 'save' | 'as' | 'copy') {
    setBusy(`Saving ${h.name}…`);
    let encoded = false, saved = false;
    try {
      if (!await permit(h, 'readwrite')) throw new Error('permission denied');
      const { blob, warnings } = await encode(saveFormat(h.name) ?? 'psd');
      encoded = true;
      if (how !== 'save' || !warnings.length || confirm(`${lost(warnings)}\n\nOverwrite ${h.name} anyway?`)) {
        await writeFile(h, blob);
        saved = true;
        if (warnings.length) setError(`Saved with warnings: ${warnings.join('; ')}`);
      }
    } catch (e) {
      setError(`Could not save ${h.name}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
    if (encoded) show(await client.call('saveEnd', saved && how !== 'copy'));
    return saved;
  }

  // Without File System Access: Save As downloads a PSD; `copy` leaves the dirty state.
  async function download(copy: boolean) {
    setMenu(null);
    const d = docRef.current;
    if (!d) return false;
    setBusy('Saving…');
    let encoded = false, saved = false;
    try {
      const { blob, warnings } = await encode();
      encoded = true;
      saved = await saveBlob(blob, `${d.name}.psd`, 'image/vnd.adobe.photoshop', 'psd');
      if (warnings.length) setError(`Saved with warnings: ${warnings.join('; ')}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
    if (encoded) show(await client.call('saveEnd', saved && !copy));
    if (saved && !copy && assetsOn) await generateAssets(true);
    return saved && !docRef.current?.dirty;
  }

  // File > Save: writes back to the tab's file when saveRoute allows (D3), else Save As.
  // True when the file was written and the document is clean.
  async function save() {
    setMenu(null);
    const d = docRef.current;
    if (!d) return false;
    const o = origins.current.get(d.key);
    if (saveRoute(o, d.parents.length > 0) === 'saveAs') return saveAs();
    const ok = await writeDoc(o!.handle, 'save');
    if (ok && assetsOn) await generateAssets(true);
    return ok && !docRef.current?.dirty;
  }

  // File > Save As (the tab takes the new file and its name) and Save a Copy (nothing about the tab changes).
  async function saveAs(copy = false) {
    setMenu(null);
    const d = docRef.current;
    if (!d) return false;
    if (!fsAccess()) return download(copy);
    const o = origins.current.get(d.key);
    let h: FileSystemFileHandle | null;
    try {
      h = await pickSave(`${d.name}.psd`, o?.handle);
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
    if (!h) return false;
    const format = saveFormat(h.name);
    if (!format) { setError(`Choose a .psd, .psb, .exr, .hdr or .ico file name, not ${h.name}.`); return false; }
    // EXR, HDR and ICO are flattened copies: the tab keeps its file and dirty state.
    const flat = format !== 'psd' && format !== 'psb';
    if (!await writeDoc(h, copy || flat ? 'copy' : 'as')) return false;
    if (copy) return true;
    remember(h);
    if (flat) return false;
    // An open Edit Contents saved the nested document: the tab keeps its own file.
    if (d.parents.length) return false;
    origins.current.set(d.key, { handle: h, kind: 'psd', warned: false });
    show(await client.call('setDocName', baseName(h.name)));
    if (assetsOn) await generateAssets(true);
    return !docRef.current?.dirty;
  }

  // File > Revert: re-reads the tab's file into the same tab. The history is cleared, so it asks first.
  async function revert() {
    setMenu(null);
    const d = docRef.current, o = d && origins.current.get(d.key);
    if (!d || !o) return;
    try {
      if (!await permit(o.handle, 'read')) throw new Error('permission denied');
    } catch (e) {
      setError(`Could not read ${o.handle.name}: ${(e as Error).message}`);
      return;
    }
    if (!confirm(`Revert to the saved version of ${o.handle.name}? This cannot be undone.`)) return;
    let warnings: string[] = [];
    await run('Reverting…', async () => {
      const r = await client.call('revertDoc', await rasterSvg(await o.handle.getFile()), d.key);
      origins.current.set(r.key, { ...o, warned: r.warnings.length > 0 });
      warnings = r.warnings;
      return r;
    });
    if (warnings.length) setError(`Opened with warnings: ${warnings.join('; ')}`);
  }

  // A picked saved channel is painted through the selection target, as in quick mask.
  const alphaTargets = (channelView.alphaTargets ?? []).filter(id => doc?.channels.some(c => c.id === id));
  const alphaEdit = alphaTargets.length > 0;
  const selEdit = quickMask || alphaEdit;
  // The channels edits change, for handlers declared before it is computed below.
  const paintTarget = useRef(editChannels(COMPOSITE));
  function editTarget(a: Active) { return selEdit ? 'selection' as const : a.target; }

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
    const src = { foreground: fg, background: bg, color: f.color, black: [0, 0, 0], gray: [128, 128, 128], white: [255, 255, 255] }[f.contents] as Rgb;
    return { source: 'solid', rgba: [...paintColor(src, paintTarget.current), 255], intensity: intensityOf(src), ...base };
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
    hdrConvert.current = null;
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

  // Filter > Liquify (Ctrl+Shift+X) on the active layer's pixels; `filterId` re-edits a Liquify smart filter.
  function openLiquify(filterId: number | null = null) {
    setMenu(null);
    if (!active || !doc) return;
    if (transformRef.current) endTransform(false);
    if (editTarget(active) !== 'pixels') { setError('Liquify works on layer pixels, not on a mask.'); return; }
    const layers = flatNodes(doc.layers).filter(n => n.kind === 'pixel' || n.kind === 'smart').map(n => ({ id: n.id, name: n.name }));
    liquifyDialog.current?.open({ id: active.id, filterId, width: doc.width, height: doc.height, guides: doc.guides, layers });
  }

  // Filter > Vanishing Point (Alt+Ctrl+V) on the active layer's pixels; `filterId` re-edits its smart filter.
  function openVanishingPoint(filterId: number | null = null) {
    setMenu(null);
    if (!active || !doc) return;
    if (transformRef.current) endTransform(false);
    if (editTarget(active) !== 'pixels') { setError('Vanishing Point works on layer pixels, not on a mask.'); return; }
    vpDialog.current?.open({ id: active.id, filterId, width: doc.width, height: doc.height });
  }

  // Edit > Content-Aware Scale: the filter dialog on the active pixel layer.
  function openContentAwareScale() {
    setMenu(null);
    const spec = filterSpecs.find(s => s.id === 'content_aware_scale'), n = active && doc ? nodeById(doc.layers, active.id) : null;
    if (!spec || !active) return;
    if (n?.kind !== 'pixel' || editTarget(active) !== 'pixels' || n.locks.pixels || n.locks.position) { setError('Content-Aware Scale needs an unlocked pixel layer.'); return; }
    openFilter(spec);
  }

  // Edit > Puppet Warp / Perspective Warp: an on-canvas session on the active layer's pixels.
  async function startDeform(kind: DeformRequest['kind']) {
    setMenu(null);
    if (!active || !doc || deform) return;
    if (transformRef.current) endTransform(false);
    const n = nodeById(doc.layers, active.id), empty = 'Select an unlocked layer with pixels to warp.';
    if (n?.kind === 'text' || n?.kind === 'shape') { setError('Convert type and shape layers to Smart Objects, or rasterize them, before warping.'); return; }
    if (!n || (n.kind !== 'pixel' && n.kind !== 'smart') || editTarget(active) !== 'pixels' || n.locks.pixels || n.locks.position) { setError(empty); return; }
    const base = { id: active.id, width: doc.width, height: doc.height };
    try {
      if (kind === 'puppet') setDeform({ ...base, kind, mesh: await client.call('puppetMesh', active.id, 'normal', 2) as Grid });
      else {
        const b = await client.call('movingBounds', active.id) as number[] | null;
        if (!b) throw new Error(empty);
        setDeform({ ...base, kind, bounds: { x: b[0], y: b[1], w: b[2], h: b[3] } });
      }
    } catch (e) { setError((e as Error).message); }
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
    hdrConvert.current = null;
    // Color Lookup picks its table first (D9); cancelling the picker opens nothing.
    if (kind === 'color_lookup') pickLookupFile((name, table, format) => startAdjust({ kind, params: { name, format, table, interpolation: 'tetrahedral', dither: false } }));
    else startAdjust(kind in DESTRUCTIVE_LABEL ? defaultDestructive(kind as DestructiveKind) : defaultAdjustment(kind as Kind));
  }

  function startAdjust(a: Adjustment | DestructiveAdjustment) {
    previewRef.current = { open: true, commit: false, pending: Promise.resolve() };
    setAdjustForm(a);
    setAdjustSession(n => n + 1);
    setPreviewDialog('adjust');
    adjustDialog.current?.showModal();
  }

  function chooseMerge(c: MergeChoice) {
    mergeDialog.current?.close();
    mergeAnswer.current?.(c);
    mergeAnswer.current = null;
  }

  // Image > Mode > 8/16 Bits/Channel from 32-bit opens HDR Toning; several layers (or one non-pixel layer)
  // ask to merge first, and Don't Merge tones each pixel layer with the default Local Adaptation.
  async function convertDepth(depth: 8 | 16 | 32) {
    setMenu(null);
    const layers = doc?.layers ?? [];
    if (doc?.depth !== 32 || depth === 32 || !layers.length) { run('Converting…', () => client.call('convertDepth', depth)); return; }
    const merge = layers.length > 1 || layers[0].kind !== 'pixel';
    if (merge) {
      setMergeDepth(depth);
      const c = await new Promise<MergeChoice>(r => { mergeAnswer.current = r; mergeDialog.current?.showModal(); mergeDialog.current?.querySelector<HTMLButtonElement>('.primary')?.focus(); });
      if (c === 'cancel') return;
      if (c === 'keep') { run('Converting…', () => client.call('convertDepth', depth, { merge: false, params: (defaultDestructive('hdr_toning') as Extract<DestructiveAdjustment, { kind: 'hdr_toning' }>).params })); return; }
    }
    hdrConvert.current = { depth, merge };
    startAdjust(defaultDestructive('hdr_toning'));
  }

  // Destructive kinds without params apply at once as one undo step.
  function applyDestructive(kind: DestructiveKind) {
    setMenu(null);
    if (!active) return;
    run(`${DESTRUCTIVE_LABEL[kind]}…`,() => client.call('adjust', active.id, defaultDestructive(kind), DESTRUCTIVE_LABEL[kind]));
  }

  function adjustPreview(a: Adjustment | DestructiveAdjustment) {
    const st = previewRef.current, id = activeRef.current?.id, h = hdrConvert.current;
    if (!st.open || (id === undefined && !h)) return;
    st.pending = (h && a.kind === 'hdr_toning' ? client.call('convertDepth', h.depth, { merge: h.merge, params: a.params }, true) : client.call('adjust', id!, a, COMMAND_LABEL[a.kind], true)).then(d => show(d), e => setError((e as Error).message));
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
    run(null, () => client.call('fillEx', active.id, editTarget(active), { source: 'solid', rgba: [...paintColor(rgb, paintTarget.current), 255], intensity: intensityOf(rgb), mode: 'normal', opacity: 1, preserveTransparency: false }, label));
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
  const pixelsOff = node?.kind !== 'pixel' || active?.target !== 'pixels' || selEdit;
  // The 16 layer kinds also run on a smart object, where they add a smart filter.
  const hostOff = pixelsOff && !(node?.kind === 'smart' && active?.target === 'pixels' && !selEdit);

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
    prefs: typePrefs, setPrefs: setTypePrefs, panels: typePanels, togglePanel: k => {
      setMenu(null);
      if (!workspaceLockedRef.current) setTypePanels(v => ({ ...v, [k]: !v[k] }));
    },
    fontDialog: k => void openFontDialog(k),
    ensureFamilies, loadSystemFonts: localFontsSupported() ? () => void loadSystemFonts() : null,
  };
  const typeTool = TYPE_TOOLS.includes(tool) ? tool : 'horizontalType';
  const chooseArrangement = (mode: ArrangeMode) => {
    setMenu(null);
    setArrangeMode(mode);
  };
  const saveArrangementView = (key: string, nextView: View) => {
    const previous = tabState.current.get(key);
    tabState.current.set(key, { view: { ...nextView }, active: previous?.active ?? null, picked: previous ? [...previous.picked] : [] });
  };
  const matchArrangement = (kind: MatchKind) => {
    setMenu(null);
    const current = viewer.current;
    if (!doc || !current) return;
    tabState.current.set(doc.key, { view: { ...current.view }, active: activeRef.current, picked: [...pickedRef.current] });
    tabState.current = matchDocumentViews(tabState.current, doc.docs.map(d => d.key), doc.key, current.view, kind);
    setArrangeRevision(n => n + 1);
  };
  const menus = buildMenus({
    setMenu, newDialog, aboutDialog, agentDialog, openFiles, placeFile, has, active, save, saveAs: () => void saveAs(), saveCopy: () => void saveAs(true),
    revert, revertOff: !doc || !origins.current.has(doc.key) || !doc.dirty || doc.parents.length > 0,
    recent: fsAccess() ? recent : null, openRecent, clearRecent: () => { setMenu(null); updateRecent(() => []); }, quickExport: () => quickExport(), quickExportLayer, openLayerExport, openExport, pathsToSvg, exportLayerComps, doc, closeTab, closeTabs, renameLayer: () => setRenameTick(n => n + 1), run,
    openPreviewDialog, contentAwareFill, quickFill, fg, bg, quickMask, selEdit, startTransform, transformAgain, transformStore, transformMode, warping, warpMenuSplit,
    transformRemap, newLayer, newGroup, duplicateLayer, deleteLayer, deleteDisabled, groupLayers, ungroupLayers, node, toggleClipping, addMask,
    deleteMask, toggleMaskEnabled, openNewFillLayer, newAdjustmentLayer, openLayerContentOptions, smart, editContents, replaceContents,
    exportContents, convertToLinked, anyLinked, toggleLabel, filterCommand, filters, filterMasks, maskLabel, openFilterBlend, openLayerStyle,
    globalLightDialog, allEffectsHidden, anyStyled, scaleEffectsDialog, openAdjust, hostOff, pixelsOff, convertDepth, applyDestructive, rotateDialog,
    openImageCalc: calc => { setMenu(null); if (calc) imageCalc.current?.open({ kind: 'calc' }); else if (active) imageCalc.current?.open({ kind: 'apply', id: active.id }); }, trimDialog, imageSizeDialog, canvasSizeDialog,
    openAutomate: kind => { setMenu(null); setAutomate(kind); automateDialog.current?.showModal(); },
    openBatch: () => { setMenu(null); batchDialog.current?.open(); },
    openImageProcessor: () => { setMenu(null); imageProcessorDialog.current?.open(); },
    openLoadStack: () => { setMenu(null); loadStackDialog.current?.open(); },
    assetsOn, toggleImageAssets, packageDoc, openVariables, openApplyDataSet, openImportSets, openFileInfo: () => void openFileInfo(), openPrint, printOneCopy: () => void printDoc(printSettings.current),
    openAnalysis: kind => { setMenu(null); analysisDialog.current?.open(kind); },
    recordMeasurements: () => void measure.record(),
    chooseTool: id => { const slot = SLOTS.find(s => s.tools.includes(id)); if (slot) setLastUsed(u => ({ ...u, [slot.id]: id })); setTool(id); },
    browseScript, scriptRunning: !!script,
    openModeDialog: kind => { setMenu(null); modeDialog.current?.open(kind); },
    openColorDialog: kind => { setMenu(null); colorDialog.current?.open(kind); },
    openColorRange, openModify, featherDialog, growOrSimilar, setQuickMask, loadSelDialog, saveSelDialog, viewer, showAnts, setShowAnts,
    showAdjustments, setShowAdjustments, showLayerComps, setShowLayerComps, showChannels, setShowChannels, showActions, setShowActions, showPaths, setShowPaths, showProperties, setShowProperties, showStyles, setShowStyles,
    showPatterns, setShowPatterns, showGradients, setShowGradients, showRulers, setShowRulers, showPixelGrid, setShowPixelGrid,
    showGuides, setShowGuides, showGrid, setShowGrid, newGuideDialog, newGuideLayoutDialog, cursorPrefsDialog, snap, setSnap, filterSpecs, openFilter, openLiquify: () => openLiquify(), openVanishingPoint: () => openVanishingPoint(), openContentAwareScale, startDeform: k => void startDeform(k), lastFilter, openFade, openSearch: () => setSearchOpen(true),
    openArtboard: mode => { setMenu(null); setArtboardMode(mode); artboardDialog.current?.showModal(); }, activeArtboard,
    selectedNodes, showShapes, setShowShapes, showCloneSource, setShowCloneSource, showNavigator, setShowNavigator, typeItems: typeMenuItems(typeCtx),
    showHistogram, setShowHistogram, showInfo, setShowInfo, showToolPresets, setShowToolPresets, showNotes, setShowNotes, showMeasurementLog, setShowMeasurementLog,
    workspace, chooseWorkspace, openWorkspaceDialog, resetCurrentWorkspace, toggleWorkspaceLock,
    arrangeMode, chooseArrangement, matchArrangement,
  });
  const menusRef = useRef(menus);
  menusRef.current = menus;
  useEffect(() => {
    if (!canvasMenu) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setCanvasMenu(null); };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [canvasMenu]);
  const runRef = useRef(run);
  runRef.current = run;

  // Agent operations reject with the engine's message instead of showing the error banner.
  const agentOps = {
    runFilter(id: string, params: Record<string, ParamValue>) {
      const a = activeRef.current;
      if (!a) return Promise.reject(new Error('No active layer'));
      if (transformRef.current) endTransform(false);
      return applyFilter(async f => show(await client.call('applyFilter', a.id, editTarget(a), { kind: f.kind, params: f.params }, f.label)),
        { kind: id, params, label: filterSpecs.find(s => s.id === id)?.label ?? id });
    },
    async openFile(f: File) {
      if (transformRef.current) endTransform(false);
      const d = await client.call('openFile', f);
      show(d);
      return { warnings: d.warnings };
    },
    async exportFile(format: Format, quality = 0.92) {
      if (format === 'psd') return client.call('savePsd');
      const blob = await client.call('exportImage', `image/${format}`, quality);
      return { blob, warnings: [] };
    },
  };
  const agentRef = useRef(agentOps);
  agentRef.current = agentOps;
  const [agent, setAgent] = useState(false);
  const bridgeRef = useRef<{ close(): void } | null>(null);

  // Agent calls wait for start-up: the filter schema loads after the engine's init.
  const [started] = useState(() => { let done!: () => void; return { promise: new Promise<void>(r => { done = r; }), done }; });
  useEffect(() => { if (filterSpecs.length) started.done(); }, [filterSpecs.length, started]);
  useEffect(() => {
    const ctx: WebMcpCtx = {
      ready: () => started.promise, doc: () => docRef.current, menus: () => menusRef.current, active: () => activeRef.current?.id ?? null,
      selectLayer: id => { setPicked([]); setActive({ id, target: 'pixels' }); },
      newDocument: (w, h) => runRef.current('Creating…', () => client.call('newDoc', w, h, 8, [255, 255, 255, 255])),
      filters: schema, runFilter: (id, params) => agentRef.current.runFilter(id, params),
      async preview(max) {
        const bmp = await createImageBitmap(await client.call('exportImage', 'image/png'));
        const k = Math.min(1, max / Math.max(bmp.width, bmp.height)), width = Math.max(1, Math.round(bmp.width * k)), height = Math.max(1, Math.round(bmp.height * k));
        const c = new OffscreenCanvas(width, height);
        c.getContext('2d')!.drawImage(bmp, 0, 0, width, height);
        bmp.close();
        return { mimeType: 'image/png', data: await toBase64(await c.convertToBlob({ type: 'image/png' })), width, height };
      },
    };
    // Chrome before 150 exposed the draft API on navigator.
    const mc = ((document as { modelContext?: ModelContext }).modelContext ?? (navigator as { modelContext?: ModelContext }).modelContext);
    const ctl = new AbortController();
    registerWebMcp(mc, ctx, ctl.signal);
    // photobaer-mcp opens the page with #agent=PORT.TOKEN; the fragment is dropped from the address bar once read.
    const pair = () => {
      const p = pairing(location.hash);
      if (!p) return;
      history.replaceState(null, '', location.pathname + location.search);
      bridgeRef.current?.close();
      bridgeRef.current = connectBridge(p, agentTools(ctx), {
        openFile: f => agentRef.current.openFile(f), exportFile: (f, q) => agentRef.current.exportFile(f, q), status: setAgent,
      });
    };
    pair();
    addEventListener('hashchange', pair);
    return () => { ctl.abort(); removeEventListener('hashchange', pair); bridgeRef.current?.close(); };
  }, [started]);

  useEffect(() => {
    let alive = true;
    client.onEvent = e => {
      if (e.event === 'autosave') setAutosave(e.state);
      else if (e.event === 'transformCancelled' && closeTransform()) show(e.doc);
      else if (e.event === 'typeCommitted') { if (typeRef.current) typeRef.current.ended(e.doc); else show(e.doc); }
      else if (e.event === 'actionStep') actions.addStep(e.step);
    };
    (async () => {
      try {
        const r = await createRenderer(canvas.current!, new URLSearchParams(location.search).get('renderer'));
        if (!alive) return;
        setRenderer(r.kind === 'webgpu' ? 'WebGPU' : 'WebGL2');
        const v = new Viewer(canvas.current!, r, makeTileSource(client, r));
        overlayRef.current = new SelectionOverlay(overlayCanvas.current!, inkCanvas.current);
        rulersRef.current = new Rulers(rulerTop.current!, rulerLeft.current!, pixelGridCanvas.current!);
        v.onView = x => { setView({ zoom: x.zoom * v.dpr, rot: x.rot }); setFullView(x); redrawOverlay(); redrawRulers(); };
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
      lq?.setConsumer(async p => { for (const h of p.files) await open(await h.getFile(), h); });
      if (fsAccess()) updateRecent(() => loadRecent());
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

  // Channels panel view: a color matrix on the document canvas and a saved channel on the overlay.
  const maskShown = channelView.mask != null && doc && nodeById(doc.layers, channelView.mask)?.mask ? channelView.mask : undefined;
  const channelState = viewState({ ...channelView, alpha: channelView.alpha.filter(id => doc?.channels.some(c => c.id === id)), mask: maskShown });
  const channelMatrix = doc?.gray && doc.mode?.kind !== 'duotone' ? GRAY_MATRIX : channelState.matrix;
  const inkView = doc?.mode?.kind === 'cmyk' || doc?.mode?.kind === 'lab' ? channelState.ink : null;
  const channelFilter = channelMatrix ? 'url(#channel-view)' : undefined;
  useEffect(() => setChannelView(COMPOSITE), [doc?.key]);
  const chTarget = editChannels({ ...channelView, alphaTargets }, quickMask);
  paintTarget.current = chTarget;
  useEffect(() => {
    if (!doc) return;
    const docId = doc.docId;
    let alive = true;
    if (docRef.current?.docId === docId) {
      client.call('setChannelTarget', chTarget.rgb, chTarget.alpha).catch(e => {
        if (alive && docRef.current?.docId === docId) setError((e as Error).message);
      });
    }
    return () => { alive = false; };
  }, [doc?.docId, chTarget.rgb.join(), chTarget.alpha.join()]);
  useEffect(() => {
    const overlay = overlayRef.current, a = channelState.alpha, mode = doc?.mode?.kind;
    const spot = a && !a.layer ? doc?.channels.find(c => c.id === a.id)?.spot : null;
    if (!overlay) return;
    if (!doc || (!a && inkView === null)) { overlay.setChannelOverlay(null, 0, 0, 1, 'gray'); redrawOverlay(); return; }
    const docId = doc.docId;
    let alive = true;
    const mask = a ? (a.layer ? client.call('layerMask', a.id, antsLevelValue) : client.call('channelMask', a.id, antsLevelValue)) : client.call('colorChannelMask', mode as 'cmyk' | 'lab', inkView!, antsLevelValue);
    mask.then(r => {
      if (!alive || r.docId !== docId || !r.data) return;
      overlay.setChannelOverlay(new Uint8Array(r.data), r.w, r.h, 1 << antsLevelValue, spot && a?.mode === 'tint' ? { ink: spot.color, solidity: spot.solidity } : a ? a.mode : 'gray');
      redrawOverlay();
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.docId, doc?.version, channelState.alpha?.id, channelState.alpha?.mode, channelState.alpha?.layer, inkView, antsLevelValue, selEdit ? liveTick : 0]);

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
  }, [doc?.selGen, antsLevelValue, doc?.docId, quickMask, quickMask ? liveTick : 0]);

  useSelectionTools({
    viewer, dragRef, polygonRef, lastPolyDownRef, overlayRef, magneticRef, tool, polygonActionsRef, toolOptionsRef, polygonModeRef, show, docRef,
    activeRef, doc,
  });

  useBucket({
    viewer, tool, active, setFg, toolOptionsRef, bg, fg, quickMask: selEdit, show,
  });

  const toolRef = useRef(tool);
  toolRef.current = tool;
  const lastUsedRef = useRef(lastUsed);
  lastUsedRef.current = lastUsed;
  const fgRef = useRef(fg);
  fgRef.current = paintColor(fg, chTarget);
  const bgRef = useRef(bg);
  bgRef.current = paintColor(bg, chTarget);
  setColorSource(() => ({ foreground: rgbToHex(fgRef.current), background: rgbToHex(bgRef.current) }));

  useGradientTool({
    viewer, tool, active, overlayRef, toolOptionsRef, gradLib, fgRef, bgRef, run, editTarget, quickMask,
  });
  useShapeTools({ viewer, tool, active, overlayRef, toolOptionsRef, fgRef, run, docRef });
  const measure = useMeasureTools({
    viewer, tool, doc, docRef, active, overlayRef, redrawOverlay, toolOptions, toolOptionsRef, run, setError, openNotes: () => setShowNotes(true),
  });
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
    if (!doc || !faces.length || fontChecked.current.has(doc.key)) return;
    fontChecked.current.add(doc.key);
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
    viewer, tool, toolOptionsRef, currentPreset, selectedPresetRef, brushLib, bgRef, fgRef, active, docRef, strokeCounter, quickMask: selEdit, perfRef,
    setError, lastStrokePoint, run, onStep: strokeStep,
    leash: line => {
      if (!prefs.current.brushLeash && line) return;
      overlayRef.current?.setLeash(line, prefs.current.brushLeashColor);
      redrawOverlay();
    },
  });

  const retouch = { viewer, canvas, overlayRef, redrawOverlay, tool, active, docRef, toolOptionsRef, run, setError };
  useRetouchTools(retouch);
  useCloneOverlay(retouch);

  useBrushCursor({
    viewer, canvas, overlayRef, tool, redrawOverlay, toolOptionsRef, capsLockRef, prefsRef: prefs, docId: doc?.docId, patchToolOptions,
  });
  useCanvasCursor({ viewer, canvas, tool, mode: String(toolOptions.mode ?? ''), toolOptionsRef, capsLockRef, prefsRef: prefs, cursorRev, docId: doc?.docId });

  function openPicker(which: 'fg' | 'bg') {
    picker.current?.open(which === 'fg' ? fg : bg, which === 'fg' ? 'Foreground Color' : 'Background Color', v => (which === 'fg' ? setFg : setBg)(v), { hdr: doc?.depth === 32 });
  }
  // Grayscale documents paint in gray: a color from elsewhere converts through the Gray profile, and a new
  // Gray profile of the same document reconverts the paint colors from their RGB twins, so they look the same.
  const grayDoc = !!doc?.gray && !doc.mode;
  const docId = doc?.docId, grayProfile = grayDoc ? doc!.profile?.name ?? '' : null;
  const paintTwins = useRef<{ docId: number; profile: string; fg: Rgb; bg: Rgb } | null>(null);
  useEffect(() => {
    if (grayProfile === null || docId === undefined) return;
    let live = true;
    const twins = paintTwins.current;
    if (twins && twins.docId === docId && twins.profile !== grayProfile) {
      paintTwins.current = { ...twins, profile: grayProfile };
      Promise.all([grayOf(twins.fg, convertColor), grayOf(twins.bg, convertColor)]).then(([f, b]) => { if (live) { setFg(f); setBg(b); } }, () => {});
    } else {
      Promise.all([inGray(fg, convertColor), inGray(bg, convertColor)]).then(async ([f, b]) => {
        if (!live) return;
        if (f !== fg) setFg(f);
        if (b !== bg) setBg(b);
        if (f !== fg || b !== bg) return;
        const t = { docId, profile: grayProfile, fg: await rgbOfGray(fg, convertColor), bg: await rgbOfGray(bg, convertColor) };
        if (live) paintTwins.current = t;
      }, () => {});
    }
    return () => { live = false; };
  }, [docId, grayProfile, fg, bg]);
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
    menusRef, capsLockRef, polygonActionsRef, transformKey, cropSession, setDockTab: guardedSetDockTab, setMenu, viewer, setFg, setBg, bgRef, fgRef, setQuickMask,
    toolRef, toolOptionsRef, patchToolOptions, flowDigitRef, opacityDigitRef, moveKeysRef, selectByKey, open, penKeysRef, typeKeysRef, setChannelView,
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
  function storeToolPresetLibrary(next: typeof toolPresetLibrary) {
    setToolPresetLibrary(next);
    if (toolPresetStart.error) { setError(toolPresetStart.error); return; }
    try { saveToolPresets(localStorage, next); }
    catch (e) { setError(`Tool presets could not be saved: ${(e as Error).message}`); }
  }
  function createToolPreset(name: string, includeColors: boolean) {
    try {
      const snapshot = snapshotToolPreset(name, tool, toolOptions, PAINT_TOOLS.has(tool) ? selectedPresetId : null,
        includeColors ? { fg, bg } : undefined);
      storeToolPresetLibrary(addToolPreset(toolPresetLibrary, snapshot));
    } catch (e) { setError((e as Error).message); }
  }
  function renameSavedToolPreset(id: string, name: string) {
    try { storeToolPresetLibrary(renameToolPreset(toolPresetLibrary, id, name)); }
    catch (e) { setError((e as Error).message); }
  }
  function deleteSavedToolPreset(id: string) {
    try { storeToolPresetLibrary(deleteToolPreset(toolPresetLibrary, id)); }
    catch (e) { setError((e as Error).message); }
  }
  function applySavedToolPreset(saved: typeof toolPresetLibrary.presets[number]) {
    try {
      const next = applyToolPreset(saved), toolDef = TOOLS[next.tool];
      validateToolOptionAssets(next.options, {
        gradient: id => gradLib.current?.get(id), shape: id => shapeLibrary().get(id),
        pattern: id => brushLib.current?.library.patterns().find(p => p.id === id),
      });
      if (next.brushPresetId !== null) {
        const lib = brushLib.current, preset = lib?.library.list().find(item => item.id === next.brushPresetId);
        if (!lib || !preset) throw new Error(`Brush preset "${next.brushPresetId}" is unavailable.`);
        validateBrushPresetAssets(preset, lib.library);
        // The saved brush uses its own texture, not one carried over by Protect Texture.
        protectedTexture.current = null;
        setSelectedPresetId(preset.id);
        setRecentPresets(recent => pushRecent(recent, preset.id));
      } else if (PAINT_TOOLS.has(next.tool)) setSelectedPresetId(null);
      const options = { ...loadToolOptions(toolDef), ...next.options };
      setOptionsByTool(current => ({ ...current, [next.tool]: options }));
      saveToolOptions(toolDef, options);
      setLastUsed(current => ({ ...current, [toolDef.slot]: next.tool }));
      setTool(next.tool);
      if (next.colors) { setFg(next.colors.fg); setBg(next.colors.bg); }
    } catch (e) { setError((e as Error).message); }
  }
  function importSavedToolPresets(json: string) {
    try { storeToolPresetLibrary(importToolPresets(toolPresetLibrary, json)); }
    catch (e) { setError((e as Error).message); }
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
    <Fragment key={itemId(i)}>
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
          {agent && <button type="button" className="agent-chip" title="An AI agent controls this tab. Click to disconnect." onClick={() => bridgeRef.current?.close()}>Agent connected ✕</button>}
          <button type="button" onClick={() => donateDialog.current?.showModal()}>
            <svg className="heart" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 21s-7.5-4.6-9.6-9.3C.9 8.3 3 4.5 6.6 4.5c2.1 0 3.8 1.2 5.4 3.1 1.6-1.9 3.3-3.1 5.4-3.1 3.6 0 5.7 3.8 4.2 7.2C19.5 16.4 12 21 12 21z" /></svg>
            Donate
          </button>
          <LanguagePicker />
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
                <li key={itemId(i)}><button role="menuitem" disabled={i.off} onClick={i.run}><span>{i.label}</span></button></li>
              ))}
            </ul>
          </div>
        </>
      )}
      {canvasMenu && (() => {
        const items = canvasItems(menus, !!doc?.selection);
        return (
          <>
            <div className="scrim" onClick={() => setCanvasMenu(null)} onContextMenu={e => { e.preventDefault(); setCanvasMenu(null); }} />
            <div className="menu context-menu" style={{
              left: Math.max(0, Math.min(canvasMenu[0], innerWidth - 220)), top: Math.max(0, Math.min(canvasMenu[1], innerHeight - items.length * 30 - 20)),
            }}>
              <ul role="menu" aria-label="Canvas">
                {items.map(i => (
                  <Fragment key={itemId(i)}>
                    {i.sep && <li role="separator" className="menu-sep" />}
                    <li><button role="menuitem" disabled={i.off} onClick={() => { setCanvasMenu(null); i.run(); }}><span>{i.label}</span></button></li>
                  </Fragment>
                ))}
              </ul>
            </div>
          </>
        );
      })()}
      <main className={`workspace${doc || showHistogram || showInfo || showToolPresets || showNotes || showMeasurementLog ? ' with-sidebar' : ''}${doc ? '' : ' no-doc'}`}>
        <ToolBar
          active={tool} setActive={setTool} lastUsed={lastUsed} setLastUsed={setLastUsed}
          fg={fg} bg={bg} openPicker={openPicker} swap={swapColors} reset={resetColors}
          quickMask={quickMask} setQuickMask={setQuickMask}
        />
        <div className="stage-column">
          {deform ? <DeformSession req={deform} viewer={viewer} show={d => show(d)} setError={m => setError(m)} onEnd={() => setDeform(null)} /> : transformStore ? (
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
          ) : <OptionsBar tool={activeTool} values={toolOptions} setValues={setToolOptions} custom={{ align: <AlignButtons count={selectedNodes.length} onAlign={mode => run(null, () => client.call('alignLayers', selectedNodes.map(n => n.id), mode))} />, pattern: patternSelect, gradient: gradientButton, actions: cropActions, customShape: customShapeSelect, family: typeFont, style: typeStyle, typeActions, measure: measure.bar }} fg={fg} depth={doc?.depth} />}
          {doc && <TabBar doc={doc} switchTo={key => run(null, () => client.call('switchDoc', key))} close={key => void closeTab(key)}
            move={(key, to) => run(null, () => client.call('moveDoc', key, to))} />}
          <DocumentArrangement
            mode={arrangeMode} documents={doc?.docs ?? []} activeKey={doc?.key ?? null}
            views={tabState.current} revision={`${doc?.key ?? ''}:${doc?.version ?? 0}:${arrangeRevision}`}
            activate={key => void run(null, () => client.call('switchDoc', key))}
            saveView={saveArrangementView} onError={setError}
            primary={<div className={`stage${showRulers ? ' with-rulers' : ''}`} >
            <canvas ref={canvas} className="view" style={{ filter: channelFilter }} onContextMenu={e => {
              e.preventDefault();
              if (transformRef.current || (e.ctrlKey && e.altKey) || !has) return;
              setCanvasMenu([e.clientX, e.clientY]);
            }} />
            <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
              <filter id="channel-view" colorInterpolationFilters="sRGB">
                <feColorMatrix type="matrix" values={channelMatrix ?? '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0'} />
              </filter>
            </svg>
            <canvas ref={inkCanvas} className="overlay ink" />
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
                  <button className="primary" onClick={() => void openFiles()}>Open image…</button>
                  <button onClick={() => newDialog.current?.showModal()}>New image</button>
                </div>
                <div
                  className={`drop-hint${dragOver ? ' over' : ''}`}
                  onDragEnter={() => setDragOver(true)}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false); }}
                  onDrop={() => setDragOver(false)}
                >
                  Drop an image here
                  <small>PNG, JPEG, WebP, GIF, BMP, AVIF, SVG, ICO, PSD, PSB, EXR, HDR or PDF</small>
                </div>
                <small className="copyright">
                  © 2026 IT-BAER ·{' '}
                  <a href={`https://github.com/IT-BAER/photobaer/releases/tag/v${__APP_VERSION__}`} target="_blank" rel="noreferrer">What's new</a> · v{__APP_VERSION__} ·{' '}
                  <a href="https://github.com/IT-BAER/photobaer" target="_blank" rel="noreferrer" aria-label="photobaer on GitHub" title="GitHub">
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
                  </a>
                  <br />
                  <a href="/impressum/" target="_blank" rel="noreferrer">Legal Notice</a> · <a href="/privacy/" target="_blank" rel="noreferrer">Privacy</a> ·{' '}
                  <a href="/terms/" target="_blank" rel="noreferrer">Terms</a> · <a href="/licenses/" target="_blank" rel="noreferrer">License</a>
                </small>
              </div>
            )}
            {busy && <div className="busy">{busy}</div>}
            {error && <div className="error" role="alert" onClick={() => setError(null)}>{error}</div>}
          </div>}
          />
        </div>
        <aside className="sidebar">
          <DockSection {...sec('tabs', 'Color panels')} header={<div className="panel-tabs dock-tabs">
            <button className={`panel-tab${dockTab === 'color' ? ' active' : ''}`} disabled={workspace.locked} onClick={() => guardedSetDockTab('color')}>Color</button>
            <button className={`panel-tab${dockTab === 'swatches' ? ' active' : ''}`} disabled={workspace.locked} onClick={() => guardedSetDockTab('swatches')}>Swatches</button>
            <button className={`panel-tab${dockTab === 'brushSettings' ? ' active' : ''}`} disabled={workspace.locked} title="Brush Settings (F5)" onClick={() => guardedSetDockTab('brushSettings')}>Brush Settings</button>
            <button className={`panel-tab${dockTab === 'brushes' ? ' active' : ''}`} disabled={workspace.locked} onClick={() => guardedSetDockTab('brushes')}>Brushes</button>
          </div>}>
          {dockTab === 'color' && <ColorPanel fg={fg} bg={bg} setFg={setFg} setBg={setBg} swap={swapColors} reset={resetColors} doc={doc} convert={convertColor} />}
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
              openSettings={() => guardedSetDockTab('brushSettings')}
            />
          )}
          </DockSection>
          {doc && active && showAdjustments && <DockSection {...sec('adjustments', 'Adjustments')}><AdjustmentsPanel create={newAdjustmentLayer} fill={quickFillLayer} patternOff={!doc.patterns.length} /></DockSection>}
          {doc && showStyles && <DockSection {...sec('styles', 'Styles')}><StylesPanel styles={styleLib.current} node={node ?? null} apply={applySavedStyle} /></DockSection>}
          {doc && active && showPatterns && (
            <DockSection {...sec('patterns', 'Patterns')}><PatternsPanel doc={doc} library={brushLib.current?.library ?? null} onDoc={d => show(d)} onError={setError}
              fill={id => panelFillLayer({ type: 'pattern', pattern_id: id, scale: 1, angle: 0, linked: true, offset: [0, 0] })} /></DockSection>
          )}
          {doc && active && showGradients && <DockSection {...sec('gradients', 'Gradients')}><GradientsPanel presets={gradLib.current.list()} fg={fg} bg={bg} fill={gradientFillLayer} /></DockSection>}
          {doc && showCloneSource && <DockSection {...sec('cloneSource', 'Clone Source')}><CloneSourcePanel docKey={doc.key} /></DockSection>}
          {doc && showNavigator && <DockSection {...sec('navigator', 'Navigator')}><NavigatorPanel doc={doc} viewer={viewer.current} view={fullView} /></DockSection>}
          {showHistogram && <DockSection {...sec('histogram', 'Histogram')}><HistogramPanel doc={doc} /></DockSection>}
          {showInfo && <DockSection {...sec('info', 'Info')}><InfoPanel doc={doc} canvas={canvas} viewer={viewer} /></DockSection>}
          {showNotes && <DockSection {...sec('notes', 'Notes')}><NotesPanel doc={doc} selected={measure.selectedNote} select={measure.setSelectedNote} commit={(a, label) => void measure.commit(a, label)} /></DockSection>}
          {showMeasurementLog && <DockSection {...sec('measurementLog', 'Measurement Log')}><MeasurementLogPanel rows={measure.log} setRows={measure.setLog} record={() => void measure.record()} canRecord={!!doc} download={downloadBlob} points={measure.points} /></DockSection>}
          {showToolPresets && <DockSection {...sec('toolPresets', 'Tool Presets')}><ToolPresetsPanel library={toolPresetLibrary} currentTool={tool}
            create={createToolPreset} rename={renameSavedToolPreset} apply={applySavedToolPreset} remove={deleteSavedToolPreset}
            importJson={importSavedToolPresets} exportJson={() => exportToolPresets(toolPresetLibrary)} onError={setError} /></DockSection>}
          {doc && showShapes && (
            <DockSection {...sec('shapes', 'Shapes')}><ShapesPanel selected={String((optionsByTool.customShape ?? loadToolOptions(TOOLS.customShape)).customShape ?? '')} arm={armShape} /></DockSection>
          )}
          {doc && showProperties && (
            <DockSection {...sec('properties', 'Properties')}>
              {node?.kind === 'adjustment' && node.adjustment && (
                <PropertiesPanel doc={doc} node={node} run={run} openGradientEditor={(g, ok) => gradEditor.current?.open(g, ok)} pickLookupFile={pickLookupFile} sampleCanvas={sampleCanvas} />
              )}
              {node?.kind === 'text' && node.text && <TypeProperties c={typeCtx} faces={pickFaces} />}
              {node?.artboard && <ArtboardPanel node={node} run={run} />}
              {node?.kind === 'shape' && node.shape && <ShapePanel key={node.id} node={node} run={run} fg={fg} selected={selectedNodes} />}
              {node?.vector_mask && <VectorMaskPanel key={`vm${node.id}`} node={node} run={run} />}
              {node?.kind === 'smart' && node.smart && (
                <SmartFiltersPanel key={node.id} node={node} run={run} openGradientEditor={(g, ok) => gradEditor.current?.open(g, ok)} pickLookupFile={pickLookupFile} sampleCanvas={sampleCanvas} openLiquify={openLiquify} openVanishingPoint={openVanishingPoint} />
              )}
              {!(node && ((node.kind === 'adjustment' && node.adjustment) || (node.kind === 'text' && node.text) || node.artboard || (node.kind === 'shape' && node.shape) || node.vector_mask || (node.kind === 'smart' && node.smart)))
                && <p className="panel-empty">No properties</p>}
            </DockSection>
          )}
          {doc && typePanels.character && (
            <DockSection {...sec('character', 'Character')}><CharacterPanel c={typeCtx} faces={pickFaces} eastAsian={typePrefs.language === 'eastAsian'}
              toolOptions={optionsByTool[typeTool] ?? loadToolOptions(TOOLS[typeTool])} setToolOption={(k, v) => patchToolOptions(typeTool, { [k]: v as string | number })} /></DockSection>
          )}
          {doc && typePanels.paragraph && <DockSection {...sec('paragraph', 'Paragraph')}><ParagraphPanel c={typeCtx} /></DockSection>}
          {doc && typePanels.characterStyles && <DockSection {...sec('characterStyles', 'Character Styles')}><TextStylesPanel kind="character" c={typeCtx} /></DockSection>}
          {doc && typePanels.paragraphStyles && <DockSection {...sec('paragraphStyles', 'Paragraph Styles')}><TextStylesPanel kind="paragraph" c={typeCtx} /></DockSection>}
          {doc && typePanels.glyphs && <DockSection {...sec('glyphs', 'Glyphs')}><GlyphsPanel c={typeCtx} faces={pickFaces} /></DockSection>}
          {doc && active && (
            <>
              <DockSection {...sec('layers', 'Layers')}><LayersPanel
                doc={doc} active={active} setActive={setActive} run={run}
                selected={selectedNodes.map(n => n.id)} setPicked={setPicked}
                contextItems={(n, nodes) => [...typeContextItems(n, { ...typeCtx, selected: nodes }), ...layerRowItems(menus, layerContextItems(n, nodes, run, setError))]}
                newLayer={newLayer} newGroup={newGroup}
                deleteLayer={deleteLayer} deleteDisabled={deleteDisabled} addMask={addMask}
                openProperties={() => setShowProperties(true)} renameTick={renameTick}
                openLayerStyle={(id, page) => openLayerStyle(page, id)}
              /></DockSection>
              <DockSection {...sec('history', 'History')}><HistoryPanel history={doc.history} goto={n => run(null, () => client.call('historyGoto', n))} /></DockSection>
              {showChannels && <DockSection {...sec('channels', 'Channels')}><ChannelsPanel doc={doc} run={run} live={selEdit ? liveTick : 0} view={channelView} setView={setChannelView} setError={setError} active={active} setActive={setActive} /></DockSection>}
              {showLayerComps && <DockSection {...sec('layerComps', 'Layer Comps')}><LayerCompsPanel doc={doc} run={run} /></DockSection>}
              {showActions && <DockSection {...sec('actions', 'Actions')}><ActionsPanel has active={active} run={run} setError={setError} /></DockSection>}
              {showPaths && <DockSection {...sec('paths', 'Paths')}><PathsPanel doc={doc} node={node ?? null} fg={fg} run={run} selected={pathSel.selected} setSelected={(id, cleared = false) => setPathSel({ selected: id, cleared })} /></DockSection>}
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
      <ColorPicker ref={picker} convert={convertColor} />
      <GradientEditor ref={gradEditor} presets={gradLib.current.list()} fg={fg} bg={bg} pickColor={(rgb, title, commit) => picker.current?.open(rgb, title, commit)} />
      <FillDialog
        fillDialog={fillDialog} endPreviewDialog={endPreviewDialog} previewRef={previewRef} fillForm={fillForm} setFillForm={setFillForm}
        picker={picker} brushLib={brushLib} depth={doc?.depth}
      />
      <StrokeDialog
        strokeDialog={strokeDialog} endPreviewDialog={endPreviewDialog} previewRef={previewRef} strokeForm={strokeForm} setStrokeForm={setStrokeForm}
        picker={picker} depth={doc?.depth}
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
      <input ref={fileInput} type="file" multiple hidden accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,image/svg+xml,image/x-icon,application/pdf,.psd,.psb,.exr,.hdr,.svg,.ico,.pdf"
        onChange={async e => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; for (const f of fs) await open(f); }} />
      <NewImageDialog newDialog={newDialog} createNew={createNew} />
      <CloseDialog closeDialog={closeDialog} name={closeName} choose={chooseClose} />
      <MergeDialog mergeDialog={mergeDialog} depth={mergeDepth} choose={chooseMerge} />
      <AboutDialog aboutDialog={aboutDialog} />
      {searchOpen && <SearchDialog menus={menus} close={() => setSearchOpen(false)} />}
      <DonateDialog donateDialog={donateDialog} />
      <AgentDialog agentDialog={agentDialog} />
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
      <ImageSizeDialog imageSizeDialog={imageSizeDialog} doc={doc} run={run} />
      <CanvasSizeDialog canvasSizeDialog={canvasSizeDialog} doc={doc} run={run} fg={fg} bg={bg} />
      <NewGuideDialog newGuideDialog={newGuideDialog} run={run} doc={doc} rulerUnit={prefs.current.rulerUnit} />
      <CursorPrefsDialog key={cursorRev} dialog={cursorPrefsDialog} prefs={prefs.current} save={p => {
        prefs.current = { ...prefs.current, ...p };
        savePreferences(prefs.current);
        setCursorRev(r => r + 1);
      }} />
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
      <ImageCalcDialog ref={imageCalc} doc={doc} show={d => show(d)} setError={m => setError(m)} />
      <ModeDialog ref={modeDialog} doc={doc} library={brushLib.current?.library ?? null} fg={fg} bg={bg} show={d => show(d)} setError={m => setError(m)} />
      <ColorDialog ref={colorDialog} doc={doc} show={d => show(d)} setError={m => setError(m)} />
      <PdfDialog ref={pdfDialog} setError={m => setError(m)} />
      <SvgDialog ref={svgDialog} setError={m => setError(m)} />
      <BatchDialog ref={batchDialog} start={o => void runBatch(o)} />
      <ImageProcessorDialog ref={imageProcessorDialog} start={o => void runImageProcessor(o)} />
      <LoadStackDialog ref={loadStackDialog} start={(f, a, sm) => void loadStack(f, a, sm)} />
      <WorkspaceDialog ref={workspaceDialog} act={workspaceAction} />
      <ExportAsDialog ref={exportAsDialog} start={(rows, target) => void runExportAs(rows, target)} />
      <SaveForWebDialog ref={saveForWebDialog} size={[doc?.width ?? 1, doc?.height ?? 1]} start={runSaveForWeb} />
      <ExportPrefsDialog ref={exportPrefsDialog} />
      <FilesExportDialog ref={filesExportDialog} start={runFilesExport} />
      <FileInfoDialog ref={fileInfoDialog} commit={i => run(null, () => client.call('setFileInfo', i))} />
      <VariablesDialog ref={variablesDialog} commit={commitVariables} importInto={importInto} exportCsv={saveSetsCsv} />
      <AnalysisDialogs ref={analysisDialog} annotations={doc?.annotations ?? null} size={doc ? [doc.width, doc.height] : null} rulerLength={measure.rulerLength}
        points={measure.points} setPoints={measure.setPoints} commit={(a, label) => void measure.commit(a, label)}
        placeMarker={(rect, color, text) => void run('Placing scale marker…', () => client.call('placeScaleMarker', rect, color, text))} />
      <ImportDataSetsDialog ref={importSetsDialog} />
      <ApplyDataSetDialog ref={applySetDialog} apply={name => void run(null, () => applySet(name))} />
      <PrintDialog ref={printDialog} settings={printSettings.current} start={s => void printDoc(s)} />
      <LiquifyDialog ref={liquifyDialog} show={d => show(d)} setError={m => setError(m)} />
      <VanishingPointDialog ref={vpDialog} show={d => show(d)} setError={m => setError(m)} />
      <FilterBlendDialog
        filterBlendDialog={filterBlendDialog} setFilterBlend={setFilterBlend} filterBlend={filterBlend} run={run} filters={filters}
      />
      <ScaleEffectsDialog scaleEffectsDialog={scaleEffectsDialog} node={node} run={run} />
      <RotateDialog rotateDialog={rotateDialog} run={run} />
      <AutomateDialog dialog={automateDialog} kind={automate} ids={selectedNodes.filter(n => n.kind === 'pixel').map(n => n.id)} docCount={doc?.docs.length ?? 0} run={run} />
      <ColorRangeDialog
        colorRangeDialog={colorRangeDialog} setColorRangeOpen={setColorRangeOpen} active={active} colorRangeSamples={colorRangeSamples}
        closeColorRange={closeColorRange} run={run} colorRange={colorRange} setColorRange={setColorRange} colorRangeCanvas={colorRangeCanvas}
        colorRangePreview={colorRangePreview} setColorRangeSamples={setColorRangeSamples}
      />
    </div>
  );
}
