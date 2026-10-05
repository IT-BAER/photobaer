// Units & Rulers, Guides, Grid & Slices and Cursors preferences (docs/M4.md section 12): app-wide, not per document.
import type { RulerUnit } from './units.ts';

export type TypeUnit = 'px' | 'pt' | 'mm';
export type PaintingCursor = 'standard' | 'precise' | 'normal' | 'full';
export type BrushOutline = 'thin' | 'normal' | 'bold' | 'extraBold';

export interface Preferences {
  rulerUnit: RulerUnit;
  typeUnit: TypeUnit;
  printResolution: number;
  screenResolution: number;
  pointsPerInch: number;
  guideColor: string;
  smartGuideColor: string;
  gridColor: string;
  gridSpacing: number;
  subdivisions: number;
  // Cursors: Painting Cursors, Brush Tip Outline, Show Crosshair in Brush Tip, Show Only Crosshair While Painting,
  // Show Brush Leash While Smoothing and its color, Other Cursors and the Brush Preview color.
  paintingCursor: PaintingCursor;
  brushOutline: BrushOutline;
  brushCrosshair: boolean;
  crosshairWhilePainting: boolean;
  brushLeash: boolean;
  brushLeashColor: string;
  otherCursor: 'standard' | 'precise';
  brushPreviewColor: string;
}

export const DEFAULT_PREFERENCES: Preferences = {
  rulerUnit: 'px',
  typeUnit: 'pt',
  printResolution: 300,
  screenResolution: 72,
  pointsPerInch: 72,
  guideColor: '#00b7ff',
  smartGuideColor: '#ff00ff',
  gridColor: '#808080',
  gridSpacing: 100,
  subdivisions: 4,
  paintingCursor: 'normal',
  brushOutline: 'normal',
  brushCrosshair: false,
  crosshairWhilePainting: false,
  brushLeash: false,
  brushLeashColor: '#ff40ff',
  otherCursor: 'standard',
  brushPreviewColor: '#ff0000',
};

const STORE_KEY = 'photobaer:preferences';

export function loadPreferences(): Preferences {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (raw) return { ...DEFAULT_PREFERENCES, ...JSON.parse(raw) };
  } catch { /* storage unavailable or corrupt: fall back to defaults */ }
  return { ...DEFAULT_PREFERENCES };
}

export function savePreferences(prefs: Preferences) {
  try {
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(prefs));
  } catch { /* storage unavailable: preferences stay session-only */ }
}
