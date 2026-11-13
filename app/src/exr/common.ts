// Helpers shared by the OpenEXR decoders.

export function halfToFloat(h: number) {
  const e = h >> 10 & 31, m = h & 1023, s = h >> 15 ? -1 : 1;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

// The nearest half (ties to even) of `f` as its bits; overflow gives infinity.
export function floatToHalf(f: number): number {
  if (Number.isNaN(f)) return 0x7e00;
  const sign = f < 0 || Object.is(f, -0) ? 0x8000 : 0;
  const a = Math.abs(f);
  if (a >= 65520) return sign | 0x7c00;
  if (a < 2 ** -24 / 2) return sign;
  let e = Math.floor(Math.log2(a));
  if (2 ** e > a) e--;
  if (e < -14) {
    // Subnormal: units of 2^-24.
    const m = a / 2 ** -24, r = Math.round(m);
    return sign | (Math.abs(m - Math.trunc(m) - 0.5) < 1e-12 && r % 2 ? r - 1 : r);
  }
  const m = (a / 2 ** e - 1) * 1024;
  let r = Math.round(m);
  if (m - Math.floor(m) === 0.5 && r % 2) r--;
  if (r === 1024) { r = 0; e++; }
  return e > 15 ? sign | 0x7c00 : sign | ((e + 15) << 10) | r;
}

// ZIP and RLE store bytes split into even/odd halves, then as differences.
export function unpredict(t: Uint8Array): Uint8Array {
  for (let i = 1; i < t.length; i++) t[i] = (t[i - 1] + t[i] - 128) & 255;
  const out = new Uint8Array(t.length), half = (t.length + 1) >> 1;
  for (let i = 0; i < t.length; i++) out[i] = i & 1 ? t[half + (i >> 1)] : t[i >> 1];
  return out;
}
