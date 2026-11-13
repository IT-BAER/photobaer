import test from 'node:test';
import assert from 'node:assert/strict';
import { i18n } from '@lingui/core';
import { CATEGORIES, convertSize, depthsFor, estimateSize, parseRecent, presetPx, presetTitle, pushRecent, searchPresets, toPx, type Preset, type RecentDoc } from './newDocument.ts';

i18n.loadAndActivate({ locale: 'en', messages: {} });
const find = (cat: string, title: string) => CATEGORIES.find(c => c.id === cat)!.presets.find(p => presetTitle(p) === title)!;

test('presets by category in Photoshop order, sizes in their own unit', () => {
  assert.deepEqual(CATEGORIES.map(c => c.id), ['photo', 'print', 'art', 'web', 'mobile', 'film', 'social']);
  assert.deepEqual(presetPx(find('print', 'Letter')), [2550, 3300]);
  assert.deepEqual(presetPx(find('print', 'A4')), [2480, 3508]);
  assert.deepEqual(presetPx(find('art', 'Comic Book')), [1988, 3075]);
  assert.deepEqual(presetPx(find('photo', 'Landscape, 6 x 4')), [1800, 1200]);
  assert.deepEqual(presetPx(find('film', 'UHD 4K')), [3840, 2160]);
  assert.ok(CATEGORIES.every(c => c.presets.length >= 4));
});

test('preset search matches titles across categories', () => {
  assert.deepEqual(searchPresets('a4').map(presetTitle), ['A4']);
  assert.ok(searchPresets('INSTAGRAM').length >= 2);
  assert.deepEqual(searchPresets('  '), []);
});

test('sizes convert from the chosen unit at the resolution; px keeps whole pixels', () => {
  assert.equal(toPx(5, 'mm', 300), 59);
  assert.equal(toPx(1920.4, 'px', 300), 1920);
  assert.equal(toPx(0.001, 'in', 72), 1, 'at least one pixel');
  assert.equal(convertSize(5, 'mm', 'cm', 300), 0.5);
  assert.equal(convertSize(8.5, 'in', 'px', 300), 2550);
  assert.equal(convertSize(2550, 'px', 'mm', 300), 215.9);
});

test('size estimate and the bit depths each color mode allows', () => {
  assert.equal(estimateSize(1920, 1080, 'rgb', 8), '5.93M');
  assert.equal(estimateSize(1920, 1080, 'cmyk', 16), '15.8M');
  assert.equal(estimateSize(800, 800, 'bitmap', 8), '78.1K');
  assert.deepEqual(depthsFor('rgb'), [8, 16, 32]);
  assert.deepEqual(depthsFor('cmyk'), [8, 16]);
  assert.deepEqual(depthsFor('bitmap'), [1]);
});

test('recent documents: newest first, no duplicates, at most five, corrupt storage ignored', () => {
  const doc = (w: number): RecentDoc => ({ w, h: 100, unit: 'px', ppi: 72, mode: 'rgb', depth: 8 });
  let list: RecentDoc[] = [];
  for (const w of [1, 2, 3, 4, 5, 6, 2]) list = pushRecent(list, doc(w));
  assert.deepEqual(list.map(d => d.w), [2, 6, 5, 4, 3]);
  assert.deepEqual(parseRecent('nope'), []);
  assert.deepEqual(parseRecent('[{"w":5}]'), [], 'entries missing fields are dropped');
  assert.deepEqual(parseRecent(JSON.stringify([doc(9)])), [doc(9)]);
  const p: Preset = { name: 'x', w: 1, h: 1, unit: 'px', ppi: 72 };
  assert.equal(presetTitle(p), 'x');
});
