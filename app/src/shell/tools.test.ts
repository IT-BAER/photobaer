import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, SLOTS, slotForKey, cycleTool, defaultOptions, loadToolOptions, saveToolOptions, keyToTool, initialLastUsed } from './tools.ts';

test('every tool belongs to a slot that lists it and to a key that resolves that slot', () => {
  for (const tool of Object.values(TOOLS)) {
    const slot = SLOTS.find(s => s.id === tool.slot);
    assert.ok(slot, `${tool.id} has slot ${tool.slot}`);
    assert.ok(slot!.tools.includes(tool.id), `${tool.id} listed in slot ${slot!.id}`);
    assert.equal(slotForKey(tool.key), slot);
  }
});

test('cycleTool wraps around a slot in order', () => {
  const marquee = SLOTS.find(s => s.id === 'marquee')!;
  assert.equal(cycleTool(marquee, 'marqueeRect'), 'marqueeEllipse');
  assert.equal(cycleTool(marquee, 'marqueeColumn'), 'marqueeRect');
});

test('slotForKey is case-insensitive and unknown keys resolve to nothing', () => {
  assert.equal(slotForKey('B')?.id, 'brush');
  assert.equal(slotForKey('q'), undefined);
});

test('defaultOptions matches each option schema default', () => {
  const brush = TOOLS.brush;
  assert.equal(defaultOptions(brush).size, 30);
  assert.equal(defaultOptions(brush).hardness, 100);
});

test('keyToTool selects the slot last-used tool and cycles it with shift', () => {
  const lastUsed = initialLastUsed();
  assert.equal(keyToTool('m', false, 'hand', lastUsed), 'marqueeRect');
  assert.equal(keyToTool('m', true, 'marqueeRect', lastUsed), 'marqueeEllipse');
  assert.equal(keyToTool('q', false, 'hand', lastUsed), null);
});

test('tool options persist through the store and fall back to defaults without one', () => {
  const calls: Record<string, string> = {};
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => calls[k] ?? null,
    setItem: (k: string, v: string) => { calls[k] = v; },
  } as Storage;
  const tool = TOOLS.eyedropper;
  assert.deepEqual(loadToolOptions(tool), defaultOptions(tool));
  saveToolOptions(tool, { ...defaultOptions(tool), sampleSize: '5x5' });
  assert.equal(loadToolOptions(tool).sampleSize, '5x5');
  delete (globalThis as { localStorage?: Storage }).localStorage;
});
