import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { BLEND_MODES, HDR_BLEND_MODES } from '../layers.ts';
// 'custom' options are drawn by the host (OptionsBar `custom`); 'segmented' is a button group over `choices`;
// 'color' holds a '#rrggbb' string, '' meaning the current foreground color.
export type OptionKind = 'number' | 'percent' | 'select' | 'boolean' | 'segmented' | 'custom' | 'color';
export interface OptionSchema {
  id: string; kind: OptionKind; label: MessageDescriptor; default: number | string | boolean;
  min?: number; max?: number; step?: number; unit?: string; choices?: string[];
  // `icon` draws a boolean as an icon toggle (label as tooltip); `sep` puts a divider before the option.
  icon?: string; sep?: boolean;
}
export interface Tool {
  id: string; label: MessageDescriptor; slot: string; key: string; cursor: string; icon: string;
  options: OptionSchema[];
}
export interface Slot { id: string; key: string; tools: string[] }

export const PAINT_MODES = [...BLEND_MODES, 'behind', 'clear'];

// A paint Mode select's choices for a document `depth`: 32-bit lists Photoshop's 32-bit modes (and keeps `current`).
export function paintModesFor(depth: number | undefined, current: string): string[] {
  if (depth !== 32) return PAINT_MODES;
  const hdr = [...HDR_BLEND_MODES, 'behind', 'clear'];
  return hdr.includes(current) ? hdr : [...hdr, current];
}

const SELECT_COMMON: OptionSchema[] = [
  { id: 'mode', kind: 'select', label: msg`Mode`, default: 'new', choices: ['new', 'add', 'subtract', 'intersect'] },
  { id: 'feather', kind: 'number', label: msg`Feather`, default: 0, min: 0, max: 1000, unit: 'px' },
  { id: 'antiAlias', kind: 'boolean', label: msg`Anti-alias`, default: true },
];

const BRUSH_COMMON: OptionSchema[] = [
  { id: 'size', kind: 'number', label: msg`Size`, default: 30, min: 1, max: 5000, unit: 'px' },
  { id: 'hardness', kind: 'percent', label: msg`Hardness`, default: 100, min: 0, max: 100 },
  { id: 'mode', kind: 'select', label: msg`Mode`, default: 'normal', choices: PAINT_MODES, sep: true },
  { id: 'opacity', kind: 'percent', label: msg`Opacity`, default: 100, min: 0, max: 100 },
  { id: 'flow', kind: 'percent', label: msg`Flow`, default: 100, min: 0, max: 100 },
  { id: 'smoothing', kind: 'percent', label: msg`Smoothing`, default: 10, min: 0, max: 100 },
  { id: 'airbrush', kind: 'boolean', label: msg`Airbrush`, default: false, icon: 'SprayCan', sep: true },
  { id: 'wetEdges', kind: 'boolean', label: msg`Wet Edges`, default: false, icon: 'Droplets' },
  { id: 'pressureSize', kind: 'boolean', label: msg`Pressure for Size`, default: false, icon: 'Scaling' },
  { id: 'pressureOpacity', kind: 'boolean', label: msg`Pressure for Opacity`, default: false, icon: 'Droplet' },
];

// Retouch tools (docs/M5.md section 9); the stamps take the brush options without Wet edges.
const RETOUCH_BRUSH: OptionSchema[] = BRUSH_COMMON.filter(o => o.id !== 'wetEdges');
const SAMPLE_ALL: OptionSchema = { id: 'allLayers', kind: 'boolean', label: msg`Sample All Layers`, default: false };
const STRUCTURE: OptionSchema = { id: 'structure', kind: 'number', label: msg`Structure`, default: 4, min: 1, max: 7 };
const COLOR_ADAPT: OptionSchema = { id: 'color', kind: 'number', label: msg`Color`, default: 2, min: 0, max: 10 };
const HEAL_BRUSH: OptionSchema[] = [
  { id: 'size', kind: 'number', label: msg`Size`, default: 30, min: 1, max: 5000, unit: 'px' },
  { id: 'hardness', kind: 'percent', label: msg`Hardness`, default: 100, min: 0, max: 100 },
  { id: 'mode', kind: 'select', label: msg`Mode`, default: 'normal', choices: PAINT_MODES, sep: true },
];
const healing = (id: string, label: MessageDescriptor, icon: string, cursor: string, options: OptionSchema[]): Tool => ({ id, label, slot: 'healing', key: 'j', cursor, icon, options });
const stamp = (id: string, label: MessageDescriptor, icon: string, options: OptionSchema[]): Tool => ({ id, label, slot: 'stamp', key: 's', cursor: 'none', icon, options });
const SIZE_HARD = BRUSH_COMMON.slice(0, 2);
const TOLERANCE: OptionSchema = { id: 'tolerance', kind: 'number', label: msg`Tolerance`, default: 32, min: 0, max: 255 };
const SAMPLING: OptionSchema = { id: 'sampling', kind: 'select', label: msg`Sampling`, default: 'continuous', choices: ['continuous', 'once', 'backgroundSwatch'] };
const LIMITS: OptionSchema = { id: 'limits', kind: 'select', label: msg`Limits`, default: 'contiguous', choices: ['discontiguous', 'contiguous', 'findEdges'] };
const SMOOTHING = BRUSH_COMMON.find(o => o.id === 'smoothing')!;
const STRENGTH: OptionSchema = { id: 'strength', kind: 'percent', label: msg`Strength`, default: 50, min: 0, max: 100 };
const toning = (id: string, label: MessageDescriptor, icon: string): Tool => ({
  id, label, slot: 'toning', key: 'o', cursor: 'none', icon, options: [
    ...SIZE_HARD,
    { id: 'range', kind: 'select', label: msg`Range`, default: 'midtones', choices: ['shadows', 'midtones', 'highlights'], sep: true },
    { id: 'exposure', kind: 'percent', label: msg`Exposure`, default: 50, min: 0, max: 100 },
    { id: 'airbrush', kind: 'boolean', label: msg`Airbrush`, default: false, icon: 'SprayCan' },
    { id: 'protectTones', kind: 'boolean', label: msg`Protect Tones`, default: true },
    SMOOTHING,
  ],
});
const focus = (id: string, label: MessageDescriptor, icon: string, options: OptionSchema[]): Tool => ({ id, label, slot: 'focus', key: '', cursor: 'none', icon, options });

