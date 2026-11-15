// Edit > Find and Replace Text: matching on type layer text in UTF-16 units (the text model's unit).
import type { TextJson } from '../psd/text.ts';

export interface FindOptions { caseSensitive: boolean; wholeWord: boolean; ignoreAccents: boolean }
// A match (or, after a change, a collapsed position) in type layer `id`.
export interface Cursor { id: number; start: number; end: number }

const WORD = /[\p{L}\p{N}_]/u;
const fold = (c: string, o: FindOptions) => {
  const s = o.caseSensitive ? c : c.toLowerCase();
  return o.ignoreAccents ? s.normalize('NFD').replace(/\p{M}/gu, '') : s;
};
const charAt = (s: string, i: number) => String.fromCodePoint(s.codePointAt(i)!);
// The code point that ends at `i` ('' at the start).
const charBefore = (s: string, i: number) => i <= 0 ? '' : i >= 2 && /[\uDC00-\uDFFF]/.test(s[i - 1]) && /[\uD800-\uDBFF]/.test(s[i - 2]) ? s.slice(i - 2, i) : s[i - 1];

// Non-overlapping [start, end) ranges of `find` in `text`, compared one code point at a time so folding stays aligned.
export function findMatches(text: string, find: string, o: FindOptions): [number, number][] {
  const needle = [...find].map(c => fold(c, o)).join('');
  if (!needle) return [];
  const out: [number, number][] = [];
  let at = 0;
  while (at < text.length) {
    let hay = '', end = at;
    while (end < text.length && hay.length < needle.length) {
      const c = charAt(text, end);
      hay += fold(c, o);
      end += c.length;
    }
    const before = charBefore(text, at), after = end < text.length ? charAt(text, end) : '';
    if (hay === needle && (!o.wholeWord || (!WORD.test(before) && !WORD.test(after)))) {
      out.push([at, end]);
      at = end;
      continue;
    }
    at += charAt(text, at).length;
  }
  return out;
}

// Span lengths after [a, b) becomes n units: the span holding `a` takes them, emptied spans drop, one span stays.
function spliceSpans<T extends { length: number }>(spans: T[], a: number, b: number, n: number): T[] {
  const total = spans.reduce((s, x) => s + x.length, 0);
  let start = 0;
  const out = spans.map((x, i) => {
    const end = start + x.length;
    const cut = Math.max(0, Math.min(end, b) - Math.max(start, a));
    const holds = a >= start && (a < end || (a === total && i === spans.length - 1));
    start = end;
    return { ...x, length: x.length - cut + (holds ? n : 0) };
  });
  const kept = out.filter(x => x.length > 0);
  return kept.length ? kept : [{ ...out[0], length: 0 }];
}

// The model with text [a, b) replaced by `s`; the replacement takes the style of the run where the match starts.
export function spliceText(t: TextJson, a: number, b: number, s: string): TextJson {
  return {
    ...t, text: t.text.slice(0, a) + s + t.text.slice(b),
    runs: spliceSpans(t.runs, a, b, s.length), paragraphs: spliceSpans(t.paragraphs, a, b, s.length),
  };
}

// The next match after `cursor` (layers in Layers panel order, top first), wrapping around; backward walks
// the layers bottom up and each text from its end. Null when nothing matches.
export function nextMatch(layers: { id: number; text: string }[], find: string, o: FindOptions, cursor: Cursor | null, forward: boolean): Cursor | null {
  const order = forward ? layers : [...layers].reverse();
  if (!order.length) return null;
  const from = Math.max(0, cursor ? order.findIndex(l => l.id === cursor.id) : 0);
  for (let k = 0; k <= order.length; k++) {
    const l = order[(from + k) % order.length], ms = findMatches(l.text, find, o);
    const here = k === 0 && cursor?.id === l.id;
    const hit = forward ? ms.find(m => !here || m[0] >= cursor.end) : ms.findLast(m => !here || m[1] <= cursor.start);
    if (hit) return { id: l.id, start: hit[0], end: hit[1] };
  }
  return null;
}
