import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History, type Snapshots } from './history.ts';

// Fake snapshot store over a single value; tracks live snapshots to catch leaks.
function store() {
  let next = 1;
  const snaps = new Map<number, string>();
  const s = {
    value: '',
    snapshot() { snaps.set(next, s.value); return next++; },
    restore(id: number) { const v = snaps.get(id); if (v === undefined) throw new Error('unknown'); s.value = v; },
    drop(id: number) { snaps.delete(id); },
    live: () => snaps.size,
  };
  return s satisfies Snapshots & object;
}

test('undo and redo walk the edits', () => {
  const s = store();
  const h = new History(s);
  h.run('A', () => { s.value = 'a'; });
  h.run('B', () => { s.value = 'ab'; });
  assert.equal(h.undoLabel, 'B');
  assert.ok(h.undo());
  assert.equal(s.value, 'a');
  assert.equal(h.redoLabel, 'B');
  assert.ok(h.undo());
  assert.equal(s.value, '');
  assert.equal(h.undo(), false);
  assert.ok(h.redo());
  assert.ok(h.redo());
  assert.equal(s.value, 'ab');
  assert.equal(h.redo(), false);
});

test('a new edit clears redo and frees its snapshots', () => {
  const s = store();
  const h = new History(s);
  h.run('A', () => { s.value = 'a'; });
  h.undo();
  h.run('C', () => { s.value = 'c'; });
  assert.equal(h.redoLabel, null);
  assert.equal(s.live(), 1);
});

test('a failing command rolls back and leaves no entry', () => {
  const s = store();
  const h = new History(s);
  s.value = 'x';
  assert.throws(() => h.run('bad', () => { s.value = 'broken'; throw new Error('boom'); }), /boom/);
  assert.equal(s.value, 'x');
  assert.equal(h.undoLabel, null);
  assert.equal(s.live(), 0);
});

test('limit drops the oldest step and its snapshot', () => {
  const s = store();
  const h = new History(s, 2);
  for (const v of ['1', '2', '3']) h.run(v, () => { s.value = v; });
  assert.equal(s.live(), 2);
  h.undo(); h.undo();
  assert.equal(s.value, '1');
  assert.equal(h.undo(), false);
});

test('labels list applied then undone steps, and goto jumps to any state', () => {
  const s = store();
  const h = new History(s);
  for (const v of ['a', 'b', 'c']) h.run(v.toUpperCase(), () => { s.value += v; });
  h.undo();
  assert.deepEqual(h.labels, ['A', 'B', 'C']);
  assert.equal(h.current, 2);
  assert.ok(h.goto(0));
  assert.equal(s.value, '');
  assert.equal(h.current, 0);
  assert.ok(h.goto(3));
  assert.equal(s.value, 'abc');
  assert.equal(h.goto(3), false);
  assert.equal(h.goto(9), false);
  assert.deepEqual(h.labels, ['A', 'B', 'C']);
  assert.equal(s.live(), 3);
});

test('clear frees everything', () => {
  const s = store();
  const h = new History(s);
  h.run('A', () => { s.value = 'a'; });
  h.undo();
  h.clear();
  assert.equal(s.live(), 0);
  assert.equal(h.undoLabel, null);
  assert.equal(h.redoLabel, null);
});
