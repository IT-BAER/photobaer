import { docToScreen, type View } from '../view.ts';

export type Preview =
  | null
  | { kind: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number }
  | { kind: 'path'; points: number[]; closed: boolean };

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
