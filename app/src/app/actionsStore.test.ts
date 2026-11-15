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

test('dialog toggles: per step, per action for the steps that have a dialog, and kept in saved sets', () => {
  const s = new ActionsStore();
  const a = s.newAction('Blur');
  s.startRecording();
  s.addStep(step('Opacity'));
  s.addStep({ id: crypto.randomUUID(), label: 'Gaussian Blur', enabled: true, calls: [{ op: 'applyFilter', args: [{ $L: { c: 0 } }, 'pixels', { kind: 'gaussian_blur', params: { radius: 2 } }, 'Gaussian Blur'] }] });
  s.stopRecording();
  const [op, blur] = a.steps;
  s.toggleDialog(op.id);
  assert.equal(op.dialog, undefined, 'a step without a dialog has no toggle');
  s.toggleDialog(blur.id);
  assert.equal(blur.dialog, true);
  s.toggleActionDialogs(a.id);
  assert.equal(blur.dialog, false, 'all on: the action toggle turns them off');
  s.toggleActionDialogs(a.id);
  assert.equal(blur.dialog, true);
  const back = new ActionsStore().importSet(s.exportSet(s.sets[0].id));
  assert.deepEqual(back.actions[0].steps.map(x => x.dialog), [undefined, true]);
});

test('Action Options: name and function key; a key moves from the action that had it; byKey finds it', () => {
  const s = new ActionsStore();
  const a = s.newAction('A'), b = s.newAction('B');
  s.setActionOptions(a.id, { name: 'Sharpen', key: 'Shift+F3' });
  assert.equal(a.name, 'Sharpen');
  assert.equal(s.byKey('Shift+F3')?.action.id, a.id);
  s.setActionOptions(b.id, { name: 'B', key: 'Shift+F3' });
  assert.equal(a.key, undefined, 'the key moved to B');
  assert.equal(s.byKey('Shift+F3')?.action.id, b.id);
  s.setActionOptions(b.id, { name: 'B', key: null });
  assert.equal(s.byKey('Shift+F3'), undefined);
  s.setActionOptions(a.id, { name: 'Sharpen', key: 'F4' });
  assert.equal(new ActionsStore().importSet(s.exportSet(s.sets[0].id)).actions[0].key, 'F4');
  assert.throws(() => s.setActionOptions(a.id, { name: 'X', key: 'Alt+F4' }), /function key/);
});

test('Insert Menu Item and Insert Conditional add steps after the selected step and load back from a saved set', () => {
  const s = new ActionsStore();
  const a = s.newAction('Main');
  s.newAction('Wide');
  s.select({ set: s.sets[0].id, action: a.id });
  assert.throws(() => s.insertConditional({ if: 'square', then: null, else: null }), /Then or Else/);
  s.insertMenuItem(['Image', 'Image Size…']);
  s.insertConditional({ if: 'landscape', then: 'Wide', else: null });
  assert.deepEqual(a.steps.map(x => [x.menu?.path, x.cond]), [[['Image', 'Image Size…'], undefined], [undefined, { if: 'landscape', then: 'Wide', else: null }]]);
  const text = s.exportSet(s.sets[0].id);
  const back = new ActionsStore().importSet(text).actions[0].steps;
  assert.deepEqual(back.map(x => [x.menu?.path, x.cond]), [[['Image', 'Image Size…'], undefined], [undefined, { if: 'landscape', then: 'Wide', else: null }]]);
  const bad = text.replace('"landscape"', '"rainy"').replace('"Image Size…"', '42');
  assert.deepEqual(new ActionsStore().importSet(bad).actions[0].steps.map(x => [x.menu, x.cond, x.enabled]), [[undefined, undefined, true], [undefined, undefined, true]], 'unknown parts are dropped');
});