const CORNER_RADIUS: OptionSchema = { id: 'cornerRadius', kind: 'number', label: msg`Corner Radius`, default: 0, min: 0, max: 1000, unit: 'px' };

// The shared shape tool options (docs/M4.md section 5); the line defaults to an outline.
function shapeTool(id: string, label: MessageDescriptor, icon: string, extra: OptionSchema[]): Tool {
  return {
    id, label, slot: 'shape', key: 'u', cursor: 'crosshair', icon,
    options: [
      { id: 'mode', kind: 'select', label: msg`Mode`, default: 'shape', choices: ['shape', 'path', 'pixels'] },
      { id: 'appearance', kind: 'select', label: msg`Appearance`, default: id === 'line' ? 'outline' : 'fill', choices: ['fill', 'outline', 'both', 'none'] },
      { id: 'fill', kind: 'color', label: msg({ message: 'Fill', context: 'shape fill color' }), default: '' },
      { id: 'stroke', kind: 'color', label: msg({ message: 'Stroke', context: 'shape stroke color' }), default: '' },
      { id: 'strokeWidth', kind: 'number', label: msg`Stroke Width`, default: 1, min: 0, max: 1000, unit: 'px' },
      { id: 'width', kind: 'number', label: msg`W`, default: 0, min: 0, max: 100000, unit: 'px' },
      { id: 'height', kind: 'number', label: msg`H`, default: 0, min: 0, max: 100000, unit: 'px' },
      ...extra,
    ],
  };
}

const PEN_MODE: OptionSchema = { id: 'mode', kind: 'select', label: msg`Mode`, default: 'path', choices: ['shape', 'path'] };
const pen = (id: string, label: MessageDescriptor, icon: string, options: OptionSchema[]): Tool => ({ id, label, slot: 'pen', key: 'p', cursor: 'crosshair', icon, options });
// Type tools (docs/M4.md section 10): family/style are drawn by the host; color '' = foreground.
const typeTool = (id: string, label: MessageDescriptor, icon: string, cursor: string): Tool => ({
  id, label, slot: 'type', key: 't', cursor, icon,
  options: [
    { id: 'family', kind: 'custom', label: msg`Font`, default: 'Noto Sans' },
    { id: 'style', kind: 'custom', label: msg`Style`, default: 'Regular' },
    { id: 'size', kind: 'number', label: msg`Size`, default: 28, min: 0.01, max: 1296, step: 0.01, unit: 'pt' },
    { id: 'alignment', kind: 'segmented', label: msg`Alignment`, default: 'left', choices: ['left', 'center', 'right'] },
    { id: 'color', kind: 'color', label: msg`Color`, default: '' },
    { id: 'typeActions', kind: 'custom', label: msg`Commit`, default: '' },
  ],
});
const pathSel = (id: string, label: MessageDescriptor, icon: string, options: OptionSchema[]): Tool => ({ id, label, slot: 'pathSelect', key: 'a', cursor: 'default', icon, options });

