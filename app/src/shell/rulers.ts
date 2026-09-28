import { docToScreen, screenToDoc, type View } from '../view.ts';
import { unitToPx, type RulerUnit } from './units.ts';
import type { Guide } from '../worker/types.ts';

export const RULER_THICKNESS = 20;
// Pixel grid draws at 800% and above (threshold not confirmed in the reference, own choice).
export const PIXEL_GRID_MIN_ZOOM = 8;
// Guide grab tolerance in screen px (own choice: not specified in the reference for guide dragging; the
// snap catch/release values are a different feature).
export const GUIDE_HIT_PX = 4;

// A guide being dragged (an existing guide, or a not-yet-created one from a ruler drag); `id` is a
// real guide id for the former, any negative sentinel for the latter (draw-only, never sent to the engine).
export interface DragGuide { id: number; axis: 'x' | 'y'; pos: number }

// Ruler-drag -> document coordinate: flat, ignoring view rotation like the ticks
// themselves (rulers stay screen-axis aligned regardless of the rotated view).
export function rulerDragToDoc(view: View, axis: 'x' | 'y', screenPos: number, cssW: number, cssH: number): number {
  const flat: View = { ...view, rot: 0 };
  const [dx, dy] = screenToDoc(flat, axis === 'x' ? screenPos : cssW / 2, axis === 'y' ? screenPos : cssH / 2, cssW, cssH);
  return axis === 'x' ? dx : dy;
}

// The nearest guide to a screen point within `tolerance` screen px on its own axis; null if none close
// enough. Also flat (guides are screen-axis aligned, like the rulers that create them).
export function hitGuide(guides: Guide[], view: View, sx: number, sy: number, cssW: number, cssH: number, tolerance = GUIDE_HIT_PX): number | null {
  const flat: View = { ...view, rot: 0 };
  let best: number | null = null, bestD = tolerance;
  for (const g of guides) {
    const [gx, gy] = docToScreen(flat, g.axis === 'x' ? g.pos : 0, g.axis === 'y' ? g.pos : 0, cssW, cssH);
    const d = Math.abs((g.axis === 'x' ? gx : gy) - (g.axis === 'x' ? sx : sy));
    if (d <= bestD) { bestD = d; best = g.id; }
  }
  return best;
}

// Smallest 1-2-5 x 10^n step (unit-space) whose screen spacing is at least `minPx` CSS px.
export function tickStep(pxPerUnit: number, minPx = 50): number {
  if (!(pxPerUnit > 0)) return 1;
  const raw = minPx / pxPerUnit;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * magnitude >= raw) return m * magnitude;
  return raw;
}

export interface Tick { value: number; pos: number; major: boolean }

// Ticks along one axis: `pxPerUnit` screen px per unit, `originPx` the screen position of unit 0,
// `spanPx` the ruler's CSS length. Every 5th step is major (labelled); others are minor (unlabelled).
export function ticksFor(pxPerUnit: number, originPx: number, spanPx: number, minPx = 50): Tick[] {
  if (!(pxPerUnit > 0)) return [];
  const step = tickStep(pxPerUnit, minPx);
  const uMin = (0 - originPx) / pxPerUnit;
  const uMax = (spanPx - originPx) / pxPerUnit;
  const start = Math.floor(uMin / step) * step;
  const out: Tick[] = [];
  for (let u = start; u <= uMax + step; u += step) {
    out.push({ value: Math.round(u / step) * step, pos: originPx + u * pxPerUnit, major: Math.round(u / step) % 5 === 0 });
  }
  return out;
}

// Top/left ruler bars and the pixel-grid overlay (docs/M4.md section 12). Rulers stay screen-axis
// aligned regardless of view rotation (own choice); the pixel grid follows the rotated view.
export class Rulers {
  #top: CanvasRenderingContext2D;
  #left: CanvasRenderingContext2D;
  #grid: CanvasRenderingContext2D;
  #unit: RulerUnit = 'px';
  #resolution = 72;
  #showRulers = false;
  #showPixelGrid = false;
  #pointer: [number, number] | null = null;
  #showGuides = false;
  #guideColor = '#00b7ff';
  #guides: Guide[] = [];
  #dragGuide: DragGuide | null = null;
  #showGrid = false;
  #gridColor = '#808080';
  #gridSpacingX = 100;
  #gridSpacingY = 100;
  #subdivisions = 4;

