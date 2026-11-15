// Face-Aware Liquify (Filter > Liquify, Face Tool): face features from the 478 face landmarks and the slider
// settings turned into a Liquify mesh field. Each feature is a local affine map (scale, rotation, shift) in the
// face's own frame with a smooth elliptical falloff; the field holds, per mesh node, where the output samples the
// source minus the node position (the engine's backward convention). Gains are our own choice, not Photoshop's.

export type Pt = [number, number];
interface Eye { outer: Pt; inner: Pt; top: Pt; bottom: Pt }
export interface Face {
  // The first eye is the one on the image's left in an upright photo (the subject's right eye).
  eyes: [Eye, Eye];
  nose: { tip: Pt; base: Pt; bridge: Pt; alae: [Pt, Pt] };
  mouth: { corners: [Pt, Pt]; top: Pt; innerTop: Pt; innerBottom: Pt; bottom: Pt };
  brows: [Pt, Pt];
  forehead: Pt;
  chin: Pt;
  oval: Pt[];
}

export const EYE_KEYS = ['eyeSize', 'eyeHeight', 'eyeWidth', 'eyeTilt'] as const;
export const SINGLE_KEYS = ['eyeDistance', 'noseHeight', 'noseWidth', 'smile', 'upperLip', 'lowerLip', 'mouthWidth', 'mouthHeight', 'forehead', 'chinHeight', 'jawline', 'faceWidth'] as const;
export type EyeKey = typeof EYE_KEYS[number];
export type SingleKey = typeof SINGLE_KEYS[number];
// Every slider is -100..100; eye sliders hold [first eye, second eye].
export type FaceSettings = Record<EyeKey, [number, number]> & Record<SingleKey, number>;

export const FACE_ZERO: FaceSettings = Object.freeze({
  eyeSize: [0, 0], eyeHeight: [0, 0], eyeWidth: [0, 0], eyeTilt: [0, 0],
  ...Object.fromEntries(SINGLE_KEYS.map(k => [k, 0])),
}) as FaceSettings;

const clamp = (v: number) => Math.max(-100, Math.min(100, Math.round(v) || 0));

// Sets one eye's value, or both when the eyes are linked.
export function setEye(s: FaceSettings, key: EyeKey, side: 0 | 1, value: number, linked: boolean): FaceSettings {
  const v = clamp(value), pair: [number, number] = linked ? [v, v] : side === 0 ? [v, s[key][1]] : [s[key][0], v];
  return { ...s, [key]: pair };
}

export function setSingle(s: FaceSettings, key: SingleKey, value: number): FaceSettings {
  return { ...s, [key]: clamp(value) };
}

const isZero = (s: FaceSettings) => EYE_KEYS.every(k => s[k][0] === 0 && s[k][1] === 0) && SINGLE_KEYS.every(k => s[k] === 0);

// One face from normalized landmarks (x, y pairs over the whole document); `oval` lists the face oval's landmark
// indices in contour order.
export function fromLandmarks(p: ArrayLike<number>, oval: number[], w: number, h: number): Face {
  const q = (i: number): Pt => [p[i * 2] * w, p[i * 2 + 1] * h];
  const eye = (outer: number, inner: number, top: number, bottom: number): Eye => ({ outer: q(outer), inner: q(inner), top: q(top), bottom: q(bottom) });
  return {
    eyes: [eye(33, 133, 159, 145), eye(263, 362, 386, 374)],
    nose: { tip: q(1), base: q(2), bridge: q(168), alae: [q(129), q(358)] },
    mouth: { corners: [q(61), q(291)], top: q(0), innerTop: q(13), innerBottom: q(14), bottom: q(17) },
    brows: [q(105), q(334)],
    forehead: q(10),
    chin: q(152),
    oval: oval.map(q),
  };
}

const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const centroid = (ps: Pt[]): Pt => { const s = ps.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]); return [s[0] / ps.length, s[1] / ps.length]; };

function inside(poly: Pt[], x: number, y: number) {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
}

