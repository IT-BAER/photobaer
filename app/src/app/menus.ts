import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { i18n } from '../i18n/index.ts';
import { historyLabel } from '../i18n/history.ts';
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
import { filterOff, GROUPS, menuId, menuLabel, type FilterSpec } from '../filters/schema.ts';
import type { DocInfo, LayerNode, SmartFilterInfo, SmartInfo } from '../worker/types.ts';
import type { SnapSettings } from '../shell/snapping.ts';
import type { ArtboardMode, AutomateKind } from './Dialogs.tsx';
import { exportPrefs, FORMAT_LABEL, type FilesKind } from '../ExportDialogs.tsx';
export type ExportKind = 'as' | 'web' | 'prefs' | FilesKind;
import { ALIGN_ITEMS, itemId, STACK_MODES, selectCreated, tl, type FillContentForm, type Item, type MODIFY_OPS, type Run } from './helpers.ts';
import { combineItems, rasterizeItems, vectorMaskItems } from './vectorCommands.ts';
import { copy, paste } from './clipboard.ts';
import { stepTab } from './tabs.ts';
import type { Recent } from './files.ts';
import type { ModeDialogKind } from '../ModeDialog.tsx';
import type { ColorDialogKind } from '../ColorDialog.tsx';
import { DEFAULT_VIEW, PROOF_PRESETS, presetSetup, type ViewState } from './proof.ts';
import { BUILTIN_WORKSPACES, workspaceLabel, type WorkspaceState } from './workspaces.ts';
import type { ArrangeMode, MatchKind } from './arrange.ts';

type SetState<T> = Dispatch<SetStateAction<T>>;
type DialogRef = RefObject<HTMLDialogElement | null>;
type Mime = 'image/png' | 'image/jpeg' | 'image/webp';
// A translated menu text and its English id (`tl`).
type Label = { id: string; label: string };
const mark = (on: boolean, label: string) => `${on ? '✓ ' : ''}${label}`;
// Edit > Undo/Redo: the id keeps the worker's English step label, the shown text translates it.
const undoText = (label: string) => { const step = historyLabel(label); return t`Undo ${step}`; };
const redoText = (label: string) => { const step = historyLabel(label); return t`Redo ${step}`; };

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
  convertToLinked: () => Promise<void>; anyLinked: boolean; toggleLabel: Label;
  filterCommand: (op: 'toggle' | 'clear' | 'deleteMasks' | 'toggleMasks', label: string) => () => void; filters: SmartFilterInfo[];
  filterMasks: boolean; maskLabel: Label; openFilterBlend: () => void; openLayerStyle: (page: StylePage, id?: number) => void;
  globalLightDialog: DialogRef; allEffectsHidden: boolean; anyStyled: boolean; scaleEffectsDialog: DialogRef; defringeDialog: DialogRef; decontaminateDialog: DialogRef;
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
  openLockLayers: () => void; selectAllLayers: () => void; findLayers: () => void; isolated: boolean; toggleIsolate: () => void;
  snap: SnapSettings; setSnap: (patch: Partial<SnapSettings>) => void;
  newGuideDialog: DialogRef; newGuideLayoutDialog: DialogRef; cursorPrefsDialog: DialogRef;
  openArtboard: (mode: ArtboardMode) => void; activeArtboard: LayerNode | null; selectedNodes: LayerNode[];
  showShapes: boolean; setShowShapes: SetState<boolean>; showCloneSource: boolean; setShowCloneSource: SetState<boolean>; showNavigator: boolean; setShowNavigator: SetState<boolean>; typeItems: Item[]; aboutDialog: DialogRef; agentDialog: DialogRef;
  showHistogram: boolean; setShowHistogram: SetState<boolean>; showInfo: boolean; setShowInfo: SetState<boolean>; showToolPresets: boolean; setShowToolPresets: SetState<boolean>; showNotes: boolean; setShowNotes: SetState<boolean>; showMeasurementLog: boolean; setShowMeasurementLog: SetState<boolean>;
}

// Image > Mode: the modes a conversion from the current one allows, the bit depths, and the Color Table.
function modeItems(doc: DocInfo | null, run: Run, open: (kind: ModeDialogKind) => void, convertDepth: (depth: 8 | 16 | 32) => void): Item[] {
  const cur = doc?.mode?.kind ?? (doc?.gray ? 'gray' : 'rgb');
  const deep = doc?.depth === 32;
  const to = (mode: 'rgb' | 'gray' | 'cmyk' | 'lab' | 'multichannel') => () => run(t`Converting…`, () => client.call('setColorMode', { mode }));
  return [
    { ...tl(msg`Bitmap…`, cur === 'bitmap'), run: () => open('bitmap'), off: cur !== 'gray' || deep },
    { ...tl(msg`Grayscale`, cur === 'gray'), run: to('gray') },
    { ...tl(msg`Duotone…`, cur === 'duotone'), run: () => open('duotone'), off: (cur !== 'gray' && cur !== 'duotone') || deep },
    { ...tl(msg`Indexed Color…`, cur === 'indexed'), run: () => open('indexed'), off: (cur !== 'rgb' && cur !== 'gray') || doc?.depth !== 8 },
    { ...tl(msg`RGB Color`, cur === 'rgb'), run: to('rgb'), off: cur === 'bitmap' },
    { ...tl(msg`CMYK Color`, cur === 'cmyk'), run: to('cmyk'), off: cur === 'bitmap' || deep },
    { ...tl(msg`Lab Color`, cur === 'lab'), run: to('lab'), off: cur === 'bitmap' || deep },
    { ...tl(msg`Multichannel`, cur === 'multichannel'), run: to('multichannel'), off: cur === 'bitmap' || deep },
    ...([8, 16, 32] as const).map((b, i) => ({
      id: `${b} Bits/Channel`, label: mark(doc?.depth === b, t`${b} Bits/Channel`), sep: i === 0, run: () => convertDepth(b),
      off: (b === 32 && cur !== 'rgb' && cur !== 'gray') || (b !== 8 && (cur === 'bitmap' || cur === 'indexed')),
    })),
    { ...tl(msg`Color Table…`), sep: true, run: () => open('table'), off: cur !== 'indexed' },
  ];
}

