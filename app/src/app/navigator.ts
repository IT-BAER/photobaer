// Window > Navigator: thumbnail geometry, the view rectangle and the zoom slider scale.
import { screenToDoc, type View } from '../view.ts';

export const ZOOM_MIN = 1 / 256;
export const ZOOM_MAX = 64;
export const SLIDER_MAX = 1000;

// Thumbnail pixel size for a W x H canvas, longest side `size` (never upscaled); matches layerThumbs.
export function thumbSize(W: number, H: number, size: number): [number, number] {
  const f = Math.min(1, size / Math.max(W, H));
  return [Math.max(1, Math.floor(W * f)), Math.max(1, Math.floor(H * f))];
}

export function docToThumb(x: number, y: number, W: number, H: number, w: number, h: number): [number, number] {
  return [x * w / W, y * h / H];
}

export function thumbToDoc(x: number, y: number, W: number, H: number, w: number, h: number): [number, number] {
  return [x * W / w, y * H / h];
}

// The viewport (vw x vh CSS px) as a quad in thumbnail pixels: top-left, top-right, bottom-right, bottom-left.
export function viewQuad(v: View, vw: number, vh: number, W: number, H: number, w: number, h: number): [number, number][] {
  return [[0, 0], [vw, 0], [vw, vh], [0, vh]].map(([sx, sy]) => {
    const [dx, dy] = screenToDoc(v, sx, sy, vw, vh);
    return docToThumb(dx, dy, W, H, w, h);
  });
}

export const zoomToSlider = (z: number) => Math.round(Math.log(z / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN) * SLIDER_MAX);
export const sliderToZoom = (s: number) => ZOOM_MIN * (ZOOM_MAX / ZOOM_MIN) ** (s / SLIDER_MAX);
export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

// Averages a premultiplied RGBA8 image (sw x sh) down to w x h and returns straight alpha.
export function boxScale(src: Uint8Array, sw: number, sh: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sh / h), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sw / w), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) {
        const o = (j * sw + i) * 4;
        r += src[o]; g += src[o + 1]; b += src[o + 2]; a += src[o + 3]; n++;
      }
      const o = (y * w + x) * 4;
      if (a) { out[o] = Math.min(255, Math.round(r * 255 / a)); out[o + 1] = Math.min(255, Math.round(g * 255 / a)); out[o + 2] = Math.min(255, Math.round(b * 255 / a)); out[o + 3] = Math.round(a / n); }
    }
  }
  return out;
}
