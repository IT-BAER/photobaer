import { hsbToRgb, intensityOf, labToRgb, type Rgb } from '../shell/color.ts';

export type Method = 'perceptual' | 'linear' | 'classic';
export interface ColorStop { position: number; color: Rgb; midpoint: number }
export interface OpacityStop { position: number; opacity: number; midpoint: number }
export interface NoiseParams {
  seed: number; roughness: number; colorModel: 'rgb' | 'hsb' | 'lab';
  minimum: [number, number, number]; maximum: [number, number, number];
  restrictColors: boolean; addTransparency: boolean; samples: number;
}
// Colors are 8-bit sRGB; a noise gradient's stops are regenerated from `noise` (see resolveStops).
export interface Gradient {
  stops: ColorStop[]; opacityStops: OpacityStop[]; kind: 'solid' | 'noise'; interpolation: Method; noise?: NoiseParams;
}

export const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const midpoint = (m: number) => (Number.isFinite(m) ? Math.min(0.999, Math.max(0.001, m)) : 0.5);

export const defaultNoise = (): NoiseParams => ({
  seed: 1, roughness: 0.5, colorModel: 'rgb', minimum: [0, 0, 0], maximum: [1, 1, 1], restrictColors: false, addTransparency: false, samples: 32,
});

// Clamps and sorts both rails; 0 color stops -> black at 0 and 1, 1 stop -> duplicated at 1; same for opacity (default 1).
export function normalize(g: Gradient): Gradient {
  const stops = g.stops.map(s => ({ position: clamp01(s.position), color: s.color, midpoint: midpoint(s.midpoint) })).sort((a, b) => a.position - b.position);
  const opacityStops = g.opacityStops.map(s => ({ position: clamp01(s.position), opacity: clamp01(s.opacity), midpoint: midpoint(s.midpoint) })).sort((a, b) => a.position - b.position);
  if (!stops.length) stops.push({ position: 0, color: [0, 0, 0], midpoint: 0.5 });
  if (stops.length === 1) stops.push({ position: 1, color: stops[0].color, midpoint: 0.5 });
  if (!opacityStops.length) opacityStops.push({ position: 0, opacity: 1, midpoint: 0.5 }, { position: 1, opacity: 1, midpoint: 0.5 });
  else if (opacityStops.length === 1) opacityStops.push({ position: 1, opacity: opacityStops[0].opacity, midpoint: 0.5 });
  return { ...g, stops, opacityStops };
}

// p -> 1 - p, order reversed; the new stop i takes 1 - (old midpoint of stop i - 1), default .5.
export function reverse(g: Gradient): Gradient {
  const flip = <T extends { position: number; midpoint: number }>(r: T[]) =>
    r.map((s, i) => ({ ...s, position: 1 - s.position, midpoint: 1 - (r[i - 1]?.midpoint ?? 0.5) })).reverse();
  return { ...g, stops: flip(g.stops), opacityStops: flip(g.opacityStops) };
}

// Mulberry32-style generator returning [0, 1).
export function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

// N samples of 4 draws, round((1 - roughness) * 6) passes of [1 2 1]/4 per channel, then min/max and the color model.
export function noiseStops(p: NoiseParams): Pick<Gradient, 'stops' | 'opacityStops'> {
  const next = prng(p.seed);
  const n = Math.max(2, Math.min(256, Math.round(p.samples)));
  const v = Array.from({ length: n }, () => [next(), next(), next(), next()]);
  const passes = Math.round((1 - clamp01(p.roughness)) * 6);
  for (let pass = 0; pass < passes; pass++) {
    for (let k = 0; k < 4; k++) {
      const a = v.map(r => r[k]);
      for (let i = 0; i < n; i++) v[i][k] = (a[Math.max(0, i - 1)] + a[i] * 2 + a[Math.min(n - 1, i + 1)]) / 4;
    }
  }
  const stops: ColorStop[] = [], opacityStops: OpacityStop[] = [];
  for (let i = 0; i < n; i++) {
    const c = [0, 1, 2].map(k => p.minimum[k] + (p.maximum[k] - p.minimum[k]) * v[i][k]);
    const position = i / (n - 1);
    stops.push({ position, color: noiseColor(c, p), midpoint: 0.5 });
    opacityStops.push({ position, opacity: p.addTransparency ? clamp01(v[i][3]) : 1, midpoint: 0.5 });
  }
  return { stops, opacityStops };
}

