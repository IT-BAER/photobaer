import type { Dispatch, RefObject, SetStateAction } from 'react';
import { client } from '../client.ts';
import type { Active } from '../LayersPanel.tsx';
import type { StylePage } from '../LayerStyleDialog.tsx';
import { EFFECT_KINDS, EFFECT_LABEL } from '../layerStyle.ts';
import { ADJUSTMENT_KINDS, MENU_LABEL, SHORTCUT, type DestructiveKind, type Kind } from '../adjustments.ts';
import type { Rgb } from '../shell/color.ts';
import { MODES, type TransformBarStore, type WarpSplit } from '../shell/TransformBar.tsx';
import type { Command, Mode } from '../transform/session.ts';
import type { Viewer } from '../viewer.ts';
import type { DocInfo, LayerNode, SmartFilterInfo, SmartInfo } from '../worker/types.ts';
import type { SnapSettings } from '../shell/snapping.ts';
import { STACK_MODES, selectCreated, type FillContentForm, type Item, type MODIFY_OPS, type Run } from './helpers.ts';

type SetState<T> = Dispatch<SetStateAction<T>>;
type DialogRef = RefObject<HTMLDialogElement | null>;
type Mime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface MenuCtx {
  setMenu: SetState<string | null>; newDialog: DialogRef; fileInput: RefObject<HTMLInputElement | null>; placeFile: (linked: boolean) => Promise<void>;
  has: boolean; active: Active | null; saveProject: () => Promise<void>; savePsd: () => Promise<void>;
  exportAs: (mime: Mime, ext: string) => Promise<void>; exportLayerComps: (mime: Mime, ext: string) => Promise<void>;
  doc: DocInfo | null; closeContents: () => Promise<void>; run: Run; openPreviewDialog: (which: 'fill' | 'stroke') => void;
  quickFill: (rgb: Rgb, label: string) => void; fg: Rgb; bg: Rgb; quickMask: boolean; startTransform: (mode?: Mode, selection?: boolean) => Promise<void>;
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
  openAdjust: (kind: Kind | DestructiveKind) => void; hostOff: boolean; pixelsOff: boolean; applyDestructive: (kind: DestructiveKind) => void;
  rotateDialog: DialogRef; trimDialog: DialogRef; openColorRange: () => void; openModify: (op: keyof typeof MODIFY_OPS) => void;
  featherDialog: DialogRef; growOrSimilar: (op: 'grow' | 'similar') => () => void; setQuickMask: SetState<boolean>;
  loadSelDialog: DialogRef; saveSelDialog: DialogRef; blurDialog: DialogRef; viewer: RefObject<Viewer | null>;
  showAnts: boolean; setShowAnts: SetState<boolean>; showAdjustments: boolean; setShowAdjustments: SetState<boolean>;
  showLayerComps: boolean; setShowLayerComps: SetState<boolean>; showPaths: boolean; setShowPaths: SetState<boolean>; showProperties: boolean; setShowProperties: SetState<boolean>;
  showStyles: boolean; setShowStyles: SetState<boolean>; showPatterns: boolean; setShowPatterns: SetState<boolean>;
  showGradients: boolean; setShowGradients: SetState<boolean>;
  showRulers: boolean; setShowRulers: SetState<boolean>; showPixelGrid: boolean; setShowPixelGrid: SetState<boolean>;
  showGuides: boolean; setShowGuides: SetState<boolean>; showGrid: boolean; setShowGrid: SetState<boolean>;
  snap: SnapSettings; setSnap: (patch: Partial<SnapSettings>) => void;
  newGuideDialog: DialogRef; newGuideLayoutDialog: DialogRef;
}

