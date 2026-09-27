// Type tool edit session (docs/M4.md section 10): the text model edits, the session's own undo with
// typing coalescing, and caret/selection math over the engine's text_layout (text space).
import type { TextJson } from '../psd/text.ts';

export interface LayoutLine {
  x: number; y: number; width: number; ascent: number; descent: number;
  start: number; end: number;
  // [UTF-16 cluster, x, y, advance]
  glyphs: [number, number, number, number][];
}
export interface TextLayout { transform: number[]; overflow: boolean; lines: LayoutLine[] }

export interface TypeOptions {
  family: string; style: string; size: number; color: [number, number, number];
  alignment: 'left' | 'center' | 'right'; orientation: 'horizontal' | 'vertical';
}

type Span = { length: number } & Record<string, any>;
type Attrs = Record<string, unknown>;

// Below this drag (document px, max of dx and dy) a click makes point text.
export const BOX_MIN = 6;
export const boxDrag = (dx: number, dy: number) => Math.max(Math.abs(dx), Math.abs(dy)) >= BOX_MIN;
// ponytail: coalescing window is a guess (the reference value is unreadable); tune if typing splits oddly.
export const COALESCE_MS = 1000;
const NAME_MAX = 30;

export function layerName(text: string) {
  const line = [...text.split('\n')[0]];
  if (!line.length) return 'Type Layer';
  return line.length > NAME_MAX ? `${line.slice(0, NAME_MAX).join('')}…` : line.join('');
}

// A new, empty type layer's model; `shape` is point or paragraph (box in text space), `origin` its translation.
export function newText(o: TypeOptions, shape: TextJson, origin: [number, number]): TextJson {
  return {
    text: '',
    runs: [{
      length: 0, family: o.family, style: o.style, postscript_name: '', size: o.size, tracking: 0, leading: null, color: o.color,
      faux_bold: false, faux_italic: false, underline: false, strikethrough: false, caps: 'normal', baseline: 'normal',
      baseline_shift: 0, horizontal_scale: 1, vertical_scale: 1, anti_alias: 'sharp', ligatures: true, discretionary_ligatures: false,
      kerning: 'metrics', language: '', no_break: false, tsume: 0, features: {},
    }],
    paragraphs: [{
      length: 0, alignment: o.alignment, indent_left: 0, indent_right: 0, indent_first: 0, space_before: 0, space_after: 0,
      hyphenate: false, rtl: false, composer: 'every_line',
      justification: { word: [0.8, 1, 1.33], letter: [0, 0, 0], glyph: [1, 1, 1] },
      hyphenation: { min_word: 5, after_first: 2, before_last: 2, limit: 2, zone: 36, capitalized: true },
      hanging_punctuation: false,
    }],
    shape, orientation: o.orientation, transform: [1, 0, 0, 1, origin[0], origin[1]], warp: null, psd: null,
  };
}

// Index of the span holding UTF-16 position `pos` (the last span past the end).
function spanAt(spans: Span[], pos: number) {
  let a = 0;
  for (let i = 0; i < spans.length; i++) {
    if (pos < a + spans[i].length) return i;
    a += spans[i].length;
  }
  return spans.length - 1;
}

// Replaces [start, end) by `n` units: they join the span of the first replaced char, else of the
// char before, or get their own span with `attrs`. Empty spans go; an empty text keeps one.
function splice(spans: Span[], start: number, end: number, n: number, attrs?: Attrs | null): Span[] {
  const k = end > start ? spanAt(spans, start) : spanAt(spans, Math.max(0, start - 1));
  const out: Span[] = [];
  let a = 0;
  spans.forEach((s, i) => {
    const b = a + s.length;
    const before = Math.max(0, Math.min(b, start) - a), after = Math.max(0, b - Math.max(a, end));
    if (i === k && attrs) out.push({ ...s, length: before }, { ...s, ...attrs, length: n }, { ...s, length: after });
    else out.push({ ...s, length: before + after + (i === k ? n : 0) });
    a = b;
  });
  const kept = out.filter(s => s.length > 0);
  return kept.length ? kept : [{ ...spans[k], length: 0 }];
}