// The face whose oval contains (x, y), else the one with the nearest centre; -1 without faces.
export function faceAt(faces: Face[], x: number, y: number) {
  const hit = faces.findIndex(f => inside(f.oval, x, y));
  if (hit >= 0 || !faces.length) return hit;
  let best = 0;
  faces.forEach((f, i) => { if (dist(centroid(f.oval), [x, y]) < dist(centroid(faces[best].oval), [x, y])) best = i; });
  return best;
}

// A local map in the face frame: output point q samples c + B * inv * B^T * (q - c - t), weighted by an elliptical
// falloff (radii ru along u, rv along v); `side` keeps only lv < at (-1) or lv > at (+1).
interface Term { c: Pt; inv: [number, number, number, number]; t: Pt; ru: number; rv: number; side?: { at: number; sign: 1 | -1; band: number } }

// 1 inside 35 % of the radius, then a smoothstep down to 0 at the edge.
const CORE = 0.35;
function falloff(r: number) {
  if (r <= CORE) return 1;
  const x = (r - CORE) / (1 - CORE);
  return 1 - x * x * (3 - 2 * x);
}
const smooth01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
// Slider -100..100 as a scale factor; shrinking mirrors growing so neither direction folds the mesh.
const scale = (v: number, gain: number) => (1 + gain) ** (v / 100);

