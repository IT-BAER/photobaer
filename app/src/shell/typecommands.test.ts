import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendText, featureOn, missingRows, newStyle, fontText, fontUses, layoutBounds, LOREM, loremText, setFeature, setParagraphs, setRuns, substituteFonts, toParagraphText, toPointText } from './typecommands.ts';
import { newText, type TextLayout } from './typesession.ts';
import type { TextJson } from '../psd/text.ts';

const base = newText({ family: 'Noto Sans', style: 'Regular', size: 20, color: [1, 2, 3], alignment: 'center', orientation: 'horizontal' }, { type: 'paragraph', box: [0, 0, 200, 80] }, [10, 20]);
const withText = (s: string, t = base): TextJson => ({ ...t, text: s, runs: [{ ...t.runs[0], length: s.length }], paragraphs: [{ ...t.paragraphs[0], length: s.length }] });
const LAYOUT: TextLayout = { transform: [1, 0, 0, 1, 10, 20], overflow: false, lines: [
  { x: 60, y: 18, width: 80, ascent: 15, descent: 5, start: 0, end: 5, glyphs: [] },
  { x: 70, y: 42, width: 60, ascent: 15, descent: 5, start: 5, end: 9, glyphs: [] },
] };

test('layout bounds span every line box in text space', () => {
  assert.deepEqual(layoutBounds(LAYOUT, false), [60, 3, 140, 47]);
});

test('Convert to Paragraph Text: box = laid-out bounds + 1 px, transform kept; paragraph text is skipped', () => {
  const point: TextJson = { ...withText('abcd efgh'), shape: { type: 'point' } };
  const p = toParagraphText(point, LAYOUT)!;
  assert.deepEqual(p.shape, { type: 'paragraph', box: [60, 3, 141, 48] });
  assert.deepEqual(p.transform, point.transform);
  assert.equal(toParagraphText(withText('x'), LAYOUT), null);
});

test('Convert to Point Text anchors x by the first alignment and y at the first baseline', () => {
  const t: TextJson = { ...withText('abcd efgh'), transform: [2, 0, 0, 2, 10, 20] };
  const p = toPointText(t, LAYOUT)!;
  assert.deepEqual(p.shape, { type: 'point' });
  assert.deepEqual(p.transform, [2, 0, 0, 2, 10 + 2 * 100, 20 + 2 * 18], 'center of box 0..200, baseline 18, through the 2x matrix');
  const right = { ...t, paragraphs: [{ ...t.paragraphs[0], alignment: 'right' }] };
  assert.equal(toPointText(right, LAYOUT)!.transform[4], 10 + 2 * 200);
  const just = { ...t, paragraphs: [{ ...t.paragraphs[0], alignment: 'justify_center' }] };
  assert.equal(toPointText(just, LAYOUT)!.transform[4], 10, 'justified alignments anchor left');
  assert.equal(toPointText({ ...t, shape: { type: 'point' } }, LAYOUT), null);
});

test('run and paragraph setters touch every span and keep lengths', () => {
  const t = { ...withText('ab\ncd'), runs: [{ ...base.runs[0], length: 2 }, { ...base.runs[0], length: 3, size: 9 }] };
  const r = setRuns(t, { anti_alias: 'crisp' });
  assert.deepEqual(r.runs.map((x: { length: number; anti_alias: string; size: number }) => [x.length, x.anti_alias, x.size]), [[2, 'crisp', 20], [3, 'crisp', 9]]);
  assert.deepEqual(setParagraphs(t, { alignment: 'right' }).paragraphs.map((p: { length: number; alignment: string }) => [p.length, p.alignment]), [[5, 'right']]);
});

test('OpenType features: liga and dlig use their run flags, calt defaults on, others default off', () => {
  const r = base.runs[0];
  assert.equal(featureOn(r, 'liga'), true);
  assert.equal(featureOn(r, 'dlig'), false);
  assert.equal(featureOn(r, 'calt'), true);
  assert.equal(featureOn(r, 'swsh'), false);
  assert.deepEqual(setFeature(r, 'dlig', true).discretionary_ligatures, true);
  assert.deepEqual(setFeature(r, 'swsh', true).features, { swsh: true });
  assert.equal(setFeature(r, 'liga', false).ligatures, false);
});