export const TOOLS: Record<string, Tool> = {
  move: {
    id: 'move', label: msg`Move`, slot: 'move', key: 'v', cursor: 'move', icon: 'Move',
    options: [
      { id: 'autoSelect', kind: 'boolean', label: msg`Auto-select`, default: false },
      { id: 'autoSelectTarget', kind: 'select', label: msg`Auto-select target`, default: 'layer', choices: ['layer', 'group'] },
      { id: 'showTransform', kind: 'boolean', label: msg`Show transform controls`, default: false },
      { id: 'snap', kind: 'boolean', label: msg`Snap`, default: true },
      { id: 'align', kind: 'custom', label: msg`Align`, default: '', sep: true },
    ],
  },
  marqueeRect: {
    id: 'marqueeRect', label: msg`Rectangular Marquee`, slot: 'marquee', key: 'm', cursor: 'crosshair', icon: 'Square',
    options: [
      ...SELECT_COMMON,
      { id: 'style', kind: 'select', label: msg`Style`, default: 'normal', choices: ['normal', 'fixed ratio', 'fixed size'] },
      { id: 'ratioW', kind: 'number', label: msg`Ratio W`, default: 1, min: 0.01, max: 1000 },
      { id: 'ratioH', kind: 'number', label: msg`Ratio H`, default: 1, min: 0.01, max: 1000 },
      { id: 'fixedW', kind: 'number', label: msg`Fixed W`, default: 100, min: 1, max: 30000, unit: 'px' },
      { id: 'fixedH', kind: 'number', label: msg`Fixed H`, default: 100, min: 1, max: 30000, unit: 'px' },
    ],
  },
  marqueeEllipse: {
    id: 'marqueeEllipse', label: msg`Elliptical Marquee`, slot: 'marquee', key: 'm', cursor: 'crosshair', icon: 'Circle',
    options: [
      ...SELECT_COMMON,
      { id: 'style', kind: 'select', label: msg`Style`, default: 'normal', choices: ['normal', 'fixed ratio', 'fixed size'] },
      { id: 'ratioW', kind: 'number', label: msg`Ratio W`, default: 1, min: 0.01, max: 1000 },
      { id: 'ratioH', kind: 'number', label: msg`Ratio H`, default: 1, min: 0.01, max: 1000 },
      { id: 'fixedW', kind: 'number', label: msg`Fixed W`, default: 100, min: 1, max: 30000, unit: 'px' },
      { id: 'fixedH', kind: 'number', label: msg`Fixed H`, default: 100, min: 1, max: 30000, unit: 'px' },
    ],
  },
  marqueeRow: {
    id: 'marqueeRow', label: msg`Single Row Marquee`, slot: 'marquee', key: 'm', cursor: 'crosshair', icon: 'Minus',
    options: [{ id: 'mode', kind: 'select', label: msg`Mode`, default: 'new', choices: ['new', 'add', 'subtract', 'intersect'] }],
  },
  marqueeColumn: {
    id: 'marqueeColumn', label: msg`Single Column Marquee`, slot: 'marquee', key: 'm', cursor: 'crosshair', icon: 'Rows3',
    options: [{ id: 'mode', kind: 'select', label: msg`Mode`, default: 'new', choices: ['new', 'add', 'subtract', 'intersect'] }],
  },
  lasso: {
    id: 'lasso', label: msg`Lasso`, slot: 'lasso', key: 'l', cursor: 'crosshair', icon: 'Lasso',
    options: [...SELECT_COMMON],
  },
  polygonalLasso: {
    id: 'polygonalLasso', label: msg`Polygonal Lasso`, slot: 'lasso', key: 'l', cursor: 'crosshair', icon: 'PenTool',
    options: [...SELECT_COMMON],
  },
  magneticLasso: {
    id: 'magneticLasso', label: msg`Magnetic Lasso`, slot: 'lasso', key: 'l', cursor: 'crosshair', icon: 'Magnet',
    options: [
      ...SELECT_COMMON,
      { id: 'width', kind: 'number', label: msg`Width`, default: 10, min: 1, max: 256, unit: 'px' },
      { id: 'contrast', kind: 'percent', label: msg`Contrast`, default: 10, min: 1, max: 100 },
      { id: 'frequency', kind: 'number', label: msg`Frequency`, default: 57, min: 0, max: 100 },
    ],
  },
  quickSelection: {
    id: 'quickSelection', label: msg`Quick Selection`, slot: 'wand', key: 'w', cursor: 'none', icon: 'MousePointerClick',
    options: [
      { id: 'size', kind: 'number', label: msg`Brush size`, default: 30, min: 1, max: 5000, unit: 'px' },
      { id: 'mode', kind: 'select', label: msg`Mode`, default: 'add', choices: ['new', 'add', 'subtract'] },
      { id: 'sampleAllLayers', kind: 'boolean', label: msg`Sample all layers`, default: false },
      { id: 'autoEnhance', kind: 'boolean', label: msg`Auto-enhance`, default: true },
    ],
  },
  magicWand: {
    id: 'magicWand', label: msg`Magic Wand`, slot: 'wand', key: 'w', cursor: 'crosshair', icon: 'Wand2',
    options: [
      { id: 'tolerance', kind: 'number', label: msg`Tolerance`, default: 32, min: 0, max: 255 },
      { id: 'antiAlias', kind: 'boolean', label: msg`Anti-alias`, default: true },
      { id: 'contiguous', kind: 'boolean', label: msg`Contiguous`, default: true },
      { id: 'sampleAllLayers', kind: 'boolean', label: msg`Sample all layers`, default: false },
    ],
  },
  crop: {
    id: 'crop', label: msg`Crop`, slot: 'crop', key: 'c', cursor: 'crosshair', icon: 'Crop',
    options: [
      // W and H are unitless ratio numbers, used only with 'free' when both are above 0.
      { id: 'ratio', kind: 'select', label: msg`Ratio`, default: 'free', choices: ['free', 'original', '1:1', '4:5', '5:7', '2:3', '16:9'] },
      { id: 'ratioWidth', kind: 'number', label: msg`W`, default: 0, min: 0, max: 30000 },
      { id: 'ratioHeight', kind: 'number', label: msg`H`, default: 0, min: 0, max: 30000 },
      { id: 'deleteCroppedPixels', kind: 'boolean', label: msg`Delete cropped pixels`, default: true },
      { id: 'straighten', kind: 'boolean', label: msg`Straighten`, default: false },
      { id: 'overlay', kind: 'select', label: msg`Overlay`, default: 'thirds', choices: ['none', 'thirds', 'grid', 'diagonal', 'triangle', 'golden ratio', 'golden spiral'] },
      { id: 'actions', kind: 'custom', label: msg`Crop actions`, default: '' },
    ],
  },
  perspectiveCrop: {
    id: 'perspectiveCrop', label: msg`Perspective Crop`, slot: 'crop', key: 'c', cursor: 'crosshair', icon: 'Frame',
    options: [
      // 0 = sized from the corners on the first release, which then writes the size back here.
      { id: 'outputWidth', kind: 'number', label: msg`W`, default: 0, min: 0, max: 30000, unit: 'px' },
      { id: 'outputHeight', kind: 'number', label: msg`H`, default: 0, min: 0, max: 30000, unit: 'px' },
    ],
  },
  eyedropper: {
    id: 'eyedropper', label: msg`Eyedropper`, slot: 'eyedropper', key: 'i', cursor: 'crosshair', icon: 'Pipette',
    options: [
      { id: 'sampleSize', kind: 'select', label: msg`Sample size`, default: 'point', choices: ['point', '3x3', '5x5', '11x11', '31x31', '51x51', '101x101'] },
      { id: 'sample', kind: 'select', label: msg`Sample`, default: 'all layers', choices: ['current layer', 'all layers'] },
    ],
  },
  brush: {
    id: 'brush', label: msg`Brush`, slot: 'brush', key: 'b', cursor: 'none', icon: 'Brush',
    options: BRUSH_COMMON,
  },
  pencil: {
    id: 'pencil', label: msg`Pencil`, slot: 'brush', key: 'b', cursor: 'none', icon: 'Pencil',
    options: [
      { id: 'size', kind: 'number', label: msg`Size`, default: 30, min: 1, max: 5000, unit: 'px' },
      { id: 'mode', kind: 'select', label: msg`Mode`, default: 'normal', choices: PAINT_MODES, sep: true },
      { id: 'opacity', kind: 'percent', label: msg`Opacity`, default: 100, min: 0, max: 100 },
      { id: 'smoothing', kind: 'percent', label: msg`Smoothing`, default: 10, min: 0, max: 100 },
      { id: 'autoErase', kind: 'boolean', label: msg`Auto erase`, default: false },
    ],
  },
  colorReplacement: {
    id: 'colorReplacement', label: msg`Color Replacement`, slot: 'brush', key: 'b', cursor: 'none', icon: 'Replace',
    options: [
      ...SIZE_HARD,
      { id: 'mode', kind: 'select', label: msg`Mode`, default: 'color', choices: ['hue', 'saturation', 'color', 'luminosity'], sep: true },
      SAMPLING, LIMITS, TOLERANCE,
      { id: 'antiAlias', kind: 'boolean', label: msg`Anti-alias`, default: true },
    ],
  },
  mixerBrush: {
    id: 'mixerBrush', label: msg`Mixer Brush`, slot: 'brush', key: 'b', cursor: 'none', icon: 'Palette',
    options: [
      ...SIZE_HARD,
      { id: 'wet', kind: 'percent', label: msg`Wet`, default: 50, min: 0, max: 100, sep: true },
      { id: 'load', kind: 'percent', label: msg`Load`, default: 50, min: 0, max: 100 },
      { id: 'mix', kind: 'percent', label: msg`Mix`, default: 50, min: 0, max: 100 },
      { id: 'flow', kind: 'percent', label: msg`Flow`, default: 100, min: 0, max: 100 },
      { id: 'mode', kind: 'select', label: msg`Mode`, default: 'normal', choices: BLEND_MODES },
      { id: 'loadAfterStroke', kind: 'boolean', label: msg`Load Brush After Each Stroke`, default: true, sep: true },
      { id: 'cleanAfterStroke', kind: 'boolean', label: msg`Clean Brush After Each Stroke`, default: false },
      SAMPLE_ALL, SMOOTHING,
    ],
  },
  eraser: {
    id: 'eraser', label: msg`Eraser`, slot: 'eraser', key: 'e', cursor: 'none', icon: 'Eraser',
    options: [
      { id: 'size', kind: 'number', label: msg`Size`, default: 30, min: 1, max: 5000, unit: 'px' },
      { id: 'hardness', kind: 'percent', label: msg`Hardness`, default: 100, min: 0, max: 100 },
      { id: 'mode', kind: 'select', label: msg`Mode`, default: 'brush', choices: ['brush', 'pencil', 'block'] },
      { id: 'opacity', kind: 'percent', label: msg`Opacity`, default: 100, min: 0, max: 100 },
      { id: 'flow', kind: 'percent', label: msg`Flow`, default: 100, min: 0, max: 100 },
      { id: 'airbrush', kind: 'boolean', label: msg`Airbrush`, default: false, icon: 'SprayCan', sep: true },
      { id: 'smoothing', kind: 'percent', label: msg`Smoothing`, default: 10, min: 0, max: 100 },
      { id: 'eraseToHistory', kind: 'boolean', label: msg`Erase to history`, default: false },
    ],
  },
  backgroundEraser: {
    id: 'backgroundEraser', label: msg`Background Eraser`, slot: 'eraser', key: 'e', cursor: 'none', icon: 'BrushCleaning',
    options: [
      ...SIZE_HARD, { ...LIMITS, sep: true }, TOLERANCE, SAMPLING,
      { id: 'protectForeground', kind: 'boolean', label: msg`Protect Foreground Color`, default: false },
    ],
  },
  magicEraser: {
    id: 'magicEraser', label: msg`Magic Eraser`, slot: 'eraser', key: 'e', cursor: 'crosshair', icon: 'WandSparkles',
    options: [
      TOLERANCE,
      { id: 'antiAlias', kind: 'boolean', label: msg`Anti-alias`, default: true },
      { id: 'contiguous', kind: 'boolean', label: msg`Contiguous`, default: true },
      SAMPLE_ALL,
      { id: 'opacity', kind: 'percent', label: msg`Opacity`, default: 100, min: 0, max: 100 },
    ],
  },
  spotHealing: healing('spotHealing', msg`Spot Healing Brush`, 'Bandage', 'none', [
    ...HEAL_BRUSH,
    { id: 'type', kind: 'select', label: msg`Type`, default: 'contentAware', choices: ['proximityMatch', 'createTexture', 'contentAware'] },
    SAMPLE_ALL,
  ]),
  healingBrush: healing('healingBrush', msg`Healing Brush`, 'Syringe', 'none', [
    ...HEAL_BRUSH,
    { id: 'source', kind: 'select', label: msg`Source`, default: 'sampled', choices: ['sampled', 'pattern'] },
    // '' = the first library pattern; the picker is drawn by the host.
    { id: 'pattern', kind: 'custom', label: msg`Pattern`, default: '' },
    { id: 'aligned', kind: 'boolean', label: msg`Aligned`, default: false },
    { id: 'diffusion', kind: 'number', label: msg`Diffusion`, default: 5, min: 1, max: 7 },
    SAMPLE_ALL,
  ]),
  patch: healing('patch', msg`Patch`, 'SquareDashed', 'move', [
    { id: 'patchMode', kind: 'select', label: msg`Patch`, default: 'normal', choices: ['normal', 'contentAware'] },
    { id: 'mode', kind: 'select', label: msg`Source`, default: 'source', choices: ['source', 'destination'] },
    STRUCTURE, COLOR_ADAPT,
    { id: 'transparent', kind: 'boolean', label: msg`Transparent`, default: false },
    SAMPLE_ALL,
  ]),
  contentAwareMove: healing('contentAwareMove', msg`Content-Aware Move`, 'Move3d', 'move', [
    { id: 'mode', kind: 'select', label: msg`Mode`, default: 'move', choices: ['move', 'extend'] },
    STRUCTURE, COLOR_ADAPT, SAMPLE_ALL,
    { id: 'transformOnDrop', kind: 'boolean', label: msg`Transform On Drop`, default: false },
  ]),
  redEye: healing('redEye', msg`Red Eye`, 'Eye', 'crosshair', [
    { id: 'pupilSize', kind: 'percent', label: msg`Pupil Size`, default: 50, min: 0, max: 100 },
    { id: 'darken', kind: 'percent', label: msg`Darken Amount`, default: 50, min: 0, max: 100 },
  ]),
  cloneStamp: stamp('cloneStamp', msg`Clone Stamp`, 'Stamp', [
    ...RETOUCH_BRUSH,
    { id: 'aligned', kind: 'boolean', label: msg`Aligned`, default: true, sep: true },
    { id: 'sample', kind: 'select', label: msg`Sample`, default: 'currentLayer', choices: ['currentLayer', 'currentBelow', 'allLayers'] },
    { id: 'ignoreAdjustments', kind: 'boolean', label: msg`Ignore Adjustment Layers`, default: false, icon: 'CircleSlash2' },
  ]),
  patternStamp: stamp('patternStamp', msg`Pattern Stamp`, 'Grid3x3', [
    ...RETOUCH_BRUSH,
    { id: 'aligned', kind: 'boolean', label: msg`Aligned`, default: true, sep: true },
    { id: 'impressionist', kind: 'boolean', label: msg`Impressionist`, default: false },
    // '' = the first library pattern; the picker is drawn by the host.
    { id: 'pattern', kind: 'custom', label: msg`Pattern`, default: '' },
  ]),
  historyBrush: { id: 'historyBrush', label: msg`History Brush`, slot: 'historyBrush', key: 'y', cursor: 'none', icon: 'History', options: BRUSH_COMMON },
  artHistoryBrush: {
    id: 'artHistoryBrush', label: msg`Art History Brush`, slot: 'historyBrush', key: 'y', cursor: 'none', icon: 'PaintbrushVertical', options: [
      BRUSH_COMMON[0],
      { id: 'style', kind: 'select', label: msg`Style`, default: 'tightShort', choices: ['tightShort', 'tightMedium', 'tightLong', 'looseMedium', 'looseLong', 'dab', 'tightCurl', 'tightCurlLong', 'looseCurl', 'looseCurlLong'] },
      { id: 'area', kind: 'number', label: msg`Area`, default: 50, min: 1, max: 500, unit: 'px' },
      { id: 'tolerance', kind: 'percent', label: msg`Tolerance`, default: 0, min: 0, max: 100 },
      { id: 'mode', kind: 'select', label: msg`Mode`, default: 'normal', choices: PAINT_MODES, sep: true },
      { id: 'opacity', kind: 'percent', label: msg`Opacity`, default: 100, min: 0, max: 100 },
    ],
  },
  blur: focus('blur', msg`Blur`, 'Droplet', [...SIZE_HARD, { ...STRENGTH, sep: true }, SAMPLE_ALL, SMOOTHING]),
  sharpen: focus('sharpen', msg`Sharpen`, 'Focus', [...SIZE_HARD, { ...STRENGTH, sep: true }, SAMPLE_ALL, SMOOTHING]),
  smudge: focus('smudge', msg`Smudge`, 'Pointer', [
    ...SIZE_HARD,
    { id: 'mode', kind: 'select', label: msg`Mode`, default: 'normal', choices: ['normal', 'darken', 'lighten', 'hue', 'saturation', 'color', 'luminosity'], sep: true },
    STRENGTH, SAMPLE_ALL,
    { id: 'fingerPainting', kind: 'boolean', label: msg`Finger Painting`, default: false },
    { id: 'pressureOpacity', kind: 'boolean', label: msg`Pressure for Strength`, default: false, icon: 'Droplet' },
    SMOOTHING,
  ]),
  dodge: toning('dodge', msg`Dodge`, 'Sun'),
  burn: toning('burn', msg`Burn`, 'Moon'),
  sponge: {
    id: 'sponge', label: msg`Sponge`, slot: 'toning', key: 'o', cursor: 'none', icon: 'Contrast', options: [
      ...SIZE_HARD,
      { id: 'mode', kind: 'select', label: msg`Mode`, default: 'desaturate', choices: ['desaturate', 'saturate'], sep: true },
      { id: 'flow', kind: 'percent', label: msg`Flow`, default: 100, min: 0, max: 100 },
      { id: 'vibrance', kind: 'boolean', label: msg`Vibrance`, default: true },
      SMOOTHING,
    ],
  },
  gradient: {
    id: 'gradient', label: msg`Gradient`, slot: 'gradient', key: 'g', cursor: 'crosshair', icon: 'Blend',
    options: [
      { id: 'gradient', kind: 'custom', label: msg`Gradient`, default: 'builtin.fgToBg' },
      { id: 'style', kind: 'segmented', label: msg`Style`, default: 'linear', choices: ['linear', 'radial', 'angle', 'reflected', 'diamond'] },
      { id: 'opacity', kind: 'percent', label: msg`Opacity`, default: 100, min: 0, max: 100 },
      { id: 'reverse', kind: 'boolean', label: msg`Reverse`, default: false },
      { id: 'dither', kind: 'boolean', label: msg`Dither`, default: true },
      { id: 'method', kind: 'select', label: msg`Method`, default: 'perceptual', choices: ['perceptual', 'linear', 'classic'] },
      { id: 'transparency', kind: 'boolean', label: msg`Transparency`, default: true },
    ],
  },
  bucket: {
    id: 'bucket', label: msg`Paint Bucket`, slot: 'gradient', key: 'g', cursor: 'crosshair', icon: 'PaintBucket',
    options: [
      // Pattern source is not in B3 (no pattern picker yet); hidden rather than offered disabled.
      { id: 'source', kind: 'select', label: msg`Source`, default: 'foreground', choices: ['foreground', 'background'] },
      { id: 'mode', kind: 'select', label: msg`Mode`, default: 'normal', choices: PAINT_MODES, sep: true },
      { id: 'opacity', kind: 'percent', label: msg`Opacity`, default: 100, min: 0, max: 100 },
      { id: 'tolerance', kind: 'number', label: msg`Tolerance`, default: 32, min: 0, max: 255 },
      { id: 'antiAlias', kind: 'boolean', label: msg`Anti-alias`, default: true },
      { id: 'contiguous', kind: 'boolean', label: msg`Contiguous`, default: true },
      { id: 'allLayers', kind: 'boolean', label: msg`Sample All Layers`, default: false },
    ],
  },
  rectangle: shapeTool('rectangle', msg`Rectangle`, 'RectangleHorizontal', [CORNER_RADIUS]),
  ellipse: shapeTool('ellipse', msg`Ellipse`, 'Circle', []),
  triangle: shapeTool('triangle', msg`Triangle`, 'Triangle', [CORNER_RADIUS]),
  polygon: shapeTool('polygon', msg`Polygon`, 'Hexagon', [
    { id: 'sides', kind: 'number', label: msg`Sides`, default: 5, min: 3, max: 100 },
    { id: 'starInset', kind: 'percent', label: msg`Star Inset`, default: 0, min: 0, max: 99 },
    CORNER_RADIUS,
  ]),
  line: shapeTool('line', msg`Line`, 'Slash', []),
  // The Shape picker is drawn by the host from the custom shape library.
  customShape: shapeTool('customShape', msg`Custom Shape`, 'Shapes', [{ id: 'customShape', kind: 'custom', label: msg`Shape`, default: '' }]),
  pen: pen('pen', msg`Pen`, 'PenTool', [
    PEN_MODE,
    // Fill '' = the foreground color, Stroke '' = the background color; width 0 = no stroke.
    { id: 'fill', kind: 'color', label: msg({ message: 'Fill', context: 'shape fill color' }), default: '' },
    { id: 'stroke', kind: 'color', label: msg({ message: 'Stroke', context: 'shape stroke color' }), default: '' },
    { id: 'strokeWidth', kind: 'number', label: msg`Stroke Width`, default: 0, min: 0, max: 1000, unit: 'px' },
    { id: 'pathOp', kind: 'select', label: msg`Path Operations`, default: 'new', choices: ['new', 'add', 'subtract', 'intersect', 'exclude'] },
    { id: 'autoAddDelete', kind: 'boolean', label: msg`Auto Add/Delete`, default: true },
    { id: 'rubberBand', kind: 'boolean', label: msg`Rubber Band`, default: true },
    { id: 'alignEdges', kind: 'boolean', label: msg`Align Edges`, default: false },
  ]),
  freeformPen: pen('freeformPen', msg`Freeform Pen`, 'Signature', [
    PEN_MODE,
    { id: 'magnetic', kind: 'boolean', label: msg`Magnetic`, default: false },
    { id: 'width', kind: 'number', label: msg`Width`, default: 10, min: 1, max: 256, unit: 'px' },
    { id: 'curveFit', kind: 'number', label: msg`Curve Fit`, default: 2, min: 0.5, max: 10, unit: 'px' },
  ]),
  curvaturePen: pen('curvaturePen', msg`Curvature Pen`, 'Spline', [PEN_MODE]),
  addAnchor: pen('addAnchor', msg`Add Anchor Point`, 'DiamondPlus', []),
  deleteAnchor: pen('deleteAnchor', msg`Delete Anchor Point`, 'DiamondMinus', []),
  convertPoint: pen('convertPoint', msg`Convert Point`, 'SplinePointer', []),
  pathSelection: pathSel('pathSelection', msg`Path Selection`, 'MousePointer2', [
    { id: 'constrain', kind: 'select', label: msg`Constrain`, default: 'free', choices: ['free', 'axis'] },
  ]),
  directSelection: pathSel('directSelection', msg`Direct Selection`, 'Navigation', []),
  horizontalType: typeTool('horizontalType', msg`Horizontal Type`, 'Type', 'text'),
  verticalType: typeTool('verticalType', msg`Vertical Type`, 'TextCursor', 'vertical-text'),
  horizontalTypeMask: typeTool('horizontalTypeMask', msg`Horizontal Type Mask`, 'SquareDashedText', 'text'),
  verticalTypeMask: typeTool('verticalTypeMask', msg`Vertical Type Mask`, 'TypeOutline', 'vertical-text'),
  colorSampler: {
    id: 'colorSampler', label: msg`Color Sampler`, slot: 'eyedropper', key: 'i', cursor: 'crosshair', icon: 'Crosshair',
    options: [
      { id: 'sampleSize', kind: 'select', label: msg`Sample size`, default: 'point', choices: ['point', '3x3', '5x5', '11x11', '31x31', '51x51', '101x101'] },
      { id: 'measure', kind: 'custom', label: msg`Samplers`, default: '', sep: true },
    ],
  },
  ruler: {
    id: 'ruler', label: msg`Ruler`, slot: 'eyedropper', key: 'i', cursor: 'crosshair', icon: 'Ruler',
    options: [{ id: 'measure', kind: 'custom', label: msg`Measurement`, default: '' }],
  },
  note: {
    id: 'note', label: msg`Note`, slot: 'eyedropper', key: 'i', cursor: 'crosshair', icon: 'StickyNote',
    options: [
      { id: 'noteColor', kind: 'color', label: msg`Color`, default: '#f2c94c' },
      { id: 'measure', kind: 'custom', label: msg`Notes`, default: '', sep: true },
    ],
  },
  count: {
    id: 'count', label: msg`Count`, slot: 'eyedropper', key: 'i', cursor: 'crosshair', icon: 'Hash',
    options: [
      { id: 'group', kind: 'number', label: msg`Count Group`, default: 1, min: 1, max: 99 },
      { id: 'markerSize', kind: 'number', label: msg`Marker Size`, default: 3, min: 1, max: 10 },
      { id: 'labelSize', kind: 'number', label: msg`Label Size`, default: 12, min: 8, max: 72 },
      { id: 'measure', kind: 'custom', label: msg`Count`, default: '', sep: true },
    ],
  },
  slice: {
    id: 'slice', label: msg`Slice`, slot: 'crop', key: 'c', cursor: 'crosshair', icon: 'Slice',
    options: [
      { id: 'style', kind: 'select', label: msg`Style`, default: 'normal', choices: ['normal', 'fixed ratio', 'fixed size'] },
      { id: 'ratioW', kind: 'number', label: msg`Ratio W`, default: 1, min: 0.01, max: 1000 },
      { id: 'ratioH', kind: 'number', label: msg`Ratio H`, default: 1, min: 0.01, max: 1000 },
      { id: 'fixedW', kind: 'number', label: msg`Fixed W`, default: 100, min: 1, max: 30000, unit: 'px' },
      { id: 'fixedH', kind: 'number', label: msg`Fixed H`, default: 100, min: 1, max: 30000, unit: 'px' },
      { id: 'measure', kind: 'custom', label: msg`Slices`, default: '', sep: true },
    ],
  },
  sliceSelect: {
    id: 'sliceSelect', label: msg`Slice Select`, slot: 'crop', key: 'c', cursor: 'default', icon: 'SquareMousePointer',
    options: [{ id: 'measure', kind: 'custom', label: msg`Slice`, default: '' }],
  },
  artboard: {
    id: 'artboard', label: msg`Artboard`, slot: 'move', key: 'v', cursor: 'crosshair', icon: 'LayoutTemplate',
    options: [
      { id: 'width', kind: 'number', label: msg`W`, default: 1920, min: 1, max: 30000, unit: 'px' },
      { id: 'height', kind: 'number', label: msg`H`, default: 1080, min: 1, max: 30000, unit: 'px' },
      { id: 'background', kind: 'select', label: msg`Background`, default: 'white', choices: ['white', 'black', 'transparent'] },
    ],
  },
  frame: {
    id: 'frame', label: msg`Frame`, slot: 'frame', key: 'k', cursor: 'crosshair', icon: 'Scan',
    options: [{ id: 'shape', kind: 'segmented', label: msg`Frame`, default: 'rectangle', choices: ['rectangle', 'ellipse'] }],
  },
  hand: { id: 'hand', label: msg`Hand`, slot: 'hand', key: 'h', cursor: 'grab', icon: 'Hand', options: [] },
  rotate: { id: 'rotate', label: msg`Rotate View`, slot: 'rotate', key: 'r', cursor: 'alias', icon: 'RotateCw', options: [] },
  zoom: { id: 'zoom', label: msg`Zoom`, slot: 'zoom', key: 'z', cursor: 'zoom-in', icon: 'ZoomIn', options: [] },
};

