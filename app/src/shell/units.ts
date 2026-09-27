// Unit <-> px conversion for rulers and dialogs (docs/M4.md section 12). Resolution is per document
// (ppi); percent is relative to the document width (x axis) or height (y axis), not resolution-aware.
export const RULER_UNITS = ['px', 'in', 'cm', 'mm', 'pt', 'pica', 'percent'] as const;
export type RulerUnit = typeof RULER_UNITS[number];

// Real-world units per inch, keyed by unit; px and percent are handled separately below.
const PER_INCH: Record<Exclude<RulerUnit, 'px' | 'percent'>, number> = { in: 1, cm: 2.54, mm: 25.4, pt: 72, pica: 6 };

export function unitToPx(value: number, unit: RulerUnit, resolution: number, docSize = 0): number {
  if (unit === 'px') return value;
  if (unit === 'percent') return (value / 100) * docSize;
  return (value / PER_INCH[unit]) * resolution;
}

export function pxToUnit(px: number, unit: RulerUnit, resolution: number, docSize = 0): number {
  if (unit === 'px') return px;
  if (unit === 'percent') return docSize ? (px / docSize) * 100 : 0;
  return (px / resolution) * PER_INCH[unit];
}
