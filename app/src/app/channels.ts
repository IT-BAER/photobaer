// Channels panel view state: which color channels and saved channels are visible; `ink` is one
// CMYK or Lab channel shown alone.
export interface ChannelView {
  rgb: [boolean, boolean, boolean];
  alpha: number[];
  ink?: number | null;
  // The saved channel edits paint (picked in the panel); eye toggles keep it.
  alphaTarget?: number;
  // The layer whose mask shows like a saved channel.
  mask?: number;
}

// Color channels of the modes whose channels are not R, G and B. Multichannel's are the
// inverted RGB channels, so they show like R, G and B; CMYK and Lab are computed.
export const MODE_CHANNELS = { cmyk: ['Cyan', 'Magenta', 'Yellow', 'Black'], lab: ['Lightness', 'a', 'b'], multichannel: ['Cyan', 'Magenta', 'Yellow'] } as const;

const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const labF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);

// Channel `ch` (0..1) of sRGB 0..1 from a table (n^3 x `w` channels, red slowest), trilinear.
function separate(sep: Float32Array, ch: number, c: [number, number, number], w: number): number {
  const n = Math.round(Math.cbrt(sep.length / w)), [i, f] = [[0, 0, 0], [0, 0, 0]];
  c.forEach((v, k) => { const x = v * (n - 1); i[k] = Math.min(n - 2, Math.floor(x)); f[k] = x - i[k]; });
  let v = 0;
  for (let k = 0; k < 8; k++) {
    const d = [k >> 2, (k >> 1) & 1, k & 1];
    v += sep[(((i[0] + d[0]) * n + i[1] + d[1]) * n + i[2] + d[2]) * w + ch] * d.reduce((p, o, j) => p * (o ? f[j] : 1 - f[j]), 1);
  }
  return v;
}

// The gray (0..255) one CMYK or Lab channel shows for sRGB 0..255 through the document's table
// `sep` (CMYK separation, or ICC 8-bit Lab D50); without one CMYK with full black generation and
// no profile, Lab from sRGB under D65 with a and b offset by 128.
export function inkGray(mode: 'cmyk' | 'lab', ch: number, r: number, g: number, b: number, sep?: Float32Array | null): number {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  let v: number;
  if (mode === 'cmyk' && sep?.length) {
    v = 1 - separate(sep, ch, [R, G, B], 4);
  } else if (mode === 'cmyk') {
    const max = Math.max(R, G, B);
    v = ch === 3 ? max : max > 0 ? [R, G, B][ch] / max : 1;
  } else if (sep?.length) {
    v = separate(sep, ch, [R, G, B], 3);
  } else {
    const [lr, lg, lb] = [lin(R), lin(G), lin(B)];
    const fx = labF((0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047);
    const fy = labF(0.2126 * lr + 0.7152 * lg + 0.0722 * lb);
    const fz = labF((0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883);
    v = [(116 * fy - 16) / 100, (500 * (fx - fy) + 128) / 255, (200 * (fy - fz) + 128) / 255][ch];
  }
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

// One CMYK or Lab channel of a straight RGBA thumbnail as gray RGBA.
export function inkThumb(rgba: Uint8Array, mode: 'cmyk' | 'lab', ch: number, sep?: Float32Array | null): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = out[i + 1] = out[i + 2] = inkGray(mode, ch, rgba[i], rgba[i + 1], rgba[i + 2], sep);
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

// What edits change: the color channels of a partial R/G/B view, and the picked saved channel.
export function editChannels(v: ChannelView): { rgb: [boolean, boolean, boolean]; alpha: number | null } {
  const partial = v.ink == null && v.rgb.some(Boolean) && !v.rgb.every(Boolean);
  return { rgb: partial ? v.rgb : [true, true, true], alpha: v.alphaTarget ?? null };
}

export const COMPOSITE: ChannelView = { rgb: [true, true, true], alpha: [] };

// A Grayscale document's view: every color channel shows the luminosity.
export const GRAY_MATRIX = '0.3 0.59 0.11 0 0 0.3 0.59 0.11 0 0 0.3 0.59 0.11 0 0 0 0 0 1 0';

// The feColorMatrix values for the visible color channels: one channel shows as gray,
// several keep their color with the hidden ones zeroed; null when no filter is needed.
export function channelMatrix(rgb: [boolean, boolean, boolean]): string | null {
  const on = rgb.filter(Boolean).length;
  if (on === 3 || on === 0) return null;
  const rows: number[][] = [0, 1, 2].map(r => {
    const row = [0, 0, 0, 0, 0];
    if (on === 1) row[rgb.indexOf(true)] = 1;
    else if (rgb[r]) row[r] = 1;
    return row;
  });
  return [...rows, [0, 0, 0, 1, 0]].flat().join(' ');
}

// One color channel of an RGBA thumbnail as gray RGBA.
export function channelThumb(rgba: Uint8Array, c: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = out[i + 1] = out[i + 2] = rgba[i + c];
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

// What the view draws: a color matrix for the canvas, and the shown layer mask or else the first
// visible saved channel, opaque gray when no color channel is visible, else a red tint over unselected areas.
export function viewState(v: ChannelView): { matrix: string | null; alpha: { id: number; mode: 'gray' | 'tint'; layer?: boolean } | null; ink: number | null } {
  const color = v.rgb.some(Boolean), mode = color ? 'tint' as const : 'gray' as const;
  return {
    matrix: color ? channelMatrix(v.rgb) : null,
    alpha: v.mask != null ? { id: v.mask, mode, layer: true } : v.alpha.length ? { id: v.alpha[0], mode } : null,
    ink: v.ink ?? null,
  };
}
