import { BLEND_MODES } from '../layers.ts';
// 'custom' options are drawn by the host (OptionsBar `custom`); 'segmented' is a button group over `choices`;
// 'color' holds a '#rrggbb' string, '' meaning the current foreground color.
export type OptionKind = 'number' | 'percent' | 'select' | 'boolean' | 'segmented' | 'custom' | 'color';
export interface OptionSchema {
  id: string; kind: OptionKind; label: string; default: number | string | boolean;
  min?: number; max?: number; step?: number; unit?: string; choices?: string[];
  // `icon` draws a boolean as an icon toggle (label as tooltip); `sep` puts a divider before the option.
  icon?: string; sep?: boolean;
}
export interface Tool {
  id: string; label: string; slot: string; key: string; cursor: string; icon: string;
  options: OptionSchema[];
}
export interface Slot { id: string; key: string; tools: string[] }

export const PAINT_MODES = [...BLEND_MODES, 'behind', 'clear'];

const SELECT_COMMON: OptionSchema[] = [
  { id: 'mode', kind: 'select', label: 'Mode', default: 'new', choices: ['new', 'add', 'subtract', 'intersect'] },
  { id: 'feather', kind: 'number', label: 'Feather', default: 0, min: 0, max: 1000, unit: 'px' },
  { id: 'antiAlias', kind: 'boolean', label: 'Anti-alias', default: true },
];

const BRUSH_COMMON: OptionSchema[] = [
  { id: 'size', kind: 'number', label: 'Size', default: 30, min: 1, max: 5000, unit: 'px' },
  { id: 'hardness', kind: 'percent', label: 'Hardness', default: 100, min: 0, max: 100 },
  { id: 'mode', kind: 'select', label: 'Mode', default: 'normal', choices: PAINT_MODES, sep: true },
  { id: 'opacity', kind: 'percent', label: 'Opacity', default: 100, min: 0, max: 100 },
  { id: 'flow', kind: 'percent', label: 'Flow', default: 100, min: 0, max: 100 },
  { id: 'smoothing', kind: 'percent', label: 'Smoothing', default: 10, min: 0, max: 100 },
  { id: 'airbrush', kind: 'boolean', label: 'Airbrush', default: false, icon: 'SprayCan', sep: true },
  { id: 'wetEdges', kind: 'boolean', label: 'Wet Edges', default: false, icon: 'Droplets' },
  { id: 'pressureSize', kind: 'boolean', label: 'Pressure for Size', default: false, icon: 'Scaling' },
  { id: 'pressureOpacity', kind: 'boolean', label: 'Pressure for Opacity', default: false, icon: 'Droplet' },
];

// Retouch tools (docs/M5.md section 9); the stamps take the brush options without Wet edges.
const RETOUCH_BRUSH: OptionSchema[] = BRUSH_COMMON.filter(o => o.id !== 'wetEdges');
const SAMPLE_ALL: OptionSchema = { id: 'allLayers', kind: 'boolean', label: 'Sample All Layers', default: false };
const STRUCTURE: OptionSchema = { id: 'structure', kind: 'number', label: 'Structure', default: 4, min: 1, max: 7 };
const COLOR_ADAPT: OptionSchema = { id: 'color', kind: 'number', label: 'Color', default: 2, min: 0, max: 10 };
const HEAL_BRUSH: OptionSchema[] = [
  { id: 'size', kind: 'number', label: 'Size', default: 30, min: 1, max: 5000, unit: 'px' },
  { id: 'hardness', kind: 'percent', label: 'Hardness', default: 100, min: 0, max: 100 },
  { id: 'mode', kind: 'select', label: 'Mode', default: 'normal', choices: PAINT_MODES, sep: true },
];
const healing = (id: string, label: string, icon: string, cursor: string, options: OptionSchema[]): Tool => ({ id, label, slot: 'healing', key: 'j', cursor, icon, options });
const stamp = (id: string, label: string, icon: string, options: OptionSchema[]): Tool => ({ id, label, slot: 'stamp', key: 's', cursor: 'none', icon, options });
const SIZE_HARD = BRUSH_COMMON.slice(0, 2);
const TOLERANCE: OptionSchema = { id: 'tolerance', kind: 'number', label: 'Tolerance', default: 32, min: 0, max: 255 };
const SAMPLING: OptionSchema = { id: 'sampling', kind: 'select', label: 'Sampling', default: 'continuous', choices: ['continuous', 'once', 'backgroundSwatch'] };
const LIMITS: OptionSchema = { id: 'limits', kind: 'select', label: 'Limits', default: 'contiguous', choices: ['discontiguous', 'contiguous', 'findEdges'] };
const SMOOTHING = BRUSH_COMMON.find(o => o.id === 'smoothing')!;
const STRENGTH: OptionSchema = { id: 'strength', kind: 'percent', label: 'Strength', default: 50, min: 0, max: 100 };
const toning = (id: string, label: string, icon: string): Tool => ({
  id, label, slot: 'toning', key: 'o', cursor: 'none', icon, options: [
    ...SIZE_HARD,
    { id: 'range', kind: 'select', label: 'Range', default: 'midtones', choices: ['shadows', 'midtones', 'highlights'], sep: true },
    { id: 'exposure', kind: 'percent', label: 'Exposure', default: 50, min: 0, max: 100 },
    { id: 'airbrush', kind: 'boolean', label: 'Airbrush', default: false, icon: 'SprayCan' },
    { id: 'protectTones', kind: 'boolean', label: 'Protect Tones', default: true },
    SMOOTHING,
  ],
});
const focus = (id: string, label: string, icon: string, options: OptionSchema[]): Tool => ({ id, label, slot: 'focus', key: '', cursor: 'none', icon, options });