function terms(f: Face, s: FaceSettings, u: Pt, v: Pt): Term[] {
  const lu = (p: Pt) => p[0] * u[0] + p[1] * u[1], lv = (p: Pt) => p[0] * v[0] + p[1] * v[1];
  const along = (k: number, l: number): Pt => [k * u[0] + l * v[0], k * u[1] + l * v[1]];
  const diag = (a: number, b: number): [number, number, number, number] => [1 / a, 0, 0, 1 / b];
  const out: Term[] = [];
  const eyeC = f.eyes.map(e => mid(e.outer, e.inner)) as [Pt, Pt];
  const D = dist(eyeC[0], eyeC[1]);
  f.eyes.forEach((e, i) => {
    const ew = Math.max(dist(e.outer, e.inner), D * 0.3), sz = scale(s.eyeSize[i], 0.35);
    // Size times Width or Height stays within 1/1.6..1.6, where the falloff cannot fold.
    const lim = (x: number) => Math.min(1.6, Math.max(1 / 1.6, x));
    const sx = lim(sz * scale(s.eyeWidth[i], 0.3)), sy = lim(sz * scale(s.eyeHeight[i], 0.45));
    // Positive tilt raises the outer corner: the first eye's outer corner is on the -u side.
    const th = ((i === 0 ? 1 : -1) * s.eyeTilt[i] / 100) * (12 * Math.PI) / 180, co = Math.cos(th), si = Math.sin(th);
    // inverse of R(th) * diag(sx, sy) = diag(1/sx, 1/sy) * R(-th)
    const inv: [number, number, number, number] = [co / sx, si / sx, -si / sy, co / sy];
    const t = along(((i === 0 ? -1 : 1) * 0.08 * D * s.eyeDistance) / 100, 0);
    if (sx !== 1 || sy !== 1 || th !== 0 || t[0] !== 0 || t[1] !== 0) out.push({ c: eyeC[i], inv, t, ru: ew * 1.15, rv: ew * 0.95 });
  });

  const n = f.nose, alaC = mid(n.alae[0], n.alae[1]), noseLen = Math.max(dist(n.base, n.bridge), D * 0.3), alaW = Math.max(dist(n.alae[0], n.alae[1]), D * 0.2);
  if (s.noseHeight || s.noseWidth) {
    out.push({ c: alaC, inv: diag(scale(s.noseWidth, 0.3), 1), t: along(0, (-0.12 * noseLen * s.noseHeight) / 100), ru: Math.max(alaW * 1.1, noseLen * 0.5), rv: noseLen * 0.6 });
  }

  const m = f.mouth, mw = Math.max(dist(m.corners[0], m.corners[1]), D * 0.3), mc = mid(m.corners[0], m.corners[1]), mh = Math.max(dist(m.top, m.bottom), mw * 0.2);
  if (s.mouthWidth || s.mouthHeight) out.push({ c: mc, inv: diag(scale(s.mouthWidth, 0.3), scale(s.mouthHeight, 0.35)), t: [0, 0], ru: mw * 0.9, rv: Math.max(mw * 0.6, mh * 2) });
  if (s.smile) {
    m.corners.forEach((c, i) => out.push({ c, inv: diag(1, 1), t: along(((i === 0 ? -0.03 : 0.03) * mw * s.smile) / 100, (-0.1 * mw * s.smile) / 100), ru: mw * 0.4, rv: mw * 0.4 }));
  }
  const upperH = Math.max(dist(m.top, m.innerTop), mw * 0.08), lowerH = Math.max(dist(m.bottom, m.innerBottom), mw * 0.08);
  if (s.upperLip) out.push({ c: m.innerTop, inv: diag(1, scale(s.upperLip, 0.6)), t: [0, 0], ru: mw * 0.6, rv: upperH * 3, side: { at: 0, sign: -1, band: upperH * 0.2 } });
  if (s.lowerLip) out.push({ c: m.innerBottom, inv: diag(1, scale(s.lowerLip, 0.6)), t: [0, 0], ru: mw * 0.6, rv: lowerH * 3, side: { at: 0, sign: 1, band: lowerH * 0.2 } });

  const ou = f.oval.map(lu), ov = f.oval.map(lv);
  const faceW = Math.max(Math.max(...ou) - Math.min(...ou), D * 1.5), faceH = Math.max(Math.max(...ov) - Math.min(...ov), D * 2);
  const brow = mid(f.brows[0], f.brows[1]), foreH = Math.max(dist(f.forehead, brow), D * 0.4), chinH = Math.max(dist(f.chin, m.bottom), D * 0.3);
  if (s.forehead) out.push({ c: brow, inv: diag(1, scale(s.forehead, 0.25)), t: [0, 0], ru: faceW * 0.55, rv: foreH * 2, side: { at: 0, sign: -1, band: foreH * 0.1 } });
  if (s.chinHeight) out.push({ c: m.bottom, inv: diag(1, scale(s.chinHeight, 0.3)), t: [0, 0], ru: faceW * 0.4, rv: chinH * 2, side: { at: 0, sign: 1, band: chinH * 0.1 } });
  const jawH = Math.max(dist(f.chin, n.base), D * 0.5);
  if (s.jawline) out.push({ c: n.base, inv: diag(scale(s.jawline, 0.15), 1), t: [0, 0], ru: faceW * 0.75, rv: jawH * 1.6, side: { at: jawH * 0.25, sign: 1, band: jawH * 0.35 } });
  if (s.faceWidth) out.push({ c: centroid(f.oval), inv: diag(scale(s.faceWidth, 0.12), 1), t: [0, 0], ru: faceW * 0.8, rv: faceH * 0.65 });
  return out;
}

type Framed = Term & { u: Pt; v: Pt; box: [number, number, number, number]; alpha: number };

// Largest singular value of a 2 x 2 matrix.
function norm2([a, b, c, d]: [number, number, number, number]) {
  const s = a * a + b * b + c * c + d * d, det = a * d - b * c;
  return Math.sqrt((s + Math.sqrt(Math.max(0, s * s - 4 * det * det))) / 2);
}

// The share of a term that keeps its displacement's Jacobian below 0.9 in norm: then the term's map keeps its
// orientation everywhere, and so does the composition of terms. d = w * (L (p - c) - inv t) with L = inv - I.
function strength(t: Term) {
  const [i00, i01, i10, i11] = t.inv, L: [number, number, number, number] = [i00 - 1, i01, i10, i11 - 1];
  const nl = norm2(L), lo = Math.min(t.ru, t.rv), rho = Math.max(t.ru, t.rv) / lo;
  const shift = Math.hypot(i00 * t.t[0] + i01 * t.t[1], i10 * t.t[0] + i11 * t.t[1]);
  let peak = 0, slope = 0;
  for (let k = 0; k <= 64; k++) {
    const r = k / 64, x = (r - CORE) / (1 - CORE), dw = r <= CORE ? 0 : (6 * x * (1 - x)) / (1 - CORE);
    peak = Math.max(peak, falloff(r) + dw * r * rho);
    slope = Math.max(slope, dw);
  }
  let bound = nl * peak + (shift * slope) / lo;
  // The one-sided ramp's slope times the largest displacement inside the ramp.
  if (t.side) bound += (1.5 / (2 * t.side.band)) * (Math.hypot(L[0], L[2]) * t.ru + Math.hypot(L[1], L[3]) * (Math.abs(t.side.at) + t.side.band) + shift);
  return Math.min(1, 0.9 / Math.max(bound, 1e-9));
}

