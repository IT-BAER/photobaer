import { TOOLS } from './tools.ts';
import { selectMode } from './selecttools.ts';
import { TOOL_ART } from './toolArt.ts';

// Canvas cursors in the Photoshop CC style: black ink with a 1 px white outline (white ink with a black outline
// for `white`) on a 32 px grid. `fill` is solid, `line` stroked at `w` (default 1); `solid` gives closed line
// shapes a white body; `mark` is drawn last as is. `hot` is the hotspot, `css` the keyword fallback.
interface Art { fill?: string; line?: string; mark?: string; w?: number; white?: boolean; solid?: boolean; hot: [number, number]; css: string; badgeAt?: [number, number] }
type Named = Partial<Art> & { icon?: string; hot: [number, number]; css: string };

const ARROW = 'M1 1v15l3.6-3.5 2.6 5.8 2.3-1-2.5-5.6H11.5z';
// The small arrow Photoshop puts beside the Paint Bucket and Crop icons.
const SMALL_ARROW = '<path d="M1 1v9.5l2.4-2.3 1.7 3.8 1.5-.7-1.7-3.7h3.4z"/>';
const CROSS = 'M9.5 2v5M9.5 12v5M2 9.5h5M12 9.5h5';
const LENS = '<path d="M13.3 13.3l5 5" stroke="#fff" stroke-width="5" stroke-linecap="round"/><path d="M13.3 13.3l5 5" stroke="#000" stroke-width="2.6" stroke-linecap="round"/>';
const PEN_NIB = 'M1.5 1.5C5.5 3 9.6 5.6 11 9.6l1.3 4.4-4.3 2.8-4-2.5C2.4 11 1.5 7.2 1.5 1.5z';
const PEN_MARK = '<path d="M1.5 1.5 6.6 8.6" stroke="#000" stroke-width="1"/><circle cx="7.2" cy="9.4" r="1.2"/><path d="M7.4 15.8l5.4-3.6 1.8 2.6-5.4 3.6z" stroke="#fff" stroke-width="1"/>';
const HAND_OPEN = 'M7 12V5.2a1.25 1.25 0 0 1 2.5 0V11h.5V3.7a1.25 1.25 0 0 1 2.5 0V11h.5V4.7a1.25 1.25 0 0 1 2.5 0V11.5h.5V7.2a1.25 1.25 0 0 1 2.5 0V15c0 4-2.6 6.5-6.2 6.5h-1c-2.4 0-3.8-1-5-3.2L2.6 13.6a1.3 1.3 0 0 1 2.1-1.5z';
const HAND_CLOSED = 'M5.5 11.5c0-1 .6-1.6 1.4-1.6s1.4.6 1.4 1.6V10c0-1 .6-1.6 1.4-1.6s1.4.6 1.4 1.6v-.5c0-1 .6-1.6 1.4-1.6s1.4.6 1.4 1.6v.5c0-1 .6-1.6 1.4-1.6s1.4.6 1.4 1.6v5.5c0 3.6-2.4 5.5-5.6 5.5h-.9c-2.9 0-4.6-1.8-4.6-5.2z';
const MOVE_CROSS = 'M10 1.5l3 3.3h-2.1v4.3h4.3V7l3.3 3-3.3 3v-2.1h-4.3v4.3H13l-3 3.3-3-3.3h2.1v-4.3H4.8V13l-3.3-3 3.3-3v2.1h4.3V4.8H7z';
const hand = (d: string, t = 'translate(1.5 1.5) scale(.82)') => `<path transform="${t}" d="${d}"/>`;
// Badge glyphs drawn over the main shape: `ink` a black line with a white edge, `blot` a black shape with one.
const ink = (d: string, w = 1) => `<path d="${d}" fill="none" stroke="#fff" stroke-width="${w + 2}"/><path d="${d}" fill="none" stroke="#000" stroke-width="${w}"/>`;
const blot = (d: string, w = 2) => `<path d="${d}" fill="#000" stroke="#fff" stroke-width="${w}" paint-order="stroke"/>`;
// Patch chip with its sampling arrow: right for Destination, left for Source.
const patchArt = (dir: 1 | -1): Named => ({
  fill: SMALL_ARROW, hot: [1, 1], css: 'default',
  mark: '<rect x="8.5" y="8.5" width="7" height="7" fill="#fff"/>'
    + ink('M8.5 8.5h7v7h-7zM10.5 6v2.5M13.5 6v2.5M10.5 15.5V18M13.5 15.5V18M6 10.5h2.5M6 13.5h2.5M15.5 10.5H18M15.5 13.5H18')
    + (dir > 0 ? ink('M18.5 12h3.5') + blot('M24.5 12l-3-2.6v5.2z', 1.5) : ink('M20 12h4') + blot('M17.5 12l3-2.6v5.2z', 1.5)),
});
const PEN = { fill: `<path d="${PEN_NIB}"/>`, white: true, mark: PEN_MARK, hot: [1, 1], css: 'crosshair', badgeAt: [19.5, 21] } satisfies Named;
const glass = (sign: string, css: string): Named => ({
  fill: '<circle cx="8.5" cy="8.5" r="6"/>', white: true, hot: [8, 8], css,
  mark: LENS + (sign && `<path d="${sign}" stroke="#000" stroke-width="2"/>`),
});
const ICON_SCALE = 0.8;

