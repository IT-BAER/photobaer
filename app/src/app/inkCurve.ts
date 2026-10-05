// Duotone Curve: output % at input ink 0, 5, 10, 20 ... 90, 95, 100 %; null fields are skipped.
import type { InkCurve } from '../worker/types.ts';

export const INK_CURVE_INPUTS = [0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100];

/** Ink fraction 0..1 printed at ink fraction `x`: a monotone cubic (Fritsch-Carlson PCHIP) through the set
 * points, an empty end point at its identity value; the engine's ink_curve (color_mode.rs) in TypeScript. */
export function inkCurve(c: InkCurve, x: number): number {
  const at = Math.min(1, Math.max(0, x)) * 100;
  const pts = INK_CURVE_INPUTS.flatMap((xi, i) => {
    const y = c[i] ?? (i === 0 ? 0 : i === 12 ? 100 : null);
    return y == null ? [] : [[xi, y]];
  });
  const n = pts.length;
  const h = pts.slice(1).map((p, i) => p[0] - pts[i][0]);
  const d = pts.slice(1).map((p, i) => (p[1] - pts[i][1]) / h[i]);
  // End slopes by the three-point formula, kept to the secant's sign; inner ones by the weighted harmonic mean.
  const end = (h0: number, h1: number, d0: number, d1: number) => {
    const m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    return m * d0 <= 0 ? 0 : d0 * d1 < 0 && Math.abs(m) > 3 * Math.abs(d0) ? 3 * d0 : m;
  };
  const m = pts.map((_, i) => {
    if (n === 2) return d[0];
    if (i === 0) return end(h[0], h[1], d[0], d[1]);
    if (i === n - 1) return end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
    if (d[i - 1] * d[i] <= 0) return 0;
    const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
    return (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  });
  const k = Math.min(n - 1, Math.max(1, pts.filter(p => p[0] < at).length));
  const [[x0, y0], [x1, y1]] = [pts[k - 1], pts[k]];
  const hk = x1 - x0, t = (at - x0) / hk, t2 = t * t, t3 = t2 * t;
  const y = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * hk * m[k - 1] + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * hk * m[k];
  return Math.min(1, Math.max(0, y / 100));
}
