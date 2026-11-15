// Segmentation model input and output: an RGBA8 image as a planar 1 x 3 x h x w tensor, and the model's
// per-pixel subject probability as a 0..255 mask.

// The model's normalization (its preprocessor config: mean 128, std 256 per channel); alpha is ignored.
export function toInput(rgba: Uint8Array, w: number, h: number): Float32Array {
  if (rgba.length !== w * h * 4) throw new Error(`the image is not ${w} x ${h} RGBA`);
  const plane = w * h, out = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    out[i] = (rgba[i * 4] - 128) / 256;
    out[plane + i] = (rgba[i * 4 + 1] - 128) / 256;
    out[2 * plane + i] = (rgba[i * 4 + 2] - 128) / 256;
  }
  return out;
}

// Probabilities stretched to 0..255 between their minimum and maximum; empty when no pixel reaches 0.5,
// so an image without a subject selects nothing instead of stretched noise. NaN counts as 0.
export function toMask(p: ArrayLike<number>): Uint8Array {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < p.length; i++) {
    const v = p[i] || 0;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const out = new Uint8Array(p.length);
  if (!(hi >= 0.5)) return out;
  const span = hi - lo;
  if (span < 1e-6) return out.fill(255);
  for (let i = 0; i < p.length; i++) out[i] = Math.round(((p[i] || 0) - lo) / span * 255);
  return out;
}
