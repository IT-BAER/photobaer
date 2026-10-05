import { TOOLS } from './tools.ts';
import { selectMode } from './selecttools.ts';

// Canvas cursors in the Photoshop style, drawn on a 24 unit grid at 24 CSS px. `fill` shapes are solid and
// `line` shapes stroked, both with an outline in the opposite color; `under` and `mark` are drawn as is,
// below and above. Ink is black on a white outline unless `white`. `hot` is the hotspot, `css` the fallback.
interface Art { fill?: string; line?: string; under?: string; mark?: string; white?: boolean; hot: [number, number]; css: string; badgeAt?: [number, number] }

const ARROW = 'M3 2v16l4-3.5 2.5 6 2.5-1-2.5-6H15z';
const SMALL_ARROW = `<path transform="translate(1.6 .4) scale(.8)" d="${ARROW}"/>`;
const CROSS = 'M12 4v5M12 15v5M4 12h5M15 12h5';
const MOVE_CROSS = (x: number, y: number) => `<path transform="translate(${x - 18.5} ${y - 18})" d="M18.5 13l2.2 2.4h-1.5v2.4h2.4v-1.5l2.4 2.2-2.4 2.2v-1.5h-2.4v2.4h1.5l-2.2 2.4-2.2-2.4h1.5v-2.4h-2.4v1.5l-2.4-2.2 2.4-2.2v1.5h2.4v-2.4h-1.5z"/>`;
const SPARKLE = 'M5 1v8M1 5h8M2.5 2.5l5 5M7.5 2.5l-5 5';
const LASSO = '<ellipse cx="13" cy="8.5" rx="8" ry="5.5"/><path d="M7 13q-3 3-1.5 5.5T4 22"/>';
const PEN = '<path d="M2 2l10 3 5 5-7 7-5-5z"/><path d="M15.5 12.5 22 19l-3 3-6.5-6.5z"/>';
const PEN_MARK = '<path d="M2.5 2.5 8 8" stroke="#fff" stroke-width="1"/><circle cx="9" cy="9" r="1.3" fill="#fff"/>';
const CROP = '<rect x="5" y="1" width="2" height="18"/><rect x="5" y="17" width="18" height="2"/><rect x="1" y="5" width="18" height="2"/><rect x="17" y="5" width="2" height="18"/>';
const DROPPER = '<g transform="translate(-10 0) rotate(45 12 22) translate(12 22) scale(1.15) translate(-12 -22)"><path d="M12 22l-1-2v-7h2v7z"/><rect x="9" y="11" width="6" height="2"/><rect x="10" y="3" width="4" height="8" rx="2"/></g>';
const IBEAM = '<path d="M9 4q3 0 3 2v12q0 2-3 2M15 4q-3 0-3 2v12q0 2 3 2M10.5 15h3"/>';
const IBEAM_BOX = '<rect x="4.5" y="7.5" width="15" height="9" fill="none" stroke="#000" stroke-width=".8" stroke-dasharray="1 1.5"/>';
const HAND_PALM = 'M6.2 11h11v3.5q0 6.5-5.5 6.5h-1q-2.7 0-4.2-2.4l-3.4-5.2a1.4 1.4 0 0 1 2.2-1.7L6.2 13.6z';
const fingers = (ys: number[], h: number[]) => [6.2, 9, 11.8, 14.6].map((x, i) => `<rect x="${x}" y="${ys[i]}" width="2.6" height="${h[i]}" rx="1.3"/>`).join('');
const glass = (sign: string) => ({
  under: '<path d="M14.5 14.5l6 6" stroke="#fff" stroke-width="5" stroke-linecap="round"/><path d="M14.5 14.5l6 6" stroke="#000" stroke-width="3" stroke-linecap="round"/>',
  fill: '<circle cx="10" cy="10" r="6.5"/>', white: true, mark: sign && `<path d="${sign}" stroke="#000" stroke-width="1.4"/>`, hot: [10, 10] as [number, number],
});

