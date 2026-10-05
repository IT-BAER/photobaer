// Tool drawings in the Photoshop toolbar style on a 24 unit grid, shared by the toolbar icons and the canvas
// cursors (Photoshop's standard cursor is the tool's icon). `f` is filled, `s` stroked (1.5), `d` filled dim.
export interface ToolArt { f?: string; s?: string; d?: string }

const p = (d: string) => `<path d="${d}"/>`;
const ev = (d: string) => `<path fill-rule="evenodd" d="${d}"/>`;
const c = (x: number, y: number, r: number) => `<circle cx="${x}" cy="${y}" r="${r}"/>`;

const BRUSH_HANDLE = 'M20.6 2.6c.7.7.5 1.6-.1 2.3l-6.6 8.2-2.3-2.3 8.2-6.6c.6-.6 1.6-.8 2.3-.2z';
const BRUSH_TIP = 'M10.8 11.7l2.4 2.4c-.5 4-3.6 6.6-8.6 7 1.4-1.4 1.8-3.2 2.3-5.2.7-2.5 2-3.7 3.9-4.2z';
const BRUSH = p(BRUSH_HANDLE) + p(BRUSH_TIP);
// Fountain pen nib drawn upright from its tip, turned 45 degrees: leaf body, slit, breather hole, collar.
const NIB = 'M0 0C-1-3-4.5-5-4.5-8.5L-3-10.5H3L4.5-8.5C4.5-5 1-3 0 0zM0 0V-5.4M-3-13.5h6v1.6h-6z';
const PEN_S = `<g transform="translate(3.5 20.5) rotate(45) scale(1.25)" stroke-width="1.2">${p(NIB) + c(0, -6.6, 1.1)}</g>`;
const DROPPER_S = p('M13.4 9.2l-8.7 8.7-.7 2.3-1.3 1.3.8.8 1.3-1.3 2.3-.7 8.7-8.7');
const DROPPER_F = p('M15.3 3.6c1.7-1.7 3.8-1.9 5-.7s1 3.3-.7 5l-1.9 1.9-4.3-4.3z') + p('M11.6 6.4l6 6-1.4 1.4-6-6z');
const ERASER_F = p('M9.5 13.5l6.8-6.8c.8-.8 2-.8 2.8 0l1.7 1.7c.8.8.8 2 0 2.8L14 18z');
const ERASER_S = p('M9.5 13.5l-4.2 4.2c-.8.8-.8 2 0 2.8l.5.5h6.5l1.7-3M7 21h14.5');
const STAMP = (dx: number) => `<g transform="translate(${dx} 0)">${c(12, 6, 3.4)}${p('M10.6 9h2.8l.6 5h-4z')}${p('M4.5 14h15v4h-15z')}${p('M4.5 19.5h15V21h-15z')}</g>`;
const BANDAGE = '<rect x="9" y="2.5" width="7" height="21" rx="3.5" transform="rotate(45 12.5 13)"/>';
const BANDAGE_PAD = '<rect x="10.3" y="9.5" width="4.4" height="7" transform="rotate(45 12.5 13)"/>';
const LASSO_KNOT = c(7.2, 17.8, 1.4) + p('M6.9 19.2 6.5 22');
const ARROWHEAD = 'M3 2.5v13l3.2-3.1 2.3 5.3 2.2-1-2.3-5.2H13z';
const SPARK = (x: number, y: number, r: number) => p(`M${x} ${y - r}v${2 * r}M${x - r} ${y}h${2 * r}`);
const TYPE_T = 'M5 4h14v4h-1.5L16.5 6H13.3v12.5h2.2V20H8.5v-1.5h2.2V6H7.5l-1 2H5z';
const shapeRect = '<rect x="3.5" y="5.5" width="17" height="13"/>';

