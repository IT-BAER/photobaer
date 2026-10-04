// Image > Analysis: measurement scale, data point columns and the scale marker geometry.
import { LOG_COLUMNS, type MeasureRow, type Measurement } from './measure.ts';

export interface MeasureScale { pixels: number; logical: number; units: string }
export const DEFAULT_SCALE: MeasureScale = { pixels: 1, logical: 1, units: 'px' };

export const scaleText = (s: MeasureScale) => `${s.pixels} px = ${s.logical} ${s.units}`;

export function scaleMeasurement(m: Measurement, s: MeasureScale): Measurement & { scale: string; units: string } {
  const k = s.logical / s.pixels, len = (v?: number) => (v === undefined ? undefined : v * k);
  return {
    ...m, length: len(m.length), perimeter: len(m.perimeter), width: len(m.width), height: len(m.height),
    area: m.area === undefined ? undefined : m.area * k * k, scale: scaleText(s), units: s.units,
  };
}

const FIXED: [keyof MeasureRow, string][] = [['label', 'Label'], ['date', 'Date and Time'], ['document', 'Document'], ['source', 'Source'], ['scale', 'Scale'], ['units', 'Units']];
// Select Data Points: the measured columns a user can turn off.
export const DATA_POINTS = LOG_COLUMNS.map(([k]) => k).filter(k => !FIXED.some(([f]) => f === k));
export const POINTS_KEY = 'photobaer.dataPoints';

// The stored choice; unknown names are dropped, and unreadable storage means all points.
export function parsePoints(raw: string | null): (keyof MeasureRow)[] {
  try {
    const v: unknown = raw === null ? null : JSON.parse(raw);
    return Array.isArray(v) ? DATA_POINTS.filter(k => v.includes(k)) : DATA_POINTS;
  } catch { return DATA_POINTS; }
}

// The log columns for the chosen data points; label, date, document, source, scale and units always show.
export function pickColumns(points: string[]): [keyof MeasureRow, string][] {
  return [...FIXED, ...LOG_COLUMNS.filter(([k]) => points.includes(k))];
}

// Place Scale Marker: a bar at the bottom left, 5% in from the edges, clipped to the canvas width.
export function markerRect(w: number, h: number, length: number, thickness: number) {
  const mx = Math.round(w * 0.05), my = Math.round(h * 0.05);
  return { x: mx, y: h - my - thickness, w: Math.min(Math.round(length), w - 2 * mx), h: thickness };
}
