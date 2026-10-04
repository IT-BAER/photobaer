import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addToolPreset, applyToolPreset, exportToolPresets, importToolPresets, loadToolPresets, renameToolPreset, saveToolPresets,
  snapshotToolPreset, validateBrushPresetAssets, validateToolOptionAssets, type ToolPresetStorage,
} from './toolPresets.ts';
import { computedTip, defaultDynamics, type BrushPreset } from '../brushes/preset.ts';

const memory = (value: string | null = null): ToolPresetStorage & { value: string | null } => ({
  value,
  getItem() { return this.value; },
  setItem(_key, next) { this.value = next; },
});
const ids = (...values: string[]) => { let i = 0; return () => values[i++]; };

test('save, load, snapshot, and apply preserve validated options, colors, and brush identity immutably', () => {
  const options = { size: 17, hardness: 50, mode: 'normal', opacity: 80, flow: 70, smoothing: 10, airbrush: false, wetEdges: false, pressureSize: false, pressureOpacity: false };
  const snapshot = snapshotToolPreset('Fine', 'brush', options, 'brush.1', { fg: [1, 2, 3], bg: [4, 5, 6] });
  let library = addToolPreset({ version: 1, presets: [] }, snapshot, ids('one'));
  options.size = 99;
  assert.equal(library.presets[0].options.size, 17);
  const store = memory();
  saveToolPresets(store, library);
  library = loadToolPresets(store);
  const applied = applyToolPreset(library.presets[0]);
  assert.deepEqual(applied, { tool: 'brush', options: snapshot.options, brushPresetId: 'brush.1', colors: { fg: [1, 2, 3], bg: [4, 5, 6] } });
  applied.options.size = 200;
  assert.equal(library.presets[0].options.size, 17);
});

test('tool option validation rejects unknown, out-of-range, nonfinite, wrong-choice, and prototype tool values', () => {
  const extras = snapshotToolPreset('Tip', 'pencil', { angle: -45, roundness: 35, spacing: 140, flipX: true, flipY: false, pulledString: true }, null);
  assert.deepEqual(extras.options, { angle: -45, roundness: 35, spacing: 140, flipX: true, flipY: false, pulledString: true });
  assert.throws(() => snapshotToolPreset('Bad', 'brush', { size: Infinity }, null), /finite|size/i);
  assert.throws(() => snapshotToolPreset('Bad', 'brush', { size: 5001 }, null), /size/i);
  assert.throws(() => snapshotToolPreset('Bad', 'brush', { mode: 'bogus' }, null), /mode/i);
  assert.throws(() => snapshotToolPreset('Bad', 'brush', { mystery: true }, null), /mystery/i);
  assert.throws(() => snapshotToolPreset('Bad', 'pencil', { roundness: 0 }, null), /roundness/i);
  assert.throws(() => snapshotToolPreset('Bad', 'constructor', {}, null), /tool/i);
});

test('imports validate atomically and append fresh ids and names without overwriting', () => {
  const base = addToolPreset({ version: 1, presets: [] }, snapshotToolPreset('Fine', 'zoom', {}, null), ids('base'));
  const payload = exportToolPresets(base);
  const appended = importToolPresets(base, payload, ids('fresh'));
  assert.deepEqual(appended.presets.map(p => [p.id, p.name]), [['base', 'Fine'], ['fresh', 'Fine (2)']]);
  const malicious = '{"version":1,"presets":[{"id":"x","name":"X","tool":"__proto__","options":{}}]}';
  assert.throws(() => importToolPresets(base, malicious, ids('unused')), /tool/i);
  assert.deepEqual(base.presets.map(p => p.id), ['base'], 'failed import leaves the input library unchanged');
  const longName = 'x'.repeat(64);
  const longBase = addToolPreset({ version: 1, presets: [] }, snapshotToolPreset(longName, 'zoom', {}, null), ids('long-a'));
  const longAppend = importToolPresets(longBase, exportToolPresets(longBase), ids('long-b'));
  assert.equal(longAppend.presets[1].name, `${'x'.repeat(60)} (2)`);
});

test('storage read and write failures propagate without overwriting the saved library', () => {
  const brokenRead: ToolPresetStorage = { getItem: () => { throw new Error('read denied'); }, setItem: () => assert.fail('must not write') };
  assert.throws(() => loadToolPresets(brokenRead), /read denied/);
  const brokenWrite: ToolPresetStorage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  assert.throws(() => saveToolPresets(brokenWrite, { version: 1, presets: [] }), /quota/);
  assert.throws(() => loadToolPresets(memory('{broken')), /valid JSON/i);
});

test('rename collisions are explicit and referenced brush assets must exist', () => {
  let library = addToolPreset({ version: 1, presets: [] }, snapshotToolPreset('One', 'zoom', {}, null), ids('a'));
  library = addToolPreset(library, snapshotToolPreset('Two', 'zoom', {}, null), ids('b'));
  assert.throws(() => renameToolPreset(library, 'b', ' One '), /already exists/i);
  const dynamics = defaultDynamics();
  dynamics.texture = { ...dynamics.texture, enabled: true, patternRef: 'p1' };
  const brush: BrushPreset = { id: 'brush.1', name: 'Brush', tip: { ...computedTip(), kind: 'sampled', tipRef: 't1' }, dynamics };
  assert.throws(() => validateBrushPresetAssets(brush, { tip: () => undefined, pattern: () => ({}) }), /t1/);
  assert.throws(() => validateBrushPresetAssets(brush, { tip: () => ({}), pattern: () => undefined }), /p1/);
  assert.doesNotThrow(() => validateBrushPresetAssets(brush, { tip: () => ({}), pattern: () => ({}) }));
});

test('referenced gradient, pattern and custom shape options must exist; empty defaults pass', () => {
  const none = { gradient: () => undefined, pattern: () => undefined, shape: () => undefined };
  const all = { gradient: () => ({}), pattern: () => ({}), shape: () => ({}) };
  assert.throws(() => validateToolOptionAssets({ gradient: 'user.gone' }, none), /user\.gone/);
  assert.throws(() => validateToolOptionAssets({ pattern: 'pat.gone' }, none), /pat\.gone/);
  assert.throws(() => validateToolOptionAssets({ customShape: 'shape.gone' }, none), /shape\.gone/);
  assert.doesNotThrow(() => validateToolOptionAssets({ gradient: 'user.ok', pattern: 'p', customShape: 's' }, all));
  assert.doesNotThrow(() => validateToolOptionAssets({ pattern: '', customShape: '', size: 3 }, none));
});
