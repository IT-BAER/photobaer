import test from 'node:test';
import assert from 'node:assert/strict';
import type { DocInfo } from '../worker/types.ts';
import { FILL_CONTENTS, holdBackground, landFloat, needsLayer, nextActive, whenBackground } from './helpers.ts';

test('Fill contents list Content-Aware between Color… and Pattern', () => {
  assert.deepEqual(Object.values(FILL_CONTENTS).map(d => d.message), ['Foreground Color', 'Background Color', 'Color…', 'Content-Aware', 'Pattern', 'History', 'Black', '50% Gray', 'White']);
});

const L = (...ids: number[]) => ({ layers: ids.map(id => ({ id, children: [] })) }) as unknown as DocInfo;

test('nextActive keeps no active layer on the same document and after undo', () => {
  assert.equal(nextActive(L(1, 2), true, null, undefined), null);
});

test('nextActive keeps the active layer on the same document while it exists, else the top layer', () => {
  assert.deepEqual(nextActive(L(1, 2), true, { id: 1, target: 'mask' }, undefined), { id: 1, target: 'mask' });
  assert.deepEqual(nextActive(L(1, 2), true, { id: 9, target: 'pixels' }, undefined), { id: 2, target: 'pixels' });
});

test('nextActive selects the top layer of a new document', () => {
  assert.deepEqual(nextActive(L(1, 2), false, null, undefined), { id: 2, target: 'pixels' });
  assert.deepEqual(nextActive(L(1, 2), false, { id: 1, target: 'pixels' }, undefined), { id: 2, target: 'pixels' });
});

test('nextActive restores the saved layer of a tab, including none', () => {
  assert.deepEqual(nextActive(L(1, 2), false, null, { active: { id: 1, target: 'pixels' } }), { id: 1, target: 'pixels' });
  assert.equal(nextActive(L(1, 2), false, { id: 2, target: 'pixels' }, { active: null }), null);
  assert.deepEqual(nextActive(L(1, 2), false, null, { active: { id: 9, target: 'pixels' } }), { id: 2, target: 'pixels' });
});

test('nextActive lets selectAfter win', () => {
  assert.deepEqual(nextActive(L(1, 2, 3), true, null, undefined, () => ({ id: 3, target: 'pixels' })), { id: 3, target: 'pixels' });
});

test('needsLayer: tools that change a layer refuse to start without one', () => {
  const key = { ctrlKey: false, metaKey: false };
  for (const tool of ['brush', 'eraser', 'cloneStamp', 'move', 'magneticLasso', 'bucket', 'magicEraser', 'gradient', 'magicWand', 'quickSelection']) {
    assert.equal(needsLayer(tool, {}, key), true, tool);
  }
  for (const tool of ['marqueeRect', 'lasso', 'polygonalLasso', 'crop', 'pen', 'typeHorizontal', 'eyedropper', 'hand', 'rectangle']) {
    assert.equal(needsLayer(tool, {}, key), false, tool);
  }
  assert.equal(needsLayer('magicWand', { sampleAllLayers: true }, key), false);
  assert.equal(needsLayer('rectangle', { mode: 'pixels' }, key), true);
  assert.equal(needsLayer('move', { autoSelect: true }, key), false);
  assert.equal(needsLayer('move', { autoSelect: true }, { ctrlKey: true, metaKey: false }), true);
  assert.equal(needsLayer('move', {}, { ctrlKey: false, metaKey: true }), false);
});

test('landFloat sends the commit right behind the step and settles without waiting for the view', async () => {
  const log: string[] = [];
  let draw!: () => void, reply!: (v: number) => void;
  const { landed, drawn } = landFloat(
    () => { log.push('step'); return new Promise<number>(r => { reply = r; }); },
    async () => { log.push('end'); return 2; },
    async d => { log.push(`show ${d}`); await new Promise<void>(r => { draw = r; }); log.push('drawn'); },
  );
  // A press after the drop must reach the worker after this commit, so it goes out before any reply.
  assert.deepEqual(log, ['step', 'end']);
  assert.equal(await landed, 2);
  reply(1);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(log, ['step', 'end', 'show 1']);
  draw();
  await drawn;
  assert.deepEqual(log, ['step', 'end', 'show 1', 'drawn']);
});

test('landFloat settles only once the commit settled and the view drew the drop', async () => {
  let draw!: () => void, fail!: (e: Error) => void;
  const { settled } = landFloat(
    async () => 1,
    () => new Promise<number>((_, j) => { fail = j; }),
    () => new Promise<void>(r => { draw = r; }),
  );
  let done = false;
  void settled.then(() => { done = true; });
  await new Promise(r => setTimeout(r, 0));
  draw();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(done, false, 'the commit is still out');
  fail(new Error('commit failed'));
  await settled;
  assert.equal(done, true, 'a failed commit still settles');
});

test('landFloat reports a failed step and still ends the session', async () => {
  const log: string[] = [];
  const { landed, drawn } = landFloat(
    async () => { throw new Error('no'); },
    async () => { log.push('end'); return null; },
    () => { log.push('show'); },
    e => log.push(`error ${(e as Error).message}`),
  );
  await landed;
  await drawn;
  assert.deepEqual(log, ['end', 'error no']);
});

test('background reads wait until every Move hold is released', async () => {
  const order: string[] = [];
  await whenBackground().then(() => order.push('free'));
  const a = holdBackground(), b = holdBackground();
  const waiting = whenBackground().then(() => order.push('after both'));
  a();
  a();
  await Promise.resolve();
  order.push('one left');
  b();
  await waiting;
  assert.deepEqual(order, ['free', 'one left', 'after both'], 'a second release of the same hold does not count twice');
});