test('Paste Lorem Ipsum replaces the text with one run and paragraph, or inserts at a position', () => {
  const t = { ...withText('ab'), runs: [{ ...base.runs[0], length: 1 }, { ...base.runs[0], length: 1, size: 9 }] };
  const all = loremText(t);
  assert.equal(all.text, LOREM);
  assert.deepEqual(all.runs.map((x: { length: number }) => x.length), [LOREM.length]);
  const at = loremText(t, 1);
  assert.equal(at.text, `a${LOREM}b`);
  assert.deepEqual(at.runs.map((x: { length: number }) => x.length), [1 + LOREM.length, 1], 'the span holding the position grows');
  assert.deepEqual(loremText(t, 0).runs.map((x: { length: number }) => x.length), [1 + LOREM.length, 1], 'position 0 grows the first span');
});

const twoRuns = (): TextJson => {
  const t = withText('Hello World');
  return { ...t, runs: [{ ...t.runs[0], length: 6 }, { ...t.runs[0], family: 'Gone Sans', style: 'Bold', postscript_name: 'GoneSans-Bold', length: 5 }] };
};

test('Insert Glyph appends to the last run and paragraph', () => {
  const t = appendText(twoRuns(), 'é');
  assert.equal(t.text, 'Hello Worldé');
  assert.deepEqual(t.runs.map((r: { length: number }) => r.length), [6, 6]);
  assert.deepEqual(t.paragraphs.map((p: { length: number }) => p.length), [12]);
});

test('font uses list each family and style once; fontText joins the text set in one face', () => {
  const t = twoRuns();
  assert.deepEqual(fontUses(t), [['Noto Sans', 'Regular'], ['Gone Sans', 'Bold']]);
  assert.equal(fontText(t, 'Gone Sans', 'Bold'), 'World');
  assert.equal(fontText(t, 'Nope', 'Regular'), '');
});

test('substituteFonts maps matching runs only and clears their PostScript name; no match returns the same object', () => {
  const t = twoRuns();
  const s = substituteFonts(t, [{ source: { family: 'Gone Sans', style: 'Bold' }, target: { family: 'Noto Sans', style: 'Bold' } }]);
  assert.deepEqual(s.runs.map((r: Record<string, unknown>) => [r.family, r.style, r.postscript_name, r.length]), [['Noto Sans', 'Regular', t.runs[0].postscript_name, 6], ['Noto Sans', 'Bold', '', 5]]);
  assert.equal(substituteFonts(t, [{ source: { family: 'X', style: 'Y' }, target: { family: 'Noto Sans', style: 'Bold' } }]), t);
});

test('a saved style takes run 0 (and paragraph 0 for a paragraph style) without lengths; empty names count up', () => {
  const t = twoRuns();
  const a = newStyle([], 'character', '  ', t.runs[0], t.paragraphs[0]);
  assert.equal(a.name, 'Character Style 1');
  assert.equal('length' in a.character, false);
  assert.equal(a.character.family, 'Noto Sans');
  assert.equal(a.paragraph, undefined);
  const b = newStyle([a], 'paragraph', ' Body ', t.runs[0], t.paragraphs[0]);
  assert.equal(b.name, 'Body');
  assert.equal(b.paragraph!.alignment, 'center');
  assert.equal('length' in b.paragraph!, false);
  assert.equal(newStyle([a, b], 'paragraph', '', t.runs[0], t.paragraphs[0]).name, 'Paragraph Style 3');
  assert.notEqual(a.id, b.id);
});

test('missing rows list each missing face once with the layers and text that use it', () => {
  const a = twoRuns(), b = { ...withText('Bye'), runs: [{ ...twoRuns().runs[1], length: 3 }] };
  const rows = missingRows([[4, a], [9, b], [11, withText('ok')]], [['Gone Sans', 'Bold']]);
  assert.deepEqual(rows, [{ family: 'Gone Sans', style: 'Bold', layerIds: [4, 9], text: 'WorldBye' }]);
  assert.deepEqual(missingRows([[4, a]], []), []);
});