const ART = {
  arrow: { fill: `<path d="${ARROW}"/>`, hot: [1, 1], css: 'default' },
  whiteArrow: { fill: `<path d="${ARROW}"/>`, white: true, hot: [1, 1], css: 'default' },
  moveCopy: { fill: `<path d="${ARROW}"/>`, mark: `<path transform="translate(5.5 2.5) scale(.8)" d="${ARROW}" fill="#fff" stroke="#000" stroke-width="1.2"/>`, hot: [1, 1], css: 'copy' },
  moveCross: { fill: `<path d="${MOVE_CROSS}"/>`, hot: [10, 10], css: 'move' },
  // Move tool: the arrow with a diamond badge holding a four-way cross.
  move: {
    fill: `<path d="${ARROW}"/>`, hot: [1, 1], css: 'default',
    mark: blot('M18 9l7.5 7.5-7.5 7.5-7.5-7.5z') + '<path d="M18 12.5v8M14 16.5h8" stroke="#fff" stroke-width="1.2"/><path d="M18 11.3l1.6 2h-3.2zM18 21.7l1.6-2h-3.2zM12.8 16.5l2-1.6v3.2zM23.2 16.5l-2-1.6v3.2z" fill="#fff"/>',
  },
  sliceSelect: {
    fill: `<path d="${ARROW}"/>`, hot: [1, 1], css: 'default',
    mark: ink('M10.5 21.5l5.6-5.6 1.4 1.4-5.6 5.6z').replace(/fill="none"/g, 'fill="#fff"') + blot('M16.1 15.9l6-6c.6 1.8-.1 4.4-2 6.3l-2.6 1.1z', 1.5),
  },
  // Slice: crosshair of hollow bars around a small ring.
  slice: {
    mark: '<path d="M.5 7.5h9v5h-9zM10.5 7.5h9v5h-9zM7.5 .5h5v9h-5zM7.5 10.5h5v9h-5z" fill="none" stroke="#fff"/>'
      + '<path d="M1.5 8.5h7v3h-7zM11.5 8.5h7v3h-7zM8.5 1.5h3v7h-3zM8.5 11.5h3v7h-3z" fill="none" stroke="#000"/><circle cx="10" cy="10" r="1" fill="#000" stroke="#fff"/>',
    hot: [10, 10], css: 'crosshair',
  },
  patch: patchArt(-1),
  patchDest: patchArt(1),
  contentAwareMove: {
    fill: SMALL_ARROW, hot: [1, 1], css: 'default',
    mark: ink('M9 11.5c3 0 4 2.5 6 5.5s3 4 6 4M21 11.5c-3 0-4 2.5-6 5.5s-3 4-6 4', 1.6) + blot('M24 21l-3.2-2.4v4.8zM6 21l3.2-2.4v4.8z', 1.5),
  },
  artboard: { line: '<path d="M6 1.5v3M6 7.5v3M1.5 6h3M7.5 6h3"/><path d="M7.5 7.5h7v7h-7z"/><path d="M18.5 15.5v6M15.5 18.5h6"/>', hot: [6, 6], css: 'crosshair' },
  precise: { line: `<path d="${CROSS}"/>`, mark: '<rect x="9" y="9" width="1" height="1"/>', hot: [9, 9], css: 'crosshair' },
  target: { line: `<circle cx="9.5" cy="9.5" r="5.5"/><path d="${CROSS}"/>`, mark: '<rect x="9" y="9" width="1" height="1"/>', hot: [9, 9], css: 'crosshair' },
  eyedropper: { icon: 'eyedropper', solid: true, hot: [2, 17], css: 'crosshair' },
  handOpen: { fill: hand(HAND_OPEN), white: true, hot: [11, 11], css: 'grab' },
  handClosed: { fill: hand(HAND_CLOSED, 'translate(-4 -6) scale(1.2)'), white: true, hot: [11, 11], css: 'grabbing' },
  zoomIn: glass('M5.5 8.5h6M8.5 5.5v6', 'zoom-in'),
  zoomOut: glass('M5.5 8.5h6', 'zoom-out'),
  zoomLimit: glass('', 'not-allowed'),
  magicWand: {
    fill: '<path d="M7.6 8.8l1.6-1.6 10 10-1.6 1.6z"/>', line: '<path d="M4.5 1.5v6M1.5 4.5h6M10.5 1v4M8.5 3h4M1 10.5h4"/>',
    hot: [8, 8], css: 'crosshair', badgeAt: [8.5, 21],
  },
  pen: PEN,
  // Pen nib with the tool's glyph upper right: dotted stroke, magnet, curve.
  freeformPen: { ...PEN, mark: PEN_MARK + ink('M15.5 9.5c1.5-2.5 2.5.5 4-1.5s2.5-3.5 4.5-2.5').replace(/stroke="#000"/, 'stroke="#000" stroke-dasharray="1.5 1.5"') },
  freeformMagnetic: { ...PEN, mark: PEN_MARK + ink('M16.5 12V7.5a3.5 3.5 0 0 1 7 0V12', 2.2) },
  curvaturePen: { ...PEN, mark: PEN_MARK + ink('M15.5 11c0-4 3-6.5 7.5-6.5') + '<circle cx="15.5" cy="11" r="1.3" stroke="#fff"/><circle cx="23" cy="4.5" r="1.3" stroke="#fff"/>' },
  bucket: {
    fill: SMALL_ARROW, line: '<path d="M16.5 7.5l7 7-6.3 6.3-7-7zM13.5 10.5V6.2a2.3 2.3 0 0 1 4.6 0v4.3"/>', solid: true,
    mark: '<path d="M25 15.5c1.1 1.7 1.9 2.8 1.9 3.9a1.9 1.9 0 0 1-3.8 0c0-1.1.8-2.2 1.9-3.9z" stroke="#fff" stroke-width="1"/>', hot: [1, 1], css: 'crosshair',
  },
  crop: { fill: SMALL_ARROW, line: '<path d="M6.5 11.5H19V24M11.5 6.5V19H24"/>', w: 2, hot: [1, 1], css: 'crosshair' },
  ruler: { line: '<path d="M2.5 16.5h14M2.5 16.5l10-10M13.5 7c1.8 1 2.8 2.6 3 4.5"/>', fill: '<path d="M14.5 11.5h4.2l-2.1 2.6z"/>', hot: [2, 16], css: 'crosshair' },
  redEye: {
    line: '<path d="M5.5 1v9M1 5.5h9"/><path d="M9 16c3.4-4.6 10.6-4.6 14 0-3.4 4.6-10.6 4.6-14 0z"/>', solid: true,
    mark: '<circle cx="16" cy="16" r="2.6"/>', hot: [5, 5], css: 'crosshair',
  },
  text: { line: '<path d="M1.5 1.5h6M4.5 1.5v15M1.5 16.5h6M2.5 12.5h4"/>', hot: [4, 12], css: 'text' },
  textVertical: { line: '<path d="M1.5 1.5v6M1.5 4.5h15M16.5 1.5v6M12.5 2.5v4"/>', hot: [12, 4], css: 'vertical-text' },
  // Rotate View: an open hand over a tilted square, a curved arrow above.
  rotate: {
    fill: '<rect x="10" y="11" width="8.5" height="8.5" transform="rotate(-20 14 15)"/>', white: true, hot: [8, 15], css: 'crosshair',
    mark: `<path transform="translate(1 9) scale(.6)" d="${HAND_OPEN}" fill="#fff" stroke="#000" stroke-width="1.7"/>` + ink('M4 8.5c3-4.5 9-5 13-1.5', 1.4) + blot('M19.8 9.6l-.6-4.6-3.7 2.9z', 1.5),
  },
} satisfies Record<string, Named>;

