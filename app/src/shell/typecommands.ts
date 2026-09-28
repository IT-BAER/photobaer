// Type menu and panel commands on the text model (docs/M4.md section 10): conversions, run and
// paragraph setters, OpenType features per run (D6), Paste Lorem Ipsum.
import type { TextJson } from '../psd/text.ts';
import type { TextLayout } from './typesession.ts';

type Attrs = Record<string, unknown>;
type Run = Record<string, any>;

export const LOREM = 'Lorem ipsum dolor sit amet, consectetuer adipiscing elit, sed diam nonummy nibh euismod tincidunt ut laoreet dolore magna aliguam erat volutpat. Ut wisis enim ad minim veniam, quis nostrud exerci tution ullamcorper suscipit lobortis nisl ut aliquip ex ea commodo consequat.';

// Type > Anti-Alias: Windows LCD and Windows render as smooth (Q3).
export const ANTI_ALIAS: [string, string][] = [
  ['None', 'none'], ['Sharp', 'sharp'], ['Crisp', 'crisp'], ['Strong', 'strong'], ['Smooth', 'smooth'], ['Windows LCD', 'smooth'], ['Windows', 'smooth'],
];
// Type > OpenType: label and tag; Contextual Alternates is calt (deviation from the reference's clig).
export const OPENTYPE: [string, string][] = [
  ['Standard Ligatures', 'liga'], ['Contextual Alternates', 'calt'], ['Discretionary Ligatures', 'dlig'], ['Swash', 'swsh'], ['Oldstyle', 'onum'],
  ['Stylistic Alternates', 'salt'], ['Titling Alternates', 'titl'], ['Ornaments', 'ornm'], ['Ordinals', 'ordn'], ['Fractions', 'frac'],
];
const ON_BY_DEFAULT = new Set(['liga', 'clig', 'calt']);

export const setRuns = (t: TextJson, attrs: Attrs): TextJson => ({ ...t, runs: t.runs.map((r: Run) => ({ ...r, ...attrs, length: r.length })) });
export const setParagraphs = (t: TextJson, attrs: Attrs): TextJson => ({ ...t, paragraphs: t.paragraphs.map((p: Run) => ({ ...p, ...attrs, length: p.length })) });

export function featureOn(r: Run, tag: string): boolean {
  if (tag === 'liga') return r.ligatures !== false;
  if (tag === 'dlig') return !!r.discretionary_ligatures;
  return r.features?.[tag] ?? ON_BY_DEFAULT.has(tag);
}

export function setFeature(r: Run, tag: string, on: boolean): Run {
  if (tag === 'liga') return { ...r, ligatures: on };
  if (tag === 'dlig') return { ...r, discretionary_ligatures: on };
  return { ...r, features: { ...r.features, [tag]: on } };
}

// Text-space bounds of the laid-out lines: [left, top, right, bottom].
export function layoutBounds(l: TextLayout, vertical: boolean): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of l.lines) {
    const half = (n.ascent + n.descent) / 2;
    const [a, b, c, d] = vertical ? [n.x - half, n.y, n.x + half, n.y + n.width] : [n.x, n.y - n.ascent, n.x + n.width, n.y + n.descent];
    x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, c); y1 = Math.max(y1, d);
  }
  return x0 === Infinity ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}

// Convert to Paragraph Text: the box is the laid-out bounds plus 1 px; null when already a box.
export function toParagraphText(t: TextJson, layout: TextLayout): TextJson | null {
  if (t.shape?.type === 'paragraph') return null;
  const [l, tp, r, b] = layoutBounds(layout, t.orientation === 'vertical');
  return { ...t, shape: { type: 'paragraph', box: [l, tp, r + 1, b + 1] } };
}

// Convert to Point Text: the anchor follows the first paragraph's alignment across the box (left
// for justified), the other axis sits on the first baseline; the text stays where it was.
export function toPointText(t: TextJson, layout: TextLayout): TextJson | null {
  if (t.shape?.type !== 'paragraph') return null;
  const [bl, bt, br, bb] = t.shape.box as number[], align = t.paragraphs[0]?.alignment ?? 'left';
  const along = (lo: number, hi: number) => (align === 'center' ? (lo + hi) / 2 : align === 'right' ? hi : lo);
  const vertical = t.orientation === 'vertical', line = layout.lines[0];
  const ax = vertical ? line?.x ?? bl : along(bl, br);
  const ay = vertical ? along(bt, bb) : line?.y ?? bt;
  const [a, b, c, d, e, f] = t.transform as number[];
  return { ...t, shape: { type: 'point' }, transform: [a, b, c, d, e + a * ax + c * ay, f + b * ax + d * ay] };
}

