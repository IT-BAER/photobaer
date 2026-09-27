import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTOUR_PRESETS, StyleLibrary, defaultBlending, defaultEffect, effectRows, emptyStyle, patternChoices, patternRefs, setEffectEnabled, setIn, type LayerStyle } from './layerStyle.ts';

test('18 contour presets on whole 0..255 levels, three in pencil mode, starting at Linear', () => {
  assert.equal(CONTOUR_PRESETS.length, 18);
  assert.deepEqual(CONTOUR_PRESETS[0].points, [[0, 0], [255, 255]]);
  assert.deepEqual(CONTOUR_PRESETS.filter(c => c.mode === 'pencil').map(c => c.name), ['Sawtooth 1', 'Sawtooth 2', 'Steps']);
  for (const c of CONTOUR_PRESETS) {
    assert.ok(c.points.flat().every(v => Number.isInteger(v) && v >= 0 && v <= 255), c.name);
    const xs = c.points.map(p => p[0]);
    assert.equal(new Set(xs).size, xs.length, `${c.name} has distinct inputs`);
  }
});

test('effect rows list present effects with instance numbers, and an eye toggles one instance', () => {
  const s = {
    ...emptyStyle(),
    drop_shadows: [defaultEffect('drop_shadows'), defaultEffect('drop_shadows')],
    strokes: [{ ...defaultEffect('strokes'), present: false }],
    bevel: defaultEffect('bevel'),
    contour: defaultEffect('contour'),
  } as unknown as LayerStyle;
  assert.deepEqual(effectRows(s).map(r => r.name), ['Bevel & Emboss', 'Drop Shadow', 'Drop Shadow 2']);
  const off = setEffectEnabled(s, 'drop_shadows', 1, false);
  assert.deepEqual(effectRows(off).map(r => r.enabled), [true, true, false]);
  assert.equal(s.drop_shadows[1].enabled, true, 'the input style is not mutated');
  assert.deepEqual(setIn({ a: [1, { b: 2 }] }, 'a.1.b', 3), { a: [1, { b: 3 }] });
});

test('saved styles start empty, persist through storage, search by name and apply as deep copies', () => {
  const data: Record<string, string> = {};
  const storage = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
  const lib = new StyleLibrary(storage);
  assert.deepEqual(lib.list(), []);
  const style: LayerStyle = { ...emptyStyle(), drop_shadows: [defaultEffect('drop_shadows') as unknown as LayerStyle['drop_shadows'][0]] };
  const blending = defaultBlending();
  const saved = lib.save('  Soft Shadow  ', style, blending);
  style.drop_shadows[0].distance = 99;
  blending.knockout = 'deep';
  assert.equal(saved.name, 'Soft Shadow');
  assert.equal(lib.save('', emptyStyle(), defaultBlending()).name, 'Style 2');
  const reopened = new StyleLibrary(storage);
  assert.deepEqual(reopened.list().map(s => s.name), ['Soft Shadow', 'Style 2']);
  assert.deepEqual(reopened.list('soft').map(s => s.id), [saved.id]);
  const a = reopened.apply(saved.id)!;
  assert.equal(a.style.drop_shadows[0].distance, 5, 'saving copied the style');
  assert.equal(a.blending.knockout, 'none');
  a.style.drop_shadows[0].distance = 42;
  assert.equal(reopened.apply(saved.id)!.style.drop_shadows[0].distance, 5, 'apply hands out a copy');
  reopened.list()[0].style.enabled = false;
  assert.equal(reopened.apply(saved.id)!.style.enabled, true, 'list hands out copies');
  assert.equal(reopened.apply('missing'), undefined);

  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  const mem = new StyleLibrary(broken);
  mem.save('Mem', emptyStyle(), defaultBlending());
  assert.deepEqual(mem.list().map(s => s.name), ['Mem']);
  assert.deepEqual(new StyleLibrary({ getItem: () => '{not json', setItem: () => {} }).list(), []);
});

test('patternRefs lists every pattern id a style or fill content names', () => {
  const style: LayerStyle = { ...emptyStyle(), pattern_overlays: [defaultEffect('pattern_overlays', 'a') as unknown as LayerStyle['pattern_overlays'][0]], texture: defaultEffect('texture', 'b') as unknown as LayerStyle['texture'] };
  assert.deepEqual(patternRefs(style).sort(), ['a', 'b']);
  assert.deepEqual(patternRefs({ type: 'pattern', pattern_id: 'c' }), ['c']);
});

test('saved styles delete one entry or clear all, persisting each change', () => {
  const data: Record<string, string> = {};
  const storage = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
  const lib = new StyleLibrary(storage);
  const a = lib.save('A', emptyStyle(), defaultBlending());
  lib.save('B', emptyStyle(), defaultBlending());
  lib.remove(a.id);
  assert.deepEqual(new StyleLibrary(storage).list().map(s => s.name), ['B']);
  lib.remove('missing');
  lib.clear();
  assert.deepEqual(new StyleLibrary(storage).list(), []);
});

test('pattern choices list document patterns, then presets the document lacks, filtered by name', () => {
  const doc = [{ id: 'd1', name: 'Bricks' }, { id: 'p2', name: 'Hatch copy' }];
  const presets = [{ id: 'p1', name: 'Canvas' }, { id: 'p2', name: 'Hatch' }, { id: 'p3', name: 'Cross Hatch' }];
  assert.deepEqual(patternChoices(doc, presets, ''), [
    { id: 'd1', name: 'Bricks', preset: false }, { id: 'p2', name: 'Hatch copy', preset: false },
    { id: 'p1', name: 'Canvas', preset: true }, { id: 'p3', name: 'Cross Hatch', preset: true },
  ]);
  assert.deepEqual(patternChoices(doc, presets, ' HATCH ').map(c => c.id), ['p2', 'p3']);
  assert.deepEqual(patternChoices([], [], 'x'), []);
});