function noiseColor(c: number[], p: NoiseParams): Rgb {
  if (p.colorModel === 'hsb') return hsbToRgb([c[0] * 360, clamp01(c[1]) * 100, clamp01(c[2]) * 100]);
  if (p.colorModel === 'lab') return labToRgb([c[0] * 100, c[1] * 255 - 128, c[2] * 255 - 128]);
  const k = p.restrictColors ? 0.9 : 1;
  return [0, 1, 2].map(i => Math.round(clamp01(c[i]) * k * 255)) as Rgb;
}

// The stops actually painted: a noise gradient regenerates them (classic) from its parameters.
export function resolveStops(g: Gradient): Gradient {
  if (g.kind !== 'noise') return normalize(g);
  return normalize({ ...g, ...noiseStops(g.noise ?? defaultNoise()), interpolation: 'classic' });
}

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const enc = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function toOklab([r, g, b]: number[]): number[] {
  const [lr, lg, lb] = [r, g, b].map(lin);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function fromOklab([L, a, b]: number[]): number[] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(c => clamp01(enc(clamp01(c))));
}

function mix(a: Rgb, b: Rgb, u: number, method: Method): Rgb {
  const fa = a.map(c => c / 255), fb = b.map(c => c / 255);
  let out: number[];
  if (method === 'classic') out = fa.map((c, i) => c + (fb[i] - c) * u);
  else if (method === 'linear') out = fa.map((c, i) => enc(lin(c) + (lin(fb[i]) - lin(c)) * u));
  else { const la = toOklab(fa), lb = toOklab(fb); out = fromOklab(la.map((c, i) => c + (lb[i] - c) * u)); }
  return out.map(c => clamp01(c) * 255) as Rgb;
}

// Segment of t on a sorted rail with the midpoint-remapped local u; held constant outside the end stops.
function segment<T extends { position: number; midpoint: number }>(r: T[], t: number): [T, T, number] {
  if (t <= r[0].position) return [r[0], r[0], 0];
  const last = r[r.length - 1];
  if (t >= last.position) return [last, last, 0];
  let i = 0;
  while (r[i + 1].position <= t) i++;
  const a = r[i], b = r[i + 1];
  const u = (t - a.position) / (b.position - a.position);
  return [a, b, a.midpoint === 0.5 ? u : u ** (Math.log(0.5) / Math.log(a.midpoint))];
}

// [r, g, b] 0..255 (unrounded) and alpha 0..1 at t for a normalized gradient.
export function evaluate(g: Gradient, t: number, method: Method = g.interpolation): [number, number, number, number] {
  const [a, b, u] = segment(g.stops, t);
  const [oa, ob, ou] = segment(g.opacityStops, t);
  const c = mix(a.color, b.color, u, method);
  return [c[0], c[1], c[2], oa.opacity + (ob.opacity - oa.opacity) * ou];
}

// CSS for a ramp preview: 33 samples of the resolved gradient.
export function rampCss(g: Gradient, method?: Method): string {
  const r = resolveStops(g);
  const parts = Array.from({ length: 33 }, (_, i) => {
    const [cr, cg, cb, ca] = evaluate(r, i / 32, method);
    return `rgba(${Math.round(cr)}, ${Math.round(cg)}, ${Math.round(cb)}, ${Math.round(ca * 1000) / 1000}) ${(i / 32) * 100}%`;
  });
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

// Middle of the widest gap between 0, the stop positions and 1.
export function largestGapMid(positions: number[]): number {
  const p = [0, ...positions.map(clamp01).sort((a, b) => a - b), 1];
  let lo = 0, hi = 0;
  for (let i = 0; i + 1 < p.length; i++) if (p[i + 1] - p[i] > hi - lo) { lo = p[i]; hi = p[i + 1]; }
  return (lo + hi) / 2;
}

// Engine `gradient` op stop shapes; a stop color from the 32-bit Color Picker carries its Intensity.
export function engineStops(g: Gradient) {
  const r = resolveStops(g);
  return {
    stops: r.stops.map(s => {
      const intensity = intensityOf(s.color);
      return { position: s.position, rgb: s.color.map(c => Math.round(c)) as Rgb, midpoint: s.midpoint, ...(intensity ? { intensity } : {}) };
    }),
    opacityStops: r.opacityStops.map(s => ({ position: s.position, opacity: s.opacity, midpoint: s.midpoint })),
  };
}