export const TOOL_ART: Record<string, ToolArt> = {
  move: { s: p('M12 4v16M4 12h16'), f: p('M12 1.5l3 3.5H9zM12 22.5l3-3.5H9zM1.5 12l3.5-3v6zM22.5 12l-3.5-3v6z') },
  artboard: { s: p('M7.5 2v4M2 7.5h4M7.5 7.5h10.5l2.5 2.5v10.5h-13z') },
  marqueeRect: { s: '<rect x="3.5" y="5.5" width="17" height="13" stroke-dasharray="3.2 2.1"/>' },
  marqueeEllipse: { s: '<ellipse cx="12" cy="12" rx="8.5" ry="7" stroke-dasharray="2.6 2"/>' },
  marqueeRow: { s: p('M3.5 14v-2.5H7M10 11.5h4M17 11.5h3.5V14') },
  marqueeColumn: { s: p('M10 3.5h2.5V7M12.5 10v4M12.5 17v3.5H10') },
  lasso: { s: '<ellipse cx="13" cy="10.5" rx="8.5" ry="6"/>' + LASSO_KNOT },
  polygonalLasso: { s: p('M2.5 5l8 4.2 9-6.2v10.2l-10.5 4.2zM2.5 5l5.6 11.6') + LASSO_KNOT },
  magneticLasso: { s: p('M2.5 5l7 4M2.5 5l5.6 11.6 5.4-2.2') + LASSO_KNOT, f: ev('M12.5 2.5h9v7a4.5 4.5 0 0 1-9 0zM15.3 5.3v4.2a1.7 1.7 0 0 0 3.4 0V5.3z') },
  quickSelection: { s: '<circle cx="8.5" cy="12" r="6.5" stroke-dasharray="1.6 2"/>', f: `<g transform="translate(2 0)">${BRUSH}</g>` },
  magicWand: { f: p('M2 19.6 13.6 8l2.4 2.4L4.4 22z'), s: SPARK(19, 4.5, 2.6) + SPARK(11.5, 3.5, 1.5) + SPARK(20.5, 13, 1.5) },
  crop: { s: p('M2.5 7.5H17v14M7 2.5V17h14.5') },
  perspectiveCrop: { s: p('M5.5 3.5h13M5.5 20.5h13M5.5 3.5v17M18.5 3.5v17'), d: p('M9.5 3.5v17h1v-17zM13.5 3.5v17h1v-17zM5.5 9h13v1h-13zM5.5 14h13v1h-13z'), f: p('M3.5 1.5h4v4h-4zM16.5 1.5h4v4h-4zM3.5 18.5h4v4h-4zM16.5 18.5h4v4h-4z') },
  slice: { f: p('M2 21.5l9.2-9.2 2.2 2.2-9.2 9.2z'), d: p('M11.2 12.3l8.8-8.8c1 2.8-.2 6.6-3 9.4l-3.6 1.6z') },
  sliceSelect: { f: p('M2 2.5v8l2.2-2.1 1.4 3.2 1.4-.6-1.4-3.2H8.4z') + p('M5 21.5l7.5-7.5 2 2-7.5 7.5z'), d: p('M12.5 14l7.5-7.5c.8 2.3-.2 5.5-2.5 7.8l-3 1.7z') },
  frame: { s: p('M3.5 4.5h17v15h-17z'), d: p('M3.5 4.5l17 15v-1.3L5 4.5zM20.5 4.5l-17 15v-1.3L19 4.5z'), f: p('M2 3h3v3H2zM19 3h3v3h-3zM2 18h3v3H2zM19 18h3v3h-3z') },
  eyedropper: { f: DROPPER_F, s: DROPPER_S },
  colorSampler: { f: DROPPER_F, s: DROPPER_S + c(6, 6, 2.3) + p('M6 1.5v9M1.5 6h9') },
  ruler: { f: ev('M2 8h20v8.5H2zM5 13h1.2v3.5H5zM8.5 12h1.2v4.5H8.5zM12 13h1.2v3.5H12zM15.5 12h1.2v4.5h-1.2zM19 13h1.2v3.5H19z') },
  note: { f: ev('M4 3h16v12h-5.5v6.5H4zM7 6.5h10V8H7zM7 9.5h10V11H7zM7 12.5h5V14H7z') + p('M16 16.5h4l-4 4.5z') },
  count: { s: p('M3.5 5 5.8 3.5V13M3.5 13h4.6M10 14.2c.3-1.6 4.4-1.7 4.4.3 0 2.2-4.4 3.4-4.4 5.5h4.7M17 3h3.6l-2 2.5c1.6 0 2.4.9 2.4 2.1 0 1.4-1.1 2.3-2.4 2.3-.9 0-1.6-.4-2-1') },
  spotHealing: { s: BANDAGE + '<path d="M3 9.5a7 7 0 0 1 6.5-6.5" stroke-dasharray="1.4 1.8"/>', d: BANDAGE, f: BANDAGE_PAD },
  healingBrush: { s: BANDAGE, d: BANDAGE, f: BANDAGE_PAD },
  patch: { s: p('M6.5 6.5h11v11h-11zM8.5 3v3.5M12 3v3.5M15.5 3v3.5M8.5 17.5V21M12 17.5V21M15.5 17.5V21M3 8.5h3.5M3 12h3.5M3 15.5h3.5M17.5 8.5H21M17.5 12H21M17.5 15.5H21'), d: p('M6.5 6.5h11v11h-11z') },
  contentAwareMove: { s: p('M4.5 7.5l15 9M4.5 16.5l15-9'), f: p('M21.5 17.7l-4.4.5 1.9-3.8zM21.5 6.3l-4.4-.5 1.9 3.8zM2.5 17.7l4.4.5-1.9-3.8zM2.5 6.3l4.4-.5-1.9 3.8z') },
  redEye: { s: p('M2 6.5h8M6 2.5v8M8 15.5c3.2-4.8 10.8-4.8 14 0-3.2 4.8-10.8 4.8-14 0z'), f: c(15, 15.5, 1.8) },
  brush: { f: BRUSH },
  pencil: { s: p('M3.5 20.5l1.2-4.6L16.2 4.4c1-1 2.4-1 3.4 0s1 2.4 0 3.4L8.1 19.3zM14.4 6.2l3.4 3.4M4.7 15.9l3.4 3.4') },
  colorReplacement: { f: BRUSH, s: p('M2.5 7.5h5v5h-5zM5 5.5v-3h7M10.5 1l1.5 1.5L10.5 4'), d: p('M2.5 7.5h5v5h-5z') },
  mixerBrush: { f: BRUSH + p('M5 3c-1.6 2.3-3 3.8-3 5.3a3 3 0 0 0 6 0C8 6.8 6.6 5.3 5 3z') },
  cloneStamp: { f: STAMP(0) },
  patternStamp: { f: `<g transform="translate(14 22) scale(.62) translate(-12 -22)">${STAMP(0)}</g>` + p('M2 3h2.6v2.6H2zM7 3h2.6v2.6H7zM4.5 5.6h2.6v2.6H4.5zM2 8.2h2.6v2.6H2zM7 8.2h2.6v2.6H7z') },
  historyBrush: { f: BRUSH + p('M11.8 2.5l.5 4.2-3.9-1.2z'), s: p('M3.5 9.5a5 5 0 0 1 7.5-5.2') },
  artHistoryBrush: { f: BRUSH, s: p('M7.5 8.5c-3 .8-5.5-1-5-3.5S6.5 1.8 8.5 3s1.2 3.5-.8 3.6C6 6.8 5.6 5 6.8 4.6') },
  eraser: { f: ERASER_F, s: ERASER_S },
  backgroundEraser: { f: ERASER_F, s: ERASER_S + c(3.5, 3.5, 1.5) + c(3.5, 9.5, 1.5) + p('M4.8 4.5 10 9M4.8 8.5 10 4') },
  magicEraser: { f: ERASER_F, s: ERASER_S + SPARK(5, 4.5, 2.4) + SPARK(13.5, 3, 1.5) + SPARK(4, 12, 1.5) },
  gradient: { s: p('M3 5h18v14H3z'), f: [0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((o, i) => `<rect x="${4.5 + i * 2.6}" y="6.5" width="2.7" height="11" opacity="${o}"/>`).join('') },
  bucket: { s: p('M11.5 6.5l7 7-6.3 6.3-7-7zM8.5 9.5V5.2a2.3 2.3 0 0 1 4.6 0v4.3'), f: p('M20 14.5c1.1 1.7 1.9 2.8 1.9 3.9a1.9 1.9 0 0 1-3.8 0c0-1.1.8-2.2 1.9-3.9z') },
  blur: { f: p('M12 2.5c3.2 4.7 6.3 7.8 6.3 11.5a6.3 6.3 0 0 1-12.6 0c0-3.7 3.1-6.8 6.3-11.5z') },
  sharpen: { f: p('M12 3l8.5 17.5h-17z') },
  smudge: { f: p('M9 3.5c4.5-1.8 10.2-.6 11.3 3.3.8 3-1.4 5.6-4.5 6.1l-7 8c-.7.8-1.8.9-2.5.2s-.6-1.7.1-2.4l5.3-6.8C9.3 10.4 6.6 5.8 9 3.5z') },
  dodge: { f: c(14.5, 9.5, 6.5), s: p('M10 14 3.5 20.5') },
  burn: { f: ev('M3.5 10C5.5 6.2 11 4.6 15 6.2l5.5 3.6c1 .8.7 2.2-.5 2.5l-4.7.7c-1 4.2-5.2 6.2-8.8 4.6C3.3 16 2.2 12.4 3.5 10zM9.2 9.3a2.4 2.1 0 1 0 .1 0z') },
  sponge: { f: ev('M5 7c2.2-3.3 11.5-3.8 14.5-1.1s1.6 10.5-1.6 12-12.2 1.6-13.8-2.6S2.9 9.9 5 7zM8 9a1.1 1.1 0 1 0 .1 0zM13 7.8a1.1 1.1 0 1 0 .1 0zM10.5 13a1.1 1.1 0 1 0 .1 0zM15.8 12.3a1.1 1.1 0 1 0 .1 0zM7.8 15.4a.9.9 0 1 0 .1 0z') },
  pen: { s: PEN_S },
  freeformPen: { s: `<g transform="translate(3 0)">${PEN_S}</g>` + '<path d="M3.5 2c-1.5 3 1.5 4.5 0 7.5s1.5 4.5 0 7.5" stroke-dasharray="1.4 1.8"/>' },
  curvaturePen: { s: `<g transform="translate(3 0)">${PEN_S}</g>` + p('M2.5 16C2 11 6 9 8 6') + c(8, 6, 1.1) },
  addAnchor: { s: `<g transform="translate(2 1)">${PEN_S}</g>` + p('M5.5 1.5v7M2 5h7') },
  deleteAnchor: { s: `<g transform="translate(2 1)">${PEN_S}</g>` + p('M2 5h7') },
  convertPoint: { s: p('M7 21V3l10.5 11.5') },
  horizontalType: { f: p(TYPE_T) },
  verticalType: { f: `<g transform="translate(3.5 0) scale(.85 1)">${p(TYPE_T)}</g>` + p('M3.5 3v14.5h-2.2L4.3 21l3-3.5H5V3z') },
  horizontalTypeMask: { s: `<path d="${TYPE_T}" stroke-dasharray="2 1.6" stroke-width="1.2"/>` },
  verticalTypeMask: { s: `<g transform="translate(3.5 0) scale(.85 1)"><path d="${TYPE_T}" stroke-dasharray="2 1.6" stroke-width="1.2"/></g>`, f: p('M3.5 3v14.5h-2.2L4.3 21l3-3.5H5V3z') },
  pathSelection: { s: `<path transform="translate(4 2)" fill="#111" d="${ARROWHEAD}"/>` },
  directSelection: { f: `<path transform="translate(4 2)" d="${ARROWHEAD}"/>` },
  rectangle: { s: shapeRect, d: shapeRect },
  ellipse: { s: '<ellipse cx="12" cy="12" rx="8.5" ry="7.5"/>', d: '<ellipse cx="12" cy="12" rx="8.5" ry="7.5"/>' },
  triangle: { s: p('M12 3.5l8.5 16h-17z'), d: p('M12 3.5l8.5 16h-17z') },
  polygon: { s: p('M7.5 4.5h9l4.5 7.5-4.5 7.5h-9L3 12z'), d: p('M7.5 4.5h9l4.5 7.5-4.5 7.5h-9L3 12z') },
  line: { s: p('M4 20 20 4') },
  customShape: { s: p('M9 3.5c2-1 3.5.5 3.5 2.5 1.5-1.5 4-1 4.5 1s-1 3.3-2.5 3.8c2.5.4 5 1.4 4 4.2s-4 1.2-5.5.3c.5 2-.3 5.2-3 4.7s-2-3.8-1.5-5.2C7 16 3.5 16.3 3 13.8s2.5-3.3 4.2-3.3C5.5 9 6 4.8 9 3.5z'), d: p('M9 3.5c2-1 3.5.5 3.5 2.5 1.5-1.5 4-1 4.5 1s-1 3.3-2.5 3.8c2.5.4 5 1.4 4 4.2s-4 1.2-5.5.3c.5 2-.3 5.2-3 4.7s-2-3.8-1.5-5.2C7 16 3.5 16.3 3 13.8s2.5-3.3 4.2-3.3C5.5 9 6 4.8 9 3.5z') },
  hand: { f: p('M7 12V5.2a1.25 1.25 0 0 1 2.5 0V11h.5V3.7a1.25 1.25 0 0 1 2.5 0V11h.5V4.7a1.25 1.25 0 0 1 2.5 0V11.5h.5V7.2a1.25 1.25 0 0 1 2.5 0V15c0 4-2.6 6.5-6.2 6.5h-1c-2.4 0-3.8-1-5-3.2L2.6 13.6a1.3 1.3 0 0 1 2.1-1.5z') },
  rotate: { f: `<g transform="translate(-1.5 2.5) scale(.82)">${p('M7 12V5.2a1.25 1.25 0 0 1 2.5 0V11h.5V3.7a1.25 1.25 0 0 1 2.5 0V11h.5V4.7a1.25 1.25 0 0 1 2.5 0V11.5h.5V7.2a1.25 1.25 0 0 1 2.5 0V15c0 4-2.6 6.5-6.2 6.5h-1c-2.4 0-3.8-1-5-3.2L2.6 13.6a1.3 1.3 0 0 1 2.1-1.5z')}</g>` + p('M21.5 5.5l-1.2 4-3.5-2.4z'), s: p('M5 4.5c4-3.5 11-3.5 15 1.8') },
  zoom: { s: c(10, 10, 6.5) + '<path d="M14.8 14.8 21 21" stroke-width="2.6"/>' },
};
