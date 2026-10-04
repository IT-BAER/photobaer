import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA_POINTS, DEFAULT_SCALE, markerRect, parsePoints, pickColumns, scaleMeasurement, scaleText } from './analysis.ts';
import { toCsv } from './measure.ts';

test('scaleMeasurement converts lengths linearly and areas by the square', () => {
  const s = { pixels: 100, logical: 2, units: 'cm' };
  const m = scaleMeasurement({ source: 'Selection', area: 10000, perimeter: 400, width: 100, height: 50 }, s);
  assert.equal(m.area, 4);
  assert.equal(m.perimeter, 8);
  assert.equal(m.width, 2);
  assert.equal(m.height, 1);
  assert.equal(m.units, 'cm');
  assert.equal(m.scale, '100 px = 2 cm');
  const r = scaleMeasurement({ source: 'Ruler', length: 50, angle: 30 }, s);
  assert.equal(r.length, 1);
  assert.equal(r.angle, 30, 'angles do not scale');
  assert.equal(scaleMeasurement({ source: 'Count', count: 3 }, s).count, 3, 'counts do not scale');
  assert.equal(scaleMeasurement({ source: 'Ruler', length: 7 }, DEFAULT_SCALE).length, 7);
});

test('scaleText and pickColumns', () => {
  assert.equal(scaleText({ pixels: 72, logical: 1, units: 'in' }), '72 px = 1 in');
  const cols = pickColumns(['area', 'length']);
  assert.deepEqual(cols.map(c => c[0]), ['label', 'date', 'document', 'source', 'scale', 'units', 'area', 'length']);
});

test('markerRect sits at the bottom left inside a 5% margin and keeps its length', () => {
  const r = markerRect(400, 300, 100, 4);
  assert.deepEqual(r, { x: 20, y: 281, w: 100, h: 4 });
  assert.deepEqual(markerRect(400, 300, 1000, 4).w, 360, 'a marker never leaves the canvas');
});

test('parsePoints keeps known data points and falls back to all of them', () => {
  assert.deepEqual(parsePoints('["area","bogus","length"]'), ['area', 'length']);
  assert.deepEqual(parsePoints(null), DATA_POINTS);
  assert.deepEqual(parsePoints('{oops'), DATA_POINTS);
  assert.deepEqual(parsePoints('[]'), [], 'an empty choice stays empty');
  assert.equal(DATA_POINTS.includes('label' as never), false, 'fixed columns are not choosable');
});

test('toCsv writes the chosen columns', () => {
  const rows = [{ label: 'Measurement 1', date: 'd', document: 'a.psd', source: 'Ruler' as const, length: 1.5, scale: '2 px = 1 cm', units: 'cm' }];
  assert.equal(toCsv(rows, pickColumns(['length'])), 'Label,Date and Time,Document,Source,Scale,Units,Length\nMeasurement 1,d,a.psd,Ruler,2 px = 1 cm,cm,1.5');
});

test('toCsv neutralizes spreadsheet formulas in text cells but keeps negative numbers', () => {
  const rows = [{ label: 'Measurement 1', date: 'd', document: '=HYPERLINK("x")', source: 'Ruler' as const, angle: -30, units: '@cm' }];
  assert.equal(toCsv(rows, pickColumns(['angle'])).split('\n')[1], `Measurement 1,d,"'=HYPERLINK(""x"")",Ruler,,'@cm,-30`);
});
