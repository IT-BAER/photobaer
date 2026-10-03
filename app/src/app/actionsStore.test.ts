import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionsStore } from './actionsStore.ts';

const step = (label: string) => ({ id: crypto.randomUUID(), label, enabled: true, calls: [{ op: 'setProps', args: [{ $L: { c: 0 } }, { opacity: 0.5 }] }] });

test('recording adds steps after the selected step, playable starts at the selected step', () => {
  const s = new ActionsStore();
  const a = s.newAction('Glow');
  assert.equal(s.sets[0].name, 'Set 1');
  s.startRecording();
  s.addStep(step('A'));
  s.addStep(step('C'));
  s.stopRecording();
  s.addStep(step('ignored'));
  s.select({ set: s.sets[0].id, action: a.id, step: a.steps[0].id });
  s.startRecording();
  s.addStep(step('B'));
  s.stopRecording();
  assert.deepEqual(s.action!.steps.map(x => x.label), ['A', 'B', 'C']);
  s.toggleStep(s.action!.steps[2].id);
  assert.deepEqual(s.playable().map(x => x.label), ['B']);
  s.select({ set: s.sets[0].id, action: a.id });
  assert.deepEqual(s.playable().map(x => x.label), ['A', 'B']);
  s.toggleAction(a.id);
  assert.ok(s.action!.steps.every(x => x.enabled));
});

test('deleteSelected removes step, then action, then set; not while recording into it', () => {
  const s = new ActionsStore();
  const a = s.newAction('X');
  s.startRecording();
  assert.throws(() => s.deleteSelected(), /Stop recording/);
  s.addStep(step('A'));
  s.stopRecording();
  s.select({ set: s.sets[0].id, action: a.id, step: a.steps[0].id });
  s.deleteSelected();
  assert.equal(s.action!.steps.length, 0);
  s.deleteSelected();
  assert.equal(s.sets[0].actions.length, 0);
  s.deleteSelected();
  assert.equal(s.sets.length, 0);
});

test('a saved set loads back with new ids and typed arrays; other files are refused', () => {
  const s = new ActionsStore();
  s.newAction('Paint');
  s.startRecording();
  s.addStep({ id: 'a', label: 'Brush Tool', enabled: false, calls: [{ op: 'strokeTo', args: [new Float32Array([1, 2.5])] }] });
  s.stopRecording();
  s.insertStop('Check it', true);
  const text = s.exportSet(s.sets[0].id);
  const t = new ActionsStore();
  const set = t.importSet(text);
  assert.notEqual(set.id, s.sets[0].id);
  const steps = set.actions[0].steps;
  assert.deepEqual(steps.map(x => [x.label, x.enabled]), [['Brush Tool', false], ['Stop', true]]);
  assert.ok(steps[0].calls[0].args[0] instanceof Float32Array);
  assert.deepEqual(steps[1].stop, { message: 'Check it', allowContinue: true });
  assert.throws(() => t.importSet('{"set":{}}'), /not a photobaer actions file/);
  assert.throws(() => t.importSet('nope'), /not a photobaer actions file/);
});