export const SLOTS: Slot[] = [
  { id: 'move', key: 'v', tools: ['move', 'artboard'] },
  { id: 'marquee', key: 'm', tools: ['marqueeRect', 'marqueeEllipse', 'marqueeRow', 'marqueeColumn'] },
  { id: 'lasso', key: 'l', tools: ['lasso', 'polygonalLasso', 'magneticLasso'] },
  { id: 'wand', key: 'w', tools: ['quickSelection', 'magicWand'] },
  { id: 'crop', key: 'c', tools: ['crop', 'perspectiveCrop', 'slice', 'sliceSelect'] },
  { id: 'frame', key: 'k', tools: ['frame'] },
  { id: 'eyedropper', key: 'i', tools: ['eyedropper', 'colorSampler', 'ruler', 'note', 'count'] },
  { id: 'healing', key: 'j', tools: ['spotHealing', 'healingBrush', 'patch', 'contentAwareMove', 'redEye'] },
  { id: 'brush', key: 'b', tools: ['brush', 'pencil', 'colorReplacement', 'mixerBrush'] },
  { id: 'stamp', key: 's', tools: ['cloneStamp', 'patternStamp'] },
  { id: 'historyBrush', key: 'y', tools: ['historyBrush', 'artHistoryBrush'] },
  { id: 'eraser', key: 'e', tools: ['eraser', 'backgroundEraser', 'magicEraser'] },
  { id: 'gradient', key: 'g', tools: ['gradient', 'bucket'] },
  { id: 'focus', key: '', tools: ['blur', 'sharpen', 'smudge'] },
  { id: 'toning', key: 'o', tools: ['dodge', 'burn', 'sponge'] },
  { id: 'shape', key: 'u', tools: ['rectangle', 'ellipse', 'triangle', 'polygon', 'line', 'customShape'] },
  { id: 'pen', key: 'p', tools: ['pen', 'freeformPen', 'curvaturePen', 'addAnchor', 'deleteAnchor', 'convertPoint'] },
  { id: 'pathSelect', key: 'a', tools: ['pathSelection', 'directSelection'] },
  { id: 'type', key: 't', tools: ['horizontalType', 'verticalType', 'horizontalTypeMask', 'verticalTypeMask'] },
  { id: 'hand', key: 'h', tools: ['hand'] },
  { id: 'rotate', key: 'r', tools: ['rotate'] },
  { id: 'zoom', key: 'z', tools: ['zoom'] },
];

