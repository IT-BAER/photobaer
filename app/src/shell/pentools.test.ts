import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VectorPath } from '../worker/types.ts';
import {
  addAnchor, arrowDelta, convertToCorner, CurvatureDraft, curvatureAnchors, deleteAnchor, deleteAnchors, hitTest, moveHandle, nudgeAnchors,
  PenDraft, penAutoEdit, penTarget, translateSubs,
} from './pentools.ts';

const NO = { shift: false, alt: false, ctrl: false };
const corner = (x: number, y: number) => [x, y, x, y, x, y] as [number, number, number, number, number, number];
const open = (pts: [number, number][]): VectorPath => ({ fill_rule: 'nonzero', subpaths: [{ closed: false, op: 'combine', points: pts.map(([x, y]) => corner(x, y)) }] });

test('clicks on three points then on the first anchor finish one closed subpath of three corners', () => {
  const d = new PenDraft();
  for (const p of [[0, 0], [10, 0], [10, 10]] as [number, number][]) {
    assert.equal(d.down(p, NO, 4), null);
    d.up();
  }
  assert.equal(d.down([1, 1], NO, 4), 'closed');
  const s = d.subpath();
  assert.equal(s.closed, true);
  assert.deepEqual(s.points, [corner(0, 0), corner(10, 0), corner(10, 10)]);
});

test('a press dragged sideways makes a smooth anchor with a mirrored in handle', () => {
  const d = new PenDraft();
  d.down([10, 0], NO, 4);
  d.move([15, 0], NO);
  d.up();
  assert.deepEqual(d.points, [[10, 0, 5, 0, 15, 0]]);
});

test('Alt-drag on a draft handle breaks the mirror and leaves the other handle', () => {
  const d = new PenDraft();
  d.down([10, 0], NO, 4);
  d.move([15, 0], NO);
  d.up();
  d.down([15, 0], { ...NO, alt: true }, 4);
  d.move([15, 5], { ...NO, alt: true });
  d.up();
  assert.deepEqual(d.points, [[10, 0, 5, 0, 15, 5]]);
  d.undo();
  assert.deepEqual(d.points, [[10, 0, 5, 0, 15, 0]], 'the edit is one draft undo step');
  d.redo();
  assert.deepEqual(d.points, [[10, 0, 5, 0, 15, 5]]);
});

test('with no draft a click on a target segment adds an anchor and on an anchor deletes it', () => {
  const path = open([[0, 0], [20, 0], [20, 20]]);
  const add = penAutoEdit(path, 10, 1, 4)!;
  assert.equal(add.label, 'Add Anchor Point');
  assert.equal(add.kind, 'add');
  assert.deepEqual(add.path.subpaths[0].points.map(p => [p[0], p[1]]), [[0, 0], [10, 0], [20, 0], [20, 20]]);
  const del = penAutoEdit(path, 20, 1, 4)!;
  assert.equal(del.label, 'Delete Anchor Point');
  assert.equal(del.kind, 'delete');
  assert.deepEqual(del.path.subpaths[0].points, [corner(0, 0), corner(20, 20)]);
  assert.equal(penAutoEdit(path, 50, 50, 4), null);
});

test('curvature: three clicks give the middle point handles of +-(p2 - p0) / 6', () => {
  const d = new CurvatureDraft();
  for (const p of [[0, 0], [10, 10], [30, 0]] as [number, number][]) { d.down(p, false, 4); d.up(); }
  const m = d.anchors()[1];
  const h = [(30 - 0) / 6, (0 - 0) / 6];
  assert.deepEqual(m, [10, 10, 10 - h[0], 10 - h[1], 10 + h[0], 10 + h[1]]);
  assert.deepEqual(curvatureAnchors([[0, 0], [10, 10], [30, 0]], [false, true, false], false)[1], corner(10, 10), 'a corner point has no handles');
});

