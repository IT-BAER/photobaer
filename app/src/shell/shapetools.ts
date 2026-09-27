// Shape tools (docs/M4.md section 5): drag geometry to live shape parameters, the options bar
// appearance to fill and stroke, and the Properties Appearance helpers. Pure, no engine calls.
import type { BoolOp, FillContent } from '../worker/types.ts';
import type { Preview } from './SelectionOverlay.ts';
import { marqueeRect, snap45Length } from './selecttools.ts';

// Combine Shapes / Pathfinder undo and menu labels.
export const BOOL_LABEL: Record<BoolOp, string> = {
  unite: 'Unite Shapes', subtract: 'Subtract Front Shape', intersect: 'Intersect Shape Areas', exclude: 'Exclude Overlapping Shapes',
};

export type Bounds = [number, number, number, number];
export type Live =
  | { type: 'rectangle' | 'roundedRectangle'; bounds: Bounds; radii: [number, number, number, number] }
  | { type: 'ellipse' | 'custom'; bounds: Bounds }
  | { type: 'triangle'; bounds: Bounds; radius: number }
  | { type: 'polygon'; bounds: Bounds; sides: number; star_inset: number; radius: number }
  | { type: 'line'; start: [number, number]; end: [number, number] };
export interface ShapeStroke {
  enabled: boolean; width: number; align: 'inside' | 'center' | 'outside'; cap: 'butt' | 'round' | 'square';
  join: 'miter' | 'round' | 'bevel'; miter_limit: number; dash: number[]; dash_offset: number; content: FillContent;
  opacity: number; blend: string;
}
export type ShapeKind = 'rectangle' | 'ellipse' | 'triangle' | 'polygon' | 'line' | 'custom';
export interface ShapeToolOpts {
  kind: ShapeKind; constrain: boolean; fromCenter: boolean; cornerRadius: number; sides: number;
  starInset: number; width: number; height: number;
}

// The live shape for a drag from `start` to `cur`; a click without drag uses the W/H options
// (anchored at the click) and draws nothing while either is 0. Null = no shape.
export function dragLive(start: [number, number], cur: [number, number], o: ShapeToolOpts): Live | null {
  if (o.kind === 'line') {
    const end = o.constrain ? snap45Length(start, cur) : cur;
    return { type: 'line', start, end };
  }
  let r = marqueeRect(start, cur, { ...o, style: 'normal', ratioW: 1, ratioH: 1, fixedW: 0, fixedH: 0 });
  if (Math.hypot(r.w, r.h) <= 1e-6) {
    if (o.width <= 0 || o.height <= 0) return null;
    r = { x: start[0], y: start[1], w: o.width, h: o.height };
  }
  if (r.w < 1e-6 || r.h < 1e-6) return null;
  const bounds: Bounds = [r.x, r.y, r.x + r.w, r.y + r.h];
  const radius = Math.max(0, o.cornerRadius);
  switch (o.kind) {
    case 'rectangle': return { type: 'rectangle', bounds, radii: [radius, radius, radius, radius] };
    case 'ellipse': return { type: 'ellipse', bounds };
    case 'custom': return { type: 'custom', bounds };
    case 'triangle': return { type: 'triangle', bounds, radius };
    case 'polygon': return {
      type: 'polygon', bounds, radius, sides: Math.min(100, Math.max(3, Math.round(o.sides))),
      star_inset: Math.min(0.99, Math.max(0, o.starInset / 100)),
    };
  }
}

const solid = (c: [number, number, number]): FillContent => ({ type: 'solid', color: c });

// The tool's new-shape stroke record (width 0 = none).
export function newStroke(color: [number, number, number], width: number, miterLimit = 100): ShapeStroke | null {
  if (!(width > 0)) return null;
  return { enabled: true, width, align: 'center', cap: 'butt', join: 'miter', miter_limit: miterLimit, dash: [], dash_offset: 0, content: solid(color), opacity: 1, blend: 'normal' };
}

export function shapeStyle(appearance: string, fill: [number, number, number], stroke: [number, number, number], width: number) {
  const hasFill = appearance === 'fill' || appearance === 'both';
  const hasStroke = appearance === 'outline' || appearance === 'both';
  return { fill: hasFill ? solid(fill) : null, stroke: hasStroke ? newStroke(stroke, width) : null };
}

// The largest corner radius a live shape's bounds allow: half the shorter side.
export function radiusMax(b: Bounds): number {
  return Math.min(b[2] - b[0], b[3] - b[1]) / 2;
}

export function setRadius(radii: [number, number, number, number], i: number, v: number, linked: boolean, b: Bounds): [number, number, number, number] {
  const r = Math.min(radiusMax(b), Math.max(0, v));
  return linked ? [r, r, r, r] : radii.map((x, k) => (k === i ? r : x)) as [number, number, number, number];
}

export type StrokeStyle = 'solid' | 'dashed' | 'dotted';

export function dashFor(style: StrokeStyle, w: number): { dash: number[]; cap?: 'round' } {
  if (style === 'dotted') return { dash: [w, w * 1.5], cap: 'round' };
  return { dash: style === 'dashed' ? [w * 4, w * 2] : [] };
}

export function strokeStyleOf(dash: number[], w: number): StrokeStyle {
  if (dash.length === 0) return 'solid';
  return dash.length === 2 && dash[0] <= w ? 'dotted' : 'dashed';
}

// The overlay outline while dragging (corner radii not drawn).
export function draftPreview(l: Live): Preview {
  if (l.type === 'line') return { kind: 'path', points: [...l.start, ...l.end], closed: false };
  const [x0, y0, x1, y1] = l.bounds;
  if (l.type === 'ellipse') return { kind: 'ellipse', x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  if (l.type === 'triangle') return { kind: 'path', points: [(x0 + x1) / 2, y0, x1, y1, x0, y1], closed: true };
  if (l.type !== 'polygon') return { kind: 'rect', x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const m = l.star_inset > 0 ? l.sides * 2 : l.sides;
  const points = Array.from({ length: m }, (_, i) => {
    const a = -Math.PI / 2 + i * 2 * Math.PI / m, k = l.star_inset > 0 && i % 2 === 1 ? 1 - l.star_inset : 1;
    return [(x0 + x1) / 2 + (x1 - x0) / 2 * k * Math.cos(a), (y0 + y1) / 2 + (y1 - y0) / 2 * k * Math.sin(a)];
  }).flat();
  return { kind: 'path', points, closed: true };
}