// Moves source position p by one term; the weight is taken at p.
function step(t: Framed, p: Pt) {
  const { u, v } = t, rx = p[0] - t.c[0], ry = p[1] - t.c[1];
  const pu = rx * u[0] + ry * u[1], pv = rx * v[0] + ry * v[1];
  const r = Math.hypot(pu / t.ru, pv / t.rv);
  if (r >= 1) return;
  let w = falloff(r) * t.alpha;
  if (t.side) w *= smooth01((t.side.sign * (pv - t.side.at) + t.side.band) / (2 * t.side.band));
  if (w === 0) return;
  const sx = rx - t.t[0], sy = ry - t.t[1], su = sx * u[0] + sy * u[1], sv = sx * v[0] + sy * v[1];
  const [i00, i01, i10, i11] = t.inv, nu = i00 * su + i01 * sv, nv = i10 * su + i11 * sv;
  p[0] += w * (t.c[0] + nu * u[0] + nv * v[0] - p[0]);
  p[1] += w * (t.c[1] + nu * u[1] + nv * v[1] - p[1]);
}

// The Face-Aware field for a mesh of cols x rows nodes `spacing` px apart ((dx, dy) per node, row by row); null when
// every slider of every face is 0. Terms are composed, not summed, so overlapping features cannot fold the mesh.
export function faceField(faces: Face[], settings: FaceSettings[], cols: number, rows: number, spacing: number): Float32Array | null {
  const all: Framed[] = [];
  faces.forEach((f, i) => {
    const s = settings[i];
    if (!s || isZero(s)) return;
    const a = f.eyes.map(e => mid(e.outer, e.inner));
    const len = dist(a[0], a[1]) || 1, u: Pt = [(a[1][0] - a[0][0]) / len, (a[1][1] - a[0][1]) / len], v: Pt = [-u[1], u[0]];
    for (const t of terms(f, s, u, v)) {
      const ex = Math.hypot(t.ru * u[0], t.rv * v[0]), ey = Math.hypot(t.ru * u[1], t.rv * v[1]);
      all.push({ ...t, u, v, box: [t.c[0] - ex, t.c[1] - ey, t.c[0] + ex, t.c[1] + ey], alpha: strength(t) });
    }
  });
  if (!all.length) return null;
  const field = new Float32Array(cols * rows * 2);
  const b = all.reduce((m, t) => [Math.min(m[0], t.box[0]), Math.min(m[1], t.box[1]), Math.max(m[2], t.box[2]), Math.max(m[3], t.box[3])], [Infinity, Infinity, -Infinity, -Infinity]);
  const c0 = Math.max(0, Math.floor(b[0] / spacing)), c1 = Math.min(cols - 1, Math.ceil(b[2] / spacing));
  const r0 = Math.max(0, Math.floor(b[1] / spacing)), r1 = Math.min(rows - 1, Math.ceil(b[3] / spacing));
  const p: Pt = [0, 0];
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const qx = col * spacing, qy = row * spacing;
      p[0] = qx;
      p[1] = qy;
      for (const t of all) if (p[0] > t.box[0] && p[0] < t.box[2] && p[1] > t.box[1] && p[1] < t.box[3]) step(t, p);
      const k = (row * cols + col) * 2;
      field[k] = p[0] - qx;
      field[k + 1] = p[1] - qy;
    }
  }
  return field;
}