// Sets `attrs` on [a, b), splitting spans at both ends.
function restyle(spans: Span[], a: number, b: number, attrs: Attrs): Span[] {
  const out: Span[] = [];
  let p = 0;
  for (const s of spans) {
    const q = p + s.length;
    const cuts = [p, Math.min(Math.max(a, p), q), Math.min(Math.max(b, p), q), q];
    for (let i = 0; i < 3; i++) {
      if (cuts[i + 1] > cuts[i]) out.push({ ...s, ...(i === 1 ? attrs : {}), length: cuts[i + 1] - cuts[i] });
    }
    p = q;
  }
  return out.length ? out : spans.map(s => ({ ...s, ...attrs }));
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const words = new Intl.Segmenter(undefined, { granularity: 'word' });

export function boundaries(text: string) {
  const b = [0];
  for (const s of graphemes.segment(text)) b.push(s.index + s.segment.length);
  return b;
}
export const prevBoundary = (text: string, i: number) => boundaries(text).filter(b => b < i).at(-1) ?? 0;
export const nextBoundary = (text: string, i: number) => boundaries(text).find(b => b > i) ?? text.length;
export function prevWord(text: string, i: number) {
  let r = 0;
  for (const s of words.segment(text)) if (s.isWordLike && s.index < i) r = s.index;
  return r;
}
export function nextWord(text: string, i: number) {
  for (const s of words.segment(text)) if (s.isWordLike && s.index + s.segment.length > i) return s.index + s.segment.length;
  return text.length;
}

// Word characters (line-break classes AL, HL, NU, ID, CM) coalesce into one typing step.
const WORD = /^[\p{L}\p{N}\p{M}]+$/u;

interface Snap { text: TextJson; caret: number; anchor: number }

export class TypeSession {
  text: TextJson;
  caret = 0;
  anchor = 0;
  // Remembered x for Up/Down.
  goal: number | null = null;
  // Character attributes for the next typing at a collapsed caret (no history step).
  pending: Attrs | null = null;
  #start: string;
  #undo: Snap[] = [];
  #redo: Snap[] = [];
  #last: { kind: 'insert' | 'delete'; pos: number; at: number } | null = null;

  constructor(text: TextJson) {
    this.text = text;
    this.#start = JSON.stringify(text);
  }

  get steps() { return this.#undo.length; }
  get changed() { return JSON.stringify(this.text) !== this.#start; }
  get value(): string { return this.text.text; }
  get range(): [number, number] { return [Math.min(this.caret, this.anchor), Math.max(this.caret, this.anchor)]; }

  move(to: number, extend: boolean) {
    this.caret = Math.max(0, Math.min(this.value.length, to));
    if (!extend) this.anchor = this.caret;
    this.goal = null;
    this.pending = null;
    this.#last = null;
  }

  selectAll() {
    this.anchor = 0;
    this.move(this.value.length, true);
  }

  insert(str: string, now: number) {
    const [a, b] = this.range;
    this.#edit(a, b, str, 'insert', now);
  }

  backspace(now: number) {
    const [a, b] = this.range;
    if (a !== b) this.#edit(a, b, '', 'delete', now);
    else if (a > 0) this.#edit(prevBoundary(this.value, a), a, '', 'delete', now);
  }

  deleteForward(now: number) {
    const [a, b] = this.range;
    if (a !== b) this.#edit(a, b, '', 'delete', now);
    else if (a < this.value.length) this.#edit(a, nextBoundary(this.value, a), '', 'delete', now);
  }

  // Character attributes: on the selection (one step), or pending at a collapsed caret.
  applyRun(attrs: Attrs, _now: number) {
    const [a, b] = this.range;
    if (a === b) { this.pending = { ...this.pending, ...attrs }; return; }
    this.#push();
    this.text = { ...this.text, runs: restyle(this.text.runs, a, b, attrs) };
  }

  // Paragraph attributes on every paragraph the caret or selection touches (one step).
  applyParagraph(attrs: Attrs, _now: number) {
    const [a, b] = this.range, t = this.value;
    const p0 = t.lastIndexOf('\n', a - 1) + 1;
    const nl = t.indexOf('\n', b);
    const p1 = nl < 0 ? t.length : nl + 1;
    this.#push();
    this.text = { ...this.text, paragraphs: restyle(this.text.paragraphs, p0, Math.max(p1, p0 + 1), attrs) };
  }

  undo() { return this.#swap(this.#undo, this.#redo); }
  redo() { return this.#swap(this.#redo, this.#undo); }

  #snap(): Snap { return { text: this.text, caret: this.caret, anchor: this.anchor }; }

  #push() {
    this.#undo.push(this.#snap());
    this.#redo = [];
    this.#last = null;
  }

  #swap(from: Snap[], to: Snap[]) {
    const s = from.pop();
    if (!s) return false;
    to.push(this.#snap());
    ({ text: this.text, caret: this.caret, anchor: this.anchor } = s);
    this.goal = null;
    this.#last = null;
    return true;
  }

  #edit(start: number, end: number, str: string, kind: 'insert' | 'delete', now: number) {
    const t = this.value;
    const unit = kind === 'insert' ? str : t.slice(start, end);
    const l = this.#last;
    const adjacent = l && l.kind === kind && now - l.at <= COALESCE_MS
      && (kind === 'insert' ? start === end && start === l.pos : end === l.pos || start === l.pos);
    if (!(adjacent && WORD.test(unit) && [...graphemes.segment(unit)].length === 1)) this.#push();
    const runs = splice(this.text.runs, start, end, str.length, kind === 'insert' ? this.pending : null);
    this.text = { ...this.text, text: t.slice(0, start) + str + t.slice(end), runs, paragraphs: splice(this.text.paragraphs, start, end, str.length) };
    this.caret = this.anchor = start + str.length;
    this.goal = null;
    if (kind === 'insert') this.pending = null;
    this.#last = { kind, pos: this.caret, at: now };
  }
}

// ---- caret geometry (text space); vertical text measures along y and stacks columns on x ----

const RTL = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;

interface Cluster { c: number; lo: number; hi: number; rtl: boolean }

function clusters(line: LayoutLine, text: string, vertical: boolean): Cluster[] {
  const m = new Map<number, Cluster>();
  for (const [c, x, y, adv] of line.glyphs) {
    const p = vertical ? y : x;
    const e = m.get(c);
    if (e) { e.lo = Math.min(e.lo, p); e.hi = Math.max(e.hi, p + adv); }
    else m.set(c, { c, lo: p, hi: p + adv, rtl: RTL.test(String.fromCodePoint(text.codePointAt(c) ?? 32)) });
  }
  return [...m.values()].sort((a, b) => a.c - b.c);
}

export function lineOf(layout: TextLayout, i: number) {
  let k = 0;
  layout.lines.forEach((l, n) => { if (l.start <= i) k = n; });
  return k;
}

const lineStart = (l: LayoutLine, vertical: boolean) => vertical ? l.y : l.x;
// Last caret position of a line: before its trailing newline.
const lineEnd = (l: LayoutLine, text: string) => (l.end > l.start && text[l.end - 1] === '\n' ? l.end - 1 : l.end);

function xIn(line: LayoutLine, cs: Cluster[], i: number, vertical: boolean) {
  const at = cs.find(k => k.c === i);
  if (at) return at.rtl ? at.hi : at.lo;
  const before = cs.filter(k => k.c < i).at(-1);
  if (!before) return lineStart(line, vertical);
  const next = cs.find(k => k.c > before.c)?.c ?? Infinity;
  if (i < next && next !== Infinity) {
    const f = (i - before.c) / (next - before.c), w = before.hi - before.lo;
    return before.rtl ? before.hi - f * w : before.lo + f * w;
  }
  return before.rtl ? before.lo : before.hi;
}

// Caret position along its line for UTF-16 index `i`.
export function caretX(layout: TextLayout, text: string, i: number, vertical: boolean) {
  const line = layout.lines[lineOf(layout, i)];
  return line ? xIn(line, clusters(line, text, vertical), i, vertical) : 0;
}

function indexInLine(layout: TextLayout, text: string, n: number, x: number, vertical: boolean) {
  const line = layout.lines[n];
  const cs = clusters(line, text, vertical), end = lineEnd(line, text);
  let best = line.start, d = Infinity;
  for (const b of boundaries(text)) {
    if (b < line.start || b > end) continue;
    const e = Math.abs(xIn(line, cs, b, vertical) - x);
    if (e < d) { d = e; best = b; }
  }
  return best;
}

// The caret index nearest to text-space point (x, y).
export function indexAt(layout: TextLayout, text: string, x: number, y: number, vertical: boolean) {
  if (!layout.lines.length) return 0;
  const cross = vertical ? x : y, along = vertical ? y : x;
  let n = 0, d = Infinity;
  layout.lines.forEach((l, k) => {
    const c = vertical ? l.x : l.y;
    const [lo, hi] = vertical ? [c - (l.ascent + l.descent) / 2, c + (l.ascent + l.descent) / 2] : [c - l.ascent, c + l.descent];
    const e = cross < lo ? lo - cross : cross > hi ? cross - hi : 0;
    if (e < d) { d = e; n = k; }
  });
  return indexInLine(layout, text, n, along, vertical);
}

// Up/Down: the next laid-out line at the remembered x; past the first/last line, the text start/end.
export function lineMove(layout: TextLayout, text: string, i: number, dir: 1 | -1, goal: number | null, vertical: boolean) {
  const x = goal ?? caretX(layout, text, i, vertical);
  const n = lineOf(layout, i) + dir;
  if (n < 0) return { index: 0, goal: x };
  if (n >= layout.lines.length) return { index: text.length, goal: x };
  return { index: indexInLine(layout, text, n, x, vertical), goal: x };
}

export function lineHome(layout: TextLayout, i: number) {
  return layout.lines[lineOf(layout, i)]?.start ?? 0;
}
export function lineEndAt(layout: TextLayout, text: string, i: number) {
  const l = layout.lines[lineOf(layout, i)];
  return l ? lineEnd(l, text) : text.length;
}

// Highlight spans per line over the glyphs whose cluster lies in [a, b), merged where they touch.
export function selectionRects(layout: TextLayout, a: number, b: number, vertical: boolean) {
  const out: { line: number; from: number; to: number }[] = [];
  layout.lines.forEach((l, n) => {
    const iv = l.glyphs.filter(g => g[0] >= a && g[0] < b).map(g => (vertical ? [g[2], g[2] + g[3]] : [g[1], g[1] + g[3]])).sort((p, q) => p[0] - q[0]);
    let cur: number[] | null = null;
    for (const [lo, hi] of iv) {
      if (cur && lo <= cur[1] + 1e-6) cur[1] = Math.max(cur[1], hi);
      else { if (cur) out.push({ line: n, from: cur[0], to: cur[1] }); cur = [lo, hi]; }
    }
    if (cur) out.push({ line: n, from: cur[0], to: cur[1] });
  });
  return out;
}
