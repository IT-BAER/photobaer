import { BLEND_MODES } from '../layers.ts';
// 'custom' options are drawn by the host (OptionsBar `custom`); 'segmented' is a button group over `choices`;
// 'color' holds a '#rrggbb' string, '' meaning the current foreground color.
export type OptionKind = 'number' | 'percent' | 'select' | 'boolean' | 'segmented' | 'custom' | 'color';
export interface OptionSchema {
  id: string; kind: OptionKind; label: string; default: number | string | boolean;
  min?: number; max?: number; unit?: string; choices?: string[];
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
  { id: 'mode', kind: 'select', label: 'Mode', default: 'normal', choices: PAINT_MODES },
  { id: 'opacity', kind: 'percent', label: 'Opacity', default: 100, min: 0, max: 100 },
  { id: 'flow', kind: 'percent', label: 'Flow', default: 100, min: 0, max: 100 },
  { id: 'smoothing', kind: 'percent', label: 'Smoothing', default: 10, min: 0, max: 100 },
  { id: 'airbrush', kind: 'boolean', label: 'Airbrush', default: false },
  { id: 'wetEdges', kind: 'boolean', label: 'Wet edges', default: false },
  { id: 'pressureSize', kind: 'boolean', label: 'Pressure controls size', default: false },
  { id: 'pressureOpacity', kind: 'boolean', label: 'Pressure controls opacity', default: false },
];

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

export const TOOLS: Record<string, Tool> = {
  move: {
    id: 'move', label: 'Move', slot: 'move', key: 'v', cursor: 'move', icon: 'Move',
    options: [
      { id: 'autoSelect', kind: 'boolean', label: 'Auto-select', default: false },
      { id: 'autoSelectTarget', kind: 'select', label: 'Auto-select target', default: 'layer', choices: ['layer', 'group'] },
      { id: 'showTransform', kind: 'boolean', label: 'Show transform controls', default: false },
      { id: 'snap', kind: 'boolean', label: 'Snap', default: true },
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
      { id: 'mode', kind: 'select', label: 'Mode', default: 'normal', choices: PAINT_MODES },
      { id: 'opacity', kind: 'percent', label: 'Opacity', default: 100, min: 0, max: 100 },
      { id: 'smoothing', kind: 'percent', label: 'Smoothing', default: 10, min: 0, max: 100 },
      { id: 'autoErase', kind: 'boolean', label: 'Auto erase', default: false },
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
      { id: 'airbrush', kind: 'boolean', label: 'Airbrush', default: false },
      { id: 'smoothing', kind: 'percent', label: 'Smoothing', default: 10, min: 0, max: 100 },
      { id: 'eraseToHistory', kind: 'boolean', label: 'Erase to history', default: false },
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
      { id: 'mode', kind: 'select', label: 'Mode', default: 'normal', choices: PAINT_MODES },
      { id: 'opacity', kind: 'percent', label: 'Opacity', default: 100, min: 0, max: 100 },
      { id: 'tolerance', kind: 'number', label: 'Tolerance', default: 32, min: 0, max: 255 },
      { id: 'antiAlias', kind: 'boolean', label: 'Anti-alias', default: true },
      { id: 'contiguous', kind: 'boolean', label: 'Contiguous', default: true },
      { id: 'allLayers', kind: 'boolean', label: 'All layers', default: false },
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
  { id: 'brush', key: 'b', tools: ['brush', 'pencil'] },
  { id: 'eraser', key: 'e', tools: ['eraser'] },
  { id: 'gradient', key: 'g', tools: ['gradient', 'bucket'] },
  { id: 'shape', key: 'u', tools: ['rectangle', 'ellipse', 'triangle', 'polygon', 'line'] },
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
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch { /* storage unavailable or corrupt: fall back to defaults */ }
  return defaults;
}

export function saveToolOptions(tool: Tool, values: Record<string, number | string | boolean>) {
  try {
    globalThis.localStorage?.setItem(STORE_KEY(tool.id), JSON.stringify(values));
  } catch { /* storage unavailable: options stay session-only */ }
}
