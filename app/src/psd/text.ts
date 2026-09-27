// PSD type layers (docs/M4.md section 9, PSD paragraph). PSD engine lengths are px at 72 ppi; the
// model keeps pt, so import scales by 72 / resolution and export by resolution / 72.
import type { AntiAlias, Justification, LayerTextData, ParagraphStyle, TextStyle, Warp, WarpStyle } from 'ag-psd';

type Warn = (m: string) => void;
type Mat = [number, number, number, number, number, number];
// Engine TextData JSON (engine/src/text.rs); kept loose because the engine validates it.
export type TextJson = Record<string, any>;

const ALIGN: Record<Justification, string> = {
  left: 'left', right: 'right', center: 'center', 'justify-left': 'justify_left', 'justify-right': 'justify_right',
  'justify-center': 'justify_center', 'justify-all': 'justify_all',
};
const AA_IN: Record<AntiAlias, string> = { none: 'none', sharp: 'sharp', crisp: 'crisp', strong: 'strong', smooth: 'smooth', platform: 'smooth', platformLCD: 'smooth' };
const WARPS: WarpStyle[] = ['arc', 'arcLower', 'arcUpper', 'arch', 'bulge', 'shellLower', 'shellUpper', 'flag', 'wave', 'fish', 'rise', 'fisheye', 'inflate', 'squeeze', 'twist'];
const snake = (s: string) => s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

// a after b (b applies first).
const compose = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const mat = (m: number[] | undefined): Mat | null => m && m.length >= 6 && m.slice(0, 6).every(Number.isFinite) ? m.slice(0, 6) as Mat : null;

// Run/paragraph lengths clamped to the text: EngineData counts a trailing return; the last span absorbs any rest.
function spans<T extends { length: number }>(list: T[], len: number): T[] {
  const out: T[] = [];
  let left = len;
  for (const s of list) {
    const n = Math.min(Math.max(0, Math.floor(s.length)), left);
    if (n) out.push({ ...s, length: n });
    left -= n;
  }
  if (left && out.length) out[out.length - 1] = { ...out[out.length - 1], length: out[out.length - 1].length + left };
  return out;
}

function runIn(length: number, s: TextStyle, aa: string, k: number) {
  const c = s.fillColor && 'r' in s.fillColor ? s.fillColor : { r: 0, g: 0, b: 0 };
  const name = s.font?.name ?? '';
  return {
    length, family: name, style: '', postscript_name: name,
    size: Math.max(0.01, (s.fontSize ?? 12) * k), tracking: s.tracking ?? 0,
    leading: s.autoLeading === false && s.leading !== undefined ? s.leading * k : null,
    color: [c.r, c.g, c.b].map(v => Math.max(0, Math.min(255, Math.round(v)))),
    faux_bold: !!s.fauxBold, faux_italic: !!s.fauxItalic, underline: !!s.underline, strikethrough: !!s.strikethrough,
    caps: s.fontCaps === 2 ? 'all' : s.fontCaps === 1 ? 'small' : 'normal',
    baseline: s.fontBaseline === 1 ? 'super' : s.fontBaseline === 2 ? 'sub' : 'normal',
    baseline_shift: (s.baselineShift ?? 0) * k, horizontal_scale: s.horizontalScale ?? 1, vertical_scale: s.verticalScale ?? 1,
    anti_alias: aa, ligatures: s.ligatures !== false, discretionary_ligatures: !!s.dLigatures,
    kerning: s.autoKerning === false ? 'none' : 'metrics', language: '', no_break: !!s.noBreak, tsume: s.tsume ?? 0, features: {},
  };
}

function paragraphIn(length: number, p: ParagraphStyle, box: boolean, k: number) {
  const three = (v: number[] | undefined, d: number[]) => v?.length === 3 && v.every(Number.isFinite) ? v : d;
  return {
    length, alignment: ALIGN[p.justification ?? 'left'] ?? 'left',
    indent_left: (p.startIndent ?? 0) * k, indent_right: (p.endIndent ?? 0) * k, indent_first: (p.firstLineIndent ?? 0) * k,
    space_before: (p.spaceBefore ?? 0) * k, space_after: (p.spaceAfter ?? 0) * k,
    hyphenate: !!p.autoHyphenate, rtl: false,
    composer: (p.everyLineComposer ?? box) ? 'every_line' : 'single_line',
    justification: {
      word: three(p.wordSpacing, [0.8, 1, 1.33]), letter: three(p.letterSpacing, [0, 0, 0]), glyph: three(p.glyphSpacing, [1, 1, 1]),
    },
    hyphenation: {
      min_word: p.hyphenatedWordSize ?? 5, after_first: p.preHyphen ?? 2, before_last: p.postHyphen ?? 2,
      limit: p.consecutiveHyphens ?? 2, zone: (p.zone ?? 36) * k, capitalized: true,
    },
    hanging_punctuation: !!p.hanging,
  };
}

