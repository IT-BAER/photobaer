import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADJUSTMENT_KINDS, FIELD_LABELS, FIELD_SPECS, defaultAdjustment, fieldLabel, defaultDestructive, getPath, setPath, type AnyKind, type Kind } from './adjustments.ts';
import { i18n } from './i18n/index.ts';

test('every generic field path resolves in its kind\'s defaults, inside the field\'s range', () => {
  for (const [kind, specs] of Object.entries(FIELD_SPECS) as [AnyKind, NonNullable<(typeof FIELD_SPECS)[AnyKind]>][]) {
    const params = ADJUSTMENT_KINDS.includes(kind as Kind) ? defaultAdjustment(kind as Kind).params : defaultDestructive(kind as Exclude<AnyKind, Kind>).params;
    for (const s of specs) {
      const v = getPath(params, s.path);
      if (s.type === 'number') {
        assert.equal(typeof v, 'number', `${kind} ${s.path}`);
        assert.ok((v as number) >= s.min && (v as number) <= s.max, `${kind} ${s.path} = ${v}`);
      } else if (s.type === 'checkbox') assert.equal(typeof v, 'boolean', `${kind} ${s.path}`);
      else assert.ok(s.options.some(([o]) => o === v), `${kind} ${s.path}`);
    }
  }
});

test('setPath clones the touched branch and leaves the original alone', () => {
  const a = defaultAdjustment('channel_mixer');
  const b = setPath(a, 'red.3', 50);
  assert.equal(getPath(b.params, 'red.3'), 50);
  assert.equal(getPath(a.params, 'red.3'), 0);
  assert.ok(Array.isArray(getPath(b.params, 'red')));
  assert.equal(getPath(b.params, 'green'), getPath(a.params, 'green'));
});

test('every field label and option name has a message with its English text, and none is unused', () => {
  const texts = new Set(Object.values(FIELD_SPECS).flat().flatMap(s => [s.label, ...(s.type === 'select' ? s.options.map(([, l]) => l) : [])]));
  assert.deepEqual([...texts].filter(t => !Object.hasOwn(FIELD_LABELS, t)), []);
  assert.deepEqual(Object.keys(FIELD_LABELS).filter(t => !texts.has(t)), []);
  for (const [text, d] of Object.entries(FIELD_LABELS)) assert.equal(d.message, text);
});

test('fieldLabel shows the active language, option values stay English', () => {
  i18n.loadAndActivate({ locale: 'de', messages: { [FIELD_LABELS['Reds C'].id!]: 'Rottöne C' } });
  try {
    assert.equal(fieldLabel('Reds C'), 'Rottöne C');
    assert.equal(fieldLabel('Radius (px)'), 'Radius (px)');
  } finally {
    i18n.loadAndActivate({ locale: 'en', messages: {} });
  }
  const mode = FIELD_SPECS.selective_color!.find(s => s.path === 'mode')!;
  assert.deepEqual(mode.type === 'select' && mode.options.map(([v]) => v), ['relative', 'absolute']);
});

test('a gradient stop keeps its 32-bit Intensity between the Gradient Editor and the engine gradient', async () => {
  const { gradientDefToUi, uiToGradientDef } = await import('./adjustments.ts');
  const { withIntensity } = await import('./shell/color.ts');
  const ui = { stops: [{ position: 0, color: [10, 20, 30] as [number, number, number], midpoint: 0.5, intensity: 1.5 }, { position: 1, color: withIntensity([1, 2, 3], -2), midpoint: 0.5 }],
    opacityStops: [{ position: 0, opacity: 1, midpoint: 0.5 }], kind: 'solid' as const, interpolation: 'classic' as const };
  const def = uiToGradientDef(ui);
  assert.deepEqual(def.color_stops.map(s => s.intensity), [1.5, -2], 'own Intensity, or a Foreground/Background color\'s');
  assert.equal('intensity' in uiToGradientDef({ ...ui, stops: [{ position: 0, color: [0, 0, 0], midpoint: 0.5 }] }).color_stops[0], false);
  assert.deepEqual(gradientDefToUi(def).stops.map(s => s.intensity), [1.5, -2]);
});
