import type { Dispatch, RefObject, SetStateAction } from 'react';
import { client } from '../client.ts';
import { flatNodes, locate } from '../layers.ts';
import type { Active } from '../LayersPanel.tsx';
import type { StylePage } from '../LayerStyleDialog.tsx';
import { EFFECT_KINDS, EFFECT_LABEL } from '../layerStyle.ts';
import { ADJUSTMENT_KINDS, MENU_LABEL, SHORTCUT, type DestructiveKind, type Kind } from '../adjustments.ts';
import type { Rgb } from '../shell/color.ts';
import { MODES, type TransformBarStore, type WarpSplit } from '../shell/TransformBar.tsx';
import type { Command, Mode } from '../transform/session.ts';
import type { Viewer } from '../viewer.ts';
import { filterOff, GROUPS, menuLabel, type FilterSpec } from '../filters/schema.ts';
import type { DocInfo, LayerNode, SmartFilterInfo, SmartInfo } from '../worker/types.ts';
import type { SnapSettings } from '../shell/snapping.ts';
import type { ArtboardMode, AutomateKind } from './Dialogs.tsx';
import { exportPrefs, FORMAT_LABEL, type FilesKind } from '../ExportDialogs.tsx';
export type ExportKind = 'as' | 'web' | 'prefs' | FilesKind;
import { ALIGN_ITEMS, STACK_MODES, selectCreated, type FillContentForm, type Item, type MODIFY_OPS, type Run } from './helpers.ts';
import { combineItems, rasterizeItems, vectorMaskItems } from './vectorCommands.ts';
import { copy, paste } from './clipboard.ts';
import { stepTab } from './tabs.ts';
import type { Recent } from './files.ts';
import type { ModeDialogKind } from '../ModeDialog.tsx';
import type { ColorDialogKind } from '../ColorDialog.tsx';
import { DEFAULT_VIEW, PROOF_PRESETS, presetSetup, type ViewState } from './proof.ts';
import { BUILTIN_WORKSPACES, type WorkspaceState } from './workspaces.ts';
import type { ArrangeMode, MatchKind } from './arrange.ts';

type SetState<T> = Dispatch<SetStateAction<T>>;
type DialogRef = RefObject<HTMLDialogElement | null>;
type Mime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface MenuCtx {
  setMenu: SetState<string | null>; newDialog: DialogRef; openFiles: () => Promise<void>; placeFile: (linked: boolean) => Promise<void>;
  has: boolean; active: Active | null; save: () => Promise<boolean>; saveAs: () => void; saveCopy: () => void;
  revert: () => Promise<void>; revertOff: boolean; recent: Recent[] | null; openRecent: (r: Recent) => Promise<void>; clearRecent: () => void;
  quickExport: () => void; quickExportLayer: () => void; openLayerExport: () => void; openExport: (k: ExportKind) => void; pathsToSvg: () => void; exportLayerComps: (mime: Mime, ext: string) => Promise<void>;
  doc: DocInfo | null; closeTab: () => Promise<void>; closeTabs: (which: 'all' | 'others') => Promise<void>; renameLayer: () => void; run: Run; openPreviewDialog: (which: 'fill' | 'stroke') => void;
  contentAwareFill: (dialog: boolean) => void;
  quickFill: (rgb: Rgb, label: string) => void; fg: Rgb; bg: Rgb; quickMask: boolean; selEdit: boolean; startTransform: (mode?: Mode, selection?: boolean) => Promise<void>;
  transformAgain: () => void; transformStore: TransformBarStore | null; transformMode: (m: Mode) => void; warping: boolean;
  warpMenuSplit: (mode: WarpSplit) => void; transformRemap: (c: Command, label: string) => void;
  newLayer: () => void; newGroup: () => void; duplicateLayer: () => void; deleteLayer: () => void; deleteDisabled: boolean;
  groupLayers: () => void; ungroupLayers: () => void; node: LayerNode | undefined; toggleClipping: () => void; addMask: () => void;
  deleteMask: () => void; toggleMaskEnabled: () => void; openNewFillLayer: (type: FillContentForm['type']) => void;
  newAdjustmentLayer: (kind: Kind) => void; openLayerContentOptions: () => void; smart: SmartInfo | undefined;
  editContents: (id: number) => Promise<void>; replaceContents: (relink: boolean) => Promise<void>; exportContents: () => Promise<void>;
  convertToLinked: () => Promise<void>; anyLinked: boolean; toggleLabel: string;
  filterCommand: (op: 'toggle' | 'clear' | 'deleteMasks' | 'toggleMasks', label: string) => () => void; filters: SmartFilterInfo[];
  filterMasks: boolean; maskLabel: string; openFilterBlend: () => void; openLayerStyle: (page: StylePage, id?: number) => void;
  globalLightDialog: DialogRef; allEffectsHidden: boolean; anyStyled: boolean; scaleEffectsDialog: DialogRef;
  openAutomate: (kind: AutomateKind) => void; openBatch: () => void; openImageProcessor: () => void; openLoadStack: () => void; browseScript: () => void; scriptRunning: boolean;
  assetsOn: boolean; toggleImageAssets: () => void; packageDoc: () => void; openVariables: (tab: 'define' | 'sets') => void; openApplyDataSet: () => void; openImportSets: () => void; openFileInfo: () => void; openPrint: () => void; printOneCopy: () => void;
  openAnalysis: (kind: 'scale' | 'points' | 'marker') => void; recordMeasurements: () => void; chooseTool: (id: string) => void;
  openAdjust: (kind: Kind | DestructiveKind) => void; hostOff: boolean; pixelsOff: boolean; openImageCalc: (calc: boolean) => void; openModeDialog: (kind: ModeDialogKind) => void; convertDepth: (depth: 8 | 16 | 32) => void; openColorDialog: (kind: ColorDialogKind) => void; applyDestructive: (kind: DestructiveKind) => void;
  rotateDialog: DialogRef; trimDialog: DialogRef; imageSizeDialog: DialogRef; canvasSizeDialog: DialogRef; openColorRange: () => void; openModify: (op: keyof typeof MODIFY_OPS) => void;
  featherDialog: DialogRef; growOrSimilar: (op: 'grow' | 'similar') => () => void; setQuickMask: SetState<boolean>;
  loadSelDialog: DialogRef; saveSelDialog: DialogRef; viewer: RefObject<Viewer | null>;
  filterSpecs: FilterSpec[]; openFilter: (spec: FilterSpec) => void; openLiquify: () => void; openVanishingPoint: () => void; openContentAwareScale: () => void; startDeform: (kind: 'puppet' | 'perspective') => void; lastFilter: () => void; openFade: () => void; openSearch: () => void;
  showAnts: boolean; setShowAnts: SetState<boolean>; showAdjustments: boolean; setShowAdjustments: SetState<boolean>;
  showLayerComps: boolean; setShowLayerComps: SetState<boolean>; showChannels: boolean; setShowChannels: SetState<boolean>; showActions: boolean; setShowActions: SetState<boolean>; showPaths: boolean; setShowPaths: SetState<boolean>; showProperties: boolean; setShowProperties: SetState<boolean>;
  showStyles: boolean; setShowStyles: SetState<boolean>; showPatterns: boolean; setShowPatterns: SetState<boolean>;
  showGradients: boolean; setShowGradients: SetState<boolean>;
  showRulers: boolean; setShowRulers: SetState<boolean>; showPixelGrid: boolean; setShowPixelGrid: SetState<boolean>;
  showGuides: boolean; setShowGuides: SetState<boolean>; showGrid: boolean; setShowGrid: SetState<boolean>;
  workspace: WorkspaceState; chooseWorkspace: (name: string) => void; openWorkspaceDialog: (mode: 'save' | 'delete') => void;
  resetCurrentWorkspace: () => void; toggleWorkspaceLock: () => void;
  arrangeMode: ArrangeMode; chooseArrangement: (mode: ArrangeMode) => void; matchArrangement: (kind: MatchKind) => void;
  snap: SnapSettings; setSnap: (patch: Partial<SnapSettings>) => void;
  newGuideDialog: DialogRef; newGuideLayoutDialog: DialogRef; cursorPrefsDialog: DialogRef;
  openArtboard: (mode: ArtboardMode) => void; activeArtboard: LayerNode | null; selectedNodes: LayerNode[];
  showShapes: boolean; setShowShapes: SetState<boolean>; showCloneSource: boolean; setShowCloneSource: SetState<boolean>; showNavigator: boolean; setShowNavigator: SetState<boolean>; typeItems: Item[]; aboutDialog: DialogRef; agentDialog: DialogRef;
  showHistogram: boolean; setShowHistogram: SetState<boolean>; showInfo: boolean; setShowInfo: SetState<boolean>; showToolPresets: boolean; setShowToolPresets: SetState<boolean>; showNotes: boolean; setShowNotes: SetState<boolean>; showMeasurementLog: boolean; setShowMeasurementLog: SetState<boolean>;
}