// ag-psd bezier control points: per segment p0, c1, c2, p3 (8 numbers).
function bezierPath(cp: unknown) {
  if (!Array.isArray(cp)) return null;
  const segs: number[][] = [];
  for (let i = 0; i + 8 <= cp.length; i += 8) segs.push(cp.slice(i, i + 8));
  if (!segs.length || !cp.every(Number.isFinite)) return null;
  const last = segs[segs.length - 1];
  const closed = segs.length > 1 && last[6] === segs[0][0] && last[7] === segs[0][1];
  const points = segs.map((s, i) => {
    const prev = i ? segs[i - 1] : closed ? last : null;
    return [s[0], s[1], prev ? prev[4] : s[0], prev ? prev[5] : s[1], s[2], s[3]];
  });
  if (!closed) points.push([last[6], last[7], last[4], last[5], last[6], last[7]]);
  let length = 0;
  for (let i = 0; i + 2 < cp.length; i += 2) length += Math.hypot(cp[i + 2] - cp[i], cp[i + 3] - cp[i + 1]);
  return { path: { fill_rule: 'nonzero', subpaths: [{ closed, op: 'combine', points }] }, length };
}

// Box when frame type 1 or shapeType box; on a path when the frame has a curve and type != 0; else point.
function shapeIn(t: LayerTextData) {
  const tp = t.textPath;
  if (tp?.data?.type === 1 || t.shapeType === 'box') {
    const b = t.boxBounds ?? [0, 0, 0, 0];
    return { type: 'paragraph', box: [b[0], b[1], b[2], b[3]] };
  }
  const curve = tp?.data?.type !== 0 && tp?.bezierCurve ? bezierPath(tp.bezierCurve.controlPoints) : null;
  if (curve) return { type: 'onPath', path: curve.path, start: 0, end: curve.length, flip: !!tp?.data?.pathData?.reversed };
  return { type: 'point' };
}

function warpIn(w: Warp | undefined, warn: Warn) {
  if (!w?.style || w.style === 'none') return null;
  if (!WARPS.includes(w.style)) {
    warn('custom and cylinder text warps were not imported');
    return null;
  }
  const f = (v: number | undefined) => clamp1((v ?? 0) / 100);
  return { style: snake(w.style), bend: f(w.value), horizontal: f(w.perspective), vertical: f(w.perspectiveOther), axis: w.rotate === 'vertical' ? 'vertical' : 'horizontal' };
}

export function textIn(t: LayerTextData, resolution: number, warn: Warn): TextJson {
  const k = 72 / resolution;
  const len = t.text.length;
  const aa = AA_IN[t.antiAlias ?? 'smooth'] ?? 'smooth';
  const shape = shapeIn(t);
  const runList = t.styleRuns?.length ? t.styleRuns.map(r => ({ length: r.length, style: { ...t.style, ...r.style } })) : [{ length: len, style: t.style ?? {} }];
  const paraList = t.paragraphStyleRuns?.length ? t.paragraphStyleRuns.map(r => ({ length: r.length, style: { ...t.paragraphStyle, ...r.style } }))
    : [{ length: len, style: t.paragraphStyle ?? {} }];
  const frame = mat(t.textPath?.data?.frameMatrix) ?? [1, 0, 0, 1, 0, 0];
  const base = shape.type === 'point' && t.pointBase?.length === 2 ? compose(frame, [1, 0, 0, 1, t.pointBase[0], t.pointBase[1]]) : frame;
  const box = shape.type === 'paragraph';
  return {
    text: t.text,
    // An empty text keeps one zero-length span each (the engine needs at least one).
    runs: len ? spans(runList, len).map(r => runIn(r.length, r.style, aa, k)) : [runIn(0, runList[0].style, aa, k)],
    paragraphs: len ? spans(paraList, len).map(p => paragraphIn(p.length, p.style, box, k)) : [paragraphIn(0, paraList[0].style, box, k)],
    shape, orientation: t.orientation === 'vertical' ? 'vertical' : 'horizontal',
    transform: compose(mat(t.transform) ?? [1, 0, 0, 1, 0, 0], base),
    warp: warpIn(t.warp, warn),
    psd: t,
  };
}

