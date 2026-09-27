import { docToScreen, screenToDoc, type View } from '../view.ts';
import { unitToPx, type RulerUnit } from './units.ts';

export const RULER_THICKNESS = 20;
// Pixel grid draws at 800% and above (docs/M4.md B16 gap: threshold not confirmed in the reference, own choice).
export const PIXEL_GRID_MIN_ZOOM = 8;

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
// aligned regardless of view rotation (own choice, gap B16); the pixel grid follows the rotated view.
export class Rulers {
  #top: CanvasRenderingContext2D;
  #left: CanvasRenderingContext2D;
  #grid: CanvasRenderingContext2D;
  #unit: RulerUnit = 'px';
  #resolution = 72;
  #showRulers = false;
  #showPixelGrid = false;
  #pointer: [number, number] | null = null;

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
}