export function buildMenus(c: MenuCtx) {
  const {
    setMenu, newDialog, fileInput, placeFile, has, active, saveProject, savePsd, exportAs, exportLayerComps, doc, closeContents, run,
    openPreviewDialog, quickFill, fg, bg, quickMask, startTransform, transformAgain, transformStore, transformMode, warping, warpMenuSplit,
    transformRemap, newLayer, newGroup, duplicateLayer, deleteLayer, deleteDisabled, groupLayers, ungroupLayers, node, toggleClipping, addMask,
    deleteMask, toggleMaskEnabled, openNewFillLayer, newAdjustmentLayer, openLayerContentOptions, smart, editContents, replaceContents,
    exportContents, convertToLinked, anyLinked, toggleLabel, filterCommand, filters, filterMasks, maskLabel, openFilterBlend, openLayerStyle,
    globalLightDialog, allEffectsHidden, anyStyled, scaleEffectsDialog, openAdjust, hostOff, pixelsOff, applyDestructive, rotateDialog, trimDialog,
    openColorRange, openModify, featherDialog, growOrSimilar, setQuickMask, loadSelDialog, saveSelDialog, blurDialog, viewer, showAnts, setShowAnts,
    showAdjustments, setShowAdjustments, showLayerComps, setShowLayerComps, showPaths, setShowPaths, showProperties, setShowProperties, showStyles, setShowStyles,
    showPatterns, setShowPatterns, showGradients, setShowGradients, showRulers, setShowRulers, showPixelGrid, setShowPixelGrid,
    showGuides, setShowGuides, showGrid, setShowGrid, newGuideDialog, newGuideLayoutDialog, snap, setSnap,
  } = c;
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
    { label: 'Rasterize', sep: true, run: () => node && run('Rasterizing…', () => client.call('rasterizeSmart', node.id, 'Rasterize')), off: !smart },
  ];

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
      { label: 'Close', run: () => doc?.parents.length ? closeContents() : run(null, () => client.call('closeDoc')), off: !has },
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
    Filter: [
      { label: 'Convert for Smart Filters', run: () => node && run('Converting…', () => client.call('convertForSmartFilters', node.id)), off: !has || node?.kind !== 'pixel' },
      {
        label: 'Blur', keys: '›', sep: true, run: () => {}, off: !has || !smart, sub: [
          { label: 'Gaussian Blur…', run: () => { setMenu(null); blurDialog.current?.showModal(); } },
        ],
      },
    ],
    View: [
      { label: 'Zoom in', keys: 'Ctrl++', run: () => { setMenu(null); viewer.current?.zoomBy(2); }, off: !has },
      { label: 'Zoom out', keys: 'Ctrl+-', run: () => { setMenu(null); viewer.current?.zoomBy(0.5); }, off: !has },
      { label: 'Fit on screen', keys: 'Ctrl+0', run: () => { setMenu(null); viewer.current?.fit(); }, off: !has },
      { label: '100%', keys: 'Ctrl+1', run: () => { setMenu(null); viewer.current?.actualPixels(); }, off: !has },
      { label: 'Reset rotation', keys: 'Esc', run: () => { setMenu(null); viewer.current?.resetRotation(); }, off: !has },
      { label: showAnts ? 'Hide selection edges' : 'Show selection edges', keys: 'Ctrl+H', run: () => { setMenu(null); setShowAnts(v => !v); }, off: !has },
      { label: showRulers ? 'Hide Rulers' : 'Show Rulers', keys: 'Ctrl+R', run: () => { setMenu(null); setShowRulers(v => !v); } },
      { label: showGuides ? 'Hide Guides' : 'Show Guides', keys: 'Ctrl+;', run: () => { setMenu(null); setShowGuides(v => !v); }, off: !has },
      { label: doc?.guidesLocked ? 'Unlock Guides' : 'Lock Guides', keys: 'Ctrl+Alt+;', run: () => run(null, () => client.call('setGuidesLocked', !doc?.guidesLocked)), off: !has },
      { label: 'Clear Guides', run: () => run(null, () => client.call('clearGuides', 'all', 0)), off: !doc?.guides.length },
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
      { label: showAdjustments ? 'Hide Adjustments' : 'Show Adjustments', run: () => { setMenu(null); setShowAdjustments(v => !v); } },
      { label: showLayerComps ? 'Hide Layer Comps' : 'Show Layer Comps', run: () => { setMenu(null); setShowLayerComps(v => !v); } },
      { label: showPaths ? 'Hide Paths' : 'Show Paths', run: () => { setMenu(null); setShowPaths(v => !v); } },
      { label: showProperties ? 'Hide Properties' : 'Show Properties', run: () => { setMenu(null); setShowProperties(v => !v); } },
      { label: showStyles ? 'Hide Styles' : 'Show Styles', run: () => { setMenu(null); setShowStyles(v => !v); } },
      { label: showPatterns ? 'Hide Patterns' : 'Show Patterns', run: () => { setMenu(null); setShowPatterns(v => !v); } },
      { label: showGradients ? 'Hide Gradients' : 'Show Gradients', run: () => { setMenu(null); setShowGradients(v => !v); } },
    ],
  };
  return menus;
}
