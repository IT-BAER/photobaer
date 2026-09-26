import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpFor, groupPresets, presetOptions, presetStrokeParams, pushRecent, smoothingFor, smoothingSettings } from './brushParams.ts';
import { computedTip, defaultDynamics, dyn, type BrushPreset } from './preset.ts';

function preset(): BrushPreset {
  const d = defaultDynamics();
  d.color.enabled = true;
  d.wetEdges = true;
  d.buildUp = true;
  d.shape.enabled = true;
  d.shape.size = dyn({ control: 'fade', minimum: 0.01 });
  d.smoothing = { amount: 0.4, pulledString: false, catchUp: true, catchUpOnEnd: true, adjustForZoom: false };
  return { id: 'p', name: 'P', tip: computedTip({ diameter: 60, hardness: 0.2, roundness: 0.5, angle: 30 }), dynamics: d, captured: { opacity: 0.3, flow: 0.2, mode: 'multiply' } };
}
const opts = { size: 12, hardness: 80, opacity: 50, flow: 40, mode: 'screen', smoothing: 25, airbrush: false };
const ctx = { rgba: [1, 2, 3, 255] as [number, number, number, number], bg: [9, 9, 9, 255] as [number, number, number, number], seed: 77, stride: 6 as const };

test('the options bar size, hardness, opacity, flow and mode win over the preset tip and captured values', () => {
  const p = presetStrokeParams(preset(), opts, { ...ctx, tool: 'brush', mode: 'screen' });
  assert.equal(p.size, 12);
  assert.equal(p.hardness, 0.8);
  assert.equal(p.opacity, 0.5);
  assert.equal(p.flow, 0.4);
  assert.equal(p.mode, 'screen');
  assert.equal(p.roundness, 0.5);
  assert.equal(p.angle, 30);
  assert.equal(p.seed, 77);
  assert.equal(p.stride, 6);
  assert.equal(p.wetEdges, true);
  assert.equal(p.airbrush, undefined, 'the airbrush option wins');
  assert.deepEqual((p.color as { bg: number[] }).bg, [9, 9, 9, 255]);
});

test('the eraser drops color dynamics and wet edges, and passes erase to history', () => {
  const p = presetStrokeParams(preset(), { ...opts, eraseToHistory: true }, { ...ctx, tool: 'eraser', mode: 'clear' });
  assert.equal(p.mode, 'clear');
  assert.equal(p.color, undefined);
  assert.equal(p.wetEdges, undefined);
  assert.equal(p.eraseToHistory, true);
});

test('pressure toggles add pen pressure control on top of the preset dynamics', () => {
  const p = presetStrokeParams(preset(), { ...opts, pressureSize: true, pressureOpacity: true }, { ...ctx, tool: 'brush', mode: 'normal' });
  assert.deepEqual((p.shapeDyn as { size: unknown }).size, { control: 'penPressure', fadeSteps: 25, jitter: 0, minimum: 0.02 });
  assert.deepEqual((p.transfer as { opacityDyn: unknown }).opacityDyn, { control: 'penPressure', fadeSteps: 25, jitter: 0, minimum: 1 });
  const src = preset();
  presetStrokeParams(src, { ...opts, pressureSize: true }, { ...ctx, tool: 'brush', mode: 'normal' });
  assert.equal(src.dynamics.shape.size.control, 'fade', 'the preset itself is not mutated');
});

test('the options bar smoothing wins; pulled string and catch-up options fall back to the preset, else the classic model', () => {
  assert.deepEqual(smoothingFor(preset(), opts), { smoothing: 25, pulledString: false, catchUp: true, catchUpOnEnd: true, adjustForZoom: false });
  assert.deepEqual(smoothingFor(preset(), { pulledString: true }), { smoothing: 40, pulledString: true, catchUp: false, catchUpOnEnd: true, adjustForZoom: false });
  assert.deepEqual(smoothingFor(null, opts), { smoothing: 25, pulledString: true, catchUp: false, catchUpOnEnd: true, adjustForZoom: true });
  assert.deepEqual(smoothingSettings(null, { smoothing: 5, strokeCatchUp: true, adjustForZoom: false }),
    { amount: 5, pulledString: true, catchUp: true, catchUpOnEnd: true, adjustForZoom: false });
});