// Tools whose standard cursor is their toolbar icon, with Photoshop's hotspot in 24 unit icon coordinates.
const ICON_HOT: Record<string, [number, number]> = {
  lasso: [6.5, 22], polygonalLasso: [6.5, 22], magneticLasso: [6.5, 22],
  note: [4, 3], count: [3.5, 3.5], colorSampler: [3, 21],
  convertPoint: [7, 3], magicEraser: [5, 4.5],
  brush: [5, 20.5], pencil: [3.5, 20.5], colorReplacement: [5, 20.5], mixerBrush: [5, 20.5], eraser: [6, 20.5],
  backgroundEraser: [6, 20.5], cloneStamp: [12, 21], patternStamp: [14, 21], historyBrush: [5, 20.5], artHistoryBrush: [5, 20.5],
  spotHealing: [12.5, 13], healingBrush: [12.5, 13], blur: [12, 14], sharpen: [12, 12], smudge: [6, 20], dodge: [14.5, 9.5],
  burn: [9, 10], sponge: [12, 12], quickSelection: [8.5, 12],
};

export type CursorName = keyof typeof ART;
export const CURSOR_NAMES = Object.keys(ART) as CursorName[];
export type Badge = 'add' | 'subtract' | 'intersect' | 'start' | 'close' | 'convert' | null;