const CORNER_RADIUS: OptionSchema = { id: 'cornerRadius', kind: 'number', label: 'Corner Radius', default: 0, min: 0, max: 1000, unit: 'px' };

// The shared shape tool options (docs/M4.md section 5); the line defaults to an outline.
function shapeTool(id: string, label: string, icon: string, extra: OptionSchema[]): Tool {
  return {
    id, label, slot: 'shape', key: 'u', cursor: 'crosshair', icon,
    options: [
      { id: 'mode', kind: 'select', label: 'Mode', default: 'shape', choices: ['shape', 'path', 'pixels'] },
      { id: 'appearance', kind: 'select', label: 'Appearance', default: id === 'line' ? 'outline' : 'fill', choices: ['fill', 'outline', 'both', 'none'] },
      { id: 'fill', kind: 'color', label: 'Fill', default: '' },
      { id: 'stroke', kind: 'color', label: 'Stroke', default: '' },
      { id: 'strokeWidth', kind: 'number', label: 'Stroke Width', default: 1, min: 0, max: 1000, unit: 'px' },
      { id: 'width', kind: 'number', label: 'W', default: 0, min: 0, max: 100000, unit: 'px' },
      { id: 'height', kind: 'number', label: 'H', default: 0, min: 0, max: 100000, unit: 'px' },
      ...extra,
    ],
  };
}

const PEN_MODE: OptionSchema = { id: 'mode', kind: 'select', label: 'Mode', default: 'path', choices: ['shape', 'path'] };
const pen = (id: string, label: string, icon: string, options: OptionSchema[]): Tool => ({ id, label, slot: 'pen', key: 'p', cursor: 'crosshair', icon, options });
// Type tools (docs/M4.md section 10): family/style are drawn by the host; color '' = foreground.
const typeTool = (id: string, label: string, icon: string, cursor: string): Tool => ({
  id, label, slot: 'type', key: 't', cursor, icon,
  options: [
    { id: 'family', kind: 'custom', label: 'Font', default: 'Noto Sans' },
    { id: 'style', kind: 'custom', label: 'Style', default: 'Regular' },
    { id: 'size', kind: 'number', label: 'Size', default: 28, min: 0.01, max: 1296, step: 0.01, unit: 'pt' },
    { id: 'alignment', kind: 'segmented', label: 'Alignment', default: 'left', choices: ['left', 'center', 'right'] },
    { id: 'color', kind: 'color', label: 'Color', default: '' },
    { id: 'typeActions', kind: 'custom', label: 'Commit', default: '' },
  ],
});
const pathSel = (id: string, label: string, icon: string, options: OptionSchema[]): Tool => ({ id, label, slot: 'pathSelect', key: 'a', cursor: 'default', icon, options });

