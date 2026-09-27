import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TextLayout } from './typesession.ts';
import { boxDrag, caretX, indexAt, layerName, lineMove, newText, selectionRects, TypeSession } from './typesession.ts';

const text = (s = '') => newText({ family: '', style: 'Regular', size: 28, color: [0, 0, 0], alignment: 'left', orientation: 'horizontal' }, { type: 'point' }, [10, 20]);
const at = (t0: number) => { let t = t0; return () => (t += 100); };
const sum = (spans: { length: number }[]) => spans.reduce((a, s) => a + s.length, 0);
const len16 = (s: TypeSession) => (s.text.text as string).length;

test('a drag of 5 px makes point text, 6 px or more makes paragraph text', () => {
  assert.equal(boxDrag(5, -5), false);
  assert.equal(boxDrag(6, 0), true);
  assert.equal(boxDrag(-2, -6), true);
});

test('typing abc is one undo step, ab c is two', () => {
  const now = at(0);
  const a = new TypeSession(text());
  for (const c of 'abc') a.insert(c, now());
  assert.equal(a.text.text, 'abc');
  assert.equal(a.steps, 1);
  const b = new TypeSession(text());
  for (const c of 'ab c') b.insert(c, now());
  assert.equal(b.steps, 2);
  b.undo();
  assert.equal(b.text.text, 'ab');
  assert.equal(b.caret, 2);
  b.redo();
  assert.equal(b.text.text, 'ab c');
});

test('a pause longer than the window starts a new step', () => {
  const s = new TypeSession(text());
  s.insert('a', 0);
  s.insert('b', 100_000);
  assert.equal(s.steps, 2);
});

test('Backspace removes a surrogate pair and a combining sequence as one', () => {
  const s = new TypeSession(text());
  s.insert('a\u{1F600}é', 0);
  s.backspace(1);
  assert.equal(s.text.text, 'a\u{1F600}');
  s.backspace(2);
  assert.equal(s.text.text, 'a');
  assert.equal(s.caret, 1);
  s.move(0, false);
  s.deleteForward(3);
  assert.equal(s.text.text, '');
  assert.equal(sum(s.text.runs), 0);
  assert.equal(s.text.runs.length, 1, 'an empty text keeps one zero-length run');
});

test('runs and paragraphs always cover the text; typing over a selection takes its first run', () => {
  const s = new TypeSession(text());
  s.insert('hello world', 0);
  s.move(6, false);
  s.move(11, true);
  s.applyRun({ faux_bold: true }, 1);
  assert.deepEqual(s.text.runs.map((r: { length: number; faux_bold: boolean }) => [r.length, r.faux_bold]), [[6, false], [5, true]]);
  s.insert('X', 2);
  assert.equal(s.text.text, 'hello X');
  assert.equal(s.text.runs.at(-1).faux_bold, true);
  s.insert('\n', 3);
  assert.equal(sum(s.text.runs), len16(s));
  assert.equal(sum(s.text.paragraphs), len16(s));
});

test('a collapsed caret makes character attributes pending for the next typing without a step', () => {
  const s = new TypeSession(text());
  s.insert('ab', 0);
  const steps = s.steps;
  s.applyRun({ size: 50 }, 1);
  assert.equal(s.steps, steps);
  s.insert('c', 2);
  assert.deepEqual(s.text.runs.map((r: { length: number; size: number }) => [r.length, r.size]), [[2, 28], [1, 50]]);
});

test('paragraph attributes apply to the caret paragraph', () => {
  const s = new TypeSession(text());
  s.insert('one\ntwo', 0);
  s.applyParagraph({ alignment: 'center' }, 1);
  assert.deepEqual(s.text.paragraphs.map((p: { length: number; alignment: string }) => [p.length, p.alignment]), [[4, 'left'], [3, 'center']]);
});

test('changed is false until the text or attributes differ from the start', () => {
  const s = new TypeSession(text());
  assert.equal(s.changed, false);
  s.insert('a', 0);
  s.backspace(1);
  assert.equal(s.changed, false, 'same text again');
  s.insert('a', 2);
  assert.equal(s.changed, true);
});

test('the layer name is the first line, 30 characters plus an ellipsis, or Type Layer', () => {
  assert.equal(layerName(''), 'Type Layer');
  assert.equal(layerName('\nsecond'), 'Type Layer');
  assert.equal(layerName('Hello\nworld'), 'Hello');
  assert.equal(layerName('x'.repeat(31)), `${'x'.repeat(30)}…`);
  assert.equal(layerName('x'.repeat(30)), 'x'.repeat(30));
});

// Two lines "ab\n" and "cd": glyphs 10 px wide at x 0, 10.
const TWO: TextLayout = {
  transform: [1, 0, 0, 1, 0, 0], overflow: false, lines: [
    { x: 0, y: 20, width: 20, ascent: 16, descent: 4, start: 0, end: 3, glyphs: [[0, 0, 20, 10], [1, 10, 20, 10]] },
    { x: 0, y: 44, width: 20, ascent: 16, descent: 4, start: 3, end: 5, glyphs: [[3, 0, 44, 10], [4, 10, 44, 10]] },
  ],
};

test('caret x sits at glyph edges; the end of a line is after its last glyph', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(i => caretX(TWO, 'ab\ncd', i, false)), [0, 10, 20, 0, 10, 20]);
});

test('right-to-left glyphs put the leading edge on the right', () => {
  const rtl: TextLayout = { transform: [1, 0, 0, 1, 0, 0], overflow: false, lines: [
    { x: 0, y: 20, width: 20, ascent: 16, descent: 4, start: 0, end: 2, glyphs: [[1, 0, 20, 10], [0, 10, 20, 10]] },
  ] };
  assert.deepEqual([0, 1, 2].map(i => caretX(rtl, 'אב', i, false)), [20, 10, 0]);
  assert.equal(indexAt(rtl, 'אב', 19, 20, false), 0);
  assert.equal(indexAt(rtl, 'אב', 1, 20, false), 2);
});

test('a click picks the nearest line and the nearest caret position', () => {
  assert.equal(indexAt(TWO, 'ab\ncd', 12, 18, false), 1);
  assert.equal(indexAt(TWO, 'ab\ncd', 40, 18, false), 2, 'past the end stays before the newline');
  assert.equal(indexAt(TWO, 'ab\ncd', 16, 60, false), 5);
});

test('Up and Down move by laid-out line keeping x', () => {
  assert.deepEqual(lineMove(TWO, 'ab\ncd', 1, 1, null, false), { index: 4, goal: 10 });
  assert.deepEqual(lineMove(TWO, 'ab\ncd', 4, -1, 10, false), { index: 1, goal: 10 });
  assert.deepEqual(lineMove(TWO, 'ab\ncd', 1, -1, null, false), { index: 0, goal: 10 }, 'above the first line: text start');
  assert.deepEqual(lineMove(TWO, 'ab\ncd', 4, 1, null, false), { index: 5, goal: 10 }, 'below the last line: text end');
});

test('selection rectangles are per line over the selected glyphs', () => {
  assert.deepEqual(selectionRects(TWO, 1, 4, false), [
    { line: 0, from: 10, to: 20 },
    { line: 1, from: 0, to: 10 },
  ]);
});