  constructor(top: HTMLCanvasElement, left: HTMLCanvasElement, grid: HTMLCanvasElement) {
    this.#top = top.getContext('2d')!;
    this.#left = left.getContext('2d')!;
    this.#grid = grid.getContext('2d')!;
  }

  setUnit(u: RulerUnit) { this.#unit = u; }
  setResolution(r: number) { this.#resolution = r; }
  setShowRulers(b: boolean) { this.#showRulers = b; }
  setShowPixelGrid(b: boolean) { this.#showPixelGrid = b; }
  setPointer(p: [number, number] | null) { this.#pointer = p; }
  setShowGuides(b: boolean) { this.#showGuides = b; }
  setGuideColor(c: string) { this.#guideColor = c; }
  setGuides(g: Guide[]) { this.#guides = g; }
  // A guide being dragged (live position, not yet committed); overrides its committed position or, for
  // a brand-new guide, draws a preview that no committed guide shares.
  setDragGuide(g: DragGuide | null) { this.#dragGuide = g; }
  setShowGrid(b: boolean) { this.#showGrid = b; }
  setGridColor(c: string) { this.#gridColor = c; }
  setGrid(spacingX: number, spacingY: number, subdivisions: number) {
    this.#gridSpacingX = spacingX; this.#gridSpacingY = spacingY; this.#subdivisions = Math.max(1, Math.round(subdivisions));
  }

  draw(view: View, cssW: number, cssH: number, dpr: number, docW: number, docH: number) {
    const flat: View = { ...view, rot: 0 };
    this.#clear(this.#top, cssW, RULER_THICKNESS, dpr);
    this.#clear(this.#left, RULER_THICKNESS, cssH, dpr);
    this.#clear(this.#grid, cssW, cssH, dpr);
    if (this.#showRulers) {
      const originX = docToScreen(flat, 0, 0, cssW, cssH)[0];
      const originY = docToScreen(flat, 0, 0, cssW, cssH)[1];
      const xPerUnit = view.zoom * unitToPx(1, this.#unit, this.#resolution, docW);
      const yPerUnit = view.zoom * unitToPx(1, this.#unit, this.#resolution, docH);
      this.#drawAxis(this.#top, ticksFor(xPerUnit, originX, cssW), cssW, RULER_THICKNESS, dpr, false, this.#pointer?.[0] === undefined ? null : originX + this.#pointer![0] * xPerUnit);
      this.#drawAxis(this.#left, ticksFor(yPerUnit, originY, cssH), cssH, RULER_THICKNESS, dpr, true, this.#pointer?.[1] === undefined ? null : originY + this.#pointer![1] * yPerUnit);
    }
    // Grid follows the rotated view like the document itself; guides stay screen-axis aligned like the rulers.
    if (this.#showGrid) this.#drawGrid(view, cssW, cssH, dpr, docW, docH);
    if (this.#showGuides) this.#drawGuides(flat, cssW, cssH, dpr);
    if (this.#showPixelGrid && view.zoom * dpr >= PIXEL_GRID_MIN_ZOOM) this.#drawPixelGrid(view, cssW, cssH, dpr, docW, docH);
  }

  #clear(ctx: CanvasRenderingContext2D, cssW: number, cssH: number, dpr: number) {
    const c = ctx.canvas;
    c.width = Math.max(1, Math.round(cssW * dpr));
    c.height = Math.max(1, Math.round(cssH * dpr));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
  }

  #drawAxis(ctx: CanvasRenderingContext2D, ticks: Tick[], spanPx: number, thickness: number, dpr: number, vertical: boolean, markerPos: number | null) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = getComputedStyle(ctx.canvas).getPropertyValue('--ruler-bg') || '#2a2d34';
    ctx.fillRect(0, 0, vertical ? thickness : spanPx, vertical ? spanPx : thickness);
    ctx.strokeStyle = '#9aa0aa';
    ctx.fillStyle = '#9aa0aa';
    ctx.font = '9px system-ui, sans-serif';
    ctx.beginPath();
    for (const t of ticks) {
      const len = t.major ? thickness : thickness / 2;
      if (vertical) { ctx.moveTo(thickness - len, t.pos); ctx.lineTo(thickness, t.pos); }
      else { ctx.moveTo(t.pos, thickness - len); ctx.lineTo(t.pos, thickness); }
      if (t.major) {
        const label = Math.round(t.value * 100) / 100 + '';
        if (vertical) { ctx.save(); ctx.translate(3, t.pos - 2); ctx.rotate(-Math.PI / 2); ctx.fillText(label, 0, 0); ctx.restore(); }
        else ctx.fillText(label, t.pos + 2, thickness - len - 2 < 8 ? 8 : thickness - len - 2);
      }
    }
    ctx.lineWidth = 1;
    ctx.stroke();
    if (markerPos !== null) {
      ctx.strokeStyle = '#ff9a3c';
      ctx.beginPath();
      if (vertical) { ctx.moveTo(0, markerPos); ctx.lineTo(thickness, markerPos); } else { ctx.moveTo(markerPos, 0); ctx.lineTo(markerPos, thickness); }
      ctx.stroke();
    }
  }

  #drawPixelGrid(view: View, cssW: number, cssH: number, dpr: number, docW: number, docH: number) {
    const corners = [screenToDoc(view, 0, 0, cssW, cssH), screenToDoc(view, cssW, 0, cssW, cssH), screenToDoc(view, cssW, cssH, cssW, cssH), screenToDoc(view, 0, cssH, cssW, cssH)];
    const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(docW, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(docH, Math.ceil(Math.max(...ys)));
    const ctx = this.#grid;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) {
      const a = docToScreen(view, x, y0, cssW, cssH), b = docToScreen(view, x, y1, cssW, cssH);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    for (let y = y0; y <= y1; y++) {
      const a = docToScreen(view, x0, y, cssW, cssH), b = docToScreen(view, x1, y, cssW, cssH);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
    ctx.stroke();
  }

  // Guide overlay in the preference color; the guide being dragged (if any) draws at its live
  // position instead of (or in addition to, for a new one) the committed list.
  #drawGuides(flat: View, cssW: number, cssH: number, dpr: number) {
    const guides: DragGuide[] = this.#dragGuide ? [...this.#guides.filter(g => g.id !== this.#dragGuide!.id), this.#dragGuide] : this.#guides;
    const ctx = this.#grid;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = this.#guideColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const g of guides) {
      if (g.axis === 'x') {
        const [sx] = docToScreen(flat, g.pos, 0, cssW, cssH);
        ctx.moveTo(sx, 0); ctx.lineTo(sx, cssH);
      } else {
        const [, sy] = docToScreen(flat, 0, g.pos, cssW, cssH);
        ctx.moveTo(0, sy); ctx.lineTo(cssW, sy);
      }
    }
    ctx.stroke();
  }

  // Grid lines from the document's spacing (per axis) and the subdivisions preference; minor lines
  // (at spacing / subdivisions) draw fainter than the major (spacing) lines.
  #drawGrid(view: View, cssW: number, cssH: number, dpr: number, docW: number, docH: number) {
    const corners = [screenToDoc(view, 0, 0, cssW, cssH), screenToDoc(view, cssW, 0, cssW, cssH), screenToDoc(view, cssW, cssH, cssW, cssH), screenToDoc(view, 0, cssH, cssW, cssH)];
    const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(docW, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(docH, Math.ceil(Math.max(...ys)));
    const ctx = this.#grid;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const lines = (major: boolean) => {
      const stepX = major ? this.#gridSpacingX : this.#gridSpacingX / this.#subdivisions;
      const stepY = major ? this.#gridSpacingY : this.#gridSpacingY / this.#subdivisions;
      ctx.beginPath();
      if (stepX > 0) {
        for (let x = Math.ceil(x0 / stepX) * stepX; x <= x1; x += stepX) {
          if (!major && Math.abs(x % this.#gridSpacingX) < 1e-6) continue;
          const a = docToScreen(view, x, y0, cssW, cssH), b = docToScreen(view, x, y1, cssW, cssH);
          ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        }
      }
      if (stepY > 0) {
        for (let y = Math.ceil(y0 / stepY) * stepY; y <= y1; y += stepY) {
          if (!major && Math.abs(y % this.#gridSpacingY) < 1e-6) continue;
          const a = docToScreen(view, x0, y, cssW, cssH), b = docToScreen(view, x1, y, cssW, cssH);
          ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        }
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = this.#gridColor;
      ctx.globalAlpha = major ? 0.6 : 0.25;
      ctx.stroke();
    };
    if (this.#subdivisions > 1) lines(false);
    lines(true);
    ctx.globalAlpha = 1;
  }
}
