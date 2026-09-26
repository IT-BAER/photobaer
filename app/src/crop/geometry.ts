import { snapAxis, type AxisLock, type Rect, type SnapAxes } from '../shell/snapping.ts';
import type { Pt } from '../transform/matrix.ts';

// Crop and perspective crop geometry, all in document px; screen radii arrive divided by the zoom.
export type Handle = 'topLeft' | 'top' | 'topRight' | 'right' | 'bottomRight' | 'bottom' | 'bottomLeft' | 'left';
export type CropHit = Handle | 'body';
export const HANDLES: Handle[] = ['topLeft', 'top', 'topRight', 'right', 'bottomRight', 'bottom', 'bottomLeft', 'left'];
const CATCH_PX = 6, HOLD_PX = 10, HANDLE_PX = 11, CORNER_PX = 10;

export function handlePoint(r: Rect, h: Handle): Pt {
  const x = /Left$|^left$/.test(h) ? r.x : /Right$|^right$/.test(h) ? r.x + r.w : r.x + r.w / 2;
  const y = /^top/.test(h) ? r.y : /^bottom/.test(h) ? r.y + r.h : r.y + r.h / 2;
  return [x, y];
}

// The first handle within `radius`, else 'body' inside the rect (edges included), else null.
export function hitCrop(r: Rect, p: Pt, radius: number): CropHit | null {
  for (const h of HANDLES) {
    const [x, y] = handlePoint(r, h);
    if (Math.hypot(x - p[0], y - p[1]) <= radius) return h;
  }
  return p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h ? 'body' : null;
}

const fromEdges = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });

// Moves the edges the handle owns, then normalizes (edges may cross). A ratio (w / h) keeps the
// normalized top-left: h = w / ratio, except top/bottom handles where w = h * ratio.
export function resizeCrop(start: Rect, hit: CropHit, dx: number, dy: number, ratio: number | null): Rect {
  if (hit === 'body') return { ...start, x: start.x + dx, y: start.y + dy };
  let x0 = start.x, y0 = start.y, x1 = start.x + start.w, y1 = start.y + start.h;
  if (/Left$|^left$/.test(hit)) x0 += dx;
  if (/Right$|^right$/.test(hit)) x1 += dx;
  if (/^top/.test(hit)) y0 += dy;
  if (/^bottom/.test(hit)) y1 += dy;
  const r = fromEdges(x0, y0, x1, y1);
  if (!ratio || ratio <= 0 || r.w <= 0 || r.h <= 0) return r;
  return hit === 'top' || hit === 'bottom' ? { ...r, w: r.h * ratio } : { ...r, h: r.w / ratio };
}

const PRESET_RATIOS: Record<string, number> = { '1:1': 1, '4:5': 0.8, '5:7': 5 / 7, '2:3': 2 / 3, '16:9': 16 / 9 };

// Width / height the box is held to, or null for a free box.
export function cropRatio(o: Record<string, unknown>, docW: number, docH: number): number | null {
  if (o.ratio === 'original') return docH === 0 ? null : docW / docH;
  const preset = PRESET_RATIOS[String(o.ratio)];
  if (preset) return preset;
  const w = Number(o.ratioWidth), h = Number(o.ratioHeight);
  return w > 0 && h > 0 ? w / h : null;
}

// The dragged line's angle in degrees folded into [-45, 45).
export function straightenAngle(from: Pt, to: Pt): number {
  const deg = Math.atan2(to[1] - from[1], to[0] - from[0]) * 180 / Math.PI;
  return (((deg + 45) % 90) + 90) % 90 - 45;
}

const GOLDEN = 0.6180339887498949;
export type Line = [number, number, number, number];

// Composition guide lines inside the box as [x0, y0, x1, y1].
export function overlayLines(r: Rect, kind: string): Line[] {
  const out: Line[] = [], right = r.x + r.w, bottom = r.y + r.h;
  const v = (x: number) => out.push([x, r.y, x, bottom]);
  const h = (y: number) => out.push([r.x, y, right, y]);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  switch (kind) {
    case 'thirds': v(r.x + r.w / 3); v(r.x + r.w * 2 / 3); h(r.y + r.h / 3); h(r.y + r.h * 2 / 3); break;
    case 'grid': {
      const step = Math.max(16, Math.min(r.w, r.h) / 8);
      for (let x = r.x + step; x < right; x += step) v(x);
      for (let y = r.y + step; y < bottom; y += step) h(y);
      break;
    }
    case 'diagonal': out.push([r.x, r.y, right, bottom], [right, r.y, r.x, bottom]); break;
    case 'triangle': out.push([r.x, r.y, right, bottom], [right, r.y, cx, cy], [r.x, bottom, cx, cy]); break;
    case 'golden ratio': v(r.x + r.w * GOLDEN); v(right - r.w * GOLDEN); h(r.y + r.h * GOLDEN); h(bottom - r.h * GOLDEN); break;
    case 'golden spiral': {
      // Straight square cuts only, alternating sides, up to 8 times.
      let q = { ...r };
      for (let i = 0; i < 8 && q.w >= 2 && q.h >= 2; i++) {
        const even = i % 2 === 0;
        if (q.w >= q.h) {
          const cut = even ? q.x + q.h : q.x + q.w - q.h;
          out.push([cut, q.y, cut, q.y + q.h]);
          q = { x: even ? cut : q.x, y: q.y, w: q.w - q.h, h: q.h };
        } else {
          const cut = even ? q.y + q.w : q.y + q.h - q.w;
          out.push([q.x, cut, q.x + q.w, cut]);
          q = { x: q.x, y: even ? cut : q.y, w: q.w, h: q.h - q.w };
        }
      }
      break;
    }
  }
  return out;
}