// Image > Mode: the modes a conversion from the current one allows, the bit depths, and the Color Table.
function modeItems(doc: DocInfo | null, run: Run, open: (kind: ModeDialogKind) => void, convertDepth: (depth: 8 | 16 | 32) => void): Item[] {
  const cur = doc?.mode?.kind ?? (doc?.gray ? 'gray' : 'rgb');
  const deep = doc?.depth === 32, mark = (on: boolean, label: string) => `${on ? '✓ ' : ''}${label}`;
  const to = (mode: 'rgb' | 'gray' | 'cmyk' | 'lab' | 'multichannel') => () => run('Converting…', () => client.call('setColorMode', { mode }));
  return [
    { label: mark(cur === 'bitmap', 'Bitmap…'), run: () => open('bitmap'), off: cur !== 'gray' || deep },
    { label: mark(cur === 'gray', 'Grayscale'), run: to('gray') },
    { label: mark(cur === 'duotone', 'Duotone…'), run: () => open('duotone'), off: (cur !== 'gray' && cur !== 'duotone') || deep },
    { label: mark(cur === 'indexed', 'Indexed Color…'), run: () => open('indexed'), off: (cur !== 'rgb' && cur !== 'gray') || doc?.depth !== 8 },
    { label: mark(cur === 'rgb', 'RGB Color'), run: to('rgb'), off: cur === 'bitmap' },
    { label: mark(cur === 'cmyk', 'CMYK Color'), run: to('cmyk'), off: cur === 'bitmap' || deep },
    { label: mark(cur === 'lab', 'Lab Color'), run: to('lab'), off: cur === 'bitmap' || deep },
    { label: mark(cur === 'multichannel', 'Multichannel'), run: to('multichannel'), off: cur === 'bitmap' || deep },
    ...([8, 16, 32] as const).map((b, i) => ({
      label: mark(doc?.depth === b, `${b} Bits/Channel`), sep: i === 0, run: () => convertDepth(b),
      off: (b === 32 && cur !== 'rgb' && cur !== 'gray') || (b !== 8 && (cur === 'bitmap' || cur === 'indexed')),
    })),
    { label: 'Color Table…', sep: true, run: () => open('table'), off: cur !== 'indexed' },
  ];
}

// View > Proof Setup, Proof Colors, Gamut Warning and 32-bit Preview Options.
function viewProofItems(doc: DocInfo | null, run: Run, open: (kind: ColorDialogKind) => void): Item[] {
  const v = doc?.view ?? DEFAULT_VIEW, mark = (on: boolean, label: string) => `${on ? '✓ ' : ''}${label}`;
  const set = (patch: Partial<ViewState>) => () => run(null, () => client.call('setView', patch));
  return [
    {
      label: 'Proof Setup', keys: '›', run: () => {}, off: !doc, sub: [
        { label: mark(v.setup.id === 'custom', 'Custom…'), run: () => open('proof') },
        ...PROOF_PRESETS.map(([id, label, sep]) => ({ label: mark(v.setup.id === id, label), sep, run: set({ setup: presetSetup(id), proofColors: true }) })),
      ],
    },
    { label: mark(v.proofColors, 'Proof Colors'), keys: 'Ctrl+Y', run: set({ proofColors: !v.proofColors }), off: !doc },
    { label: mark(v.gamutWarning, 'Gamut Warning'), keys: 'Shift+Ctrl+Y', run: set({ gamutWarning: !v.gamutWarning }), off: !doc },
    { label: '32-bit Preview Options…', sep: true, run: () => open('hdr'), off: doc?.depth !== 32 },
  ];
}