function styleOut(r: TextJson, raw: TextStyle | undefined, k: number): TextStyle {
  const name = r.postscript_name || r.family;
  const [cr, cg, cb] = r.color;
  const f = raw?.font;
  return {
    ...raw,
    font: f?.name === name ? f : { name },
    fontSize: r.size * k, tracking: r.tracking, autoLeading: r.leading === null,
    ...(r.leading === null ? {} : { leading: r.leading * k }),
    fillColor: { r: cr, g: cg, b: cb }, fauxBold: r.faux_bold, fauxItalic: r.faux_italic, underline: r.underline, strikethrough: r.strikethrough,
    fontCaps: r.caps === 'all' ? 2 : r.caps === 'small' ? 1 : 0, fontBaseline: r.baseline === 'super' ? 1 : r.baseline === 'sub' ? 2 : 0,
    baselineShift: r.baseline_shift * k, horizontalScale: r.horizontal_scale, verticalScale: r.vertical_scale,
    ligatures: r.ligatures, dLigatures: r.discretionary_ligatures, autoKerning: r.kerning !== 'none', noBreak: r.no_break, tsume: r.tsume,
  };
}

function paragraphOut(p: TextJson, raw: ParagraphStyle | undefined, k: number): ParagraphStyle {
  const j = p.justification, h = p.hyphenation;
  return {
    ...raw,
    justification: (Object.keys(ALIGN) as Justification[]).find(key => ALIGN[key] === p.alignment) ?? 'left',
    startIndent: p.indent_left * k, endIndent: p.indent_right * k, firstLineIndent: p.indent_first * k,
    spaceBefore: p.space_before * k, spaceAfter: p.space_after * k, autoHyphenate: p.hyphenate, everyLineComposer: p.composer === 'every_line',
    wordSpacing: j.word, letterSpacing: j.letter, glyphSpacing: j.glyph,
    hyphenatedWordSize: h.min_word, preHyphen: h.after_first, postHyphen: h.before_last, consecutiveHyphens: h.limit, zone: h.zone * k,
    hanging: p.hanging_punctuation,
  };
}

// Starts from the imported object and overwrites the mapped fields; runs and paragraphs merge over the
// original at the same index only while their count is unchanged.
export function textOut(t: TextJson, resolution: number, warn: Warn): LayerTextData {
  const k = resolution / 72;
  const raw: LayerTextData = t.psd ?? { text: '' };
  const { textPath: _, ...base } = raw;
  const rawRuns = raw.styleRuns?.length === t.runs.length ? raw.styleRuns : undefined;
  const rawParas = raw.paragraphStyleRuns?.length === t.paragraphs.length ? raw.paragraphStyleRuns : undefined;
  if (t.shape.type === 'onPath' || t.shape.type === 'inShape') warn('text on a path or in a shape is saved as point text');
  const aa = t.runs[0].anti_alias;
  const keepAa = aa === 'smooth' && (raw.antiAlias === 'platform' || raw.antiAlias === 'platformLCD');
  const w = t.warp;
  const keepWarp = !w && raw.warp?.style && !WARPS.includes(raw.warp.style) && raw.warp.style !== 'none';
  return {
    ...base,
    text: t.text, transform: [...t.transform], antiAlias: keepAa ? raw.antiAlias : aa,
    orientation: t.orientation,
    ...(t.shape.type === 'paragraph' ? { shapeType: 'box', boxBounds: [...t.shape.box] } : { shapeType: 'point', pointBase: [0, 0] }),
    style: raw.style ?? styleOut(t.runs[0], undefined, k),
    styleRuns: t.runs.map((r: TextJson, i: number) => ({ length: r.length, style: styleOut(r, rawRuns ? { ...raw.style, ...rawRuns[i].style } : raw.style, k) })),
    paragraphStyle: raw.paragraphStyle ?? paragraphOut(t.paragraphs[0], undefined, k),
    paragraphStyleRuns: t.paragraphs.map((p: TextJson, i: number) => ({
      length: p.length, style: paragraphOut(p, rawParas ? { ...raw.paragraphStyle, ...rawParas[i].style } : raw.paragraphStyle, k),
    })),
    warp: keepWarp ? raw.warp : w
      ? { ...raw.warp, style: camel(w.style) as WarpStyle, value: w.bend * 100, perspective: w.horizontal * 100, perspectiveOther: w.vertical * 100, rotate: w.axis }
      : { style: 'none', value: 0, perspective: 0, perspectiveOther: 0, rotate: raw.warp?.rotate ?? 'horizontal' },
    left: raw.left ?? 0, top: raw.top ?? 0, right: raw.right ?? 0, bottom: raw.bottom ?? 0,
  };
}