export function initialLastUsed(): Record<string, string> {
  return Object.fromEntries(SLOTS.map(s => [s.id, s.tools[0]]));
}

export function slotForKey(key: string): Slot | undefined {
  const k = key.toLowerCase();
  return SLOTS.find(s => s.key === k);
}

// The tool after `current` in the slot's cycle, wrapping around; `current` outside the slot starts at its first tool.
export function cycleTool(slot: Slot, current: string): string {
  const i = slot.tools.indexOf(current);
  return slot.tools[(i + 1) % slot.tools.length];
}

// A letter key selects the slot's last-used tool; Shift+letter cycles within the slot from the
// currently active tool if it belongs there, else from the slot's last-used tool. Returns null for
// keys that map to no slot.
export function keyToTool(key: string, shift: boolean, active: string, lastUsed: Record<string, string>): string | null {
  const slot = slotForKey(key);
  if (!slot) return null;
  if (!shift) return lastUsed[slot.id] ?? slot.tools[0];
  const from = slot.tools.includes(active) ? active : lastUsed[slot.id] ?? slot.tools[0];
  return cycleTool(slot, from);
}

const STORE_KEY = (toolId: string) => `photobaer:options:${toolId}`;

export function defaultOptions(tool: Tool): Record<string, number | string | boolean> {
  return Object.fromEntries(tool.options.map(o => [o.id, o.default]));
}

export function loadToolOptions(tool: Tool): Record<string, number | string | boolean> {
  const defaults = defaultOptions(tool);
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY(tool.id));
    // A stored value of another type than the default (the option changed kind) is dropped.
    if (raw) return { ...defaults, ...Object.fromEntries(Object.entries(JSON.parse(raw) as Record<string, number | string | boolean>).filter(([k, v]) => !(k in defaults) || typeof v === typeof defaults[k])) };
  } catch { /* storage unavailable or corrupt: fall back to defaults */ }
  return defaults;
}

export function saveToolOptions(tool: Tool, values: Record<string, number | string | boolean>) {
  try {
    globalThis.localStorage?.setItem(STORE_KEY(tool.id), JSON.stringify(values));
  } catch { /* storage unavailable: options stay session-only */ }
}
