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

// Free transform overlay: the 8 dest handle points (clockwise from the top-left corner, corners at
// even indexes), the dest reference point and an optional size readout, all in document px.
export interface TransformBox { handles: [number, number][]; ref: [number, number]; dims: { text: string; at: [number, number] } | null }
// Preview source: image pixel (i, j) sits at document ((x + i) / f, (y + j) / f) before the
// row-major 3x3 matrix `m` maps it; `map` (a warp) replaces the matrix when set.
export interface TransformImage { source: CanvasImageSource; x: number; y: number; w: number; h: number; f: number; m: number[]; map?: (x: number, y: number) => [number, number] }
// Warp overlay: a (3 cols + 1) x (3 rows + 1) row-major grid of Bezier control points in document px.
export interface WarpGrid { cols: number; rows: number; points: [number, number][] }

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
  #transform: TransformBox | null = null;
  #image: TransformImage | null = null;
  #antsMatrix: number[] | null = null;
  #warp: WarpGrid | null = null;
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

  setTransform(t: TransformBox | null) {
    this.#transform = t;
  }

  setWarp(w: WarpGrid | null) {
    this.#warp = w;
  }

  setImage(img: TransformImage | null) {
    this.#image = img;
  }

  // Draws the marching ants mapped through a row-major 3x3 matrix (the outline of a transform preview).
  setAntsMatrix(m: number[] | null) {
    this.#antsMatrix = m;
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
    if (this.#image) this.#drawImage(this.#image, view, cssW, cssH, dpr);
    if (this.#hidden) return;
    if (this.#mask) this.#drawMask(this.#mask, view, cssW, cssH, dpr);
    else if (this.#ants && this.#antsMatrix) this.#strokeSegments(this.#mapSegments(this.#ants, this.#antsScale, this.#antsMatrix), view, cssW, cssH, dpr, 1);
    else if (this.#ants) this.#strokeSegments(this.#segmentsFor(this.#ants), view, cssW, cssH, dpr, this.#antsScale);
    if (this.#preview) this.#strokeSegments(this.#previewSegments(this.#preview), view, cssW, cssH, dpr, 1);
    if (this.#box) this.#drawBox(this.#box, view, cssW, cssH, dpr);
    if (this.#transform) this.#drawTransform(this.#transform, view, cssW, cssH, dpr);
    if (this.#warp) this.#drawWarp(this.#warp, view, cssW, cssH, dpr);
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

  // Affine matrices draw in one call; a projective one is drawn as an 8 x 8 mesh of affine triangles.
  #drawImage(img: TransformImage, view: View, cssW: number, cssH: number, dpr: number) {
    const ctx = this.#ctx, m = img.m;
    const o = docToScreen(view, 0, 0, cssW, cssH), ex = docToScreen(view, 1, 0, cssW, cssH), ey = docToScreen(view, 0, 1, cssW, cssH);
    const [a, b, c, d, e, f] = [(ex[0] - o[0]) * dpr, (ex[1] - o[1]) * dpr, (ey[0] - o[0]) * dpr, (ey[1] - o[1]) * dpr, o[0] * dpr, o[1] * dpr];
    const toDevice = (i: number, j: number): [number, number] => {
      const x = (img.x + i) / img.f, y = (img.y + j) / img.f;
      if (img.map) { const [u, v] = img.map(x, y); return [a * u + c * v + e, b * u + d * v + f]; }
      const w = m[6] * x + m[7] * y + m[8];
      const u = (m[0] * x + m[1] * y + m[2]) / w, v = (m[3] * x + m[4] * y + m[5]) / w;
      return [a * u + c * v + e, b * u + d * v + f];
    };
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    if (!img.map && m[6] === 0 && m[7] === 0) {
      const p0 = toDevice(0, 0), px = toDevice(1, 0), py = toDevice(0, 1);
      ctx.setTransform(px[0] - p0[0], px[1] - p0[1], py[0] - p0[0], py[1] - p0[1], p0[0], p0[1]);
      ctx.drawImage(img.source, 0, 0);
      return;
    }
    const n = img.map ? 12 : 8, sx = img.w / n, sy = img.h / n;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const s00: [number, number] = [i * sx, j * sy], s10: [number, number] = [(i + 1) * sx, j * sy];
        const s01: [number, number] = [i * sx, (j + 1) * sy], s11: [number, number] = [(i + 1) * sx, (j + 1) * sy];
        for (const tri of [[s00, s10, s11], [s00, s11, s01]]) this.#drawTriangle(img, tri, tri.map(p => toDevice(p[0], p[1])));
      }
    }
  }

  // Draws the source triangle `s` (image px) onto the device triangle `t`, clipped with a 0.5 px
  // overlap so neighbouring triangles leave no seam. Only the triangle's source box is drawn.
  #drawTriangle(img: TransformImage, s: [number, number][], t: [number, number][]) {
    const ctx = this.#ctx;
    const [[x0, y0], [x1, y1], [x2, y2]] = s, [[u0, v0], [u1, v1], [u2, v2]] = t;
    const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (!det) return;
    const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / det, c = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / det;
    const b = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / det, d = ((v2 - v0) * (x1 - x0) - (v1 - v0) * (x2 - x0)) / det;
    const cx = (u0 + u1 + u2) / 3, cy = (v0 + v1 + v2) / 3;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    for (const [u, v] of t) {
      const l = Math.hypot(u - cx, v - cy) || 1;
      ctx.lineTo(u + ((u - cx) / l) * 0.5, v + ((v - cy) / l) * 0.5);
    }
    ctx.clip();
    ctx.setTransform(a, b, c, d, u0 - a * x0 - c * y0, v0 - b * x0 - d * y0);
    const sx = Math.max(0, Math.floor(Math.min(x0, x1, x2)) - 1), sy = Math.max(0, Math.floor(Math.min(y0, y1, y2)) - 1);
    const sw = Math.min(img.w, Math.ceil(Math.max(x0, x1, x2)) + 1) - sx, sh = Math.min(img.h, Math.ceil(Math.max(y0, y1, y2)) + 1) - sy;
    ctx.drawImage(img.source, sx, sy, sw, sh, sx, sy, sw, sh);
    ctx.restore();
  }

  // Patch boundary curves, then anchors as squares and handles as dots.
  #drawWarp(g: WarpGrid, view: View, cssW: number, cssH: number, dpr: number) {
    const ctx = this.#ctx, nc = 3 * g.cols + 1, nr = 3 * g.rows + 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pts = g.points.map(([x, y]) => docToScreen(view, x, y, cssW, cssH));
    const color = getComputedStyle(this.#canvas).getPropertyValue('--transform-box');
    ctx.beginPath();
    const curve = (idx: number[]) => {
      ctx.moveTo(pts[idx[0]][0], pts[idx[0]][1]);
      for (let k = 1; k + 2 < idx.length; k += 3) {
        const [p, q, r] = [pts[idx[k]], pts[idx[k + 1]], pts[idx[k + 2]]];
        ctx.bezierCurveTo(p[0], p[1], q[0], q[1], r[0], r[1]);
      }
    };
    for (let j = 0; j < nr; j += 3) curve(Array.from({ length: nc }, (_, i) => j * nc + i));
    for (let i = 0; i < nc; i += 3) curve(Array.from({ length: nr }, (_, j) => j * nc + i));
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    pts.forEach(([x, y], k) => {
      if ((k % nc) % 3 === 0 && Math.floor(k / nc) % 3 === 0) {
        ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
        ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    });
  }

  #drawTransform(t: TransformBox, view: View, cssW: number, cssH: number, dpr: number) {
    const ctx = this.#ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pts = t.handles.map(([x, y]) => docToScreen(view, x, y, cssW, cssH));
    const color = getComputedStyle(this.#canvas).getPropertyValue('--transform-box');
    ctx.beginPath();
    for (let i = 0; i < 8; i += 2) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    for (const [x, y] of pts) {
      ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
      ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
    }
    const [rx, ry] = docToScreen(view, t.ref[0], t.ref[1], cssW, cssH);
    ctx.beginPath();
    ctx.arc(rx, ry, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(rx - 7, ry); ctx.lineTo(rx + 7, ry);
    ctx.moveTo(rx, ry - 7); ctx.lineTo(rx, ry + 7);
    ctx.stroke();
    if (t.dims) {
      const [dx, dy] = docToScreen(view, t.dims.at[0], t.dims.at[1], cssW, cssH);
      ctx.font = '11px system-ui, sans-serif';
      const w = ctx.measureText(t.dims.text).width + 10;
      ctx.fillStyle = color;
      ctx.fillRect(dx + 12, dy + 12, w, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(t.dims.text, dx + 17, dy + 25);
    }
  }

  #mapSegments(flat: Float32Array, scale: number, m: number[]): [number, number, number, number][] {
    const map = (x: number, y: number) => {
      const w = m[6] * x + m[7] * y + m[8];
      return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
    };
    const out: [number, number, number, number][] = [];
    for (let i = 0; i < flat.length; i += 4) out.push([...map(flat[i] * scale, flat[i + 1] * scale), ...map(flat[i + 2] * scale, flat[i + 3] * scale)] as [number, number, number, number]);
    return out;
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
