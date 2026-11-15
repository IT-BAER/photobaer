import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropletText, readDroplet } from './droplets.ts';
import type { ActionSet } from '../actions.ts';

const set: ActionSet = {
  id: 's', name: 'Web',
  actions: [
    { id: 'a', name: 'Blur', key: 'F3', steps: [{ id: 'x', label: 'Gaussian Blur', enabled: true, dialog: true, calls: [{ op: 'applyFilter', args: [{ $L: { n: 'Background' } }, 'pixels', { kind: 'gaussian_blur', params: { radius: 2 } }, 'Gaussian Blur'] }] }] },
    { id: 'b', name: 'Wide', steps: [{ id: 'y', label: 'If', enabled: true, calls: [], cond: { if: 'landscape', then: 'Blur', else: null } }] },
  ],
};

test('a droplet keeps the action set, the action and the batch options; other files are refused', () => {
  const d = readDroplet(dropletText(set, 'b', { dest: 'folder', format: 'jpeg', errors: 'log' }));
  assert.equal(d.action.name, 'Wide');
  assert.deepEqual(d.set.actions.map(a => a.name), ['Blur', 'Wide']);
  assert.notEqual(d.set.id, 's');
  assert.deepEqual(d.set.actions[0].steps[0].calls, set.actions[0].steps[0].calls);
  assert.deepEqual(d.set.actions[1].steps[0].cond, { if: 'landscape', then: 'Blur', else: null });
  assert.deepEqual(d.options, { dest: 'folder', format: 'jpeg', errors: 'log' });

  const odd = JSON.parse(dropletText(set, 'a', { dest: 'download', format: 'png', errors: 'stop' }));
  odd.options = { dest: 'ftp', format: 'gif', errors: 1 };
  assert.deepEqual(readDroplet(JSON.stringify(odd)).options, { dest: 'download', format: 'png', errors: 'stop' }, 'unknown options fall back');
  odd.action = 'Nope';
  assert.throws(() => readDroplet(JSON.stringify(odd)), /not a photobaer droplet/);
  assert.throws(() => readDroplet('{"photobaerActions":1,"set":{"name":"x","actions":[]}}'), /not a photobaer droplet/);
  assert.throws(() => readDroplet('nope'), /not a photobaer droplet/);
  assert.throws(() => readDroplet('{"photobaerDroplet":1,"action":"A","set":{"name":"x","actions":[null]}}'), /not a photobaer droplet/);
  const holes = readDroplet('{"photobaerDroplet":1,"action":"A","set":{"name":"x","actions":[{"name":"A","steps":[null,{"label":"S","calls":[]}]}]}}');
  assert.deepEqual(holes.action.steps.map(s => s.label), ['S'], 'steps that are not objects are dropped');
  assert.throws(() => dropletText(set, 'zz', { dest: 'none', format: 'png', errors: 'stop' }), /Select an action/);
});
