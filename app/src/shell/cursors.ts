import { TOOLS } from './tools.ts';

// Hand-drawn canvas cursors in the system style: black shapes and lines with a white outline. Every tool symbol
// is fitted into the same box below a small arrow whose tip is the hotspot. `fill` shapes are solid, `line`
// shapes are stroked, `mark` is drawn last as is; `box` is the symbol's extent in its own 24 unit drawing.
interface CursorArt { fill?: string; line?: string; mark?: string; box: [number, number, number, number] }

const ARROW = '<path d="M3 2v16l4-3.5 2.5 6 2.5-1-2.5-6H15z"/>';
const CROP = '<rect x="5" y="1" width="2" height="18"/><rect x="5" y="17" width="18" height="2"/><rect x="1" y="5" width="18" height="2"/><rect x="17" y="5" width="2" height="18"/>';
const SPARKLE = '<path d="M5 1v8M1 5h8M2.5 2.5l5 5M7.5 2.5l-5 5"/>';

const ART: Record<string, CursorArt> = {
  lasso: { line: '<ellipse cx="13" cy="8.5" rx="8" ry="5.5"/><path d="M7 13q-3 3-1.5 5.5T4 22"/>', box: [4, 3, 21, 22] },
  polygonalLasso: { line: '<path d="M7 13.5 4 8l7-5 10 3-3 7z"/><path d="M7 13.5 5 18l-1 4"/>', box: [4, 3, 21, 22] },
  magicWand: { fill: '<path d="M9 7l13 13-2 2L7 9z"/>', line: SPARKLE, box: [1, 1, 22, 22] },
  magicEraser: { fill: '<path d="M8 14l6-6 7 7-6 6z"/>', line: SPARKLE, box: [1, 1, 21, 21] },
  eyedropper: {
    fill: '<g transform="translate(-9 -1) rotate(45 12 23)"><path d="M12 23l-1-2v-7h2v7z"/><rect x="9" y="12" width="6" height="2"/><rect x="10" y="4" width="4" height="8" rx="2"/></g>',
    box: [0.9, 6.4, 18.6, 24.1],
  },
  bucket: {
    fill: '<path d="M4 10l6-6 9 9-6 6z"/><path d="M4 11q-2.5 4-1.5 7.5t2 0q1-3.5-.5-7.5z"/>',
    line: '<path d="M7 7q-2-4 2-5t3 4"/>', mark: '<path d="M5.5 10 10 5.5" stroke="#fff" stroke-width="1"/>', box: [2.2, 1.8, 19, 20.2],
  },
  crop: { fill: CROP, box: [1, 1, 23, 23] },
  perspectiveCrop: { fill: CROP, box: [1, 1, 23, 23] },
  slice: { fill: '<path d="M2 22 14 9.5l3.5 3.5L9 20.5z"/><path d="M15 8.5 19.5 4 22 6.5 17.5 11z"/>', box: [2, 4, 22, 22] },
  pen: {
    fill: '<path d="M2 2l10 3 5 5-7 7-5-5z"/><path d="M15.5 12.5 22 19l-3 3-6.5-6.5z"/>',
    mark: '<path d="M2.5 2.5 8 8" stroke="#fff" stroke-width="1"/><circle cx="9" cy="9" r="1.3" fill="#fff"/>', box: [2, 2, 22, 22],
  },
};
// Path Selection and Direct Selection are the arrow itself, black or white.
const ARROWS: Record<string, boolean> = { pathSelection: false, directSelection: true };
const HOT = 2, SYMBOL_AT = 9, SYMBOL_SIZE = 13;

const cache = new Map<string, string>();

// Outline and ink passes of one drawing scaled by `s`; stroke widths stay constant on screen.
function passes(fill: string, line: string, s: number, ink: string, edge: string): string {
  return `<g fill="${edge}" stroke="${edge}" stroke-width="${2 / s}">${fill}</g><g fill="none" stroke="${edge}" stroke-width="${3.2 / s}">${line}</g>`
    + `<g fill="${ink}">${fill}</g><g fill="none" stroke="${ink}" stroke-width="${1.3 / s}">${line}</g>`;
}

// The arrow at scale `s` with its tip on the hotspot.
const arrow = (s: number, white: boolean) =>
  `<g transform="translate(${HOT} ${HOT}) scale(${s}) translate(-3 -2)">${passes(ARROW, '', s, white ? '#fff' : '#000', white ? '#000' : '#fff')}</g>`;

function cursorSvg(id: string, px: number): string | null {
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">`;
  if (id in ARROWS) return `${head}${arrow(0.85, ARROWS[id])}</svg>`;
  const a = ART[id];
  if (!a) return null;
  const [x0, y0, x1, y1] = a.box, s = SYMBOL_SIZE / Math.max(x1 - x0, y1 - y0);
  const dx = SYMBOL_AT + (SYMBOL_SIZE - (x1 - x0) * s) / 2 - x0 * s, dy = SYMBOL_AT + (SYMBOL_SIZE - (y1 - y0) * s) / 2 - y0 * s;
  const symbol = `<g transform="translate(${dx} ${dy}) scale(${s})">${passes(a.fill ?? '', a.line ?? '', s, '#000', '#fff')}${a.mark ?? ''}</g>`;
  return `${head}${symbol}${arrow(0.5, false)}</svg>`;
}

// The CSS cursor for a tool over the canvas at device pixel ratio `dpr`. Brush-type tools ('none') draw their
// own outline on the overlay while it shows; the crosshair is what remains when it does not. On a scaled display
// the cursor is drawn at device pixels, so the browser does not upscale a 1x bitmap; the hotspot stays in CSS pixels.
export function toolCursor(id: string, dpr = 1): string {
  const key = `${id}@${dpr}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const css = TOOLS[id]?.cursor ?? 'default';
  const fallback = css === 'none' ? 'crosshair' : css;
  const svg = cursorSvg(id, Math.round(24 * dpr));
  let cursor = fallback;
  if (svg) {
    const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    cursor = `${dpr === 1 ? url : `image-set(${url} ${dpr}x)`} ${HOT} ${HOT}, ${fallback}`;
  }
  cache.set(key, cursor);
  return cursor;
}
