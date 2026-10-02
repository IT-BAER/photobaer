import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveSession, convex, engineState, validate, type State } from './pwarp.ts';

const B = { x: 0, y: 0, w: 200, h: 100 };
const SNAP = 9;

// Draws a quad by dragging from (x0, y0) to (x1, y1) in layout mode.
function draw(s: PerspectiveSession, x0: number, y0: number, x1: number, y1: number) {
  s.begin(x0, y0, SNAP); s.move(x1, y1); s.end();
}

test('drawing a quad adds 4 vertices; a second quad sharing an edge joins 2 of them', () => {
  const s = new PerspectiveSession(B);
  draw(s, 0, 0, 100, 100);
  assert.equal(s.state.quads.length, 1);
  assert.deepEqual(s.state.layout, [[0, 0], [100, 0], [100, 100], [0, 100]]);
  draw(s, 200, 100, 104, 3);
  assert.equal(s.state.quads.length, 2);
  assert.equal(s.state.layout.length, 6, 'corners within the snap reuse vertices 1 and 2');
  assert.deepEqual(s.state.quads[1].corners, [1, 4, 5, 2]);
});

test('a quad smaller than the snap is not drawn', () => {
  const s = new PerspectiveSession(B);
  draw(s, 0, 0, 5, 50);
  assert.equal(s.state.quads.length, 0);
});

test('warp mode needs a quad; Enter-like setMode switches and the engine state carries current', () => {
  const s = new PerspectiveSession(B);
  s.setMode('warp');
  assert.equal(s.state.mode, 'layout');
  draw(s, 0, 0, 100, 100);
  s.setMode('warp');
  assert.equal(s.state.mode, 'warp');
  s.begin(100, 100, SNAP); s.move(120, 110); s.end();
  assert.deepEqual(s.state.current[2], [120, 110]);
  assert.deepEqual(s.state.layout[2], [100, 100], 'warp mode leaves the layout');
  assert.ok(s.isModified());
  assert.deepEqual(engineState(s.state), { layout: [[0, 0], [100, 0], [100, 100], [0, 100]], current: [[0, 0], [100, 0], [120, 110], [0, 100]], quads: [[0, 1, 2, 3]] });
});

test('layout mode engine state uses the layout as current (no warp)', () => {
  const s = new PerspectiveSession(B);
  draw(s, 0, 0, 100, 100);
  s.setMode('warp'); s.begin(0, 0, SNAP); s.move(10, 10); s.end();
  s.setMode('layout');
  const e = engineState(s.state);
  assert.deepEqual(e.current, e.layout);
});

test('a move that makes a quad non-convex is rejected', () => {
  const s = new PerspectiveSession(B);
  draw(s, 0, 0, 100, 100);
  s.setMode('warp');
  s.begin(100, 100, SNAP); s.move(20, 20); s.end();
  assert.deepEqual(s.state.current[2], [100, 100]);
  assert.equal(convex([[0, 0], [100, 0], [20, 20], [0, 100]]), false);
});

test('shift-click straightens an edge to its mean, locks it, and a locked vertex drags its partner', () => {
  const s = new PerspectiveSession(B);
  draw(s, 0, 0, 100, 100);
  s.setMode('warp');
  s.begin(100, 0, SNAP); s.move(110, 0); s.end();
  s.straighten(1, 2);
  assert.deepEqual([s.state.current[1][0], s.state.current[2][0]], [105, 105]);
  assert.deepEqual(s.state.straightEdges, [{ a: 1, b: 2, axis: 'x' }]);
  s.begin(105, 100, SNAP); s.move(115, 100); s.end();
  assert.equal(s.state.current[1][0], 115, 'locked partner follows on the x axis');
  s.straighten(1, 2);
  assert.deepEqual(s.state.straightEdges, [], 'second shift-click unlocks');
});

test('hitEdge finds the edge near a point', () => {
  const s = new PerspectiveSession(B);
  draw(s, 0, 0, 100, 100);
  assert.deepEqual(s.hitEdge(100, 50, SNAP), [1, 2]);
  assert.equal(s.hitEdge(50, 50, SNAP), null);
});

test('dropping a vertex onto a vertex of another quad merges them', () => {
  const s = new PerspectiveSession(B);
  draw(s, 0, 0, 100, 100);
  draw(s, 120, 0, 200, 100);
  assert.equal(s.state.layout.length, 8);
  s.begin(120, 0, SNAP); s.move(101, 1); s.end();
  assert.equal(s.state.layout.length, 7);
  assert.equal(s.state.quads[1].corners[0], 1);
});

test('dragging inside a quad moves it; Delete removes the selected quad', () => {
  const s = new PerspectiveSession(B);
  draw(s, 0, 0, 100, 100);
  s.begin(50, 50, SNAP); s.move(60, 55); s.end();
  assert.deepEqual(s.state.layout[0], [10, 5]);
  s.removeSelected();
  assert.equal(s.state.quads.length, 0);
  assert.equal(s.state.layout.length, 0);
});

test('session undo and redo step whole edits', () => {
  const s = new PerspectiveSession(B);
  draw(s, 0, 0, 100, 100);
  s.setMode('warp');
  s.begin(0, 0, SNAP); s.move(10, 5); s.end();
  s.historyStep('undo');
  assert.deepEqual(s.state.current[0], [0, 0]);
  s.historyStep('undo');
  assert.equal(s.state.mode, 'layout');
  s.historyStep('redo'); s.historyStep('redo');
  assert.deepEqual(s.state.current[0], [10, 5]);
  s.reset();
  assert.deepEqual(s.state.current, s.state.layout);
});

test('auto straighten verticals locks the near-vertical edges', () => {
  const s = new PerspectiveSession(B);
  draw(s, 0, 0, 100, 100);
  s.setMode('warp');
  s.begin(0, 100, SNAP); s.move(6, 100); s.end();
  s.autoStraighten('vertical');
  assert.equal(s.state.straightEdges.length, 2);
  assert.equal(s.state.current[0][0], s.state.current[3][0]);
});

test('validate refuses a perspective across the horizon', () => {
  const st: State = { mode: 'warp', layout: [[0, 0], [100, 0], [100, 100], [0, 100]], current: [[0, 0], [100, 0], [55, 2], [45, 2]], quads: [{ id: 'q', corners: [0, 1, 2, 3] }], straightEdges: [] };
  assert.throws(() => validate(st, { x: 0, y: -1000, w: 100, h: 1100 }), /crosses the image horizon/);
  assert.doesNotThrow(() => validate({ ...st, current: st.layout }, B));
});

test('gridLines gives 10 lines per quad', () => {
  const s = new PerspectiveSession(B);
  draw(s, 0, 0, 100, 100);
  const g = s.gridLines();
  assert.equal(g.length, 10);
  assert.deepEqual(g[0], [[0, 0], [0, 100]]);
});