export function roundOut(r: Rect): Rect {
  const x = Math.floor(r.x), y = Math.floor(r.y);
  return { x, y, w: Math.max(0, Math.ceil(r.x + r.w) - x), h: Math.max(0, Math.ceil(r.y + r.h) - y) };
}

// Rounded-out bbox of the rect's corners under the row-major affine `m`.
function bbox(m: number[], r: Rect): Rect {
  const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([x, y]) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]]);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.floor(Math.min(...xs)), y0 = Math.floor(Math.min(...ys));
  return { x: x0, y: y0, w: Math.ceil(Math.max(...xs)) - x0, h: Math.ceil(Math.max(...ys)) - y0 };
}

// The size a crop commit produces: the rounded-out box, or with a straighten angle the rounded-out
// bbox of that box after the canvas turns by -angle about its centre and moves to the origin.
export function croppedSize(rect: Rect, angle: number, docW: number, docH: number): [number, number] {
  const r = roundOut(rect);
  const a = ((-angle % 360) + 360) % 360;
  if (!a) return [r.w, r.h];
  const s = Math.sin(a * Math.PI / 180), c = Math.cos(a * Math.PI / 180), cx = docW / 2, cy = docH / 2;
  const m = [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy];
  const canvas = bbox(m, { x: 0, y: 0, w: docW, h: docH });
  m[2] -= canvas.x;
  m[5] -= canvas.y;
  const out = bbox(m, r);
  return [out.w, out.h];
}

const canvasTargets = (docW: number, docH: number) => ({ x: [0, docW / 2, docW], y: [0, docH / 2, docH] });

// Snaps a crop drag offset: the body by its left/centre/right and top/middle/bottom, a handle by
// the edges it owns, against the canvas edges and centre.
export function snapCropDrag(start: Rect, hit: CropHit, dx: number, dy: number, docW: number, docH: number, lock: SnapAxes, zoom: number) {
  const t = canvasTargets(docW, docH), c = CATCH_PX / zoom, hold = HOLD_PX / zoom;
  const ax = hit === 'body' ? [start.x, start.x + start.w / 2, start.x + start.w] : /Left$|^left$/.test(hit) ? [start.x] : /Right$|^right$/.test(hit) ? [start.x + start.w] : [];
  const ay = hit === 'body' ? [start.y, start.y + start.h / 2, start.y + start.h] : /^top/.test(hit) ? [start.y] : /^bottom/.test(hit) ? [start.y + start.h] : [];
  const lx = snapAxis(ax, t.x, dx, lock.x && ax.includes(lock.x.anchor) ? lock.x : null, c, hold);
  const ly = snapAxis(ay, t.y, dy, lock.y && ay.includes(lock.y.anchor) ? lock.y : null, c, hold);
  return { dx: lx ? lx.target - lx.anchor : dx, dy: ly ? ly.target - ly.anchor : dy, lock: { x: lx, y: ly } };
}

// Snaps a point to the canvas edges and centre (per axis, with hold).
export function snapPoint(p: Pt, docW: number, docH: number, lock: SnapAxes, zoom: number): { p: Pt; lock: SnapAxes } {
  const t = canvasTargets(docW, docH), c = CATCH_PX / zoom, hold = HOLD_PX / zoom;
  const lx: AxisLock | null = snapAxis([0], t.x, p[0], lock.x, c, hold), ly: AxisLock | null = snapAxis([0], t.y, p[1], lock.y, c, hold);
  return { p: [lx ? lx.target : p[0], ly ? ly.target : p[1]], lock: { x: lx, y: ly } };
}

export interface CropCtx { docW: number; docH: number; zoom: number; ratio: number | null; straighten: boolean }
export interface Mods { shift: boolean; alt: boolean }
// `rect` null means the default box (the whole canvas); `angle` is the stored straighten angle.
export interface CropState {
  rect: Rect | null; angle: number; active: boolean; hit: CropHit | null; origin: Pt; start: Rect;
  line: [Pt, Pt] | null; lock: SnapAxes;
}
const NO_LOCK: SnapAxes = { x: null, y: null };

export const newCropState = (): CropState => ({ rect: null, angle: 0, active: false, hit: null, origin: [0, 0], start: { x: 0, y: 0, w: 0, h: 0 }, line: null, lock: NO_LOCK });
export const cropBox = (s: CropState, docW: number, docH: number): Rect => s.rect ?? { x: 0, y: 0, w: docW, h: docH };
// A pending crop: a drag, a user box or a straighten angle (commit on tool switch, Enter goes to it).
export const cropActive = (s: CropState) => s.active || s.rect !== null || s.angle !== 0;

