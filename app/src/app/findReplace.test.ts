import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMatches, nextMatch, spliceText, type FindOptions } from './findReplace.ts';

const o = (p: Partial<FindOptions> = {}): FindOptions => ({ caseSensitive: false, wholeWord: false, ignoreAccents: false, ...p });

test('findMatches: case folding, whole words, accents, UTF-16 ranges', () => {
  assert.deepEqual(findMatches('Cat cat CAT', 'cat', o()), [[0, 3], [4, 7], [8, 11]]);
  assert.deepEqual(findMatches('Cat cat CAT', 'cat', o({ caseSensitive: true })), [[4, 7]]);
  assert.deepEqual(findMatches('cat concat cats cat_x cat', 'cat', o({ wholeWord: true })), [[0, 3], [22, 25]]);
  assert.deepEqual(findMatches('Café cafe CAFÉ', 'cafe', o()), [[5, 9]]);
  assert.deepEqual(findMatches('Café cafe CAFÉ', 'cafe', o({ ignoreAccents: true })), [[0, 4], [5, 9], [10, 14]]);
  assert.deepEqual(findMatches('😀a😀a', 'a', o()), [[2, 3], [5, 6]], 'surrogate pairs count as two units');
  assert.deepEqual(findMatches('𝐀a 😀a', 'a', o({ wholeWord: true })), [[6, 7]], 'a letter outside the BMP before the match is a word character');
  assert.deepEqual(findMatches('aaaa', 'aa', o()), [[0, 2], [2, 4]], 'matches do not overlap');
  assert.deepEqual(findMatches('abc', '', o()), []);
  assert.deepEqual(findMatches('Straße', 'STRASSE', o()), [], 'no multi-letter case expansion');
});

const model = (text: string, runs: number[], paragraphs: number[] = [text.length]) => ({
  text, runs: runs.map((length, i) => ({ length, size: 10 + i })), paragraphs: paragraphs.map((length, i) => ({ length, align: i })), shape: { type: 'point' },
});
const lens = (l: { length: number }[]) => l.map(x => x.length);

test('spliceText keeps runs and paragraphs covering the text; the replacement takes the style at the match start', () => {
  // "Hello world": run 0 "Hello " (6), run 1 "world" (5)
  const t = model('Hello world', [6, 5]);
  const a = spliceText(t, 6, 11, 'there!');
  assert.equal(a.text, 'Hello there!');
  assert.deepEqual(lens(a.runs), [6, 6]);
  assert.equal(a.runs[1].size, 11);
  const b = spliceText(t, 4, 8, 'X');
  assert.equal(b.text, 'HellXrld');
  assert.deepEqual(lens(b.runs), [5, 3], 'the run where the match starts takes the new text');
  assert.equal(b.runs[0].size, 10);
  const c = spliceText(model('ab|cd|ef', [3, 3, 2]), 2, 7, '');
  assert.equal(c.text, 'abf');
  assert.deepEqual(lens(c.runs), [2, 1], 'a run emptied by the change is dropped');
  assert.deepEqual(c.runs.map((r: { size: number }) => r.size), [10, 12]);
  const d = spliceText(model('abc', [3]), 0, 3, '');
  assert.equal(d.text, '');
  assert.deepEqual(lens(d.runs), [0], 'empty text keeps one run');
  assert.deepEqual(lens(d.paragraphs), [0]);
  const p = spliceText(model('one\rtwo two', [11], [4, 7]), 8, 11, 'three');
  assert.deepEqual(lens(p.paragraphs), [4, 9]);
  assert.equal(p.shape.type, 'point', 'other fields stay');
});

const layers = [{ id: 1, text: 'a b a' }, { id: 2, text: 'none' }, { id: 3, text: 'a' }];

test('nextMatch walks forward through the layers and wraps around', () => {
  let c = nextMatch(layers, 'a', o(), null, true);
  assert.deepEqual(c, { id: 1, start: 0, end: 1 });
  c = nextMatch(layers, 'a', o(), c, true);
  assert.deepEqual(c, { id: 1, start: 4, end: 5 });
  c = nextMatch(layers, 'a', o(), c, true);
  assert.deepEqual(c, { id: 3, start: 0, end: 1 });
  c = nextMatch(layers, 'a', o(), c, true);
  assert.deepEqual(c, { id: 1, start: 0, end: 1 }, 'wraps to the first layer');
  assert.equal(nextMatch(layers, 'zz', o(), null, true), null);
  assert.equal(nextMatch([], 'a', o(), null, true), null);
});

test('nextMatch backward walks the layers bottom up and each text from its end', () => {
  let c = nextMatch(layers, 'a', o(), null, false);
  assert.deepEqual(c, { id: 3, start: 0, end: 1 });
  c = nextMatch(layers, 'a', o(), c, false);
  assert.deepEqual(c, { id: 1, start: 4, end: 5 });
  c = nextMatch(layers, 'a', o(), c, false);
  assert.deepEqual(c, { id: 1, start: 0, end: 1 });
  c = nextMatch(layers, 'a', o(), c, false);
  assert.deepEqual(c, { id: 3, start: 0, end: 1 });
});

test('nextMatch from a collapsed cursor after a change finds the following match', () => {
  const after = [{ id: 1, text: 'xyz b a' }];
  assert.deepEqual(nextMatch(after, 'a', o(), { id: 1, start: 3, end: 3 }, true), { id: 1, start: 6, end: 7 });
  assert.deepEqual(nextMatch(after, 'a', o(), { id: 9, start: 0, end: 0 }, true), { id: 1, start: 6, end: 7 }, 'a cursor on a gone layer starts over');
});
