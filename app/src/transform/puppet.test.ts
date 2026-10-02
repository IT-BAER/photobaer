import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PuppetSession, type Geometry, type Grid } from './puppet.ts';

const MESH: Grid = { x: 0, y: 0, step: 10, w: 10, h: 10, cols: 1, rows: 1, cells: [0, 1], transform: [1, 0, 0, 0, 1, 0] };
const MESH2: Grid = { ...MESH, step: 5, cols: 2, rows: 2, cells: [0, 4] };
// One 10 x 10 cell as two triangles, deformed by +5 in x.
const GEO: Geometry = { rest: [0, 0, 10, 0, 10, 10, 0, 10], deformed: [5, 0, 15, 0, 15, 10, 5, 10], triangles: [0, 1, 2, 0, 2, 3] };
const R = 3;
const round = (v: number) => Math.round(v * 1e9) / 1e9;

function session() {
  const s = new PuppetSession(MESH);
  s.geometry = GEO;
  return s;
}

test('a click inside the deformed mesh adds a selected pin at its rest point', () => {
  const s = session();
  const p = s.add(6, 1, R)!;
  assert.ok(p);
  assert.deepEqual([p.x, p.y, p.tx, p.ty].map(round), [1, 1, 6, 1]);
  assert.deepEqual([...s.selected], [p.id]);
});

test('a click outside the mesh or near a pin adds nothing', () => {
  const s = session();
  assert.equal(s.add(2, 5, R), null, 'outside the deformed mesh');
  s.add(8, 5, R);
  assert.equal(s.add(9, 6, R), null, 'within the hit radius of a pin');
  assert.equal(s.pins.length, 1);
});

test('drag moves the selected pins; shift locks to the dominant axis', () => {
  const s = session();
  const p = s.add(8, 5, R)!;
  s.begin(p, 8, 5); s.move(12, 6); s.end();
  assert.deepEqual([s.pins[0].tx, s.pins[0].ty], [12, 6]);
  s.begin(s.pins[0], 12, 6); s.move(15, 8, true); s.end();
  assert.deepEqual([s.pins[0].tx, s.pins[0].ty], [15, 6]);
  assert.ok(s.isModified());
});

test('shift-click toggles selection; delete removes the selected pins', () => {
  const s = session();
  const a = s.add(6, 1, R)!, b = s.add(14, 9, R)!;
  assert.deepEqual([...s.selected], [b.id]);
  s.begin(a, 6, 1, false, true); s.end();
  assert.deepEqual([...s.selected].sort(), [a.id, b.id].sort());
  s.removeSelected();
  assert.equal(s.pins.length, 0);
});

test('alt-drag rotates the selected pins around the pivot and fixes their rotation; shift snaps 15 deg', () => {
  const s = session();
  const p = s.add(10, 5, R)!;
  s.begin(p, 20, 5, true); s.move(10, 15); s.end();
  assert.ok(Math.abs(s.pins[0].rotation - Math.PI / 2) < 1e-12);
  assert.equal(s.pins[0].fixed, true);
  s.begin(s.pins[0], 20, 5, true); s.move(20, 6, true); s.end();
  assert.ok(Math.abs(s.pins[0].rotation - Math.PI / 2) < 1e-12, 'a 5.7 deg turn snaps to 0');
});

test('rig() is the engine param: no pin ids, the mesh and options', () => {
  const s = session();
  s.add(6, 1, R);
  const rig = s.rig();
  rig.pins = rig.pins.map(p => ({ ...p, x: round(p.x), y: round(p.y) }));
  assert.deepEqual(rig, { mesh: MESH, pins: [{ x: 1, y: 1, tx: 6, ty: 1, rotation: 0, fixed: false, depth: 0 }], mode: 'normal', density: 'normal', expansion: 2 });
});

test('rotationOf reads a fixed rotation, else the turn of the nearest mesh edge', () => {
  const s = session();
  const p = s.add(6, 1, R)!;
  assert.equal(s.rotationOf(p), 0, 'a translated mesh has no turn');
  s.updatePins(q => ({ ...q, rotation: 0.5, fixed: true }));
  assert.equal(s.rotationOf(s.pins[0]), 0.5);
});

test('options with a new mesh and pin edits step through session undo/redo', () => {
  const s = session();
  s.add(6, 1, R);
  s.updateOptions({ density: 'morePoints' }, MESH2);
  assert.equal(s.mesh, MESH2);
  s.updatePins(p => ({ ...p, depth: p.depth + 1 }));
  assert.equal(s.pins[0].depth, 1);
  s.historyStep('undo');
  assert.equal(s.pins[0].depth, 0);
  s.historyStep('undo');
  assert.deepEqual(s.mesh, MESH);
  assert.equal(s.options.density, 'normal');
  s.historyStep('undo');
  assert.equal(s.pins.length, 0);
  s.historyStep('redo');
  assert.equal(s.pins.length, 1);
  s.reset();
  assert.equal(s.pins.length, 0);
});
