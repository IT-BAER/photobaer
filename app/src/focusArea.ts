// Focus Area dialog helpers: the preview of the in-focus area per view, and the Add and Remove brush edits
// (working-size bytes: 255 adds, 0 removes, other values keep the computed mask).

export type FocusView = 'overlay' | 'black' | 'white' | 'bw';

// RGBA preview of the opaque working image `img` with the in-focus `mask` (0..255) and the brush `edits`; Overlay
// tints what is out of focus half red, Black & White shows the mask alone. Without `preview`, the image alone.
export function focusView(img: Uint8Array, mask: Uint8Array, edits: Uint8Array | null, view: FocusView, preview: boolean): Uint8ClampedArray<ArrayBuffer> {
  const n = mask.length, out = new Uint8ClampedArray(n * 4);
  if (!preview) { out.set(img.subarray(0, n * 4)); return out; }
  for (let i = 0; i < n; i++) {
    const e = edits ? edits[i] : 128;
    const m = e === 255 ? 1 : e === 0 ? 0 : mask[i] / 255;
    for (let c = 0; c < 3; c++) {
      const v = img[i * 4 + c];
      out[i * 4 + c] = view === 'bw' ? 255 * m : view === 'black' ? v * m : view === 'white' ? v * m + 255 * (1 - m)
        : v * m + (v * 0.5 + (c === 0 ? 127.5 : 0)) * (1 - m);
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}

// Paints `value` into `edits` (w x h) with a disc of radius `r` (working pixels) along the segment from `from` (null:
// a single dab) to `to`, spaced so a fast stroke leaves no gaps.
export function strokeEdit(edits: Uint8Array, w: number, h: number, from: [number, number] | null, to: [number, number], r: number, value: number) {
  const [ax, ay] = from ?? to, [bx, by] = to;
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(0.5, r / 2)));
  for (let s = 0; s <= steps; s++) {
    const x = ax + (bx - ax) * s / steps, y = ay + (by - ay) * s / steps;
    const x1 = Math.min(w - 1, Math.ceil(x + r)), y1 = Math.min(h - 1, Math.ceil(y + r));
    for (let py = Math.max(0, Math.floor(y - r)); py <= y1; py++) {
      for (let px = Math.max(0, Math.floor(x - r)); px <= x1; px++) {
        if (Math.hypot(px + 0.5 - x, py + 0.5 - y) <= r) edits[py * w + px] = value;
      }
    }
  }
}
