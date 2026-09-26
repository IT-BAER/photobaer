import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_GRADIENTS, GradientLibrary, resolvePreset } from './presets.ts';

test('ten built-ins with own ids, the swatch presets resolving live from the current colors', () => {
  assert.equal(BUILTIN_GRADIENTS.length, 10);
  assert.ok(BUILTIN_GRADIENTS.every(p => p.id.startsWith('builtin.')));
  const [fgBg, fgClear] = BUILTIN_GRADIENTS;
  const a = resolvePreset(fgBg, [10, 20, 30], [200, 210, 220]);
  assert.deepEqual(a.stops.map(s => s.color), [[10, 20, 30], [200, 210, 220]]);
  const b = resolvePreset(fgClear, [10, 20, 30], [200, 210, 220]);
  assert.deepEqual(b.stops.map(s => s.color), [[10, 20, 30], [10, 20, 30]]);
  assert.deepEqual(b.opacityStops.map(s => s.opacity), [1, 0]);
  const noise = BUILTIN_GRADIENTS.find(p => p.gradient.kind === 'noise')!;
  assert.equal(noise.gradient.noise!.seed, 20240824);
});

test('user gradients persist through storage and fall back to memory when storage throws', () => {
  const data: Record<string, string> = {};
  const storage = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
  const lib = new GradientLibrary(storage);
  const added = lib.add(BUILTIN_GRADIENTS[2].gradient);
  assert.equal(added.name, 'Custom gradient');
  assert.equal(added.group, 'Custom');
  assert.equal(new GradientLibrary(storage).get(added.id)?.name, 'Custom gradient');
  assert.equal(new GradientLibrary(storage).list().length, 11);

  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  const mem = new GradientLibrary(broken);
  const m = mem.add(BUILTIN_GRADIENTS[2].gradient);
  assert.equal(mem.get(m.id)?.group, 'Custom');
});