test('build-up is the airbrush option when set, else the preset; never for pencil-like strokes', () => {
  assert.equal(buildUpFor(preset(), { airbrush: false }, 'brush'), false);
  assert.equal(buildUpFor(preset(), {}, 'brush'), true);
  assert.equal(buildUpFor(null, { airbrush: true }, 'brush'), true);
  assert.equal(buildUpFor(null, {}, 'brush'), false);
  assert.equal(buildUpFor(preset(), { airbrush: true }, 'pencil'), false);
  assert.equal(buildUpFor(preset(), { airbrush: true, mode: 'pencil' }, 'eraser'), false);
});

test('tip geometry, wet edges and airbrush options override the preset', () => {
  const p = presetStrokeParams(preset(), { ...opts, spacing: 50, roundness: 30, angle: -20, flipX: true, flipY: false, wetEdges: false }, { ...ctx, tool: 'brush', mode: 'normal' });
  assert.equal(p.spacing, 0.5);
  assert.equal(p.roundness, 0.3);
  assert.equal(p.angle, -20);
  assert.equal(p.flipX, true);
  assert.equal(p.flipY, undefined);
  assert.equal(p.wetEdges, undefined);
  assert.equal(p.airbrush, undefined);
});

test('no preset paints the default round tip from the options', () => {
  const p = presetStrokeParams(null, opts, { ...ctx, tool: 'brush', mode: 'normal' });
  assert.equal(p.tip, 'round');
  assert.equal(p.size, 12);
  assert.equal(p.hardness, 0.8);
  assert.equal(p.spacing, 0.25);
});

test('pencil and the eraser pencil mode use the preset with hardness 1, flow 1, no build-up, aliased', () => {
  for (const [tool, o] of [['pencil', opts], ['eraser', { ...opts, mode: 'pencil', airbrush: true }]] as const) {
    const p = presetStrokeParams(preset(), o, { ...ctx, tool, mode: 'normal' });
    assert.equal(p.hardness, 1);
    assert.equal(p.flow, 1);
    assert.equal(p.airbrush, undefined);
    assert.equal(p.aliased, true);
    assert.equal(p.roundness, 0.5, 'the preset tip still applies');
  }
});

test('selecting a preset copies tip geometry, build-up, wet edges, smoothing and captured values into the options', () => {
  assert.deepEqual(presetOptions(preset()), {
    size: 60, hardness: 20, spacing: 25, roundness: 50, angle: 30, flipX: false, flipY: false,
    airbrush: true, wetEdges: true, smoothing: 40, opacity: 30, flow: 20, mode: 'multiply',
  });
  const bare = { ...preset(), captured: undefined };
  assert.equal('opacity' in presetOptions(bare), false);
  // The eraser's mode option is brush/pencil/block, never a blend mode.
  assert.equal('mode' in presetOptions(preset(), 'eraser'), false);
});

test('groupPresets: preset group first, else the keyword heuristic, fixed group order, empty groups dropped', () => {
  const mk = (id: string, name: string, group?: string): BrushPreset => ({ ...preset(), id, name, group });
  const g = groupPresets([mk('a', 'Watercolor Wash'), mk('b', 'Hard Round'), mk('c', 'Charcoal'), mk('d', 'Splatter'), mk('e', 'X', 'Mine'), mk('f', 'Pastel Dry')]);
  assert.deepEqual(g.map(([n, ps]) => [n, ps.map(p => p.id)]), [
    ['General', ['b']], ['Dry Media', ['c', 'f']], ['Wet Media', ['a']], ['Special Effects', ['d']], ['Mine', ['e']],
  ]);
});

test('pushRecent keeps the last 8 distinct ids, newest first', () => {
  let r: string[] = [];
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'b']) r = pushRecent(r, id);
  assert.deepEqual(r, ['b', 'i', 'h', 'g', 'f', 'e', 'd', 'c']);
});