test('Direct Selection nudge moves the selected anchors 1 px, 10 with Shift', () => {
  const path = open([[0, 0], [20, 0], [20, 20]]);
  const [dx, dy] = arrowDelta('ArrowRight', false);
  assert.deepEqual(nudgeAnchors(path, [[0, 1], [0, 2]], dx, dy).subpaths[0].points, [corner(0, 0), corner(21, 0), corner(21, 20)]);
  assert.deepEqual(arrowDelta('ArrowUp', true), [0, -10]);
});

test('hit test order: anchor, then handle, then segment, then fill', () => {
  const path: VectorPath = { fill_rule: 'nonzero', subpaths: [{ closed: true, op: 'combine', points: [corner(0, 0), [20, 0, 20, 0, 25, 0], corner(20, 20), corner(0, 20)] }] };
  assert.deepEqual(hitTest(path, 21, 0, 4, { handles: true, fill: true }), { kind: 'anchor', s: 0, i: 1 });
  assert.deepEqual(hitTest(path, 26, 0, 4, { handles: true, fill: true }), { kind: 'handle', s: 0, i: 1, which: 'out' });
  const seg = hitTest(path, 10, 21, 4, { handles: true, fill: true });
  assert.equal(seg?.kind === 'segment' && seg.seg, 2);
  assert.deepEqual(hitTest(path, 10, 10, 4, { handles: true, fill: true }), { kind: 'fill', s: 0 });
  assert.equal(hitTest(path, 10, 10, 4, { handles: false, fill: false }), null);
});

test('path edit helpers: handles, corners, splits and deletes', () => {
  const smooth = { closed: false, op: 'combine', points: [[10, 0, 5, 0, 15, 0] as [number, number, number, number, number, number]] };
  assert.deepEqual(moveHandle(smooth, 0, 'out', 10, 10, {}).points[0], [10, 0, 10, -10, 10, 10], 'equal lengths stay symmetric');
  assert.deepEqual(moveHandle(smooth, 0, 'out', 10, 20, { symmetric: false }).points[0], [10, 0, 10, -5, 10, 20], 'keeps its length');
  assert.deepEqual(moveHandle(smooth, 0, 'out', 10, 20, { breakSmooth: true }).points[0], [10, 0, 5, 0, 10, 20]);
  assert.deepEqual(convertToCorner(smooth, 0).points[0], corner(10, 0));
  const line = { closed: false, op: 'combine', points: [corner(0, 0), [30, 0, 20, 0, 30, 0] as [number, number, number, number, number, number]] };
  const split = addAnchor(line, 0, 0.5).points;
  assert.equal(split.length, 3);
  assert.deepEqual([split[1][0], split[1][1]], [11.25, 0]);
  const tri: VectorPath = { fill_rule: 'nonzero', subpaths: [{ closed: true, op: 'combine', points: [corner(0, 0), corner(10, 0), corner(10, 10)] }] };
  assert.equal(deleteAnchor(tri, 0, 1).subpaths[0].closed, false, 'fewer than 3 points left opens it');
  assert.equal(deleteAnchors(tri, [[0, 0], [0, 1], [0, 2]]).subpaths.length, 0, 'an empty subpath is removed');
});

test('Path Selection moves subpaths and Alt copies them', () => {
  const path = open([[0, 0], [10, 0]]);
  assert.deepEqual(translateSubs(path, [0], 5, 5, false).path.subpaths[0].points[0], corner(5, 5));
  const r = translateSubs(path, [0], 5, 0, true);
  assert.equal(r.path.subpaths.length, 2);
  assert.deepEqual(r.sel, [1]);
});

test('target resolution: panel path, else a selected shape layer, else the work path unless cleared', () => {
  const p = open([[0, 0], [1, 1]]);
  const doc = { paths: [{ id: 1, name: 'Work Path', work: true, path: p }, { id: 2, name: 'Path 1', work: false, path: p }] };
  const shape = { id: 7, shape: { path: p } };
  assert.deepEqual(penTarget(doc, shape, 2, false), { role: 'document', id: 2, path: p });
  assert.deepEqual(penTarget(doc, shape, null, false), { role: 'shape', id: 7, path: p });
  assert.deepEqual(penTarget(doc, null, null, false), { role: 'document', id: 1, path: p });
  assert.equal(penTarget(doc, null, null, true), null);
});
