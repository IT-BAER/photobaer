// sRGB 8-bit <-> HSB <-> CIE Lab (D65) conversions, hex parse/format, web-safe snap.
export type Rgb = [number, number, number];
export type Hsb = [number, number, number]; // h 0-360, s/b 0-100
export type Lab = [number, number, number]; // L 0-100, a/b roughly -128..127

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 100) / 100;

export function rgbToHsb([r, g, b]: Rgb): Hsb {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return [round(h), round(s * 100), round(max * 100)];
}

export function hsbToRgb([h, s, b]: Hsb): Rgb {
  const hn = ((h % 360) + 360) % 360, sn = clamp(s, 0, 100) / 100, bn = clamp(b, 0, 100) / 100;
  const c = bn * sn, x = c * (1 - Math.abs(((hn / 60) % 2) - 1)), m = bn - c;
  let [r, g, bl] = [0, 0, 0];
  if (hn < 60) [r, g, bl] = [c, x, 0];
  else if (hn < 120) [r, g, bl] = [x, c, 0];
  else if (hn < 180) [r, g, bl] = [0, c, x];
  else if (hn < 240) [r, g, bl] = [0, x, c];
  else if (hn < 300) [r, g, bl] = [x, 0, c];
  else [r, g, bl] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((bl + m) * 255)];
}

function srgbToLinear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return clamp(Math.round(v * 255), 0, 255);
}

const WHITE = [0.95047, 1.0, 1.08883] as const;
const EPS = 216 / 24389, KAPPA = 24389 / 27;

export function rgbToLab([r, g, b]: Rgb): Lab {
  const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b);
  const x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750;
  const z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041;
  const f = (t: number) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
  const fx = f(x / WHITE[0]), fy = f(y / WHITE[1]), fz = f(z / WHITE[2]);
  return [round(116 * fy - 16), round(500 * (fx - fy)), round(200 * (fy - fz))];
}

export function labToRgb([l, a, b]: Lab): Rgb {
  const fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (f: number) => (f ** 3 > EPS ? f ** 3 : (116 * f - 16) / KAPPA);
  const yr = l > KAPPA * EPS ? ((l + 16) / 116) ** 3 : l / KAPPA;
  const xr = inv(fx), zr = inv(fz);
  const x = xr * WHITE[0], y = yr * WHITE[1], z = zr * WHITE[2];
  const rl = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const gl = x * -0.9692660 + y * 1.8760108 + z * 0.0415560;
  const bl = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;
  return [linearToSrgb(rl), linearToSrgb(gl), linearToSrgb(bl)];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const h = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function isWebSafe([r, g, b]: Rgb): boolean {
  return [r, g, b].every(c => c % 51 === 0);
}

export function snapWebSafe([r, g, b]: Rgb): Rgb {
  const snap = (c: number) => clamp(Math.round(c / 51) * 51, 0, 255);
  return [snap(r), snap(g), snap(b)];
}

// The 32-bit Color Picker's Intensity (stops) of a color array the picker made; any other color has 0,
// so a swatch or eyedropper color drops it and Swap carries it along with the array.
const intensities = new WeakMap<Rgb, number>();
export const intensityOf = (c: Rgb): number => intensities.get(c) ?? 0;
export function withIntensity(c: Rgb, stops: number): Rgb {
  const out: Rgb = [c[0], c[1], c[2]];
  if (stops) intensities.set(out, stops);
  return out;
}