export function buildMenus(c: MenuCtx) {
  const switchStep = (step: 1 | -1) => {
    setMenu(null);
    const key = stepTab(c.doc?.docs ?? [], step);
    if (key) void c.run(null, () => client.call('switchDoc', key));
  };
  const {
    setMenu, newDialog, openFiles, placeFile, has, active, save, saveAs, saveCopy, revert, revertOff, recent, openRecent, clearRecent, quickExport, quickExportLayer, openLayerExport, openExport, pathsToSvg, exportLayerComps, doc, closeTab, closeTabs, renameLayer, run,
    openPreviewDialog, contentAwareFill, quickFill, fg, bg, quickMask, selEdit, startTransform, transformAgain, transformStore, transformMode, warping, warpMenuSplit,
    transformRemap, newLayer, newGroup, duplicateLayer, deleteLayer, deleteDisabled, groupLayers, ungroupLayers, node, toggleClipping, addMask,
    deleteMask, toggleMaskEnabled, openNewFillLayer, newAdjustmentLayer, openLayerContentOptions, smart, editContents, replaceContents,
    exportContents, convertToLinked, anyLinked, toggleLabel, filterCommand, filters, filterMasks, maskLabel, openFilterBlend, openLayerStyle,
    openAutomate, openBatch, openImageProcessor, openLoadStack, browseScript, scriptRunning, assetsOn, toggleImageAssets, packageDoc, openVariables, openApplyDataSet, openImportSets, openFileInfo, openPrint, printOneCopy, openAnalysis, recordMeasurements, chooseTool, globalLightDialog, allEffectsHidden, anyStyled, scaleEffectsDialog, openAdjust, hostOff, pixelsOff, openImageCalc, openModeDialog, convertDepth, openColorDialog, applyDestructive, rotateDialog, trimDialog, imageSizeDialog, canvasSizeDialog,
    openColorRange, openModify, featherDialog, growOrSimilar, setQuickMask, loadSelDialog, saveSelDialog, viewer, showAnts, setShowAnts,
    showAdjustments, setShowAdjustments, showLayerComps, setShowLayerComps, showChannels, setShowChannels, showActions, setShowActions, showPaths, setShowPaths, showProperties, setShowProperties, showStyles, setShowStyles,
    showPatterns, setShowPatterns, showGradients, setShowGradients, showRulers, setShowRulers, showPixelGrid, setShowPixelGrid,
    showGuides, setShowGuides, showGrid, setShowGrid, newGuideDialog, newGuideLayoutDialog, cursorPrefsDialog, snap, setSnap, openArtboard, activeArtboard,
    selectedNodes, showShapes, setShowShapes, showCloneSource, setShowCloneSource, showNavigator, setShowNavigator, typeItems, filterSpecs, openFilter, openLiquify, openVanishingPoint, openContentAwareScale, startDeform, lastFilter, openFade, openSearch, aboutDialog, agentDialog,
    showHistogram, setShowHistogram, showInfo, setShowInfo, showToolPresets, setShowToolPresets, showNotes, setShowNotes, showMeasurementLog, setShowMeasurementLog,
    workspace, chooseWorkspace, openWorkspaceDialog, resetCurrentWorkspace, toggleWorkspaceLock,
    arrangeMode, chooseArrangement, matchArrangement,
  } = c;
  const workspaceTypeItems = typeItems.map(item => item.label === 'Panels'
    ? { ...item, sub: item.sub?.map(panel => ({ ...panel, off: workspace.locked })) }
    : item);
  const smartItems: Item[] = [
    { label: 'Convert to Smart Object', run: () => node && run('Converting…', () => client.call('convertToSmart', [node.id]), selectCreated), off: !node },
    { label: 'New Smart Object via Copy', run: () => node && run(null, () => client.call('smartViaCopy', node.id), selectCreated), off: !smart },
    { label: 'Edit Contents', sep: true, run: () => node && editContents(node.id), off: !smart },
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
    { label: 'Perspective Warp', sep: true, run: () => startDeform('perspective'), off: !smart },
    { label: 'Puppet Warp', run: () => startDeform('puppet'), off: !smart },
    { label: 'Rasterize', sep: true, run: () => node && run('Rasterizing…', () => client.call('rasterizeSmart', node.id, 'Rasterize')), off: !smart },
  ];

  const raster = rasterizeItems(selectedNodes, run);

  const smartFilterItems: Item[] = [
    { label: toggleLabel, run: filterCommand('toggle', toggleLabel), off: !filters.length },
    { label: 'Delete Filter Mask', run: filterCommand('deleteMasks', 'Delete Filter Mask'), off: !filterMasks },
    { label: maskLabel, run: filterCommand('toggleMasks', maskLabel), off: !filterMasks },
    { label: 'Blending Options…', sep: true, run: openFilterBlend, off: !filters.length },
    { label: 'Clear Smart Filters', sep: true, run: filterCommand('clear', 'Clear Smart Filters'), off: !filters.length },
  ];

  const menus: Record<string, Item[]> = {
    File: [
      { label: 'New…', keys: 'Alt+Ctrl+N', run: () => { setMenu(null); newDialog.current?.showModal(); } },
      { label: 'Open…', keys: 'Ctrl+O', run: () => void openFiles() },
      ...(recent ? [{
        label: 'Open Recent', keys: '›', run: () => {}, off: !recent.length, sub: [
          ...recent.map(r => ({ label: r.name, run: () => void openRecent(r) })),
          { label: 'Clear Recent File List', sep: recent.length > 0, run: clearRecent },
        ],
      }] : []),
      { label: 'Place Embedded…', run: () => void placeFile(false), off: !has || !active },
      { label: 'Place Linked…', run: () => void placeFile(true), off: !has || !active },
      { label: 'Package…', run: packageDoc, off: !has },
      {
        label: 'Import', keys: '›', run: () => {}, off: !has, sub: [
          { label: 'Variable Data Sets…', run: openImportSets },
        ],
      },
      { label: 'Save', keys: 'Ctrl+S', sep: true, run: () => void save(), off: !has },
      { label: 'Save As…', keys: 'Shift+Ctrl+S', run: saveAs, off: !has },
      { label: 'Save a Copy…', keys: 'Alt+Ctrl+S', run: saveCopy, off: !has },
      { label: 'Revert', keys: 'F12', run: () => void revert(), off: revertOff },
      {
        label: 'Export', keys: '›', run: () => {}, off: !has, sub: [
          { label: `Quick Export as ${FORMAT_LABEL[exportPrefs().format]}`, run: quickExport },
          { label: 'Export As…', keys: 'Alt+Shift+Ctrl+W', run: () => openExport('as') },
          { label: 'Export Preferences…', run: () => openExport('prefs') },
          { label: 'Save for Web (Legacy)…', keys: 'Alt+Shift+Ctrl+S', sep: true, run: () => openExport('web') },
          { label: 'Artboards to Files…', sep: true, run: () => openExport('artboards'), off: !doc?.layers.some(l => l.artboard) },
          { label: 'Artboards to PDF…', run: () => openExport('pdf'), off: !doc?.layers.some(l => l.artboard) },
          { label: 'Layers to Files…', run: () => openExport('layers'), off: !doc?.layers.length },
          { label: 'Layer Comps to Files (PNG)…', run: () => exportLayerComps('image/png', 'png'), off: !has || !doc?.layerComps.length },
          { label: 'Layer Comps to Files (JPEG)…', run: () => exportLayerComps('image/jpeg', 'jpg'), off: !has || !doc?.layerComps.length },
          { label: 'Layer Comps to Files (WebP)…', run: () => exportLayerComps('image/webp', 'webp'), off: !has || !doc?.layerComps.length },
          { label: 'Data Sets as Files…', sep: true, run: () => openExport('datasets'), off: !has },
          { label: 'Paths to SVG…', sep: true, run: pathsToSvg, off: !doc?.paths.length },
        ],
      },
      {
        label: 'Generate', keys: '›', run: () => {}, sub: [
          { label: `${assetsOn ? '✓ ' : ''}Image Assets`, run: toggleImageAssets },
        ],
      },
      {
        label: 'Automate', keys: '›', run: () => {}, sub: [
          { label: 'Batch…', run: openBatch },
          { label: 'Photomerge…', sep: true, run: () => openAutomate('photomerge'), off: !has },
          { label: 'Merge to HDR Pro…', run: () => openAutomate('hdr'), off: (doc?.docs.length ?? 0) < 2 },
        ],
      },
      {
        label: 'Scripts', keys: '›', run: () => {}, sub: [
          { label: 'Image Processor…', run: openImageProcessor },
          { label: 'Delete All Empty Layers', sep: true, run: () => run(null, () => client.call('deleteEmptyLayers')), off: !has },
          { label: 'Flatten All Layer Effects', run: () => run(null, () => client.call('flattenAllLayerEffects')), off: !has },
          { label: 'Flatten All Masks', run: () => run(null, () => client.call('flattenAllMasks')), off: !has },
          { label: 'Load Files into Stack…', sep: true, run: openLoadStack },
          { label: scriptRunning ? 'Stop Script' : 'Browse…', sep: true, run: browseScript },
        ],
      },
      { label: 'File Info…', keys: 'Alt+Shift+Ctrl+I', sep: true, run: openFileInfo, off: !has },
      { label: 'Print…', keys: 'Ctrl+P', sep: true, run: openPrint, off: !has },
      { label: 'Print One Copy', keys: 'Alt+Shift+Ctrl+P', run: printOneCopy, off: !has },
      { label: 'Close', sep: true, run: () => void closeTab(), off: !has },
      { label: 'Close All', run: () => void closeTabs('all'), off: !has },
      { label: 'Close Others', run: () => void closeTabs('others'), off: (doc?.docs.length ?? 0) < 2 },
    ],
    Edit: [
      { label: doc?.undoLabel ? `Undo ${doc.undoLabel}` : 'Undo', keys: 'Ctrl+Z', run: () => run(null, () => client.call('undo')), off: !doc?.undoLabel },
      { label: doc?.redoLabel ? `Redo ${doc.redoLabel}` : 'Redo', keys: 'Shift+Ctrl+Z', run: () => run(null, () => client.call('redo')), off: !doc?.redoLabel },
      { label: 'Fade…', keys: 'Shift+Ctrl+F', run: openFade, off: !doc?.undoLabel || !active || node?.kind !== 'pixel' },
      { label: 'Cut', keys: 'Ctrl+X', sep: true, run: () => active && copy(run, active, false, true), off: !doc?.selection || node?.kind !== 'pixel' },
      { label: 'Copy', keys: 'Ctrl+C', run: () => active && copy(run, active, false, false), off: !has || !active },
      { label: 'Copy Merged', keys: 'Shift+Ctrl+C', run: () => active && copy(run, active, true, false), off: !has || !active },
      { label: 'Paste', keys: 'Ctrl+V', run: (bytes?: Uint8Array | null) => active && paste(run, active, 'paste', bytes), off: !has || !active },
      {
        label: 'Paste Special', keys: '›', run: () => {}, off: !has || !active, sub: [
          { label: 'Paste in Place', keys: 'Shift+Ctrl+V', run: () => active && paste(run, active, 'inPlace') },
          { label: 'Paste Into', keys: 'Alt+Shift+Ctrl+V', run: () => active && paste(run, active, 'into'), off: !doc?.selection },
        ],
      },
      { label: 'Fill…', keys: 'Shift+F5', sep: true, run: () => openPreviewDialog('fill'), off: !has || !active },
      { label: 'Fill with Foreground Color', keys: 'Alt+Backspace', run: () => quickFill(fg, 'Fill with Foreground Color'), off: !has || !active },
      { label: 'Fill with Background Color', keys: 'Ctrl+Backspace', run: () => quickFill(bg, 'Fill with Background Color'), off: !has || !active },
      { label: 'Stroke…', run: () => openPreviewDialog('stroke'), off: !doc?.selection || !active },
      { label: 'Content-Aware Fill…', run: () => contentAwareFill(true), off: !has || !active },
      { label: 'Delete and Fill Selection', run: () => contentAwareFill(false), off: !has || !active },
      { label: 'Clear', keys: 'Delete', run: () => active && run('Clearing…', () => client.call('clearSelected', active.id, selEdit ? 'selection' : active.target)), off: !doc?.selection || !active },
      { label: 'Content-Aware Scale…', keys: 'Alt+Shift+Ctrl+C', run: openContentAwareScale, off: !has || !active },
      { label: 'Puppet Warp', run: () => startDeform('puppet'), off: !has || !active },
      { label: 'Perspective Warp', run: () => startDeform('perspective'), off: !has || !active },
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
      { label: 'Auto-Align Layers…', run: () => openAutomate('align'), off: selectedNodes.filter(n => n.kind === 'pixel').length < 2 },
      { label: 'Auto-Blend Layers…', run: () => openAutomate('blend'), off: selectedNodes.filter(n => n.kind === 'pixel').length < 2 },
      { label: 'Color Settings…', keys: 'Shift+Ctrl+K', sep: true, run: () => openColorDialog('settings') },
      { label: 'Assign Profile…', run: () => openColorDialog('assign'), off: !has || (!!doc?.mode && doc.mode.kind !== 'cmyk') },
      { label: 'Convert to Profile…', run: () => openColorDialog('convert'), off: !has || (!!doc?.mode && doc.mode.kind !== 'cmyk') },
      { label: 'Search…', keys: 'Ctrl+F', sep: true, run: () => { setMenu(null); openSearch(); } },
      { label: 'Preferences', keys: '›', sep: true, run: () => {}, sub: [{ label: 'Cursors…', run: () => { setMenu(null); cursorPrefsDialog.current?.showModal(); } }] },
    ],
    Layer: [
      { label: 'New Layer', run: newLayer, off: !has },
      { label: 'New Group', run: newGroup, off: !has },
      // Ctrl+J: the selected pixels as a new layer, or the whole layer when there is no pixel selection (Photoshop).
      { label: 'Layer via Copy', keys: 'Ctrl+J', run: () => doc?.selection && node?.kind === 'pixel' && active ? run(null, () => client.call('layerViaCopy', active.id), selectCreated) : duplicateLayer(), off: !has || !active },
      { label: 'Layer via Cut', keys: 'Shift+Ctrl+J', run: () => active && run(null, () => client.call('layerViaCut', active.id), selectCreated), off: !has || !active || !doc?.selection || node?.kind !== 'pixel' },
      { label: 'Duplicate Layer', run: duplicateLayer, off: !has },
      { label: 'Rename Layer', run: renameLayer, off: !has || !active },
      { label: `Quick Export as ${FORMAT_LABEL[exportPrefs().format]}`, keys: "Shift+Ctrl+'", sep: true, run: quickExportLayer, off: !node },
      { label: 'Export As…', keys: "Alt+Shift+Ctrl+'", run: openLayerExport, off: !selectedNodes.length },
      {
        label: 'Delete', keys: '›', run: () => {}, off: !has, sub: [
          { label: 'Layer', run: deleteLayer, off: deleteDisabled },
          { label: 'Hidden Layers', run: () => run(null, () => client.call('deleteHiddenLayers')), off: !has || !flatNodes(doc?.layers ?? []).some(n => !n.visible) },
        ],
      },
      { label: 'Group Layers', keys: 'Ctrl+G', run: groupLayers, off: !has },
      { label: 'Ungroup Layers', keys: 'Shift+Ctrl+G', run: ungroupLayers, off: !has || node?.kind !== 'group' },
      { label: 'Lock All Layers in Group', run: () => node && run(null, () => client.call('setLocks', flatNodes(node.children ?? []).map(n => n.id), { transparency: true, pixels: true, position: true })), off: !has || node?.kind !== 'group' },
      {
        label: 'Arrange', keys: '›', sep: true, run: () => {}, off: !has || !selectedNodes.length, sub: ([
          ['front', 'Bring to Front', 'Shift+Ctrl+]'], ['forward', 'Bring Forward', 'Ctrl+]'], ['backward', 'Send Backward', 'Ctrl+['], ['back', 'Send to Back', 'Shift+Ctrl+['],
        ] as const).map(([mode, label, keys]) => ({ label, keys, run: () => run(null, () => client.call('arrangeNodes', selectedNodes.map(n => n.id), mode)) })),
      },
      ...([['Align', 1, ALIGN_ITEMS.slice(0, 6)], ['Distribute', 3, ALIGN_ITEMS.slice(6)]] as const).map(([label, min, items]) => ({
        label, keys: '›', run: () => {}, off: !has || selectedNodes.length < min,
        sub: items.map(([mode, text]) => ({ label: text, run: () => run(null, () => client.call('alignLayers', selectedNodes.map(n => n.id), mode)) })),
      })),
      selectedNodes.length > 1
        ? { label: 'Merge Layers', keys: 'Ctrl+E', sep: true, run: () => run(null, () => client.call('mergeNodes', selectedNodes.map(n => n.id), 'layers')), off: !has }
        : { label: node?.kind === 'group' ? 'Merge Group' : 'Merge Down', keys: 'Ctrl+E', sep: true, run: () => node && run(null, () => client.call('mergeNodes', [node.id], 'down')), off: !has || !node || (node.kind !== 'group' && !locate(doc!.layers, node.id)?.index) },
      { label: 'Merge Visible', keys: 'Shift+Ctrl+E', run: () => run(null, () => client.call('mergeNodes', [], 'visible')), off: !has },
      { label: 'Stamp Visible', keys: 'Alt+Shift+Ctrl+E', run: () => run(null, () => client.call('mergeNodes', [], 'stamp')), off: !has },
      { label: 'Flatten Image', run: () => run(null, () => client.call('mergeNodes', [], 'flatten')), off: !has },
      { label: node?.clipping ? 'Release Clipping Mask' : 'Create Clipping Mask', keys: 'Alt+Ctrl+G', run: toggleClipping, off: !has },
      { label: 'Add Layer Mask', run: addMask, off: !has || !!node?.mask },
      { label: 'Delete Layer Mask', run: deleteMask, off: !has || !node?.mask },
      { label: node?.mask?.enabled === false ? 'Enable Layer Mask' : 'Disable Layer Mask', run: toggleMaskEnabled, off: !has || !node?.mask },
      { label: 'Vector Mask', keys: '›', run: () => {}, off: !doc || !selectedNodes.length, sub: doc ? vectorMaskItems(doc, selectedNodes, run) : [] },
      { label: 'Combine Shapes', keys: '›', run: () => {}, off: !selectedNodes.some(n => n.kind === 'shape'), sub: combineItems(selectedNodes, run) },
      {
        label: 'New Artboard', keys: '›', run: () => {}, off: !has, sep: true, sub: [
          { label: 'Artboard…', run: () => openArtboard('new') },
          { label: 'Artboard from Group…', run: () => openArtboard('fromGroup'), off: node?.kind !== 'group' || !!node.artboard },
          { label: 'Artboard from Layers…', run: () => openArtboard('fromLayers'), off: !node || !!activeArtboard },
        ],
      },
      {
        label: 'New Fill Layer', keys: '›', run: () => {}, off: !has || !active, sub: [
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
      { label: 'Smart Filter', keys: '›', run: () => {}, off: !has || !smart, sub: smartFilterItems },
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
        label: 'Rasterize', keys: '›', run: () => {}, off: !has || !node, sub: [
          raster[0], raster[1],
          { label: 'Fill Content', run: () => active && run('Rasterizing…', () => client.call('rasterizeFill', active.id)), off: node?.kind !== 'fill' },
          raster[2],
          { label: 'Smart Object', run: () => active && run('Rasterizing…', () => client.call('rasterizeSmart', active.id, 'Smart Object')), off: node?.kind !== 'smart' },
        ],
      },
    ],
    Type: workspaceTypeItems,
    Image: [
      {
        label: 'Mode', keys: '›', run: () => {}, off: !has, sub: modeItems(doc, run, openModeDialog, convertDepth),
      },
      {
        label: 'Adjustments', sep: true, keys: '›', run: () => {}, off: !has || !active, sub: ADJUSTMENT_KINDS.map<Item>(kind => kind === 'invert'
          ? { label: 'Invert', keys: 'Ctrl+I', sep: true, run: () => run('Inverting…', () => client.call('command', 'invert', active!.id, selEdit ? 'selection' : active!.target)) }
          : { label: `${MENU_LABEL[kind]}…`, keys: SHORTCUT[kind], run: () => openAdjust(kind), off: hostOff }).concat([
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
      { label: 'Image Size…', keys: 'Alt+Ctrl+I', sep: true, run: () => { setMenu(null); imageSizeDialog.current?.showModal(); }, off: !has },
      { label: 'Canvas Size…', keys: 'Alt+Ctrl+C', run: () => { setMenu(null); canvasSizeDialog.current?.showModal(); }, off: !has },
      {
        label: 'Image Rotation', keys: '›', run: () => {}, off: !has, sub: [
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
      { label: 'Apply Image…', sep: true, run: () => openImageCalc(false), off: pixelsOff },
      { label: 'Calculations…', run: () => openImageCalc(true), off: !has },
      {
        label: 'Variables', keys: '›', sep: true, run: () => {}, off: !has, sub: [
          { label: 'Define…', run: () => openVariables('define') },
          { label: 'Data Sets…', run: () => openVariables('sets') },
        ],
      },
      { label: 'Apply Data Set…', run: openApplyDataSet, off: !has },
      {
        label: 'Analysis', keys: '›', sep: true, run: () => {}, off: !has, sub: [
          { label: 'Set Measurement Scale…', run: () => openAnalysis('scale') },
          { label: 'Select Data Points…', run: () => openAnalysis('points') },
          { label: 'Record Measurements', keys: 'Shift+Ctrl+M', run: () => { setMenu(null); recordMeasurements(); } },
          { label: 'Ruler Tool', sep: true, run: () => { setMenu(null); chooseTool('ruler'); } },
          { label: 'Count Tool', run: () => { setMenu(null); chooseTool('count'); } },
          { label: 'Place Scale Marker…', sep: true, run: () => openAnalysis('marker') },
        ],
      },
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
    Filter: [
      { label: 'Last Filter', keys: 'Alt+Ctrl+F', run: lastFilter, off: !has || !active },
      { label: 'Convert for Smart Filters', sep: true, run: () => node && run('Converting…', () => client.call('convertForSmartFilters', node.id)), off: !has || node?.kind !== 'pixel' },
      { label: 'Filter Gallery…', sep: true, run: () => { const s = filterSpecs.find(s => s.id === 'gallery.filter_gallery'); if (s) openFilter(s); }, off: !has || !active || doc?.depth === 32 },
      { label: 'Adaptive Wide Angle…', keys: 'Alt+Shift+Ctrl+A', run: () => { const s = filterSpecs.find(s => s.id === 'tool.adaptive_wide_angle'); if (s) openFilter(s); }, off: !has || !active || doc?.depth === 32 },
      { label: 'Camera Raw Filter…', keys: 'Shift+Ctrl+A', run: () => { const s = filterSpecs.find(s => s.id === 'tool.camera_raw'); if (s) openFilter(s); }, off: !has || !active || doc?.depth === 32 },
      { label: 'Lens Correction…', keys: 'Shift+Ctrl+R', run: () => { const s = filterSpecs.find(s => s.id === 'tool.lens_correction'); if (s) openFilter(s); }, off: !has || !active || doc?.depth === 32 },
      { label: 'Liquify…', keys: 'Shift+Ctrl+X', run: openLiquify, off: !has || !active || doc?.depth === 32 },
      { label: 'Vanishing Point…', keys: 'Alt+Ctrl+V', run: openVanishingPoint, off: !has || !active || doc?.depth === 32 },
      ...GROUPS.map(([g, name]) => ({ name, specs: filterSpecs.filter(s => s.group === g) })).filter(g => g.specs.length).map((g, i) => ({
        label: g.name, keys: '›', sep: i === 0, run: () => {}, off: !has || !active || g.specs.every(s => filterOff(s, doc?.depth)),
        sub: g.specs.map(s => ({ label: menuLabel(s), run: () => openFilter(s), off: filterOff(s, doc?.depth) })),
      })),
    ],
    View: [
      ...viewProofItems(doc, run, openColorDialog),
      { label: 'Zoom in', keys: 'Ctrl++', sep: true, run: () => { setMenu(null); viewer.current?.zoomBy(2); }, off: !has },
      { label: 'Zoom out', keys: 'Ctrl+-', run: () => { setMenu(null); viewer.current?.zoomBy(0.5); }, off: !has },
      { label: 'Fit on screen', keys: 'Ctrl+0', run: () => { setMenu(null); viewer.current?.fit(); }, off: !has },
      {
        label: 'Fit Artboard on Screen', off: !activeArtboard, run: () => {
          setMenu(null);
          const r = activeArtboard?.artboard?.rect;
          if (r) viewer.current?.fitRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
        },
      },
      { label: '100%', keys: 'Ctrl+1', run: () => { setMenu(null); viewer.current?.actualPixels(); }, off: !has },
      { label: 'Reset rotation', keys: 'Esc', run: () => { setMenu(null); viewer.current?.resetRotation(); }, off: !has },
      { label: showAnts ? 'Hide selection edges' : 'Show selection edges', keys: 'Ctrl+H', run: () => { setMenu(null); setShowAnts(v => !v); }, off: !has },
      { label: showRulers ? 'Hide Rulers' : 'Show Rulers', keys: 'Ctrl+R', run: () => { setMenu(null); setShowRulers(v => !v); } },
      { label: showGuides ? 'Hide Guides' : 'Show Guides', keys: 'Ctrl+;', run: () => { setMenu(null); setShowGuides(v => !v); }, off: !has },
      { label: doc?.guidesLocked ? 'Unlock Guides' : 'Lock Guides', keys: 'Ctrl+Alt+;', run: () => run(null, () => client.call('setGuidesLocked', !doc?.guidesLocked)), off: !has },
      { label: 'Clear Guides', run: () => run(null, () => client.call('clearGuides', 'all', 0)), off: !doc?.guides.length },
      { label: 'Clear Canvas Guides', run: () => run(null, () => client.call('clearGuides', 'canvas', 0)), off: !doc?.guides.length },
      { label: 'Clear Selected Artboard Guides', run: () => activeArtboard && run(null, () => client.call('clearGuides', 'artboard', activeArtboard.id)), off: !activeArtboard?.artboard?.guide_ids.length },
      { label: 'New Guide…', run: () => { setMenu(null); newGuideDialog.current?.showModal(); }, off: !has },
      { label: 'New Guide Layout…', run: () => { setMenu(null); newGuideLayoutDialog.current?.showModal(); }, off: !has },
      { label: 'New Guides From Shape', run: () => node && run(null, () => client.call('newGuidesFromShape', [node.id])), off: !node },
      { label: showGrid ? 'Hide Grid' : 'Show Grid', keys: 'Ctrl+\'', sep: true, run: () => { setMenu(null); setShowGrid(v => !v); } },
      { label: showPixelGrid ? 'Hide Pixel Grid' : 'Show Pixel Grid', run: () => { setMenu(null); setShowPixelGrid(v => !v); } },
      { label: `${snap.smartGuides ? '✓ ' : ''}Smart Guides`, run: () => { setMenu(null); setSnap({ smartGuides: !snap.smartGuides }); } },
      { label: `${snap.enabled ? '✓ ' : ''}Snap`, keys: 'Ctrl+Shift+;', sep: true, run: () => { setMenu(null); setSnap({ enabled: !snap.enabled }); } },
      {
        label: 'Snap To', keys: '›', run: () => {}, off: !snap.enabled, sub: [
          ...([['guides', 'Guides'], ['grid', 'Grid'], ['layers', 'Layers'], ['documentBounds', 'Document Bounds'], ['artboards', 'Artboards']] as const).map(([k, label]) => ({
            label: `${snap[k] ? '✓ ' : ''}${label}`, run: () => { setMenu(null); setSnap({ [k]: !snap[k] }); },
          })),
          { label: 'All', sep: true, run: () => { setMenu(null); setSnap({ guides: true, grid: true, layers: true, documentBounds: true, artboards: true }); } },
          { label: 'None', run: () => { setMenu(null); setSnap({ guides: false, grid: false, layers: false, documentBounds: false, artboards: false }); } },
        ],
      },
    ],
    Window: [
      {
        label: 'Arrange', keys: '›', run: () => {}, sub: [
          { label: `${arrangeMode === 'tabs' ? '✓ ' : ''}Consolidate All to Tabs`, run: () => chooseArrangement('tabs'), off: !doc },
          { label: `${arrangeMode === 'vertical' ? '✓ ' : ''}Tile All Vertically`, sep: true, run: () => chooseArrangement('vertical'), off: (doc?.docs.length ?? 0) < 2 },
          { label: `${arrangeMode === 'horizontal' ? '✓ ' : ''}Tile All Horizontally`, run: () => chooseArrangement('horizontal'), off: (doc?.docs.length ?? 0) < 2 },
          ...([['2-up', '2-up'], ['3-up', '3-up'], ['4-up', '4-up'], ['6-up', '6-up']] as const).map(([mode, label], index) => ({
            label: `${arrangeMode === mode ? '✓ ' : ''}${label}`, sep: index === 0, run: () => chooseArrangement(mode), off: (doc?.docs.length ?? 0) < 2,
          })),
          { label: `${arrangeMode === 'float' ? '✓ ' : ''}Float All in Windows`, sep: true, run: () => chooseArrangement('float'), off: (doc?.docs.length ?? 0) < 2 },
          { label: 'Match Zoom', sep: true, run: () => matchArrangement('zoom'), off: (doc?.docs.length ?? 0) < 2 },
          { label: 'Match Location', run: () => matchArrangement('location'), off: (doc?.docs.length ?? 0) < 2 },
          { label: 'Match All', run: () => matchArrangement('all'), off: (doc?.docs.length ?? 0) < 2 },
        ],
      },
      {
        label: 'Workspace', keys: '›', sep: true, run: () => {}, sub: [
          ...BUILTIN_WORKSPACES.map(w => ({ label: `${workspace.selected === w.name ? '✓ ' : ''}${w.name}`, run: () => chooseWorkspace(w.name) })),
          ...workspace.custom.map((w, i) => ({ label: `${workspace.selected === w.name ? '✓ ' : ''}${w.name}`, sep: i === 0, run: () => chooseWorkspace(w.name) })),
          { label: 'New Workspace…', sep: true, run: () => openWorkspaceDialog('save') },
          { label: 'Delete Workspace…', run: () => openWorkspaceDialog('delete'), off: !workspace.custom.length },
          { label: `Reset ${workspace.selected}`, sep: true, run: resetCurrentWorkspace },
          { label: `${workspace.locked ? '✓ ' : ''}Lock Workspace`, run: toggleWorkspaceLock },
        ],
      },
      { label: showActions ? 'Hide Actions' : 'Show Actions', keys: 'Alt+F9', sep: true, run: () => { setMenu(null); setShowActions(v => !v); }, off: workspace.locked },
      { label: showAdjustments ? 'Hide Adjustments' : 'Show Adjustments', run: () => { setMenu(null); setShowAdjustments(v => !v); }, off: workspace.locked },
      { label: showChannels ? 'Hide Channels' : 'Show Channels', run: () => { setMenu(null); setShowChannels(v => !v); }, off: workspace.locked },
      { label: showCloneSource ? 'Hide Clone Source' : 'Show Clone Source', run: () => { setMenu(null); setShowCloneSource(v => !v); }, off: workspace.locked },
      { label: showNavigator ? 'Hide Navigator' : 'Show Navigator', run: () => { setMenu(null); setShowNavigator(v => !v); }, off: workspace.locked },
      { label: showLayerComps ? 'Hide Layer Comps' : 'Show Layer Comps', run: () => { setMenu(null); setShowLayerComps(v => !v); }, off: workspace.locked },
      { label: showPaths ? 'Hide Paths' : 'Show Paths', run: () => { setMenu(null); setShowPaths(v => !v); }, off: workspace.locked },
      { label: showProperties ? 'Hide Properties' : 'Show Properties', run: () => { setMenu(null); setShowProperties(v => !v); }, off: workspace.locked },
      { label: showStyles ? 'Hide Styles' : 'Show Styles', run: () => { setMenu(null); setShowStyles(v => !v); }, off: workspace.locked },
      { label: showPatterns ? 'Hide Patterns' : 'Show Patterns', run: () => { setMenu(null); setShowPatterns(v => !v); }, off: workspace.locked },
      { label: showGradients ? 'Hide Gradients' : 'Show Gradients', run: () => { setMenu(null); setShowGradients(v => !v); }, off: workspace.locked },
      { label: showShapes ? 'Hide Shapes' : 'Show Shapes', run: () => { setMenu(null); setShowShapes(v => !v); }, off: workspace.locked },
      { label: showHistogram ? 'Hide Histogram' : 'Show Histogram', run: () => { setMenu(null); setShowHistogram(v => !v); }, off: workspace.locked },
      { label: showInfo ? 'Hide Info' : 'Show Info', run: () => { setMenu(null); setShowInfo(v => !v); }, off: workspace.locked },
      { label: showToolPresets ? 'Hide Tool Presets' : 'Show Tool Presets', run: () => { setMenu(null); setShowToolPresets(v => !v); }, off: workspace.locked },
      { label: showNotes ? 'Hide Notes' : 'Show Notes', run: () => { setMenu(null); setShowNotes(v => !v); }, off: workspace.locked },
      { label: showMeasurementLog ? 'Hide Measurement Log' : 'Show Measurement Log', run: () => { setMenu(null); setShowMeasurementLog(v => !v); }, off: workspace.locked },
      { label: 'Next Document', keys: 'Ctrl+Tab', sep: true, run: () => switchStep(1), off: (doc?.docs.length ?? 0) < 2 },
      { label: 'Previous Document', keys: 'Shift+Ctrl+Tab', run: () => switchStep(-1), off: (doc?.docs.length ?? 0) < 2 },
      ...(doc?.docs ?? []).map((t, i) => ({
        label: `${t.active ? '✓ ' : ''}${i + 1} ${t.name}${t.dirty ? '*' : ''}`, sep: i === 0, run: () => { setMenu(null); if (!t.active) void run(null, () => client.call('switchDoc', t.key)); },
      })),
    ],
    Help: [
      { label: 'Use with AI Agents…', run: () => { setMenu(null); agentDialog.current?.showModal(); agentDialog.current?.querySelector<HTMLButtonElement>('.actions button')?.focus(); } },
      { label: 'About photobaer…', run: () => { setMenu(null); aboutDialog.current?.showModal(); aboutDialog.current?.querySelector('button')?.focus(); } },
    ],
  };
  return menus;
}