const BADGES: Record<NonNullable<Badge>, (x: number, y: number) => string> = {
  add: (x, y) => `<path d="M${x} ${y - 3.5}v7M${x - 3.5} ${y}h7"/>`,
  subtract: (x, y) => `<path d="M${x - 3.5} ${y}h7"/>`,
  start: (x, y) => `<path d="M${x} ${y - 3.5}v7M${x - 3} ${y - 1.7}l6 3.4M${x + 3} ${y - 1.7}l-6 3.4"/>`,
  intersect: (x, y) => BADGES.start(x, y),
  close: (x, y) => `<circle cx="${x}" cy="${y}" r="2.5"/>`,
  convert: (x, y) => `<path d="M${x - 3} ${y + 3}l6-6"/>`,
};

// A tool icon from shell/toolArt.ts as cursor art, scaled into the 32 px grid.
function iconArt(id: string): Art {
  const a = TOOL_ART[id], k = ICON_SCALE, g = (s: string) => `<g transform="scale(${k})">${s}</g>`;
  const [hx, hy] = ICON_HOT[id] ?? [12, 12];
  return {
    fill: g((a.f ?? '') + (a.d ?? '')), line: a.s ? g(a.s.replace(/stroke-width="[\d.]+"/g, '')) : undefined, w: 1.5 * k,
    hot: [Math.round(hx * k), Math.round(hy * k)], css: 'crosshair',
  };
}

function cursorSvg(a: Art, badge: Badge, px: number): string {
  const ink = a.white ? '#fff' : '#000', edge = a.white ? '#000' : '#fff', w = a.w ?? 1;
  const [bx, by] = a.badgeAt ?? [20, 19];
  const line = a.line ?? '', b = badge ? BADGES[badge](bx, by) : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 32 32" stroke-linecap="round" stroke-linejoin="round">`
    + `<g fill="${edge}" stroke="${edge}" stroke-width="2">${a.fill ?? ''}</g>`
    + `<g fill="${a.solid ? edge : 'none'}" stroke="${edge}" stroke-width="${w + 2}">${line}</g><g fill="none" stroke="#fff" stroke-width="3">${b}</g>`
    + `<g fill="${ink}">${a.fill ?? ''}</g><g fill="none" stroke="${a.white ? '#000' : ink}" stroke-width="${w}">${line}</g>`
    + `<g fill="none" stroke="#000" stroke-width="1">${b}</g>${a.mark ?? ''}</svg>`;
}

