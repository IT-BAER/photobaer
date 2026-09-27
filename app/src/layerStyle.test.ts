import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTOUR_PRESETS, defaultEffect, effectRows, emptyStyle, setEffectEnabled, setIn, type LayerStyle } from './layerStyle.ts';

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
