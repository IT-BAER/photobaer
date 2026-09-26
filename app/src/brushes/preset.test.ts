import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { toStrokeParams, computedTip, defaultDynamics, dyn, type BrushPreset, type ToolOptions } from './preset.ts';
import { builtinPresets, builtinPatterns } from './builtin.ts';
import { BrushLibrary, MemoryStore, openBrushStore, PRESET_CAP } from './store.ts';

const tool: ToolOptions = { rgba: [10, 20, 30, 255], mode: 'normal' };
const byId = (id: string) => builtinPresets().find(p => p.id === id)!;

test('toStrokeParams: a preset with every dynamic off maps to plain B4 params', () => {
  assert.deepEqual(toStrokeParams(byId('builtin.hard-round'), tool), {
    rgba: [10, 20, 30, 255], mode: 'normal', size: 20, opacity: 1, flow: 1, hardness: 1, spacing: 0.25, angle: 0, roundness: 1,
    tip: 'round', stride: 3, seed: 0,
  });
});

test('toStrokeParams: dynamics sections map to engine names; unresolved texture and sampled tip fall back', () => {
  const chalk = byId('builtin.chalk');
  const resolve = (kind: 'tip' | 'pattern', ref: string) => (kind === 'pattern' && ref === 'builtin.pattern.canvas' ? 7 : undefined);
  const p = toStrokeParams(chalk, { ...tool, resolve, seed: 42, stride: 6 });
  assert.deepEqual(p.shapeDyn, {
    enabled: true, angleFollowsPath: false, size: { control: 'penPressure', fadeSteps: 25, jitter: 0, minimum: 0.4 },
    roundness: { control: 'off', fadeSteps: 25, jitter: 0, minimum: 0 }, flipXJitter: false, flipYJitter: false,
    angleControl: 'off', angleFadeSteps: 25, angleJitter: 0.08,
  });
  assert.deepEqual(p.texture, {
    enabled: true, patternId: 7, invert: false, scale: 1, brightness: 0, contrast: 0.35, eachTip: false, mode: 'multiply',
    depth: 0.8, minimumDepth: 0.1, depthJitter: { control: 'off', fadeSteps: 25, jitter: 0, minimum: 1 },
  });
  assert.deepEqual([p.seed, p.stride], [42, 6]);
  assert.equal('texture' in toStrokeParams(chalk, tool), false);
  const sampled: BrushPreset = { id: 'x', name: 'x', tip: { ...computedTip(), kind: 'sampled', tipRef: 't1' }, dynamics: defaultDynamics() };
  assert.equal(toStrokeParams(sampled, tool).tip, 'round');
  assert.deepEqual([toStrokeParams(sampled, { ...tool, resolve: () => 3 }).tip, toStrokeParams(sampled, { ...tool, resolve: () => 3 }).tipId], ['sampled', 3]);
  const wet = toStrokeParams(byId('builtin.wet-edge-round'), { ...tool, bg: [1, 2, 3, 255] });
  assert.equal(wet.wetEdges, true);
  assert.deepEqual(wet.color, { enabled: true, bg: [1, 2, 3, 255], fgBg: 0, hueJitter: 0.02, satJitter: 0.1, briJitter: 0.08, purity: 0, perTip: false });
  const dry = toStrokeParams(byId('builtin.dry-brush'), tool);
  assert.deepEqual(dry.dualBrush, {
    enabled: true, tip: 'round', hardness: 0.6, roundness: 1, angle: 0, mode: 'multiply', size: 14, spacing: 0.55, scatter: 0.4,
    bothAxes: true, count: 1, flipX: false, flipY: false,
  });
  assert.equal(toStrokeParams(byId('builtin.airbrush-soft'), tool).airbrush, true);
});

test('built-in set: 10 presets with own ids, reference-derived values, patterns all present', () => {
  const presets = builtinPresets();
  assert.equal(presets.length, 10);
  assert.equal(new Set(presets.map(p => p.id)).size, 10);
  assert.ok(presets.every(p => p.id.startsWith('builtin.')));
  const dry = byId('builtin.dry-brush');
  assert.deepEqual([dry.tip.diameter, dry.tip.hardness, dry.tip.roundness, dry.tip.spacing], [50, 0.35, 0.7, 0.07]);
  assert.deepEqual([dry.dynamics.texture.patternRef, dry.dynamics.texture.contrast, dry.dynamics.texture.depth, dry.dynamics.texture.minimumDepth], ['builtin.pattern.hatch', 0.5, 1, 0]);
  const stipple = byId('builtin.stipple');
  assert.deepEqual(stipple.dynamics.scattering, { enabled: true, amount: 2.5, scatter: dyn(), bothAxes: true, count: 4, countJitter: dyn({ jitter: 0.5, minimum: 0.25 }) });
  assert.deepEqual(byId('builtin.wet-edge-round').captured, { flow: 0.5, opacity: 0.85, mode: 'multiply' });
  const patterns = builtinPatterns();
  assert.equal(patterns.length, 10);
  for (const p of presets) if (p.dynamics.texture.patternRef) assert.ok(patterns.some(x => x.id === p.dynamics.texture.patternRef), p.id);
});

