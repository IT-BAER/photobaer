// Row-major 3x3 forward matrices (source -> dest document px), the engine's transform format.
export type Mat3 = number[];
export type Pt = [number, number];
// Corners clockwise from the top-left: TL, TR, BR, BL.
export type Quad = [Pt, Pt, Pt, Pt];
export interface Rect { x: number; y: number; w: number; h: number }
// Angles in radians; positive rotation is clockwise on screen (y points down).
export interface Params { tx: number; ty: number; rotation: number; sx: number; sy: number; skewX: number; skewY: number }

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function identityParams(): Params {
  return { tx: 0, ty: 0, rotation: 0, sx: 1, sy: 1, skewX: 0, skewY: 0 };
}

export function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

export function invert(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d].map(v => v / det);
}

export function apply(m: Mat3, x: number, y: number): Pt {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

// R K S as [a, b, c, d] (row-major 2x2): scale first, then skew, then rotate.
export function linear(p: Params): [number, number, number, number] {
  const cos = Math.cos(p.rotation), sin = Math.sin(p.rotation), kx = Math.tan(p.skewX), ky = Math.tan(p.skewY);
  const k = [p.sx, kx * p.sy, ky * p.sx, p.sy];
  return [cos * k[0] - sin * k[2], cos * k[1] - sin * k[3], sin * k[0] + cos * k[2], sin * k[1] + cos * k[3]];
}

// x' = R K S (x - ref) + ref + t.
export function affine(p: Params, ref: Pt): Mat3 {
  const [a, b, c, d] = linear(p);
  return [a, b, ref[0] + p.tx - a * ref[0] - b * ref[1], c, d, ref[1] + p.ty - c * ref[0] - d * ref[1], 0, 0, 1];
}

// Projective map of the four `src` corners onto `dst` (8x8 solve, h33 = 1).
export function homography(src: Quad, dst: Quad): Mat3 {
  const rows: number[][] = [];
  for (let k = 0; k < 4; k++) {
    const [x, y] = src[k], [u, v] = dst[k];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(rows[r][c]) > Math.abs(rows[p][c])) p = r;
    [rows[c], rows[p]] = [rows[p], rows[c]];
    const piv = rows[c][c];
    if (Math.abs(piv) < 1e-12) return [...IDENTITY];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = rows[r][c] / piv;
      if (f) for (let j = c; j < 9; j++) rows[r][j] -= f * rows[c][j];
    }
  }
  return [...rows.map((r, i) => r[8] / r[i]), 1];
}

export function rectQuad(r: Rect): Quad {
  return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
}

// The session matrix: the affine part after the optional distortion of the source rect onto `quad`.
export function transformMatrix(p: Params, ref: Pt, bounds: Rect, quad: Quad | null): Mat3 {
  const a = affine(p, ref);
  return quad ? mul(a, homography(rectQuad(bounds), quad)) : a;
}

// Maps the unit square onto `r`.
function basis(r: Rect): Mat3 {
  return [r.w, 0, r.x, 0, r.h, r.y, 0, 0, 1];
}

function basisInverse(r: Rect): Mat3 {
  return [1 / r.w, 0, -r.x / r.w, 0, 1 / r.h, -r.y / r.h, 0, 0, 1];
}

// N = B^-1 M B, the transform relative to the unit square of its source bounds.
export function normalize(m: Mat3, r: Rect): Mat3 {
  return mul(basisInverse(r), mul(m, basis(r)));
}

// M' = B' N B'^-1 for other source bounds.
export function denormalize(n: Mat3, r: Rect): Mat3 {
  return mul(basis(r), mul(n, basisInverse(r)));
}

export function isIdentity(m: Mat3, eps = 1e-9): boolean {
  return m.every((v, i) => Math.abs(v / m[8] - IDENTITY[i]) <= eps);
}
