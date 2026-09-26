export type SelectMode = 'new' | 'add' | 'subtract' | 'intersect';

export function selectMode(option: string, shift: boolean, alt: boolean): SelectMode {
  if (shift && alt) return 'intersect';
  if (shift) return 'add';
  if (alt) return 'subtract';
  return option as SelectMode;
}

export interface MarqueeOpts {
  constrain: boolean; fromCenter: boolean; style: 'normal' | 'fixed ratio' | 'fixed size';
  ratioW: number; ratioH: number; fixedW: number; fixedH: number;
}

export function marqueeRect(start: [number, number], cur: [number, number], o: MarqueeOpts) {
  const [sx, sy] = start, [cx, cy] = cur;
  if (o.style === 'fixed size') {
    const w = o.fixedW, h = o.fixedH;
    return o.fromCenter ? { x: cx - w / 2, y: cy - h / 2, w, h } : { x: cx, y: cy, w, h };
  }
  const dx = cx - sx, dy = cy - sy;
  let w = Math.abs(dx);
  let h: number;
  if (o.style === 'fixed ratio') h = w * o.ratioH / o.ratioW;
  else {
    h = Math.abs(dy);
    if (o.constrain) w = h = Math.max(w, h);
  }
  if (o.fromCenter) return { x: sx - w, y: sy - h, w: w * 2, h: h * 2 };
  return { x: dx >= 0 ? sx : sx - w, y: dy >= 0 ? sy : sy - h, w, h };
}

// Projects `to` onto the nearest of the 8 45-degree directions from `from`, keeping the
// component of the drag vector along that direction (not the raw drag length).
export function snap45(from: [number, number], to: [number, number]): [number, number] {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const proj = dx * Math.cos(angle) + dy * Math.sin(angle);
  return [from[0] + proj * Math.cos(angle), from[1] + proj * Math.sin(angle)];
}

export class PolygonLasso {
  points: [number, number][] = [];
  add(p: [number, number]) { this.points.push(p); }
  removeLast() { this.points.pop(); }
  closesAt(p: [number, number], tolDoc: number): boolean {
    if (this.points.length < 3) return false;
    const [x0, y0] = this.points[0];
    return Math.hypot(p[0] - x0, p[1] - y0) <= tolDoc;
  }
  flat(): number[] { return this.points.flat(); }
}

// Boundary segments (x0,y0,x1,y1,...) between inside (mask >= threshold) and outside pixels,
// in mask pixel units. Out-of-bounds counts as outside. Adjacent unit edges on the same grid
// line merge into one run.
export function contour(mask: Uint8Array, w: number, h: number, threshold = 128): Float32Array {
  const inside = (x: number, y: number) => x >= 0 && x < w && y >= 0 && y < h && mask[y * w + x] >= threshold;
  const segs: number[] = [];
  for (let edgeY = 0; edgeY <= h; edgeY++) {
    let runStart = -1;
    for (let x = 0; x <= w; x++) {
      const differs = x < w && inside(x, edgeY - 1) !== inside(x, edgeY);
      if (differs && runStart < 0) runStart = x;
      else if (!differs && runStart >= 0) { segs.push(runStart, edgeY, x, edgeY); runStart = -1; }
    }
  }
  for (let edgeX = 0; edgeX <= w; edgeX++) {
    let runStart = -1;
    for (let y = 0; y <= h; y++) {
      const differs = y < h && inside(edgeX - 1, y) !== inside(edgeX, y);
      if (differs && runStart < 0) runStart = y;
      else if (!differs && runStart >= 0) { segs.push(edgeX, runStart, edgeX, y); runStart = -1; }
    }
  }
  return Float32Array.from(segs);
}

// Smallest tile level >= displayLevel that keeps the doc's longest side within `cap`, clamped
// to maxLevel and to 8 (the engine's tile level limit).
export function antsLevel(displayLevel: number, docW: number, docH: number, maxLevel: number, cap = 4096): number {
  let level = displayLevel;
  while ((Math.max(docW, docH) >> level) > cap) level++;
  return Math.min(level, maxLevel, 8);
}