const cache = new Map<string, string>();

function toCss(key: string, a: Art, dpr: number, badge: Badge): string {
  const hit = cache.get(key);
  if (hit) return hit;
  const url = `url("data:image/svg+xml,${encodeURIComponent(cursorSvg(a, badge, Math.round(32 * dpr)))}")`;
  const out = `${dpr === 1 ? url : `image-set(${url} ${dpr}x)`} ${a.hot[0]} ${a.hot[1]}, ${a.css}`;
  cache.set(key, out);
  return out;
}

// The CSS cursor for a named cursor at device pixel ratio `dpr`. On a scaled display the image is drawn at
// device pixels so the browser does not upscale a 1x bitmap; the hotspot stays in CSS pixels.
export function namedCursor(name: CursorName, dpr = 1, badge: Badge = null): string {
  const n: Named = ART[name];
  const a: Art = n.icon ? { ...iconArt(n.icon), ...n } : n as Art;
  return toCss(`${name}:${badge}@${dpr}`, a, dpr, badge);
}

// A tool's icon as its cursor: Photoshop's Standard cursor for tools without a cursor of their own.
export function iconCursor(id: string, dpr = 1, badge: Badge = null): string {
  return toCss(`icon:${id}:${badge}@${dpr}`, iconArt(id), dpr, badge);
}

export interface CursorCtx {
  shift?: boolean; alt?: boolean; mode?: string; precise?: boolean; grabbing?: boolean; zoom?: number; magnetic?: boolean;
  spring?: 'hand' | 'zoom' | 'zoomOut' | 'rotate' | null;
  // Painting Cursors = Standard: brush tools show their icon instead of the overlay outline.
  paintIcon?: boolean;
}

const NAMED: Record<string, CursorName> = {
  eyedropper: 'eyedropper', bucket: 'bucket', crop: 'crop', perspectiveCrop: 'crop', ruler: 'ruler', move: 'move', pen: 'pen',
  addAnchor: 'pen', deleteAnchor: 'pen', pathSelection: 'arrow', directSelection: 'whiteArrow', horizontalType: 'text',
  horizontalTypeMask: 'text', verticalType: 'textVertical', verticalTypeMask: 'textVertical', hand: 'handOpen', zoom: 'zoomIn',
  rotate: 'rotate', redEye: 'redEye', magicWand: 'magicWand', slice: 'slice', sliceSelect: 'sliceSelect', contentAwareMove: 'contentAwareMove',
  artboard: 'artboard', freeformPen: 'freeformPen', curvaturePen: 'curvaturePen',
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
  if (tool.cursor === 'none') {
    if (ctx.alt && SAMPLES_WITH_ALT.has(id)) return namedCursor('target', dpr);
    return ctx.paintIcon ? iconCursor(id, dpr) : 'none';
  }
  const sel = SELECTING.has(id) ? selectMode(ctx.mode ?? 'new', !!ctx.shift, !!ctx.alt) : 'new';
  const badge: Badge = sel === 'new' ? TOOL_BADGE[id] ?? null : sel;
  if (ctx.precise && !KEEP_ICON.has(id)) return namedCursor('precise', dpr, SELECTING.has(id) ? badge : null);
  if (id === 'zoom') {
    const out = !!ctx.alt, z = ctx.zoom ?? 1;
    return namedCursor((out ? z <= ZOOM_MIN : z >= ZOOM_MAX) ? 'zoomLimit' : out ? 'zoomOut' : 'zoomIn', dpr);
  }
  if (id === 'hand' && ctx.grabbing) return namedCursor('handClosed', dpr);
  if (id === 'move' && ctx.alt) return namedCursor('moveCopy', dpr);
  if (id === 'directSelection' && ctx.grabbing) return namedCursor('arrow', dpr);
  if (id === 'patch') return namedCursor(ctx.mode === 'destination' ? 'patchDest' : 'patch', dpr);
  if (id === 'freeformPen' && ctx.magnetic) return namedCursor('freeformMagnetic', dpr);
  if (NAMED[id]) return namedCursor(NAMED[id], dpr, badge);
  if (ICON_HOT[id]) return iconCursor(id, dpr, badge);
  return namedCursor('precise', dpr, badge);
}