const ART = {
  arrow: { fill: `<path d="${ARROW}"/>`, hot: [3, 2], css: 'default' },
  whiteArrow: { fill: `<path d="${ARROW}"/>`, white: true, hot: [3, 2], css: 'default' },
  precise: { line: `<path d="${CROSS}"/>`, hot: [12, 12], css: 'crosshair' },
  target: { line: `<circle cx="12" cy="12" r="6"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>`, hot: [12, 12], css: 'crosshair' },
  lasso: { line: LASSO, hot: [4, 22], css: 'crosshair', badgeAt: [19, 19] },
  polygonalLasso: { line: '<path d="M7 13.5 4 8l7-5 10 3-3 7z"/><path d="M7 13.5 5 18l-1 4"/>', hot: [4, 22], css: 'crosshair', badgeAt: [19, 19] },
  magneticLasso: { line: `${LASSO}<path d="M10.5 6v2.5a2.5 2.5 0 0 0 5 0V6"/>`, hot: [4, 22], css: 'crosshair', badgeAt: [19, 19] },
  magicWand: { fill: '<path d="M9 7l13 13-2 2L7 9z"/>', line: `<path d="${SPARKLE}"/>`, hot: [5, 5], css: 'crosshair', badgeAt: [5, 19] },
  magicEraser: { fill: '<path d="M8 14l6-6 7 7-6 6z"/>', line: `<path d="${SPARKLE}"/>`, hot: [5, 5], css: 'crosshair' },
  eyedropper: { fill: DROPPER, hot: [2, 22], css: 'crosshair' },
  colorSampler: { fill: DROPPER, line: '<circle cx="19" cy="19" r="2.6"/><path d="M19 15v8M15 19h8"/>', hot: [2, 22], css: 'crosshair' },
  bucket: {
    fill: '<path d="M4 10l6-6 9 9-6 6z"/><path d="M4 11q-2.5 4-1.5 7.5t2 0q1-3.5-.5-7.5z"/>', line: '<path d="M7 7q-2-4 2-5t3 4"/>',
    mark: '<path d="M5.5 10 10 5.5" stroke="#fff" stroke-width="1"/>', hot: [3, 19], css: 'crosshair',
  },
  crop: { fill: CROP, hot: [6, 6], css: 'crosshair' },
  slice: { fill: '<path d="M2 22 14 9.5l3.5 3.5L9 20.5z"/><path d="M15 8.5 19.5 4 22 6.5 17.5 11z"/>', hot: [2, 22], css: 'crosshair' },
  sliceSelect: { fill: `${SMALL_ARROW}<path transform="translate(11 11) scale(.55)" d="M2 22 14 9.5l3.5 3.5L9 20.5zM15 8.5 19.5 4 22 6.5 17.5 11z"/>`, hot: [4, 2], css: 'default' },
  ruler: {
    fill: '<rect transform="rotate(-45 5 21)" x="5" y="16" width="23" height="5"/>',
    mark: '<path transform="rotate(-45 5 21)" d="M9 16v2.5M13 16v1.5M17 16v2.5M21 16v1.5M25 16v2.5" stroke="#fff" stroke-width=".9"/>', hot: [5, 21], css: 'crosshair',
  },
  note: { fill: '<path d="M3 3h15l3 3v15H3z"/>', mark: '<path d="M6 9h11M6 12.5h11M6 16h8M18 3v3h3" fill="none" stroke="#fff" stroke-width="1"/>', hot: [3, 3], css: 'crosshair' },
  count: { fill: SMALL_ARROW, line: '<path d="M17 14.5l-1 8M20.5 14.5l-1 8M14.5 17h8M14 20h8"/>', hot: [4, 2], css: 'crosshair' },
  move: { fill: `${SMALL_ARROW}${MOVE_CROSS(18, 18)}`, hot: [4, 2], css: 'move' },
  moveCopy: { under: `<path transform="translate(8.5 7.5) scale(.65)" d="${ARROW}" fill="#fff" stroke="#000" stroke-width="2"/>`, fill: SMALL_ARROW, hot: [4, 2], css: 'copy' },
  artboard: { fill: SMALL_ARROW, line: '<path d="M15 15h7v7h-7zM15 12.5V15M12.5 15H15"/>', hot: [4, 2], css: 'crosshair' },
  pen: { fill: PEN, mark: PEN_MARK, hot: [2, 2], css: 'crosshair', badgeAt: [19, 6] },
  freeformPen: { fill: PEN, mark: PEN_MARK, line: '<path d="M1.5 21q2-4 4 0t4 0"/>', hot: [2, 2], css: 'crosshair', badgeAt: [19, 6] },
  curvaturePen: { fill: PEN, mark: PEN_MARK, line: '<path d="M1.5 22q4-7 8 0"/>', hot: [2, 2], css: 'crosshair', badgeAt: [19, 6] },
  convertPoint: { line: '<path d="M5 20 12 4l7 16"/>', hot: [12, 4], css: 'crosshair' },
  text: { line: IBEAM, mark: IBEAM_BOX, hot: [12, 15], css: 'text' },
  textVertical: { line: `<g transform="rotate(90 12 12)">${IBEAM}</g>`, mark: `<g transform="rotate(90 12 12)">${IBEAM_BOX}</g>`, hot: [9, 12], css: 'vertical-text' },
  handOpen: { fill: fingers([5, 3, 3.5, 5.5], [9, 10, 10, 8.5]) + `<path d="${HAND_PALM}"/>`, white: true, hot: [12, 12], css: 'grab' },
  handClosed: { fill: fingers([8, 8, 8, 8.5], [5, 5, 5, 4.5]) + '<path d="M6 11h11.2v3.5q0 6.5-5.5 6.5h-1q-4.7 0-4.7-5z"/>', white: true, hot: [12, 12], css: 'grabbing' },
  zoomIn: { ...glass('M7 10h6M10 7v6'), css: 'zoom-in' },
  zoomOut: { ...glass('M7 10h6'), css: 'zoom-out' },
  zoomLimit: { ...glass(''), css: 'not-allowed' },
  rotate: { line: '<path d="M18.5 9.5A7 7 0 1 0 19 14"/>', fill: '<path d="M15.5 9.5l5 1 .5-5z"/>', hot: [12, 12], css: 'crosshair' },
  redEye: { line: `<path d="${CROSS}"/><path d="M15 19q4-4 8 0q-4 4-8 0z"/>`, mark: '<circle cx="19" cy="19" r="1.1"/>', hot: [12, 12], css: 'crosshair' },
  patch: {
    fill: '<path d="M8 10l8-5 6 9-8 5z"/>', line: '<path d="M9 14 3 21"/>',
    mark: '<path d="M9.6 10.3l6.1-3.8 4.6 7.1-6.2 3.8z" fill="none" stroke="#fff" stroke-width=".8" stroke-dasharray="1.2 1"/>', hot: [3, 21], css: 'crosshair',
  },
  contentAwareMove: { fill: MOVE_CROSS(15, 9.5), line: '<path d="M10 14 3 21"/>', hot: [3, 21], css: 'move' },
} satisfies Record<string, Art>;

