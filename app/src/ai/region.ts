// Object Selection regions: the model sees the drawn shape's bounds with some context around them, and its
// mask keeps only what lies inside the drawn shape.

export type Rect4 = [number, number, number, number];

// Bounds of the flat x, y `points`, padded by a tenth of their size (at least 8 px) and clipped to the w x h
// canvas, as whole pixels [x, y, w, h]; null when the shape is under 2 px wide or high or misses the canvas.
export function objectRegion(points: number[], w: number, h: number): Rect4 | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    x0 = Math.min(x0, points[i]); x1 = Math.max(x1, points[i]);
    y0 = Math.min(y0, points[i + 1]); y1 = Math.max(y1, points[i + 1]);
  }
  if (!(x1 - x0 >= 2 && y1 - y0 >= 2)) return null;
  const px = Math.max(8, (x1 - x0) / 10), py = Math.max(8, (y1 - y0) / 10);
  const a = Math.max(0, Math.floor(x0 - px)), b = Math.max(0, Math.floor(y0 - py));
  const c = Math.min(w, Math.ceil(x1 + px)), d = Math.min(h, Math.ceil(y1 + py));
  return c - a >= 1 && d - b >= 1 ? [a, b, c - a, d - b] : null;
}

// `mask` (side x side over the document `rect`) with every pixel whose centre lies outside the closed polygon
// `points` (flat document x, y) set to 0, by the even-odd rule.
export function clipMask(mask: Uint8Array, side: number, rect: Rect4, points: number[]): Uint8Array {
  const out = new Uint8Array(mask.length), n = points.length >> 1, xs: number[] = [];
  for (let r = 0; r < side; r++) {
    const y = rect[1] + (r + 0.5) * rect[3] / side;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = points[2 * i], yi = points[2 * i + 1], xj = points[2 * j], yj = points[2 * j + 1];
      if ((yi > y) !== (yj > y)) xs.push(xi + (y - yi) * (xj - xi) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    // Columns whose centre x lies in [xs[k], xs[k + 1]).
    const col = (x: number) => Math.min(side, Math.max(0, Math.ceil((x - rect[0]) * side / rect[2] - 0.5)));
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let c = col(xs[k]), end = col(xs[k + 1]); c < end; c++) out[r * side + c] = mask[r * side + c];
    }
  }
  return out;
}