// View > Proof Setup, Proof Colors, Gamut Warning and 32-bit Preview Options.
function viewProofItems(doc: DocInfo | null, run: Run, open: (kind: ColorDialogKind) => void): Item[] {
  const v = doc?.view ?? DEFAULT_VIEW;
  const set = (patch: Partial<ViewState>) => () => run(null, () => client.call('setView', patch));
  return [
    {
      ...tl(msg`Proof Setup`), keys: '›', run: () => {}, off: !doc, sub: [
        { ...tl(msg`Custom…`, v.setup.id === 'custom'), run: () => open('proof') },
        ...PROOF_PRESETS.map(([id, label, sep]) => ({ ...tl(label, v.setup.id === id), sep, run: set({ setup: presetSetup(id), proofColors: true }) })),
      ],
    },
    { ...tl(msg`Proof Colors`, v.proofColors), keys: 'Ctrl+Y', run: set({ proofColors: !v.proofColors }), off: !doc },
    { ...tl(msg`Gamut Warning`, v.gamutWarning), keys: 'Shift+Ctrl+Y', run: set({ gamutWarning: !v.gamutWarning }), off: !doc },
    { ...tl(msg`32-bit Preview Options…`), sep: true, run: () => open('hdr'), off: doc?.depth !== 32 },
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
    openAutomate, openBatch, openImageProcessor, openLoadStack, browseScript, scriptRunning, assetsOn, toggleImageAssets, packageDoc, openVariables, openApplyDataSet, openImportSets, openFileInfo, openPrint, printOneCopy, openAnalysis, recordMeasurements, chooseTool, globalLightDialog, allEffectsHidden, anyStyled, scaleEffectsDialog, defringeDialog, decontaminateDialog, openAdjust, hostOff, pixelsOff, openImageCalc, openModeDialog, convertDepth, openColorDialog, applyDestructive, rotateDialog, trimDialog, imageSizeDialog, canvasSizeDialog,
    openColorRange, openModify, featherDialog, growOrSimilar, setQuickMask, loadSelDialog, saveSelDialog, viewer, showAnts, setShowAnts,
    showAdjustments, setShowAdjustments, showLayerComps, setShowLayerComps, showChannels, setShowChannels, showActions, setShowActions, showPaths, setShowPaths, showProperties, setShowProperties, showStyles, setShowStyles,
    showPatterns, setShowPatterns, showGradients, setShowGradients, showRulers, setShowRulers, showPixelGrid, setShowPixelGrid,
    showGuides, setShowGuides, showGrid, setShowGrid, newGuideDialog, newGuideLayoutDialog, cursorPrefsDialog, snap, setSnap, openArtboard, activeArtboard,
    selectedNodes, showShapes, setShowShapes, showCloneSource, setShowCloneSource, showNavigator, setShowNavigator, typeItems, filterSpecs, openFilter, openLiquify, openVanishingPoint, openContentAwareScale, startDeform, lastFilter, openFade, openSearch, aboutDialog, agentDialog,
    showHistogram, setShowHistogram, showInfo, setShowInfo, showToolPresets, setShowToolPresets, showNotes, setShowNotes, showMeasurementLog, setShowMeasurementLog,
    workspace, chooseWorkspace, openWorkspaceDialog, resetCurrentWorkspace, toggleWorkspaceLock,
    arrangeMode, chooseArrangement, matchArrangement, openLockLayers, selectAllLayers, findLayers, isolated, toggleIsolate,
  } = c;
  const selectedIds = selectedNodes.map(n => n.id);
  const allHidden = selectedNodes.length > 0 && selectedNodes.every(n => !n.visible);
  const maskItems: Item[] = [
    { ...tl(msg`Reveal All`), run: () => node && run(null, () => client.call('addMask', node.id, true)), off: !!node?.mask },
    { ...tl(msg`Hide All`), run: () => node && run(null, () => client.call('addMask', node.id, false)), off: !!node?.mask },
    { ...tl(msg`Reveal Selection`), run: () => node && run(null, () => client.call('addMaskFromSelection', node.id, false)), off: !!node?.mask || !doc?.selection },
    { ...tl(msg`Hide Selection`), run: () => node && run(null, () => client.call('addMaskFromSelection', node.id, true)), off: !!node?.mask || !doc?.selection },
    { ...tl(msg`From Transparency`), run: () => node && run(null, () => client.call('maskFromTransparency', node.id)), off: node?.kind !== 'pixel' || !!node.mask },
    { ...tl(msg({ message: 'Apply', context: 'layer mask' })), run: () => node && run(null, () => client.call('applyMask', node.id)), off: node?.kind !== 'pixel' || !node.mask },
  ];
  const workspaceTypeItems = typeItems.map(item => itemId(item) === 'Panels'
    ? { ...item, sub: item.sub?.map(panel => ({ ...panel, off: workspace.locked })) }
    : item);
  const smartItems: Item[] = [
    { ...tl(msg`Convert to Smart Object`), run: () => node && run(t`Converting…`, () => client.call('convertToSmart', [node.id]), selectCreated), off: !node },
    { ...tl(msg`New Smart Object via Copy`), run: () => node && run(null, () => client.call('smartViaCopy', node.id), selectCreated), off: !smart },
    { ...tl(msg`Edit Contents`), sep: true, run: () => node && editContents(node.id), off: !smart },
    { ...tl(msg`Replace Contents…`), run: () => void replaceContents(false), off: !smart },
    { ...tl(msg`Export Contents…`), run: () => void exportContents(), off: !smart },
    { ...tl(msg`Convert to Linked…`), sep: true, run: () => void convertToLinked(), off: !smart || smart.link.type === 'linked' },
    { ...tl(msg`Convert to Embedded`), run: () => node && run(t`Embedding…`, () => client.call('convertToEmbedded', node.id)), off: smart?.link.type !== 'linked' },
    { ...tl(msg`Relink to File…`), run: () => void replaceContents(true), off: !smart },
    { ...tl(msg`Update Modified Content`), run: () => node && run(t`Updating…`, () => client.call('updateModified', node.id)), off: smart?.link.type !== 'linked' },
    { ...tl(msg`Update All Modified Content`), run: () => run(t`Updating…`, () => client.call('updateModified', null)), off: !anyLinked },
    {
      ...tl(msg`Stack Mode`), keys: '›', sep: true, run: () => {}, off: !smart, sub: STACK_MODES.map(([mode, label]) => ({
        ...tl(label, (smart?.stack_mode ?? null) === mode), run: () => node && run(null, () => client.call('setStackMode', node.id, mode)),
      })),
    },
    { ...tl(msg`Perspective Warp`), sep: true, run: () => startDeform('perspective'), off: !smart },
    { ...tl(msg`Puppet Warp`), run: () => startDeform('puppet'), off: !smart },
    { ...tl(msg`Rasterize`), sep: true, run: () => node && run(t`Rasterizing…`, () => client.call('rasterizeSmart', node.id, 'Rasterize')), off: !smart },
  ];

  const raster = rasterizeItems(selectedNodes, run);
  const format = FORMAT_LABEL[exportPrefs().format];

  const smartFilterItems: Item[] = [
    { id: toggleLabel.id, label: toggleLabel.label, run: filterCommand('toggle', toggleLabel.id), off: !filters.length },
    { ...tl(msg`Delete Filter Mask`), run: filterCommand('deleteMasks', 'Delete Filter Mask'), off: !filterMasks },
    { id: maskLabel.id, label: maskLabel.label, run: filterCommand('toggleMasks', maskLabel.id), off: !filterMasks },
    { ...tl(msg`Blending Options…`), sep: true, run: openFilterBlend, off: !filters.length },
    { ...tl(msg`Clear Smart Filters`), sep: true, run: filterCommand('clear', 'Clear Smart Filters'), off: !filters.length },
  ];

  const menus: Record<string, Item[]> = {
    File: [
      { ...tl(msg`New…`), keys: 'Alt+Ctrl+N', run: () => { setMenu(null); newDialog.current?.showModal(); } },
      { ...tl(msg`Open…`), keys: 'Ctrl+O', run: () => void openFiles() },
      ...(recent ? [{
        ...tl(msg`Open Recent`), keys: '›', run: () => {}, off: !recent.length, sub: [
          ...recent.map(r => ({ label: r.name, run: () => void openRecent(r) })),
          { ...tl(msg`Clear Recent File List`), sep: recent.length > 0, run: clearRecent },
        ],
      }] : []),
      { ...tl(msg`Place Embedded…`), run: () => void placeFile(false), off: !has || !active },
      { ...tl(msg`Place Linked…`), run: () => void placeFile(true), off: !has || !active },
      { ...tl(msg`Package…`), run: packageDoc, off: !has },
      {
        ...tl(msg`Import`), keys: '›', run: () => {}, off: !has, sub: [
          { ...tl(msg`Variable Data Sets…`), run: openImportSets },
        ],
      },
      { ...tl(msg`Save`), keys: 'Ctrl+S', sep: true, run: () => void save(), off: !has },
      { ...tl(msg`Save As…`), keys: 'Shift+Ctrl+S', run: saveAs, off: !has },
      { ...tl(msg`Save a Copy…`), keys: 'Alt+Ctrl+S', run: saveCopy, off: !has },
      { ...tl(msg`Revert`), keys: 'F12', run: () => void revert(), off: revertOff },
      {
        ...tl(msg`Export`), keys: '›', run: () => {}, off: !has, sub: [
          { id: `Quick Export as ${format}`, label: t`Quick Export as ${format}`, run: quickExport },
          { ...tl(msg`Export As…`), keys: 'Alt+Shift+Ctrl+W', run: () => openExport('as') },
          { ...tl(msg`Export Preferences…`), run: () => openExport('prefs') },
          { ...tl(msg`Save for Web (Legacy)…`), keys: 'Alt+Shift+Ctrl+S', sep: true, run: () => openExport('web') },
          { ...tl(msg`Artboards to Files…`), sep: true, run: () => openExport('artboards'), off: !doc?.layers.some(l => l.artboard) },
          { ...tl(msg`Artboards to PDF…`), run: () => openExport('pdf'), off: !doc?.layers.some(l => l.artboard) },
          { ...tl(msg`Layers to Files…`), run: () => openExport('layers'), off: !doc?.layers.length },
          { ...tl(msg`Layer Comps to Files (PNG)…`), run: () => exportLayerComps('image/png', 'png'), off: !has || !doc?.layerComps.length },
          { ...tl(msg`Layer Comps to Files (JPEG)…`), run: () => exportLayerComps('image/jpeg', 'jpg'), off: !has || !doc?.layerComps.length },
          { ...tl(msg`Layer Comps to Files (WebP)…`), run: () => exportLayerComps('image/webp', 'webp'), off: !has || !doc?.layerComps.length },
          { ...tl(msg`Data Sets as Files…`), sep: true, run: () => openExport('datasets'), off: !has },
          { ...tl(msg`Paths to SVG…`), sep: true, run: pathsToSvg, off: !doc?.paths.length },
        ],
      },
      {
        ...tl(msg`Generate`), keys: '›', run: () => {}, sub: [
          { ...tl(msg`Image Assets`, assetsOn), run: toggleImageAssets },
        ],
      },
      {
        ...tl(msg`Automate`), keys: '›', run: () => {}, sub: [
          { ...tl(msg`Batch…`), run: openBatch },
          { ...tl(msg`Photomerge…`), sep: true, run: () => openAutomate('photomerge'), off: !has },
          { ...tl(msg`Merge to HDR Pro…`), run: () => openAutomate('hdr'), off: (doc?.docs.length ?? 0) < 2 },
        ],
      },
      {
        ...tl(msg`Scripts`), keys: '›', run: () => {}, sub: [
          { ...tl(msg`Image Processor…`), run: openImageProcessor },
          { ...tl(msg`Delete All Empty Layers`), sep: true, run: () => run(null, () => client.call('deleteEmptyLayers')), off: !has },
          { ...tl(msg`Flatten All Layer Effects`), run: () => run(null, () => client.call('flattenAllLayerEffects')), off: !has },
          { ...tl(msg`Flatten All Masks`), run: () => run(null, () => client.call('flattenAllMasks')), off: !has },
          { ...tl(msg`Load Files into Stack…`), sep: true, run: openLoadStack },
          { ...tl(scriptRunning ? msg`Stop Script` : msg`Browse…`), sep: true, run: browseScript },
        ],
      },
      { ...tl(msg`File Info…`), keys: 'Alt+Shift+Ctrl+I', sep: true, run: openFileInfo, off: !has },
      { ...tl(msg`Print…`), keys: 'Ctrl+P', sep: true, run: openPrint, off: !has },
      { ...tl(msg`Print One Copy`), keys: 'Alt+Shift+Ctrl+P', run: printOneCopy, off: !has },
      { ...tl(msg`Close`), sep: true, run: () => void closeTab(), off: !has },
      { ...tl(msg`Close All`), run: () => void closeTabs('all'), off: !has },
      { ...tl(msg`Close Others`), run: () => void closeTabs('others'), off: (doc?.docs.length ?? 0) < 2 },
    ],
    Edit: [
      { ...(doc?.undoLabel ? { id: `Undo ${doc.undoLabel}`, label: undoText(doc.undoLabel) } : tl(msg`Undo`)), keys: 'Ctrl+Z', run: () => run(null, () => client.call('undo')), off: !doc?.undoLabel },
      { ...(doc?.redoLabel ? { id: `Redo ${doc.redoLabel}`, label: redoText(doc.redoLabel) } : tl(msg`Redo`)), keys: 'Shift+Ctrl+Z', run: () => run(null, () => client.call('redo')), off: !doc?.redoLabel },
      { ...tl(msg`Fade…`), keys: 'Shift+Ctrl+F', run: openFade, off: !doc?.undoLabel || !active || node?.kind !== 'pixel' },
      { ...tl(msg`Cut`), keys: 'Ctrl+X', sep: true, run: () => active && copy(run, active, false, true), off: !doc?.selection || node?.kind !== 'pixel' },
      { ...tl(msg`Copy`), keys: 'Ctrl+C', run: () => active && copy(run, active, false, false), off: !has || !active },
      { ...tl(msg`Copy Merged`), keys: 'Shift+Ctrl+C', run: () => active && copy(run, active, true, false), off: !has || !active },
      { ...tl(msg`Paste`), keys: 'Ctrl+V', run: (bytes?: Uint8Array | null) => active && paste(run, active, 'paste', bytes), off: !has || !active },
      {
        ...tl(msg`Paste Special`), keys: '›', run: () => {}, off: !has || !active, sub: [
          { ...tl(msg`Paste in Place`), keys: 'Shift+Ctrl+V', run: () => active && paste(run, active, 'inPlace') },
          { ...tl(msg`Paste Into`), keys: 'Alt+Shift+Ctrl+V', run: () => active && paste(run, active, 'into'), off: !doc?.selection },
        ],
      },
      { ...tl(msg`Fill…`), keys: 'Shift+F5', sep: true, run: () => openPreviewDialog('fill'), off: !has || !active },
      { ...tl(msg`Fill with Foreground Color`), keys: 'Alt+Backspace', run: () => quickFill(fg, 'Fill with Foreground Color'), off: !has || !active },
      { ...tl(msg`Fill with Background Color`), keys: 'Ctrl+Backspace', run: () => quickFill(bg, 'Fill with Background Color'), off: !has || !active },
      { ...tl(msg`Stroke…`), run: () => openPreviewDialog('stroke'), off: !doc?.selection || !active },
      { ...tl(msg`Content-Aware Fill…`), run: () => contentAwareFill(true), off: !has || !active },
      { ...tl(msg`Delete and Fill Selection`), run: () => contentAwareFill(false), off: !has || !active },
      { ...tl(msg`Clear`), keys: 'Delete', run: () => active && run(t`Clearing…`, () => client.call('clearSelected', active.id, selEdit ? 'selection' : active.target)), off: !doc?.selection || !active },
      { ...tl(msg`Content-Aware Scale…`), keys: 'Alt+Shift+Ctrl+C', run: openContentAwareScale, off: !has || !active },
      { ...tl(msg`Puppet Warp`), run: () => startDeform('puppet'), off: !has || !active },
      { ...tl(msg`Perspective Warp`), run: () => startDeform('perspective'), off: !has || !active },
      { ...tl(msg`Free Transform`), keys: 'Ctrl+T', run: () => void startTransform(), off: !has || !active },
      {
        ...tl(msg`Transform`), keys: '›', run: () => {}, off: !has || !active, sub: [
          { ...tl(msg`Again`), keys: 'Shift+Ctrl+T', run: transformAgain, off: !!transformStore },
          ...MODES.filter(([m]) => m !== 'free').map(([m, label]) => ({ ...tl(label), run: () => transformMode(m), off: warping && m !== 'warp' })),
          ...([['horizontal', msg`Split Warp Horizontally`], ['vertical', msg`Split Warp Vertically`], ['both', msg`Split Warp Crosswise`], ['remove', msg`Remove Warp Split`]] as [WarpSplit, MessageDescriptor][])
            .map(([m, label]) => ({ ...tl(label), run: () => warpMenuSplit(m) })),
          ...([['180', msg`Rotate 180°`], ['cw', msg`Rotate 90° Clockwise`], ['ccw', msg`Rotate 90° Counter Clockwise`], ['flipH', msg`Flip Horizontal`], ['flipV', msg`Flip Vertical`]] as [Command, MessageDescriptor][])
            .map(([c, label]) => ({ ...tl(label), run: () => transformRemap(c, label.message!), off: warping })),
        ],
      },
      { ...tl(msg`Auto-Align Layers…`), run: () => openAutomate('align'), off: selectedNodes.filter(n => n.kind === 'pixel').length < 2 },
      { ...tl(msg`Auto-Blend Layers…`), run: () => openAutomate('blend'), off: selectedNodes.filter(n => n.kind === 'pixel').length < 2 },
      { ...tl(msg`Color Settings…`), keys: 'Shift+Ctrl+K', sep: true, run: () => openColorDialog('settings') },
      { ...tl(msg`Assign Profile…`), run: () => openColorDialog('assign'), off: !has || (!!doc?.mode && doc.mode.kind !== 'cmyk') },
      { ...tl(msg`Convert to Profile…`), run: () => openColorDialog('convert'), off: !has || (!!doc?.mode && doc.mode.kind !== 'cmyk') },
      { ...tl(msg`Search…`), keys: 'Ctrl+F', sep: true, run: () => { setMenu(null); openSearch(); } },
      { ...tl(msg`Preferences`), keys: '›', sep: true, run: () => {}, sub: [{ ...tl(msg`Cursors…`), run: () => { setMenu(null); cursorPrefsDialog.current?.showModal(); } }] },
    ],
    Layer: [
      { ...tl(msg`New Layer`), run: newLayer, off: !has },
      { ...tl(msg`New Group`), run: newGroup, off: !has },
      // Ctrl+J: the selected pixels as a new layer, or the whole layer when there is no pixel selection (Photoshop).
      { ...tl(msg`Layer via Copy`), keys: 'Ctrl+J', run: () => doc?.selection && node?.kind === 'pixel' && active ? run(null, () => client.call('layerViaCopy', active.id), selectCreated) : duplicateLayer(), off: !has || !active },
      { ...tl(msg`Layer via Cut`), keys: 'Shift+Ctrl+J', run: () => active && run(null, () => client.call('layerViaCut', active.id), selectCreated), off: !has || !active || !doc?.selection || node?.kind !== 'pixel' },
      { ...tl(msg`Duplicate Layer`), run: duplicateLayer, off: !has },
      { ...tl(msg`Rename Layer`), run: renameLayer, off: !has || !active },
      { id: `Quick Export as ${format}`, label: t`Quick Export as ${format}`, keys: "Shift+Ctrl+'", sep: true, run: quickExportLayer, off: !node },
      { ...tl(msg`Export As…`), keys: "Alt+Shift+Ctrl+'", run: openLayerExport, off: !selectedNodes.length },
      {
        ...tl(msg`Delete`), keys: '›', run: () => {}, off: !has, sub: [
          { ...tl(msg`Layer`), run: deleteLayer, off: deleteDisabled },
          { ...tl(msg`Hidden Layers`), run: () => run(null, () => client.call('deleteHiddenLayers')), off: !has || !flatNodes(doc?.layers ?? []).some(n => !n.visible) },
        ],
      },
      { ...tl(msg`Group Layers`), keys: 'Ctrl+G', run: groupLayers, off: !has },
      { ...tl(msg`Ungroup Layers`), keys: 'Shift+Ctrl+G', run: ungroupLayers, off: !has || node?.kind !== 'group' },
      { ...tl(allHidden ? msg`Show Layers` : msg`Hide Layers`), keys: 'Ctrl+,', run: () => run(null, () => client.call('setVisibility', selectedIds, allHidden)), off: !has || !selectedNodes.length },
      { ...tl(msg`Lock Layers…`), keys: 'Ctrl+/', run: openLockLayers, off: !has || !selectedNodes.length },
      { ...tl(msg`Lock All Layers in Group`), run: () => node && run(null, () => client.call('setLocks', flatNodes(node.children ?? []).map(n => n.id), { transparency: true, pixels: true, position: true })), off: !has || node?.kind !== 'group' },
      {
        ...tl(msg`Arrange`), keys: '›', sep: true, run: () => {}, off: !has || !selectedNodes.length, sub: ([
          ['front', msg`Bring to Front`, 'Shift+Ctrl+]'], ['forward', msg`Bring Forward`, 'Ctrl+]'], ['backward', msg`Send Backward`, 'Ctrl+['], ['back', msg`Send to Back`, 'Shift+Ctrl+['],
        ] as const).map<Item>(([mode, label, keys]) => ({ ...tl(label), keys, run: () => run(null, () => client.call('arrangeNodes', selectedIds, mode)) })).concat([
          { ...tl(msg({ message: 'Reverse', context: 'arrange' })), sep: true, run: () => run(null, () => client.call('arrangeNodes', selectedIds, 'reverse')), off: selectedNodes.length < 2 },
        ]),
      },
      ...([[msg`Align`, 1, ALIGN_ITEMS.slice(0, 6)], [msg`Distribute`, 3, ALIGN_ITEMS.slice(6)]] as const).map(([label, min, items]) => ({
        ...tl(label), keys: '›', run: () => {}, off: !has || selectedNodes.length < min,
        sub: items.map(([mode, text]) => ({ ...tl(text), run: () => run(null, () => client.call('alignLayers', selectedNodes.map(n => n.id), mode)) })),
      })),
      selectedNodes.length > 1
        ? { ...tl(msg`Merge Layers`), keys: 'Ctrl+E', sep: true, run: () => run(null, () => client.call('mergeNodes', selectedNodes.map(n => n.id), 'layers')), off: !has }
        : { ...tl(node?.kind === 'group' ? msg`Merge Group` : msg`Merge Down`), keys: 'Ctrl+E', sep: true, run: () => node && run(null, () => client.call('mergeNodes', [node.id], 'down')), off: !has || !node || (node.kind !== 'group' && !locate(doc!.layers, node.id)?.index) },
      { ...tl(msg`Merge Visible`), keys: 'Shift+Ctrl+E', run: () => run(null, () => client.call('mergeNodes', [], 'visible')), off: !has },
      { ...tl(msg`Stamp Visible`), keys: 'Alt+Shift+Ctrl+E', run: () => run(null, () => client.call('mergeNodes', [], 'stamp')), off: !has },
      { ...tl(msg`Flatten Image`), run: () => run(null, () => client.call('mergeNodes', [], 'flatten')), off: !has },
      {
        ...tl(msg`Matting`), keys: '›', run: () => {}, off: !has || node?.kind !== 'pixel', sub: [
          { ...tl(msg`Color Decontaminate…`), run: () => { setMenu(null); decontaminateDialog.current?.showModal(); }, off: !node?.mask },
          { ...tl(msg`Defringe…`), run: () => { setMenu(null); defringeDialog.current?.showModal(); } },
          { ...tl(msg`Remove Black Matte`), run: () => node && run(null, () => client.call('removeMatte', node.id, false)) },
          { ...tl(msg`Remove White Matte`), run: () => node && run(null, () => client.call('removeMatte', node.id, true)) },
        ],
      },
      { ...tl(node?.clipping ? msg`Release Clipping Mask` : msg`Create Clipping Mask`), keys: 'Alt+Ctrl+G', run: toggleClipping, off: !has },
      { ...tl(msg`Add Layer Mask`), run: addMask, off: !has || !!node?.mask },
      { ...tl(msg`Delete Layer Mask`), run: deleteMask, off: !has || !node?.mask },
      { ...tl(node?.mask?.enabled === false ? msg`Enable Layer Mask` : msg`Disable Layer Mask`), run: toggleMaskEnabled, off: !has || !node?.mask },
      { ...tl(msg`Layer Mask`), keys: '›', run: () => {}, off: !has || !node, sub: maskItems },
      { ...tl(msg`Vector Mask`), keys: '›', run: () => {}, off: !doc || !selectedNodes.length, sub: doc ? vectorMaskItems(doc, selectedNodes, run) : [] },
      { ...tl(msg`Combine Shapes`), keys: '›', run: () => {}, off: !selectedNodes.some(n => n.kind === 'shape'), sub: combineItems(selectedNodes, run) },
      {
        ...tl(msg`New Artboard`), keys: '›', run: () => {}, off: !has, sep: true, sub: [
          { ...tl(msg`Artboard…`), run: () => openArtboard('new') },
          { ...tl(msg`Artboard from Group…`), run: () => openArtboard('fromGroup'), off: node?.kind !== 'group' || !!node.artboard },
          { ...tl(msg`Artboard from Layers…`), run: () => openArtboard('fromLayers'), off: !node || !!activeArtboard },
        ],
      },
      {
        ...tl(msg`New Fill Layer`), keys: '›', run: () => {}, off: !has || !active, sub: [
          { ...tl(msg`Solid Color…`), run: () => openNewFillLayer('solid') },
          { ...tl(msg`Gradient…`), run: () => openNewFillLayer('gradient') },
          { ...tl(msg`Pattern…`), run: () => openNewFillLayer('pattern') },
        ],
      },
      {
        ...tl(msg`New Adjustment Layer`), keys: '›', run: () => {}, off: !has || !active, sub: ADJUSTMENT_KINDS.map(kind => ({
          ...tl(MENU_LABEL[kind]), sep: kind === 'invert', run: () => newAdjustmentLayer(kind),
        })),
      },
      { ...tl(msg`Layer Content Options…`), run: openLayerContentOptions, off: !has || node?.kind !== 'fill' },
      { ...tl(msg`Smart Objects`), keys: '›', run: () => {}, off: !has || !node, sub: smartItems },
      { ...tl(msg`Smart Filter`), keys: '›', run: () => {}, off: !has || !smart, sub: smartFilterItems },
      {
        ...tl(msg`Layer Style`), keys: '›', run: () => {}, off: !has || !node, sub: [
          { ...tl(msg`Blending Options…`), run: () => openLayerStyle('blending') },
          ...EFFECT_KINDS.filter(k => k !== 'contour' && k !== 'texture').map(kind => ({ id: `${EFFECT_LABEL[kind].message}…`, label: `${i18n._(EFFECT_LABEL[kind])}…`, run: () => openLayerStyle({ kind, index: 0 }) })),
          { ...tl(msg`Copy Layer Style`), sep: true, run: () => node && run(null, () => client.call('copyLayerStyle', node.id)), off: !node?.style },
          { ...tl(msg`Paste Layer Style`), run: () => node && run(null, () => client.call('pasteLayerStyle', [node.id])) },
          { ...tl(msg`Clear Layer Style`), run: () => node && run(null, () => client.call('clearLayerStyle', [node.id])), off: !node?.style },
          { ...tl(msg`Global Light…`), sep: true, run: () => { setMenu(null); globalLightDialog.current?.showModal(); } },
          { ...tl(msg`Create Layers`), run: () => node && run(t`Creating layers…`, () => client.call('createLayersFromStyle', node.id)), off: !node?.style },
          { ...tl(allEffectsHidden ? msg`Show All Effects` : msg`Hide All Effects`), run: () => run(null, () => client.call('hideAllEffects')), off: !anyStyled },
          { ...tl(msg`Scale Effects…`), run: () => { setMenu(null); scaleEffectsDialog.current?.showModal(); }, off: !node?.style },
        ],
      },
      {
        ...tl(msg`Rasterize`), keys: '›', run: () => {}, off: !has || !node, sub: [
          raster[0], raster[1],
          { ...tl(msg`Fill Content`), run: () => active && run(t`Rasterizing…`, () => client.call('rasterizeFill', active.id)), off: node?.kind !== 'fill' },
          raster[2],
          { ...tl(msg`Smart Object`), run: () => active && run(t`Rasterizing…`, () => client.call('rasterizeSmart', active.id, 'Smart Object')), off: node?.kind !== 'smart' },
        ],
      },
    ],
    Type: workspaceTypeItems,
    Image: [
      {
        ...tl(msg`Mode`), keys: '›', run: () => {}, off: !has, sub: modeItems(doc, run, openModeDialog, convertDepth),
      },
      {
        ...tl(msg`Adjustments`), sep: true, keys: '›', run: () => {}, off: !has || !active, sub: ADJUSTMENT_KINDS.map<Item>(kind => kind === 'invert'
          ? { ...tl(msg`Invert`), keys: 'Ctrl+I', sep: true, run: () => run(t`Inverting…`, () => client.call('command', 'invert', active!.id, selEdit ? 'selection' : active!.target)) }
          : { id: `${MENU_LABEL[kind].message}…`, label: `${i18n._(MENU_LABEL[kind])}…`, keys: SHORTCUT[kind], run: () => openAdjust(kind), off: hostOff }).concat([
          { ...tl(msg`Shadows/Highlights…`), sep: true, run: () => openAdjust('shadows_highlights'), off: pixelsOff },
          { ...tl(msg`HDR Toning…`), run: () => openAdjust('hdr_toning'), off: pixelsOff },
          { ...tl(msg`Desaturate`), keys: 'Ctrl+Shift+U', sep: true, run: () => applyDestructive('desaturate'), off: pixelsOff },
          { ...tl(msg`Match Color…`), run: () => openAdjust('match_color'), off: pixelsOff },
          { ...tl(msg`Replace Color…`), run: () => openAdjust('replace_color'), off: pixelsOff },
          { ...tl(msg`Equalize`), run: () => applyDestructive('equalize'), off: pixelsOff },
        ]),
      },
      { ...tl(msg`Auto Tone`), keys: 'Ctrl+Shift+L', run: () => applyDestructive('auto_tone'), off: !has || !active || pixelsOff },
      { ...tl(msg`Auto Contrast`), keys: 'Ctrl+Alt+Shift+L', run: () => applyDestructive('auto_contrast'), off: !has || !active || pixelsOff },
      { ...tl(msg`Auto Color`), keys: 'Ctrl+Shift+B', run: () => applyDestructive('auto_color'), off: !has || !active || pixelsOff },
      { ...tl(msg`Image Size…`), keys: 'Alt+Ctrl+I', sep: true, run: () => { setMenu(null); imageSizeDialog.current?.showModal(); }, off: !has },
      { ...tl(msg`Canvas Size…`), keys: 'Alt+Ctrl+C', run: () => { setMenu(null); canvasSizeDialog.current?.showModal(); }, off: !has },
      {
        ...tl(msg`Image Rotation`), keys: '›', run: () => {}, off: !has, sub: [
          ...([['180', msg`180°`], ['cw', msg`90° Clockwise`], ['ccw', msg`90° Counter Clockwise`]] as [Command, MessageDescriptor][])
            .map(([c, label]) => ({ ...tl(label), run: () => run(t`Rotating…`, () => client.call('rotateCanvas', c)) })),
          { ...tl(msg`Arbitrary…`), run: () => { setMenu(null); rotateDialog.current?.showModal(); } },
          ...([['flipH', msg`Flip Canvas Horizontal`], ['flipV', msg`Flip Canvas Vertical`]] as [Command, MessageDescriptor][])
            .map(([c, label], i) => ({ ...tl(label), sep: i === 0, run: () => run(t`Flipping…`, () => client.call('rotateCanvas', c)) })),
        ],
      },
      { ...tl(msg`Crop`), run: () => run(t`Cropping…`, () => client.call('cropToSelection')), off: !doc?.selection },
      { ...tl(msg`Trim…`), run: () => { setMenu(null); trimDialog.current?.showModal(); }, off: !has },
      { ...tl(msg`Reveal All`), run: () => run(t`Revealing…`, () => client.call('revealAll')), off: !has },
      { ...tl(msg`Apply Image…`), sep: true, run: () => openImageCalc(false), off: pixelsOff },
      { ...tl(msg`Calculations…`), run: () => openImageCalc(true), off: !has },
      {
        ...tl(msg`Variables`), keys: '›', sep: true, run: () => {}, off: !has, sub: [
          { ...tl(msg`Define…`), run: () => openVariables('define') },
          { ...tl(msg`Data Sets…`), run: () => openVariables('sets') },
        ],
      },
      { ...tl(msg`Apply Data Set…`), run: openApplyDataSet, off: !has },
      {
        ...tl(msg`Analysis`), keys: '›', sep: true, run: () => {}, off: !has, sub: [
          { ...tl(msg`Set Measurement Scale…`), run: () => openAnalysis('scale') },
          { ...tl(msg`Select Data Points…`), run: () => openAnalysis('points') },
          { ...tl(msg`Record Measurements`), keys: 'Shift+Ctrl+M', run: () => { setMenu(null); recordMeasurements(); } },
          { ...tl(msg`Ruler Tool`), sep: true, run: () => { setMenu(null); chooseTool('ruler'); } },
          { ...tl(msg`Count Tool`), run: () => { setMenu(null); chooseTool('count'); } },
          { ...tl(msg`Place Scale Marker…`), sep: true, run: () => openAnalysis('marker') },
        ],
      },
    ],
    Select: [
      { ...tl(msg`All`), keys: 'Ctrl+A', run: () => run(null, () => client.call('selectCommand', 'all')), off: !has },
      { ...tl(msg`Deselect`), keys: 'Ctrl+D', run: () => run(null, () => client.call('selectCommand', 'deselect')), off: !doc?.selection },
      { ...tl(msg`Reselect`), keys: 'Shift+Ctrl+D', run: () => run(null, () => client.call('selectCommand', 'reselect')), off: !doc?.hasLastSelection },
      { ...tl(msg`Inverse`), keys: 'Shift+Ctrl+I', run: () => run(null, () => client.call('selectCommand', 'inverse')), off: !doc?.selection },
      { ...tl(msg`All Layers`), keys: 'Alt+Ctrl+A', sep: true, run: selectAllLayers, off: !has },
      { ...tl(msg`Find Layers`), keys: 'Alt+Shift+Ctrl+F', run: () => { setMenu(null); findLayers(); }, off: !has },
      { ...tl(msg`Isolate Layers`, isolated), run: toggleIsolate, off: !has || (!isolated && !selectedNodes.length) },
      { ...tl(msg`Color Range…`), sep: true, run: () => openColorRange(), off: !has },
      { ...tl(msg`Border…`), run: () => openModify('border'), off: !doc?.selection },
      { ...tl(msg`Smooth…`), run: () => openModify('smooth'), off: !doc?.selection },
      { ...tl(msg`Expand…`), run: () => openModify('expand'), off: !doc?.selection },
      { ...tl(msg`Contract…`), run: () => openModify('contract'), off: !doc?.selection },
      { ...tl(msg`Feather…`), keys: 'Shift+F6', run: () => { setMenu(null); featherDialog.current?.showModal(); }, off: !doc?.selection },
      { ...tl(msg`Grow`), run: growOrSimilar('grow'), off: !doc?.selection },
      { ...tl(msg`Similar`), run: growOrSimilar('similar'), off: !doc?.selection },
      { ...tl(quickMask ? msg`Exit Quick Mask Mode` : msg`Edit in Quick Mask Mode`), keys: 'Q', run: () => { setMenu(null); setQuickMask(v => !v); }, off: !has },
      { ...tl(msg`Load Selection…`), run: () => { setMenu(null); loadSelDialog.current?.showModal(); }, off: !doc?.channels.length },
      { ...tl(msg`Save Selection…`), run: () => { setMenu(null); saveSelDialog.current?.showModal(); }, off: !doc?.selection },
      { ...tl(msg`Transform Selection`), run: () => void startTransform('free', true), off: !has || !!transformStore },
    ],
    Filter: [
      { ...tl(msg`Last Filter`), keys: 'Alt+Ctrl+F', run: lastFilter, off: !has || !active },
      { ...tl(msg`Convert for Smart Filters`), sep: true, run: () => node && run(t`Converting…`, () => client.call('convertForSmartFilters', node.id)), off: !has || node?.kind !== 'pixel' },
      { ...tl(msg`Filter Gallery…`), sep: true, run: () => { const s = filterSpecs.find(s => s.id === 'gallery.filter_gallery'); if (s) openFilter(s); }, off: !has || !active || doc?.depth === 32 },
      { ...tl(msg`Adaptive Wide Angle…`), keys: 'Alt+Shift+Ctrl+A', run: () => { const s = filterSpecs.find(s => s.id === 'tool.adaptive_wide_angle'); if (s) openFilter(s); }, off: !has || !active || doc?.depth === 32 },
      { ...tl(msg`Camera Raw Filter…`), keys: 'Shift+Ctrl+A', run: () => { const s = filterSpecs.find(s => s.id === 'tool.camera_raw'); if (s) openFilter(s); }, off: !has || !active || doc?.depth === 32 },
      { ...tl(msg`Lens Correction…`), keys: 'Shift+Ctrl+R', run: () => { const s = filterSpecs.find(s => s.id === 'tool.lens_correction'); if (s) openFilter(s); }, off: !has || !active || doc?.depth === 32 },
      { ...tl(msg`Liquify…`), keys: 'Shift+Ctrl+X', run: openLiquify, off: !has || !active || doc?.depth === 32 },
      { ...tl(msg`Vanishing Point…`), keys: 'Alt+Ctrl+V', run: openVanishingPoint, off: !has || !active || doc?.depth === 32 },
      ...GROUPS.map(([g, name]) => ({ name, specs: filterSpecs.filter(s => s.group === g) })).filter(g => g.specs.length).map((g, i) => ({
        ...tl(g.name), keys: '›', sep: i === 0, run: () => {}, off: !has || !active || g.specs.every(s => filterOff(s, doc?.depth)),
        sub: g.specs.map(s => ({ id: menuId(s), label: menuLabel(s), run: () => openFilter(s), off: filterOff(s, doc?.depth) })),
      })),
    ],
    View: [
      ...viewProofItems(doc, run, openColorDialog),
      { ...tl(msg`Zoom in`), keys: 'Ctrl++', sep: true, run: () => { setMenu(null); viewer.current?.zoomBy(2); }, off: !has },
      { ...tl(msg`Zoom out`), keys: 'Ctrl+-', run: () => { setMenu(null); viewer.current?.zoomBy(0.5); }, off: !has },
      { ...tl(msg`Fit on screen`), keys: 'Ctrl+0', run: () => { setMenu(null); viewer.current?.fit(); }, off: !has },
      {
        ...tl(msg`Fit Artboard on Screen`), off: !activeArtboard, run: () => {
          setMenu(null);
          const r = activeArtboard?.artboard?.rect;
          if (r) viewer.current?.fitRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
        },
      },
      { ...tl(msg`100%`), keys: 'Ctrl+1', run: () => { setMenu(null); viewer.current?.actualPixels(); }, off: !has },
      { ...tl(msg`Reset rotation`), keys: 'Esc', run: () => { setMenu(null); viewer.current?.resetRotation(); }, off: !has },
      { ...tl(showAnts ? msg`Hide selection edges` : msg`Show selection edges`), keys: 'Ctrl+H', run: () => { setMenu(null); setShowAnts(v => !v); }, off: !has },
      { ...tl(showRulers ? msg`Hide Rulers` : msg`Show Rulers`), keys: 'Ctrl+R', run: () => { setMenu(null); setShowRulers(v => !v); } },
      { ...tl(showGuides ? msg`Hide Guides` : msg`Show Guides`), keys: 'Ctrl+;', run: () => { setMenu(null); setShowGuides(v => !v); }, off: !has },
      { ...tl(doc?.guidesLocked ? msg`Unlock Guides` : msg`Lock Guides`), keys: 'Ctrl+Alt+;', run: () => run(null, () => client.call('setGuidesLocked', !doc?.guidesLocked)), off: !has },
      { ...tl(msg`Clear Guides`), run: () => run(null, () => client.call('clearGuides', 'all', 0)), off: !doc?.guides.length },
      { ...tl(msg`Clear Canvas Guides`), run: () => run(null, () => client.call('clearGuides', 'canvas', 0)), off: !doc?.guides.length },
      { ...tl(msg`Clear Selected Artboard Guides`), run: () => activeArtboard && run(null, () => client.call('clearGuides', 'artboard', activeArtboard.id)), off: !activeArtboard?.artboard?.guide_ids.length },
      { ...tl(msg`New Guide…`), run: () => { setMenu(null); newGuideDialog.current?.showModal(); }, off: !has },
      { ...tl(msg`New Guide Layout…`), run: () => { setMenu(null); newGuideLayoutDialog.current?.showModal(); }, off: !has },
      { ...tl(msg`New Guides From Shape`), run: () => node && run(null, () => client.call('newGuidesFromShape', [node.id])), off: !node },
      { ...tl(showGrid ? msg`Hide Grid` : msg`Show Grid`), keys: 'Ctrl+\'', sep: true, run: () => { setMenu(null); setShowGrid(v => !v); } },
      { ...tl(showPixelGrid ? msg`Hide Pixel Grid` : msg`Show Pixel Grid`), run: () => { setMenu(null); setShowPixelGrid(v => !v); } },
      { ...tl(msg`Smart Guides`, snap.smartGuides), run: () => { setMenu(null); setSnap({ smartGuides: !snap.smartGuides }); } },
      { ...tl(msg`Snap`, snap.enabled), keys: 'Ctrl+Shift+;', sep: true, run: () => { setMenu(null); setSnap({ enabled: !snap.enabled }); } },
      {
        ...tl(msg`Snap To`), keys: '›', run: () => {}, off: !snap.enabled, sub: [
          ...([['guides', msg`Guides`], ['grid', msg`Grid`], ['layers', msg`Layers`], ['documentBounds', msg`Document Bounds`], ['artboards', msg`Artboards`]] as const).map(([k, label]) => ({
            ...tl(label, snap[k]), run: () => { setMenu(null); setSnap({ [k]: !snap[k] }); },
          })),
          { ...tl(msg`All`), sep: true, run: () => { setMenu(null); setSnap({ guides: true, grid: true, layers: true, documentBounds: true, artboards: true }); } },
          { ...tl(msg`None`), run: () => { setMenu(null); setSnap({ guides: false, grid: false, layers: false, documentBounds: false, artboards: false }); } },
        ],
      },
    ],
    Window: [
      {
        ...tl(msg`Arrange`), keys: '›', run: () => {}, sub: [
          { ...tl(msg`Consolidate All to Tabs`, arrangeMode === 'tabs'), run: () => chooseArrangement('tabs'), off: !doc },
          { ...tl(msg`Tile All Vertically`, arrangeMode === 'vertical'), sep: true, run: () => chooseArrangement('vertical'), off: (doc?.docs.length ?? 0) < 2 },
          { ...tl(msg`Tile All Horizontally`, arrangeMode === 'horizontal'), run: () => chooseArrangement('horizontal'), off: (doc?.docs.length ?? 0) < 2 },
          ...([['2-up', msg`2-up`], ['3-up', msg`3-up`], ['4-up', msg`4-up`], ['6-up', msg`6-up`]] as const).map(([mode, label], index) => ({
            ...tl(label, arrangeMode === mode), sep: index === 0, run: () => chooseArrangement(mode), off: (doc?.docs.length ?? 0) < 2,
          })),
          { ...tl(msg`Float All in Windows`, arrangeMode === 'float'), sep: true, run: () => chooseArrangement('float'), off: (doc?.docs.length ?? 0) < 2 },
          { ...tl(msg`Match Zoom`), sep: true, run: () => matchArrangement('zoom'), off: (doc?.docs.length ?? 0) < 2 },
          { ...tl(msg`Match Location`), run: () => matchArrangement('location'), off: (doc?.docs.length ?? 0) < 2 },
          { ...tl(msg`Match All`), run: () => matchArrangement('all'), off: (doc?.docs.length ?? 0) < 2 },
        ],
      },
      {
        ...tl(msg`Workspace`), keys: '›', sep: true, run: () => {}, sub: [
          ...BUILTIN_WORKSPACES.map(w => ({ id: w.name, label: mark(workspace.selected === w.name, workspaceLabel(w.name)), run: () => chooseWorkspace(w.name) })),
          ...workspace.custom.map((w, i) => ({ label: `${workspace.selected === w.name ? '✓ ' : ''}${w.name}`, sep: i === 0, run: () => chooseWorkspace(w.name) })),
          { ...tl(msg`New Workspace…`), sep: true, run: () => openWorkspaceDialog('save') },
          { ...tl(msg`Delete Workspace…`), run: () => openWorkspaceDialog('delete'), off: !workspace.custom.length },
          { id: `Reset ${workspace.selected}`, label: t`Reset ${workspaceLabel(workspace.selected)}`, sep: true, run: resetCurrentWorkspace },
          { ...tl(msg`Lock Workspace`, workspace.locked), run: toggleWorkspaceLock },
        ],
      },
      { ...tl(showActions ? msg`Hide Actions` : msg`Show Actions`), keys: 'Alt+F9', sep: true, run: () => { setMenu(null); setShowActions(v => !v); }, off: workspace.locked },
      { ...tl(showAdjustments ? msg`Hide Adjustments` : msg`Show Adjustments`), run: () => { setMenu(null); setShowAdjustments(v => !v); }, off: workspace.locked },
      { ...tl(showChannels ? msg`Hide Channels` : msg`Show Channels`), run: () => { setMenu(null); setShowChannels(v => !v); }, off: workspace.locked },
      { ...tl(showCloneSource ? msg`Hide Clone Source` : msg`Show Clone Source`), run: () => { setMenu(null); setShowCloneSource(v => !v); }, off: workspace.locked },
      { ...tl(showNavigator ? msg`Hide Navigator` : msg`Show Navigator`), run: () => { setMenu(null); setShowNavigator(v => !v); }, off: workspace.locked },
      { ...tl(showLayerComps ? msg`Hide Layer Comps` : msg`Show Layer Comps`), run: () => { setMenu(null); setShowLayerComps(v => !v); }, off: workspace.locked },
      { ...tl(showPaths ? msg`Hide Paths` : msg`Show Paths`), run: () => { setMenu(null); setShowPaths(v => !v); }, off: workspace.locked },
      { ...tl(showProperties ? msg`Hide Properties` : msg`Show Properties`), run: () => { setMenu(null); setShowProperties(v => !v); }, off: workspace.locked },
      { ...tl(showStyles ? msg`Hide Styles` : msg`Show Styles`), run: () => { setMenu(null); setShowStyles(v => !v); }, off: workspace.locked },
      { ...tl(showPatterns ? msg`Hide Patterns` : msg`Show Patterns`), run: () => { setMenu(null); setShowPatterns(v => !v); }, off: workspace.locked },
      { ...tl(showGradients ? msg`Hide Gradients` : msg`Show Gradients`), run: () => { setMenu(null); setShowGradients(v => !v); }, off: workspace.locked },
      { ...tl(showShapes ? msg`Hide Shapes` : msg`Show Shapes`), run: () => { setMenu(null); setShowShapes(v => !v); }, off: workspace.locked },
      { ...tl(showHistogram ? msg`Hide Histogram` : msg`Show Histogram`), run: () => { setMenu(null); setShowHistogram(v => !v); }, off: workspace.locked },
      { ...tl(showInfo ? msg`Hide Info` : msg`Show Info`), run: () => { setMenu(null); setShowInfo(v => !v); }, off: workspace.locked },
      { ...tl(showToolPresets ? msg`Hide Tool Presets` : msg`Show Tool Presets`), run: () => { setMenu(null); setShowToolPresets(v => !v); }, off: workspace.locked },
      { ...tl(showNotes ? msg`Hide Notes` : msg`Show Notes`), run: () => { setMenu(null); setShowNotes(v => !v); }, off: workspace.locked },
      { ...tl(showMeasurementLog ? msg`Hide Measurement Log` : msg`Show Measurement Log`), run: () => { setMenu(null); setShowMeasurementLog(v => !v); }, off: workspace.locked },
      { ...tl(msg`Next Document`), keys: 'Ctrl+Tab', sep: true, run: () => switchStep(1), off: (doc?.docs.length ?? 0) < 2 },
      { ...tl(msg`Previous Document`), keys: 'Shift+Ctrl+Tab', run: () => switchStep(-1), off: (doc?.docs.length ?? 0) < 2 },
      ...(doc?.docs ?? []).map((d, i) => ({
        label: `${d.active ? '✓ ' : ''}${i + 1} ${d.name}${d.dirty ? '*' : ''}`, sep: i === 0, run: () => { setMenu(null); if (!d.active) void run(null, () => client.call('switchDoc', d.key)); },
      })),
    ],
    Help: [
      { ...tl(msg`Use with AI Agents…`), run: () => { setMenu(null); agentDialog.current?.showModal(); agentDialog.current?.querySelector<HTMLButtonElement>('.actions button')?.focus(); } },
      { ...tl(msg`About photobaer…`), run: () => { setMenu(null); aboutDialog.current?.showModal(); aboutDialog.current?.querySelector('button')?.focus(); } },
    ],
  };
  return menus;
}