export const TOOLS: Record<string, Tool> = {
  move: {
    id: 'move', label: 'Move', slot: 'move', key: 'v', cursor: 'move', icon: 'Move',
    options: [
      { id: 'autoSelect', kind: 'boolean', label: 'Auto-select', default: false },
      { id: 'autoSelectTarget', kind: 'select', label: 'Auto-select target', default: 'layer', choices: ['layer', 'group'] },
      { id: 'showTransform', kind: 'boolean', label: 'Show transform controls', default: false },
      { id: 'snap', kind: 'boolean', label: 'Snap', default: true },
      { id: 'align', kind: 'custom', label: 'Align', default: '', sep: true },
    ],
  },
  marqueeRect: {
    id: 'marqueeRect', label: 'Rectangular Marquee', slot: 'marquee', key: 'm', cursor: 'crosshair', icon: 'Square',
    options: [
      ...SELECT_COMMON,
      { id: 'style', kind: 'select', label: 'Style', default: 'normal', choices: ['normal', 'fixed ratio', 'fixed size'] },
      { id: 'ratioW', kind: 'number', label: 'Ratio W', default: 1, min: 0.01, max: 1000 },
      { id: 'ratioH', kind: 'number', label: 'Ratio H', default: 1, min: 0.01, max: 1000 },
      { id: 'fixedW', kind: 'number', label: 'Fixed W', default: 100, min: 1, max: 30000, unit: 'px' },
      { id: 'fixedH', kind: 'number', label: 'Fixed H', default: 100, min: 1, max: 30000, unit: 'px' },
    ],
  },
  marqueeEllipse: {
    id: 'marqueeEllipse', label: 'Elliptical Marquee', slot: 'marquee', key: 'm', cursor: 'crosshair', icon: 'Circle',
    options: [
      ...SELECT_COMMON,
      { id: 'style', kind: 'select', label: 'Style', default: 'normal', choices: ['normal', 'fixed ratio', 'fixed size'] },
      { id: 'ratioW', kind: 'number', label: 'Ratio W', default: 1, min: 0.01, max: 1000 },
      { id: 'ratioH', kind: 'number', label: 'Ratio H', default: 1, min: 0.01, max: 1000 },
      { id: 'fixedW', kind: 'number', label: 'Fixed W', default: 100, min: 1, max: 30000, unit: 'px' },
      { id: 'fixedH', kind: 'number', label: 'Fixed H', default: 100, min: 1, max: 30000, unit: 'px' },
    ],
  },
  marqueeRow: {
    id: 'marqueeRow', label: 'Single Row Marquee', slot: 'marquee', key: 'm', cursor: 'crosshair', icon: 'Minus',
    options: [{ id: 'mode', kind: 'select', label: 'Mode', default: 'new', choices: ['new', 'add', 'subtract', 'intersect'] }],
  },
  marqueeColumn: {
    id: 'marqueeColumn', label: 'Single Column Marquee', slot: 'marquee', key: 'm', cursor: 'crosshair', icon: 'Rows3',
    options: [{ id: 'mode', kind: 'select', label: 'Mode', default: 'new', choices: ['new', 'add', 'subtract', 'intersect'] }],
  },
  lasso: {
    id: 'lasso', label: 'Lasso', slot: 'lasso', key: 'l', cursor: 'crosshair', icon: 'Lasso',
    options: [...SELECT_COMMON],
  },
  polygonalLasso: {
    id: 'polygonalLasso', label: 'Polygonal Lasso', slot: 'lasso', key: 'l', cursor: 'crosshair', icon: 'PenTool',
    options: [...SELECT_COMMON],
  },
  magneticLasso: {
    id: 'magneticLasso', label: 'Magnetic Lasso', slot: 'lasso', key: 'l', cursor: 'crosshair', icon: 'Magnet',
    options: [
      ...SELECT_COMMON,
      { id: 'width', kind: 'number', label: 'Width', default: 10, min: 1, max: 256, unit: 'px' },
      { id: 'contrast', kind: 'percent', label: 'Contrast', default: 10, min: 1, max: 100 },
      { id: 'frequency', kind: 'number', label: 'Frequency', default: 57, min: 0, max: 100 },
    ],
  },
  quickSelection: {
    id: 'quickSelection', label: 'Quick Selection', slot: 'wand', key: 'w', cursor: 'crosshair', icon: 'MousePointerClick',
    options: [
      { id: 'size', kind: 'number', label: 'Brush size', default: 30, min: 1, max: 5000, unit: 'px' },
      { id: 'mode', kind: 'select', label: 'Mode', default: 'add', choices: ['new', 'add', 'subtract'] },
      { id: 'sampleAllLayers', kind: 'boolean', label: 'Sample all layers', default: false },
      { id: 'autoEnhance', kind: 'boolean', label: 'Auto-enhance', default: true },
    ],
  },
  magicWand: {
    id: 'magicWand', label: 'Magic Wand', slot: 'wand', key: 'w', cursor: 'crosshair', icon: 'Wand2',
    options: [
      { id: 'tolerance', kind: 'number', label: 'Tolerance', default: 32, min: 0, max: 255 },
      { id: 'antiAlias', kind: 'boolean', label: 'Anti-alias', default: true },
      { id: 'contiguous', kind: 'boolean', label: 'Contiguous', default: true },
      { id: 'sampleAllLayers', kind: 'boolean', label: 'Sample all layers', default: false },
    ],
  },
  crop: {
    id: 'crop', label: 'Crop', slot: 'crop', key: 'c', cursor: 'crosshair', icon: 'Crop',
    options: [
      // W and H are unitless ratio numbers, used only with 'free' when both are above 0.
      { id: 'ratio', kind: 'select', label: 'Ratio', default: 'free', choices: ['free', 'original', '1:1', '4:5', '5:7', '2:3', '16:9'] },
      { id: 'ratioWidth', kind: 'number', label: 'W', default: 0, min: 0, max: 30000 },
      { id: 'ratioHeight', kind: 'number', label: 'H', default: 0, min: 0, max: 30000 },
      { id: 'deleteCroppedPixels', kind: 'boolean', label: 'Delete cropped pixels', default: true },
      { id: 'straighten', kind: 'boolean', label: 'Straighten', default: false },
      { id: 'overlay', kind: 'select', label: 'Overlay', default: 'thirds', choices: ['none', 'thirds', 'grid', 'diagonal', 'triangle', 'golden ratio', 'golden spiral'] },
      { id: 'actions', kind: 'custom', label: 'Crop actions', default: '' },
    ],
  },
  perspectiveCrop: {
    id: 'perspectiveCrop', label: 'Perspective Crop', slot: 'crop', key: 'c', cursor: 'crosshair', icon: 'Frame',
    options: [
      // 0 = sized from the corners on the first release, which then writes the size back here.
      { id: 'outputWidth', kind: 'number', label: 'W', default: 0, min: 0, max: 30000, unit: 'px' },
      { id: 'outputHeight', kind: 'number', label: 'H', default: 0, min: 0, max: 30000, unit: 'px' },
    ],
  },
  eyedropper: {
    id: 'eyedropper', label: 'Eyedropper', slot: 'eyedropper', key: 'i', cursor: 'crosshair', icon: 'Pipette',
    options: [
      { id: 'sampleSize', kind: 'select', label: 'Sample size', default: 'point', choices: ['point', '3x3', '5x5', '11x11', '31x31', '51x51', '101x101'] },
      { id: 'sample', kind: 'select', label: 'Sample', default: 'all layers', choices: ['current layer', 'all layers'] },
    ],
  },
  brush: {
    id: 'brush', label: 'Brush', slot: 'brush', key: 'b', cursor: 'none', icon: 'Brush',
    options: BRUSH_COMMON,
  },
  pencil: {
    id: 'pencil', label: 'Pencil', slot: 'brush', key: 'b', cursor: 'none', icon: 'Pencil',
    options: [
      { id: 'size', kind: 'number', label: 'Size', default: 30, min: 1, max: 5000, unit: 'px' },
      { id: 'mode', kind: 'select', label: 'Mode', default: 'normal', choices: PAINT_MODES, sep: true },
      { id: 'opacity', kind: 'percent', label: 'Opacity', default: 100, min: 0, max: 100 },
      { id: 'smoothing', kind: 'percent', label: 'Smoothing', default: 10, min: 0, max: 100 },
      { id: 'autoErase', kind: 'boolean', label: 'Auto erase', default: false },
    ],
  },
  colorReplacement: {
    id: 'colorReplacement', label: 'Color Replacement', slot: 'brush', key: 'b', cursor: 'none', icon: 'Replace',
    options: [
      ...SIZE_HARD,
      { id: 'mode', kind: 'select', label: 'Mode', default: 'color', choices: ['hue', 'saturation', 'color', 'luminosity'], sep: true },
      SAMPLING, LIMITS, TOLERANCE,
      { id: 'antiAlias', kind: 'boolean', label: 'Anti-alias', default: true },
    ],
  },
  mixerBrush: {
    id: 'mixerBrush', label: 'Mixer Brush', slot: 'brush', key: 'b', cursor: 'none', icon: 'Palette',
    options: [
      ...SIZE_HARD,
      { id: 'wet', kind: 'percent', label: 'Wet', default: 50, min: 0, max: 100, sep: true },
      { id: 'load', kind: 'percent', label: 'Load', default: 50, min: 0, max: 100 },
      { id: 'mix', kind: 'percent', label: 'Mix', default: 50, min: 0, max: 100 },
      { id: 'flow', kind: 'percent', label: 'Flow', default: 100, min: 0, max: 100 },
      { id: 'mode', kind: 'select', label: 'Mode', default: 'normal', choices: BLEND_MODES },
      { id: 'loadAfterStroke', kind: 'boolean', label: 'Load Brush After Each Stroke', default: true, sep: true },
      { id: 'cleanAfterStroke', kind: 'boolean', label: 'Clean Brush After Each Stroke', default: false },
      SAMPLE_ALL, SMOOTHING,
    ],
  },
  eraser: {
    id: 'eraser', label: 'Eraser', slot: 'eraser', key: 'e', cursor: 'none', icon: 'Eraser',
    options: [
      { id: 'size', kind: 'number', label: 'Size', default: 30, min: 1, max: 5000, unit: 'px' },
      { id: 'hardness', kind: 'percent', label: 'Hardness', default: 100, min: 0, max: 100 },
      { id: 'mode', kind: 'select', label: 'Mode', default: 'brush', choices: ['brush', 'pencil', 'block'] },
      { id: 'opacity', kind: 'percent', label: 'Opacity', default: 100, min: 0, max: 100 },
      { id: 'flow', kind: 'percent', label: 'Flow', default: 100, min: 0, max: 100 },
      { id: 'airbrush', kind: 'boolean', label: 'Airbrush', default: false, icon: 'SprayCan', sep: true },
      { id: 'smoothing', kind: 'percent', label: 'Smoothing', default: 10, min: 0, max: 100 },
      { id: 'eraseToHistory', kind: 'boolean', label: 'Erase to history', default: false },
    ],
  },
  backgroundEraser: {
    id: 'backgroundEraser', label: 'Background Eraser', slot: 'eraser', key: 'e', cursor: 'none', icon: 'BrushCleaning',
    options: [
      ...SIZE_HARD, { ...LIMITS, sep: true }, TOLERANCE, SAMPLING,
      { id: 'protectForeground', kind: 'boolean', label: 'Protect Foreground Color', default: false },
    ],
  },
  magicEraser: {
    id: 'magicEraser', label: 'Magic Eraser', slot: 'eraser', key: 'e', cursor: 'crosshair', icon: 'WandSparkles',
    options: [
      TOLERANCE,
      { id: 'antiAlias', kind: 'boolean', label: 'Anti-alias', default: true },
      { id: 'contiguous', kind: 'boolean', label: 'Contiguous', default: true },
      SAMPLE_ALL,
      { id: 'opacity', kind: 'percent', label: 'Opacity', default: 100, min: 0, max: 100 },
    ],
  },
  spotHealing: healing('spotHealing', 'Spot Healing Brush', 'Bandage', 'none', [
    ...HEAL_BRUSH,
    { id: 'type', kind: 'select', label: 'Type', default: 'contentAware', choices: ['proximityMatch', 'createTexture', 'contentAware'] },
    SAMPLE_ALL,
  ]),
  healingBrush: healing('healingBrush', 'Healing Brush', 'Syringe', 'none', [
    ...HEAL_BRUSH,
    { id: 'source', kind: 'select', label: 'Source', default: 'sampled', choices: ['sampled', 'pattern'] },
    // '' = the first library pattern; the picker is drawn by the host.
    { id: 'pattern', kind: 'custom', label: 'Pattern', default: '' },
    { id: 'aligned', kind: 'boolean', label: 'Aligned', default: false },
    { id: 'diffusion', kind: 'number', label: 'Diffusion', default: 5, min: 1, max: 7 },
    SAMPLE_ALL,
  ]),
  patch: healing('patch', 'Patch', 'SquareDashed', 'move', [
    { id: 'patchMode', kind: 'select', label: 'Patch', default: 'normal', choices: ['normal', 'contentAware'] },
    { id: 'mode', kind: 'select', label: 'Source', default: 'source', choices: ['source', 'destination'] },
    STRUCTURE, COLOR_ADAPT,
    { id: 'transparent', kind: 'boolean', label: 'Transparent', default: false },
    SAMPLE_ALL,
  ]),
  contentAwareMove: healing('contentAwareMove', 'Content-Aware Move', 'Move3d', 'move', [
    { id: 'mode', kind: 'select', label: 'Mode', default: 'move', choices: ['move', 'extend'] },
    STRUCTURE, COLOR_ADAPT, SAMPLE_ALL,
    { id: 'transformOnDrop', kind: 'boolean', label: 'Transform On Drop', default: false },
  ]),
  redEye: healing('redEye', 'Red Eye', 'Eye', 'crosshair', [
    { id: 'pupilSize', kind: 'percent', label: 'Pupil Size', default: 50, min: 0, max: 100 },
    { id: 'darken', kind: 'percent', label: 'Darken Amount', default: 50, min: 0, max: 100 },
  ]),
  cloneStamp: stamp('cloneStamp', 'Clone Stamp', 'Stamp', [
    ...RETOUCH_BRUSH,
    { id: 'aligned', kind: 'boolean', label: 'Aligned', default: true, sep: true },
    { id: 'sample', kind: 'select', label: 'Sample', default: 'currentLayer', choices: ['currentLayer', 'currentBelow', 'allLayers'] },
    { id: 'ignoreAdjustments', kind: 'boolean', label: 'Ignore Adjustment Layers', default: false, icon: 'CircleSlash2' },
  ]),
  patternStamp: stamp('patternStamp', 'Pattern Stamp', 'Grid3x3', [
    ...RETOUCH_BRUSH,
    { id: 'aligned', kind: 'boolean', label: 'Aligned', default: true, sep: true },
    { id: 'impressionist', kind: 'boolean', label: 'Impressionist', default: false },
    // '' = the first library pattern; the picker is drawn by the host.
    { id: 'pattern', kind: 'custom', label: 'Pattern', default: '' },
  ]),
  historyBrush: { id: 'historyBrush', label: 'History Brush', slot: 'historyBrush', key: 'y', cursor: 'none', icon: 'History', options: BRUSH_COMMON },
  artHistoryBrush: {
    id: 'artHistoryBrush', label: 'Art History Brush', slot: 'historyBrush', key: 'y', cursor: 'none', icon: 'PaintbrushVertical', options: [
      BRUSH_COMMON[0],
      { id: 'style', kind: 'select', label: 'Style', default: 'tightShort', choices: ['tightShort', 'tightMedium', 'tightLong', 'looseMedium', 'looseLong', 'dab', 'tightCurl', 'tightCurlLong', 'looseCurl', 'looseCurlLong'] },
      { id: 'area', kind: 'number', label: 'Area', default: 50, min: 1, max: 500, unit: 'px' },
      { id: 'tolerance', kind: 'percent', label: 'Tolerance', default: 0, min: 0, max: 100 },
      { id: 'mode', kind: 'select', label: 'Mode', default: 'normal', choices: PAINT_MODES, sep: true },
      { id: 'opacity', kind: 'percent', label: 'Opacity', default: 100, min: 0, max: 100 },
    ],
  },
  blur: focus('blur', 'Blur', 'Droplet', [...SIZE_HARD, { ...STRENGTH, sep: true }, SAMPLE_ALL, SMOOTHING]),
  sharpen: focus('sharpen', 'Sharpen', 'Focus', [...SIZE_HARD, { ...STRENGTH, sep: true }, SAMPLE_ALL, SMOOTHING]),
  smudge: focus('smudge', 'Smudge', 'Pointer', [
    ...SIZE_HARD,
    { id: 'mode', kind: 'select', label: 'Mode', default: 'normal', choices: ['normal', 'darken', 'lighten', 'hue', 'saturation', 'color', 'luminosity'], sep: true },
    STRENGTH, SAMPLE_ALL,
    { id: 'fingerPainting', kind: 'boolean', label: 'Finger Painting', default: false },
    { id: 'pressureOpacity', kind: 'boolean', label: 'Pressure for Strength', default: false, icon: 'Droplet' },
    SMOOTHING,
  ]),
  dodge: toning('dodge', 'Dodge', 'Sun'),
  burn: toning('burn', 'Burn', 'Moon'),
  sponge: {
    id: 'sponge', label: 'Sponge', slot: 'toning', key: 'o', cursor: 'none', icon: 'Contrast', options: [
      ...SIZE_HARD,
      { id: 'mode', kind: 'select', label: 'Mode', default: 'desaturate', choices: ['desaturate', 'saturate'], sep: true },
      { id: 'flow', kind: 'percent', label: 'Flow', default: 100, min: 0, max: 100 },
      { id: 'vibrance', kind: 'boolean', label: 'Vibrance', default: true },
      SMOOTHING,
    ],
  },
  gradient: {
    id: 'gradient', label: 'Gradient', slot: 'gradient', key: 'g', cursor: 'crosshair', icon: 'Blend',
    options: [
      { id: 'gradient', kind: 'custom', label: 'Gradient', default: 'builtin.fgToBg' },
      { id: 'style', kind: 'segmented', label: 'Style', default: 'linear', choices: ['linear', 'radial', 'angle', 'reflected', 'diamond'] },
      { id: 'opacity', kind: 'percent', label: 'Opacity', default: 100, min: 0, max: 100 },
      { id: 'reverse', kind: 'boolean', label: 'Reverse', default: false },
      { id: 'dither', kind: 'boolean', label: 'Dither', default: true },
      { id: 'method', kind: 'select', label: 'Method', default: 'perceptual', choices: ['perceptual', 'linear', 'classic'] },
      { id: 'transparency', kind: 'boolean', label: 'Transparency', default: true },
    ],
  },
  bucket: {
    id: 'bucket', label: 'Paint Bucket', slot: 'gradient', key: 'g', cursor: 'crosshair', icon: 'PaintBucket',
    options: [
      // Pattern source is not in B3 (no pattern picker yet); hidden rather than offered disabled.
      { id: 'source', kind: 'select', label: 'Source', default: 'foreground', choices: ['foreground', 'background'] },
      { id: 'mode', kind: 'select', label: 'Mode', default: 'normal', choices: PAINT_MODES, sep: true },
      { id: 'opacity', kind: 'percent', label: 'Opacity', default: 100, min: 0, max: 100 },
      { id: 'tolerance', kind: 'number', label: 'Tolerance', default: 32, min: 0, max: 255 },
      { id: 'antiAlias', kind: 'boolean', label: 'Anti-alias', default: true },
      { id: 'contiguous', kind: 'boolean', label: 'Contiguous', default: true },
      { id: 'allLayers', kind: 'boolean', label: 'Sample All Layers', default: false },
    ],
  },
  rectangle: shapeTool('rectangle', 'Rectangle', 'RectangleHorizontal', [CORNER_RADIUS]),
  ellipse: shapeTool('ellipse', 'Ellipse', 'Circle', []),
  triangle: shapeTool('triangle', 'Triangle', 'Triangle', [CORNER_RADIUS]),
  polygon: shapeTool('polygon', 'Polygon', 'Hexagon', [
    { id: 'sides', kind: 'number', label: 'Sides', default: 5, min: 3, max: 100 },
    { id: 'starInset', kind: 'percent', label: 'Star Inset', default: 0, min: 0, max: 99 },
    CORNER_RADIUS,
  ]),
  line: shapeTool('line', 'Line', 'Slash', []),
  // The Shape picker is drawn by the host from the custom shape library.
  customShape: shapeTool('customShape', 'Custom Shape', 'Shapes', [{ id: 'customShape', kind: 'custom', label: 'Shape', default: '' }]),
  pen: pen('pen', 'Pen', 'PenTool', [
    PEN_MODE,
    // Fill '' = the foreground color, Stroke '' = the background color; width 0 = no stroke.
    { id: 'fill', kind: 'color', label: 'Fill', default: '' },
    { id: 'stroke', kind: 'color', label: 'Stroke', default: '' },
    { id: 'strokeWidth', kind: 'number', label: 'Stroke Width', default: 0, min: 0, max: 1000, unit: 'px' },
    { id: 'pathOp', kind: 'select', label: 'Path Operations', default: 'new', choices: ['new', 'add', 'subtract', 'intersect', 'exclude'] },
    { id: 'autoAddDelete', kind: 'boolean', label: 'Auto Add/Delete', default: true },
    { id: 'rubberBand', kind: 'boolean', label: 'Rubber Band', default: true },
    { id: 'alignEdges', kind: 'boolean', label: 'Align Edges', default: false },
  ]),
  freeformPen: pen('freeformPen', 'Freeform Pen', 'Signature', [
    PEN_MODE,
    { id: 'magnetic', kind: 'boolean', label: 'Magnetic', default: false },
    { id: 'width', kind: 'number', label: 'Width', default: 10, min: 1, max: 256, unit: 'px' },
    { id: 'curveFit', kind: 'number', label: 'Curve Fit', default: 2, min: 0.5, max: 10, unit: 'px' },
  ]),
  curvaturePen: pen('curvaturePen', 'Curvature Pen', 'Spline', [PEN_MODE]),
  addAnchor: pen('addAnchor', 'Add Anchor Point', 'DiamondPlus', []),
  deleteAnchor: pen('deleteAnchor', 'Delete Anchor Point', 'DiamondMinus', []),
  convertPoint: pen('convertPoint', 'Convert Point', 'SplinePointer', []),
  pathSelection: pathSel('pathSelection', 'Path Selection', 'MousePointer2', [
    { id: 'constrain', kind: 'select', label: 'Constrain', default: 'free', choices: ['free', 'axis'] },
  ]),
  directSelection: pathSel('directSelection', 'Direct Selection', 'Navigation', []),
  horizontalType: typeTool('horizontalType', 'Horizontal Type', 'Type', 'text'),
  verticalType: typeTool('verticalType', 'Vertical Type', 'TextCursor', 'vertical-text'),
  horizontalTypeMask: typeTool('horizontalTypeMask', 'Horizontal Type Mask', 'SquareDashedText', 'text'),
  verticalTypeMask: typeTool('verticalTypeMask', 'Vertical Type Mask', 'TypeOutline', 'vertical-text'),
  hand: { id: 'hand', label: 'Hand', slot: 'hand', key: 'h', cursor: 'grab', icon: 'Hand', options: [] },
  rotate: { id: 'rotate', label: 'Rotate View', slot: 'rotate', key: 'r', cursor: 'alias', icon: 'RotateCw', options: [] },
  zoom: { id: 'zoom', label: 'Zoom', slot: 'zoom', key: 'z', cursor: 'zoom-in', icon: 'ZoomIn', options: [] },
};

export const SLOTS: Slot[] = [
  { id: 'move', key: 'v', tools: ['move'] },
  { id: 'marquee', key: 'm', tools: ['marqueeRect', 'marqueeEllipse', 'marqueeRow', 'marqueeColumn'] },
  { id: 'lasso', key: 'l', tools: ['lasso', 'polygonalLasso', 'magneticLasso'] },
  { id: 'wand', key: 'w', tools: ['quickSelection', 'magicWand'] },
  { id: 'crop', key: 'c', tools: ['crop', 'perspectiveCrop'] },
  { id: 'eyedropper', key: 'i', tools: ['eyedropper'] },
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