export type CursorName = keyof typeof ART;
export const CURSOR_NAMES = Object.keys(ART) as CursorName[];
export type Badge = 'add' | 'subtract' | 'intersect' | 'start' | 'close' | null;

const BADGES: Record<NonNullable<Badge>, (x: number, y: number) => string> = {
  add: (x, y) => `<path d="M${x} ${y - 3}v6M${x - 3} ${y}h6"/>`,
  subtract: (x, y) => `<path d="M${x - 3} ${y}h6"/>`,
  intersect: (x, y) => `<path d="M${x - 2.5} ${y - 2.5}l5 5M${x + 2.5} ${y - 2.5}l-5 5"/>`,
  start: (x, y) => `<path d="M${x - 2} ${y - 2}l4 4M${x + 2} ${y - 2}l-4 4"/>`,
  close: (x, y) => `<circle cx="${x}" cy="${y}" r="2.3"/>`,
};

function cursorSvg(a: Art, badge: Badge, px: number): string {
  const ink = a.white ? '#fff' : '#000', edge = a.white ? '#000' : '#fff';
  const [bx, by] = a.badgeAt ?? [19, 19];
  const line = (a.line ?? '') + (badge ? BADGES[badge](bx, by) : '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${a.under ?? ''}`
    + `<g fill="${edge}" stroke="${edge}" stroke-width="2">${a.fill ?? ''}</g><g fill="none" stroke="${edge}" stroke-width="3.2">${line}</g>`
    + `<g fill="${ink}">${a.fill ?? ''}</g><g fill="none" stroke="${a.white ? '#000' : ink}" stroke-width="1.3">${line}</g>${a.mark ?? ''}</svg>`;
}

const cache = new Map<string, string>();

// The CSS cursor for a named cursor at device pixel ratio `dpr`. On a scaled display the image is drawn at
// device pixels so the browser does not upscale a 1x bitmap; the hotspot stays in CSS pixels.
export function namedCursor(name: CursorName, dpr = 1, badge: Badge = null): string {
  const key = `${name}:${badge}@${dpr}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const a: Art = ART[name];
  const url = `url("data:image/svg+xml,${encodeURIComponent(cursorSvg(a, badge, Math.round(24 * dpr)))}")`;
  const css = `${dpr === 1 ? url : `image-set(${url} ${dpr}x)`} ${a.hot[0]} ${a.hot[1]}, ${a.css}`;
  cache.set(key, css);
  return css;
}

export interface CursorCtx {
  shift?: boolean; alt?: boolean; mode?: string; precise?: boolean; grabbing?: boolean; zoom?: number;
  spring?: 'hand' | 'zoom' | 'zoomOut' | 'rotate' | null;
}

const ICONS: Record<string, CursorName> = {
  lasso: 'lasso', polygonalLasso: 'polygonalLasso', magneticLasso: 'magneticLasso', magicWand: 'magicWand', magicEraser: 'magicEraser',
  eyedropper: 'eyedropper', colorSampler: 'colorSampler', bucket: 'bucket', crop: 'crop', perspectiveCrop: 'crop', slice: 'slice',
  sliceSelect: 'sliceSelect', ruler: 'ruler', note: 'note', count: 'count', move: 'move', artboard: 'artboard', pen: 'pen',
  freeformPen: 'freeformPen', curvaturePen: 'curvaturePen', addAnchor: 'pen', deleteAnchor: 'pen', convertPoint: 'convertPoint',
  pathSelection: 'arrow', directSelection: 'whiteArrow', horizontalType: 'text', horizontalTypeMask: 'text', verticalType: 'textVertical',
  verticalTypeMask: 'textVertical', hand: 'handOpen', zoom: 'zoomIn', rotate: 'rotate', redEye: 'redEye', patch: 'patch', contentAwareMove: 'contentAwareMove',
};
const TOOL_BADGE: Record<string, Badge> = { addAnchor: 'add', deleteAnchor: 'subtract' };
const SELECTING = new Set(['marqueeRect', 'marqueeEllipse', 'marqueeRow', 'marqueeColumn', 'lasso', 'polygonalLasso', 'magneticLasso', 'magicWand']);
// Tools whose cursor stays its icon under Precise, as in Photoshop.
const KEEP_ICON = new Set(['hand', 'zoom', 'rotate', 'move', 'artboard', 'horizontalType', 'horizontalTypeMask', 'verticalType', 'verticalTypeMask', 'pathSelection', 'directSelection', 'sliceSelect']);
const SAMPLES_WITH_ALT = new Set(['cloneStamp', 'healingBrush']);
const ZOOM_MAX = 64, ZOOM_MIN = 1 / 256;

const SPRING: Record<string, CursorName> = { hand: 'handOpen', zoom: 'zoomIn', zoomOut: 'zoomOut', rotate: 'rotate' };

// True when the cursor beats a tool's own hover cursor (pen states, crop handles): a held Space or
// Ctrl+Space view tool, or Precise for a tool that has an icon.
export function cursorOverrides(id: string, ctx: CursorCtx): boolean {
  return !!ctx.spring || (!!ctx.precise && !KEEP_ICON.has(id) && TOOLS[id]?.cursor !== 'none');
}

// The canvas cursor for a tool. Brush-type tools ('none') draw their outline on the overlay.
export function toolCursor(id: string, dpr = 1, ctx: CursorCtx = {}): string {
  if (ctx.spring) return namedCursor(ctx.spring === 'hand' && ctx.grabbing ? 'handClosed' : SPRING[ctx.spring], dpr);
  const tool = TOOLS[id];
  if (!tool) return 'default';
  if (tool.cursor === 'none') return ctx.alt && SAMPLES_WITH_ALT.has(id) ? namedCursor('target', dpr) : 'none';
  const sel = SELECTING.has(id) ? selectMode(ctx.mode ?? 'new', !!ctx.shift, !!ctx.alt) : 'new';
  const badge: Badge = sel === 'new' ? TOOL_BADGE[id] ?? null : sel;
  if (ctx.precise && !KEEP_ICON.has(id)) return namedCursor('precise', dpr, SELECTING.has(id) ? badge : null);
  if (id === 'zoom') {
    const out = !!ctx.alt, z = ctx.zoom ?? 1;
    return namedCursor((out ? z <= ZOOM_MIN : z >= ZOOM_MAX) ? 'zoomLimit' : out ? 'zoomOut' : 'zoomIn', dpr);
  }
  if (id === 'hand' && ctx.grabbing) return namedCursor('handClosed', dpr);
  if (id === 'move' && ctx.alt) return namedCursor('moveCopy', dpr);
  return namedCursor(ICONS[id] ?? 'precise', dpr, badge);
}
