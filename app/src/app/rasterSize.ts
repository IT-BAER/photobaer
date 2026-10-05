// Rasterize dialogs (SVG, PDF): pixel size from a base size in points (72 per inch) or CSS px, resolution and scale.
export interface RasterSize { ppi: number; sx: number; sy: number; constrain: boolean }

export const rasterSize = (ppi: number): RasterSize => ({ ppi, sx: ppi / 72, sy: ppi / 72, constrain: true });
export const pixels = (s: RasterSize, [w, h]: [number, number]): [number, number] => [Math.max(1, Math.round(w * s.sx)), Math.max(1, Math.round(h * s.sy))];
// A new resolution keeps the print size: the pixel size scales with it.
export const setPpi = (s: RasterSize, ppi: number): RasterSize => ({ ...s, ppi, sx: s.sx * ppi / s.ppi, sy: s.sy * ppi / s.ppi });
export function setWidth(s: RasterSize, [w]: [number, number], px: number): RasterSize {
  const sx = Math.max(1, px) / w;
  return { ...s, sx, sy: s.constrain ? sx : s.sy };
}
export function setHeight(s: RasterSize, [, h]: [number, number], px: number): RasterSize {
  const sy = Math.max(1, px) / h;
  return { ...s, sy, sx: s.constrain ? sy : s.sx };
}

const UNITS: Record<string, number> = { '': 1, px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 };

// The root <svg> tag: its offset, length and attribute text (comments and prologue skipped).
function rootTag(text: string) {
  const blank = text.replace(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>/gi, m => ' '.repeat(m.length));
  const m = /<svg\b([^>]*)>/.exec(blank);
  if (!m) return null;
  return { at: m.index, len: m[0].length, attrs: text.slice(m.index + 4, m.index + m[0].length - 1) };
}
const attr = (attrs: string, name: string) => new RegExp(`(\\s${name}\\s*=\\s*)(["'])(.*?)\\2`).exec(attrs);
function length(v: string | undefined) {
  const m = v && /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|pt|pc|in|cm|mm)?\s*$/i.exec(v);
  return m ? +m[1] * UNITS[(m[2] ?? '').toLowerCase()] : null;
}

// The SVG's own size in CSS px: width and height, a missing one from the viewBox aspect, else 300 x 150.
export function svgSize(text: string): [number, number] {
  const t = rootTag(text);
  if (!t) return [300, 150];
  const w = length(attr(t.attrs, 'width')?.[3]), h = length(attr(t.attrs, 'height')?.[3]);
  const vb = attr(t.attrs, 'viewBox')?.[3].trim().split(/[\s,]+/).map(Number);
  const box = vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? [vb[2], vb[3]] : null;
  if (w && h) return [w, h];
  if (box) return w ? [w, w * box[1] / box[0]] : h ? [h * box[0] / box[1], h] : [box[0], box[1]];
  return [w ?? 300, h ?? 150];
}

// The SVG drawn at `w` x `h` px: the root gets that size and, without one, a viewBox of its own size.
export function svgAtSize(text: string, w: number, h: number): string {
  const t = rootTag(text);
  if (!t) return text;
  const [ow, oh] = svgSize(text);
  let a = t.attrs;
  const close = a.endsWith('/') ? '/' : '';
  if (close) a = a.slice(0, -1);
  for (const [name, v] of [['width', w], ['height', h]] as const) {
    a = attr(a, name) ? a.replace(new RegExp(`(\\s${name}\\s*=\\s*)(["'])(.*?)\\2`), `$1"${v}"`) : `${a} ${name}="${v}"`;
  }
  if (!attr(a, 'viewBox')) a += ` viewBox="0 0 ${ow} ${oh}"`;
  return `${text.slice(0, t.at)}<svg${a}${close}>${text.slice(t.at + t.len)}`;
}