// Paste Lorem Ipsum: at `at` the text is inserted and the span holding the position grows;
// without a position it replaces the whole text with the first run and paragraph (Q4).
export function loremText(t: TextJson, at?: number): TextJson {
  if (at === undefined) {
    return { ...t, text: LOREM, runs: [{ ...t.runs[0], length: LOREM.length }], paragraphs: [{ ...t.paragraphs[0], length: LOREM.length }] };
  }
  const p = Math.max(0, Math.min(at, t.text.length));
  const grow = (spans: Run[]) => {
    const out = spans.map(s => ({ ...s }));
    let a = 0;
    for (const s of out) {
      const b = a + s.length;
      if (p > a && p <= b) { s.length += LOREM.length; return out; }
      a = b;
    }
    if (out.length) out[0].length += LOREM.length;
    return out;
  };
  return { ...t, text: t.text.slice(0, p) + LOREM + t.text.slice(p), runs: grow(t.runs), paragraphs: grow(t.paragraphs) };
}

// Insert Glyph without a session: the text grows at its end, in the last run and paragraph.
export function appendText(t: TextJson, s: string): TextJson {
  const grow = (spans: Run[]) => spans.map((x, i) => (i === spans.length - 1 ? { ...x, length: x.length + s.length } : x));
  return { ...t, text: t.text + s, runs: grow(t.runs), paragraphs: grow(t.paragraphs) };
}

// Every (family, style) the runs use, first use first.
export function fontUses(t: TextJson): [string, string][] {
  const seen = new Map<string, [string, string]>();
  for (const r of t.runs as Run[]) seen.set(`${r.family}\0${r.style}`, [r.family, r.style]);
  return [...seen.values()];
}

// The characters set in one face (preview text and coverage checks of the missing-font dialogs).
export function fontText(t: TextJson, family: string, style: string): string {
  let at = 0, out = '';
  for (const r of t.runs as Run[]) {
    if (r.family === family && r.style === style) out += t.text.slice(at, at + r.length);
    at += r.length;
  }
  return out;
}

export interface FontSub { source: { family: string; style: string }; target: { family: string; style: string } }
// Missing-font replacement: runs set in a source face take the target; unchanged text is returned as is.
export function substituteFonts(t: TextJson, subs: FontSub[]): TextJson {
  let hit = false;
  const runs = (t.runs as Run[]).map(r => {
    const s = subs.find(x => x.source.family === r.family && x.source.style === r.style);
    if (!s) return r;
    hit = true;
    return { ...r, family: s.target.family, style: s.target.style, postscript_name: '' };
  });
  return hit ? { ...t, runs } : t;
}

// Character and Paragraph Styles (D12): app-wide values; a paragraph style also carries character attributes.
export interface TextStyle { id: string; name: string; character: Record<string, unknown>; paragraph?: Record<string, unknown> }
export function newStyle(list: TextStyle[], kind: 'character' | 'paragraph', name: string, run: Run, paragraph: Run): TextStyle {
  const { length: _r, ...character } = run, { length: _p, ...para } = paragraph;
  const fallback = `${kind === 'character' ? 'Character' : 'Paragraph'} Style ${list.length + 1}`;
  return { id: crypto.randomUUID(), name: name.trim() || fallback, character, ...(kind === 'paragraph' ? { paragraph: para } : {}) };
}

// One row per missing (family, style): the type layers using it and their text in that face.
export interface MissingRow { family: string; style: string; layerIds: number[]; text: string }
export function missingRows(texts: [number, TextJson][], missing: [string, string][]): MissingRow[] {
  return missing.map(([family, style]) => {
    const users = texts.filter(([, t]) => fontUses(t).some(([f, s]) => f === family && s === style));
    return { family, style, layerIds: users.map(([id]) => id), text: users.map(([, t]) => fontText(t, family, style)).join('') };
  });
}