test('built-in patterns are deterministic, sized, and not flat', () => {
  const a = builtinPatterns(), b = builtinPatterns();
  assert.deepEqual(a, b);
  for (const p of a) {
    assert.equal(p.data.length, p.width * p.height * p.channels, p.id);
    assert.ok(Math.max(...p.data) - Math.min(...p.data) > 40, p.id);
  }
});

const userPreset = (id: string): BrushPreset => ({ id, name: id, tip: computedTip({ diameter: 5 }), dynamics: defaultDynamics() });

test('store: builtins listed but not stored until edited; deletions persist in meta', async () => {
  const backend = new MemoryStore();
  const lib = await BrushLibrary.open(backend);
  assert.deepEqual(lib.list().map(p => p.id), builtinPresets().map(p => p.id));
  await lib.flush();
  assert.equal(backend.dump().presets.length, 0);
  const edited = { ...byId('builtin.soft-round'), name: 'Soft Edited' };
  lib.save(edited);
  lib.delete('builtin.chalk');
  lib.save(userPreset('mine'));
  await lib.flush();
  const dump = backend.dump();
  assert.deepEqual(dump.presets.map(p => p.id).sort(), ['builtin.soft-round', 'mine']);
  assert.deepEqual(dump.meta.deletedIds, ['builtin.chalk']);
  const again = await BrushLibrary.open(backend);
  const ids = again.list().map(p => p.id);
  assert.equal(ids.includes('builtin.chalk'), false);
  assert.equal(ids.at(-1), 'mine');
  assert.equal(again.list().find(p => p.id === 'builtin.soft-round')!.name, 'Soft Edited');
  assert.equal(ids.indexOf('builtin.soft-round'), 1);
});

test('store: writes are debounced 250 ms into one save', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const backend = new MemoryStore();
    const lib = await BrushLibrary.open(backend);
    lib.save(userPreset('a'));
    mock.timers.tick(200);
    lib.save(userPreset('b'));
    mock.timers.tick(249);
    assert.equal(backend.saves, 0);
    mock.timers.tick(1);
    await lib.idle();
    assert.equal(backend.saves, 1);
    assert.deepEqual(backend.dump().presets.map(p => p.id).sort(), ['a', 'b']);
  } finally { mock.timers.reset(); }
});

test('store: import keeps ids unique, reuses identical tips, remaps changed ones, caps presets', async () => {
  const lib = await BrushLibrary.open(new MemoryStore());
  const tipA = { id: 't', name: 't', width: 1, height: 1, alpha: new Uint8Array([9]) };
  const sampled = (id: string): BrushPreset => ({ ...userPreset(id), tip: { ...computedTip(), kind: 'sampled', tipRef: 't' } });
  lib.import({ presets: [sampled('abr-1')], tips: [tipA], patterns: [] });
  lib.import({ presets: [sampled('abr-1')], tips: [tipA], patterns: [] });
  const r = lib.import({ presets: [sampled('abr-1')], tips: [{ ...tipA, alpha: new Uint8Array([1]) }], patterns: [] });
  const users = lib.list().slice(10);
  assert.equal(new Set(users.map(p => p.id)).size, 3);
  const refs = users.map(p => (p.tip.kind === 'sampled' ? p.tip.tipRef : ''));
  assert.deepEqual([refs[0], refs[1]], ['t', 't']);
  assert.notEqual(refs[2], 't');
  assert.deepEqual([...lib.tip(refs[2])!.alpha], [1]);
  assert.equal(r.added, 1);
  const many = Array.from({ length: PRESET_CAP }, (_, i) => userPreset(`m${i}`));
  const capped = lib.import({ presets: many, tips: [], patterns: [] });
  assert.equal(capped.added, PRESET_CAP - 3);
  assert.ok(capped.warnings.length > 0);
});

test('openBrushStore falls back to memory when indexedDB is missing', async () => {
  assert.equal(typeof indexedDB, 'undefined');
  assert.ok((await openBrushStore()) instanceof MemoryStore);
});