export function cropDown(s: CropState, p: Pt, ctx: CropCtx) {
  s.active = true;
  if (ctx.straighten) { s.line = [p, p]; return; }
  s.lock = NO_LOCK;
  const box = cropBox(s, ctx.docW, ctx.docH), hit = hitCrop(box, p, HANDLE_PX / ctx.zoom);
  if (hit) { s.hit = hit; s.origin = p; s.start = { ...box }; return; }
  const q = snapPoint(p, ctx.docW, ctx.docH, NO_LOCK, ctx.zoom).p;
  s.hit = 'bottomRight';
  s.origin = q;
  s.start = { x: q[0], y: q[1], w: 0, h: 0 };
  s.rect = { ...s.start };
}

export function cropMove(s: CropState, p: Pt, mods: Mods, ctx: CropCtx) {
  if (!s.active) return;
  if (s.line) { s.line = [s.line[0], p]; return; }
  if (!s.hit) return;
  if (p[0] === s.origin[0] && p[1] === s.origin[1]) { s.rect = { ...s.start }; s.lock = NO_LOCK; return; }
  let dx = p[0] - s.origin[0], dy = p[1] - s.origin[1];
  if (mods.alt) s.lock = NO_LOCK;
  else ({ dx, dy, lock: s.lock } = snapCropDrag(s.start, s.hit, dx, dy, ctx.docW, ctx.docH, s.lock, ctx.zoom));
  s.rect = resizeCrop(s.start, s.hit, dx, dy, mods.shift ? null : ctx.ratio);
}

// Ends a drag; a straighten line stores and returns its angle (the caller turns straighten off).
export function cropUp(s: CropState, p: Pt, mods: Mods, ctx: CropCtx): number | null {
  if (!s.active) return null;
  cropMove(s, p, mods, ctx);
  s.active = false;
  s.hit = null;
  if (s.rect && (s.rect.w === 0 || s.rect.h === 0)) s.rect = null;
  if (!s.line) return null;
  s.angle = straightenAngle(s.line[0], p);
  s.line = null;
  return s.angle;
}

export function cropPointerCancel(s: CropState) {
  s.active = false;
  s.hit = null;
  s.line = null;
}

export function cropCancel(s: CropState) {
  cropPointerCancel(s);
  s.rect = null;
  s.angle = 0;
}

// The rect and angle to apply, resetting the tool; null when there is nothing to do (an empty box
// stays, the untouched canvas clears).
export function cropCommit(s: CropState, docW: number, docH: number): { rect: Rect; angle: number } | null {
  const rect = roundOut(cropBox(s, docW, docH)), angle = s.angle;
  if (rect.w <= 0 || rect.h <= 0) return null;
  s.rect = null;
  if (!angle && rect.x === 0 && rect.y === 0 && rect.w === docW && rect.h === docH) return null;
  s.angle = 0;
  return { rect, angle };
}

export interface PerspCtx { docW: number; docH: number; zoom: number }
// Corners in click order map to the output's top-left, top-right, bottom-right, bottom-left.
export interface PerspState { corners: Pt[]; dragging: number; active: boolean; lock: SnapAxes }
export const newPerspState = (): PerspState => ({ corners: [], dragging: -1, active: false, lock: NO_LOCK });

// Grabs a corner within 10 screen px, else adds a corner (a fifth click starts over).
export function perspDown(s: PerspState, p: Pt, ctx: PerspCtx) {
  s.active = true;
  s.lock = NO_LOCK;
  s.dragging = s.corners.findIndex(c => Math.hypot(c[0] - p[0], c[1] - p[1]) <= CORNER_PX / ctx.zoom);
  if (s.dragging >= 0) return;
  if (s.corners.length >= 4) s.corners = [];
  const q = snapPoint(p, ctx.docW, ctx.docH, s.lock, ctx.zoom);
  s.lock = q.lock;
  s.corners.push(q.p);
  s.dragging = s.corners.length - 1;
}

export function perspMove(s: PerspState, p: Pt, ctx: PerspCtx) {
  if (!s.active || s.dragging < 0) return;
  const q = snapPoint(p, ctx.docW, ctx.docH, s.lock, ctx.zoom);
  s.lock = q.lock;
  s.corners[s.dragging] = q.p;
}

// With 4 corners, the output size to write back to the options.
export function perspUp(s: PerspState, p: Pt, ctx: PerspCtx, outW: number, outH: number): [number, number] | null {
  perspMove(s, p, ctx);
  s.active = false;
  s.dragging = -1;
  return s.corners.length === 4 ? perspSize(s.corners, outW, outH) : null;
}

// The set output size when both are positive, else the mean opposite edge lengths.
export function perspSize(c: Pt[], outW: number, outH: number): [number, number] {
  const w = Math.round(outW), h = Math.round(outH);
  if (w > 0 && h > 0) return [w, h];
  const d = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  return [Math.max(1, Math.round((d(c[0], c[1]) + d(c[3], c[2])) / 2)), Math.max(1, Math.round((d(c[0], c[3]) + d(c[1], c[2])) / 2))];
}
