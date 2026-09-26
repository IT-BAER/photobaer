import { docToScreen, type View } from '../view.ts';

export type Preview =
  | null
  | { kind: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number }
  | { kind: 'path'; points: number[]; closed: boolean };

// Brush cursor (docs/M2.md section 4): x/y and sizeDoc are document-space so the outline scales
// with zoom; crosshair replaces the outline under 6 screen px or with Caps Lock on.
export interface CursorState { x: number; y: number; sizeDoc: number; shape: 'round' | 'square'; crosshair: boolean }

export interface BoxRect { x: number; y: number; w: number; h: number }
export const HANDLE_CURSORS = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'];

// Handle points clockwise from the top-left corner (corners at even indexes), in document px.
export function boxHandles(r: BoxRect): [number, number][] {
  const { x, y, w, h } = r, mx = x + w / 2, my = y + h / 2;
  return [[x, y], [mx, y], [x + w, y], [x + w, my], [x + w, y + h], [mx, y + h], [x, y + h], [x, my]];
}

// Draws marching-ants selection edges and the in-progress shape preview on a transparent canvas
// layered over the stage. Strokes are sized in device pixels so they stay crisp at any zoom/rotation.
export class SelectionOverlay {
  #canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #ants: Float32Array | null = null;
  #antsScale = 1;
  #preview: Preview = null;
  #hidden = false;
  #mask: { canvas: OffscreenCanvas | HTMLCanvasElement; w: number; h: number; scale: number } | null = null;
  #cursor: CursorState | null = null;
  #guides: [number, number, number, number][] = [];
  #box: BoxRect | null = null;
  #dash = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #last: [View, number, number, number] | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d')!;
  }

  setAnts(segments: Float32Array | null, scale: number) {
    this.#ants = segments;
    this.#antsScale = scale;
    this.#syncTimer();
  }

  setPreview(p: Preview) {
    this.#preview = p;
    this.#syncTimer();
  }

  setHidden(b: boolean) {
    this.#hidden = b;
  }

  setCursor(c: CursorState | null) {
    this.#cursor = c;
  }

  // Move/transform smart guides: full-document lines (x0, y0, x1, y1 in doc px) at the locked
  // snap targets, own colour, drawn only while set (cleared with an empty array).
  setGuides(lines: [number, number, number, number][]) {
    this.#guides = lines;
  }

  // Move tool transform controls: the target's bounding box with 8 handles (no drag from them).
  setBox(r: BoxRect | null) {
    this.#box = r;
  }

  // Quick mask: `coverage` is the selectionMask byte buffer (255 = selected); unselected pixels
  // are drawn as a 50% red tint. Pass null to go back to marching ants.
  setMaskOverlay(coverage: Uint8Array | null, w: number, h: number, scale: number) {
    if (!coverage) { this.#mask = null; return; }
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
    if (!(canvas instanceof OffscreenCanvas)) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      img.data[i * 4] = 255;
      img.data[i * 4 + 3] = Math.round((255 - coverage[i]) * 0.5);
    }
    ctx.putImageData(img, 0, 0);
    this.#mask = { canvas, w, h, scale };
  }

  #syncTimer() {
    const active = !!this.#ants || !!this.#preview;
    if (active && !this.#timer) this.#timer = setInterval(() => {
      this.#dash = (this.#dash + 1) % 8;
      if (this.#last) this.draw(...this.#last);
    }, 100);
    else if (!active && this.#timer) { clearInterval(this.#timer); this.#timer = undefined; }
  }

  draw(view: View, cssW: number, cssH: number, dpr: number) {
    this.#last = [view, cssW, cssH, dpr];
    this.#canvas.width = Math.round(cssW * dpr);
    this.#canvas.height = Math.round(cssH * dpr);
    const ctx = this.#ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    if (this.#hidden) return;
    if (this.#mask) this.#drawMask(this.#mask, view, cssW, cssH, dpr);
    else if (this.#ants) this.#strokeSegments(this.#segmentsFor(this.#ants), view, cssW, cssH, dpr, this.#antsScale);
    if (this.#preview) this.#strokeSegments(this.#previewSegments(this.#preview), view, cssW, cssH, dpr, 1);
    if (this.#box) this.#drawBox(this.#box, view, cssW, cssH, dpr);
    if (this.#guides.length) this.#drawGuides(view, cssW, cssH, dpr);
    if (this.#cursor) this.#drawCursor(this.#cursor, view, cssW, cssH, dpr);
  }

  // Screen-space outline (or crosshair) at the cursor's doc position; not part of the ants/preview
  // dash cycle since it tracks the pointer instead of animating.
  #drawCursor(cur: CursorState, view: View, cssW: number, cssH: number, dpr: number) {
    const ctx = this.#ctx;
    const [sx, sy] = docToScreen(view, cur.x, cur.y, cssW, cssH);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    if (cur.crosshair) {
      const r = 5;
      ctx.moveTo(sx - r, sy); ctx.lineTo(sx + r, sy);
      ctx.moveTo(sx, sy - r); ctx.lineTo(sx, sy + r);
    } else {
      const rPx = (cur.sizeDoc / 2) * view.zoom;
      if (cur.shape === 'square') ctx.rect(sx - rPx, sy - rPx, rPx * 2, rPx * 2);
      else ctx.arc(sx, sy, rPx, 0, Math.PI * 2);
    }
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }

  #drawGuides(view: View, cssW: number, cssH: number, dpr: number) {
    const ctx = this.#ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of this.#guides) {
      const [sx0, sy0] = docToScreen(view, x0, y0, cssW, cssH);
      const [sx1, sy1] = docToScreen(view, x1, y1, cssW, cssH);
      ctx.moveTo(sx0, sy0);
      ctx.lineTo(sx1, sy1);
    }
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeStyle = getComputedStyle(this.#canvas).getPropertyValue('--smart-guide');
    ctx.stroke();
  }

  #drawBox(r: BoxRect, view: View, cssW: number, cssH: number, dpr: number) {
    const ctx = this.#ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pts = boxHandles(r).map(([x, y]) => docToScreen(view, x, y, cssW, cssH));
    const color = getComputedStyle(this.#canvas).getPropertyValue('--transform-box');
    ctx.beginPath();
    for (let i = 0; i < 8; i += 2) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeStyle = color;
    ctx.stroke();
    for (const [x, y] of pts) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
      ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
    }
  }

  #segmentsFor(flat: Float32Array): [number, number, number, number][] {
    const out: [number, number, number, number][] = [];
    for (let i = 0; i < flat.length; i += 4) out.push([flat[i], flat[i + 1], flat[i + 2], flat[i + 3]]);
    return out;
  }

  #previewSegments(p: Exclude<Preview, null>): [number, number, number, number][] {
    if (p.kind === 'path') {
      const pts = p.points;
      const out: [number, number, number, number][] = [];
      const n = p.closed ? pts.length / 2 : pts.length / 2 - 1;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % (pts.length / 2);
        out.push([pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1]]);
      }
      return out;
    }
    const { x, y, w, h } = p;
    if (p.kind === 'rect') return [[x, y, x + w, y], [x + w, y, x + w, y + h], [x + w, y + h, x, y + h], [x, y + h, x, y]];
    // Ellipse as a stroked path: approximate with line segments so it shares the ants/dash code path.
    const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2, steps = 64;
    const out: [number, number, number, number][] = [];
    for (let i = 0; i < steps; i++) {
      const a0 = (i / steps) * Math.PI * 2, a1 = ((i + 1) / steps) * Math.PI * 2;
      out.push([cx + rx * Math.cos(a0), cy + ry * Math.sin(a0), cx + rx * Math.cos(a1), cy + ry * Math.sin(a1)]);
    }
    return out;
  }

  // Blits the per-tile-scaled mask canvas at doc origin, using the same view transform as the ants.
  #drawMask(mask: { canvas: OffscreenCanvas | HTMLCanvasElement; w: number; h: number; scale: number }, view: View, cssW: number, cssH: number, dpr: number) {
    const ctx = this.#ctx;
    const o = docToScreen(view, 0, 0, cssW, cssH);
    const ex = docToScreen(view, 1, 0, cssW, cssH);
    const ey = docToScreen(view, 0, 1, cssW, cssH);
    const a = (ex[0] - o[0]) * dpr * mask.scale, b = (ex[1] - o[1]) * dpr * mask.scale;
    const c = (ey[0] - o[0]) * dpr * mask.scale, d = (ey[1] - o[1]) * dpr * mask.scale;
    ctx.setTransform(a, b, c, d, o[0] * dpr, o[1] * dpr);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(mask.canvas, 0, 0);
    ctx.imageSmoothingEnabled = true;
  }

  // Sets ctx.setTransform to dpr * doc->screen * scale, then strokes the segments (in that local
  // coordinate space) white solid, then black dashed at exactly 1 device px regardless of the scale.
  #strokeSegments(segs: [number, number, number, number][], view: View, cssW: number, cssH: number, dpr: number, scale: number) {
    if (!segs.length) return;
    const ctx = this.#ctx;
    const o = docToScreen(view, 0, 0, cssW, cssH);
    const ex = docToScreen(view, 1, 0, cssW, cssH);
    const ey = docToScreen(view, 0, 1, cssW, cssH);
    const a = (ex[0] - o[0]) * dpr * scale, b = (ex[1] - o[1]) * dpr * scale;
    const c = (ey[0] - o[0]) * dpr * scale, d = (ey[1] - o[1]) * dpr * scale;
    ctx.setTransform(a, b, c, d, o[0] * dpr, o[1] * dpr);
    const s = Math.hypot(a, b);
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of segs) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
    ctx.lineWidth = 1 / s;
    ctx.setLineDash([]);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.setLineDash([4 / s, 4 / s]);
    ctx.lineDashOffset = -this.#dash * (4 / s);
    ctx.strokeStyle = '#000';
    ctx.stroke();
  }
}
