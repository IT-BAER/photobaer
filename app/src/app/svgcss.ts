// Copy SVG / Copy CSS of one layer (docs/M4.md section 7, D15). A plain shape layer becomes one
// <path>; the worker falls back to an embedded PNG for everything `shapeSvg` refuses.
import { defaultBlending } from '../layerStyle.ts';
import type { FillContent, LayerNode, VectorPath } from '../worker/types.ts';

type Rect = [number, number, number, number];

// Key-sorted JSON, so records compare by value whatever order the engine wrote their keys in.
const canon = (v: unknown) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
const rgb = (c: FillContent | null | undefined) => (c?.type === 'solid' ? `rgb(${c.color.join(', ')})` : null);

// Every segment as a cubic from the previous anchor's out handle to this anchor's in handle.
export function pathData(p: VectorPath): string {
  return p.subpaths.map(s => {
    const n = s.points.length;
    if (!n) return '';
    const d = [`M ${s.points[0][0]} ${s.points[0][1]}`];
    for (let r = 1; r < n + (s.closed ? 1 : 0); r++) {
      const [, , , , ox, oy] = s.points[r - 1], [x, y, ix, iy] = s.points[r % n];
      d.push(`C ${ox} ${oy} ${ix} ${iy} ${x} ${y}`);
    }
    if (s.closed) d.push('Z');
    return d.join(' ');
  }).join(' ');
}

/** The layer as one SVG path over `b` ([x, y, w, h]), or null when a path cannot keep its look: masks,
 * styles, clipping, non-default blending, non-combine subpaths, non-solid paint, a non-center stroke. */
export function shapeSvg(n: LayerNode, b: Rect): string | null {
  const s = n.shape;
  if (n.kind !== 'shape' || !s) return null;
  if (n.mask || n.vector_mask || n.style || n.clipping || n.blend !== 'normal' || canon(n.blending) !== canon(defaultBlending())) return null;
  if (s.path.subpaths.some(p => p.op !== 'combine')) return null;
  const fill = s.fill ? rgb(s.fill) : 'none';
  if (!fill) return null;
  let stroke = '';
  const st = s.stroke;
  if (st?.enabled) {
    const color = rgb(st.content);
    if (!color || st.align !== 'center') return null;
    stroke = ` stroke="${color}" stroke-width="${st.width}" stroke-linecap="${st.cap}" stroke-linejoin="${st.join}" stroke-miterlimit="${st.miter_limit}" stroke-dashoffset="${st.dash_offset}"`;
    if (st.dash.length) stroke += ` stroke-dasharray="${st.dash.join(' ')}"`;
  }
  const [x, y, w, h] = b;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}">`
    + `<path d="${pathData(s.path)}" fill="${fill}" fill-rule="${s.path.fill_rule}" opacity="${n.opacity * n.fill}"${stroke}/></svg>`;
}

/** An SVG holding a w x h PNG (base64), the fallback for layers `shapeSvg` refuses. */
export function pngSvg(w: number, h: number, base64: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" href="data:image/png;base64,${base64}"/></svg>`;
}

/** Copy CSS: one absolutely placed rule at the layer bounds with the layer's SVG as its background. */
export function layerCss(svg: string, [x, y, w, h]: Rect): string {
  return `.photobaer-layer {\n  position: absolute;\n  left: ${x}px;\n  top: ${y}px;\n  width: ${w}px;\n  height: ${h}px;\n`
    + `  background: url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27')}") center / 100% 100% no-repeat;\n}`;
}
