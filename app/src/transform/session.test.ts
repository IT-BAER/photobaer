import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from './matrix.ts';
import { commandState, drag, handlePoints, hitTest, initialState, matrixOf, numericValues, opFor, refPoint, setNumeric, setReference, setReferenceNormalized, type Mods } from './session.ts';

const close = (a: number[], b: number[], eps = 1e-9) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= eps, `index ${i}: ${v} vs ${b[i]}`));
const none: Mods = { shift: false, alt: false, ctrl: false };
const B = { x: 0, y: 0, w: 100, h: 50 };
const id = (p: [number, number]): [number, number] => p;

test('handles run clockwise from the top-left corner and the reference defaults to the bounds centre', () => {
  const s = initialState(B);
  assert.deepEqual(handlePoints(s), [[0, 0], [50, 0], [100, 0], [100, 25], [100, 50], [50, 50], [0, 50], [0, 25]]);
  assert.deepEqual(refPoint(s), [50, 25]);
});

test('hit testing: reference, then corners, then edges; inside is the body, a 32 px band outside rotates', () => {
  const small = initialState({ x: 0, y: 0, w: 10, h: 10 });
  // (4, 4) is within 8 px of both the reference and the top-left corner.
  assert.deepEqual(hitTest(small, id, [4, 4]), { kind: 'ref' });
  assert.deepEqual(hitTest(initialState({ x: 0, y: 0, w: 20, h: 20 }), id, [1, 1]), { kind: 'handle', i: 0 });
  const s = initialState(B);
  assert.deepEqual(hitTest(s, id, [52, 1]), { kind: 'handle', i: 1 });
  assert.deepEqual(hitTest(s, id, [30, 30]), { kind: 'body' });
  assert.deepEqual(hitTest(s, id, [130, 25]), { kind: 'rotate' });
  assert.equal(hitTest(s, id, [140, 25]), null);
  // Radius is in screen px: at 4x zoom a point 3 doc px off a corner is 12 screen px away.
  assert.deepEqual(hitTest(s, id, [103, 50]), { kind: 'handle', i: 4 });
  assert.deepEqual(hitTest(s, p => [p[0] * 4, p[1] * 4], [412, 200]), { kind: 'rotate' });
});

test('modifier to operation map', () => {
  const corner = { kind: 'handle' as const, i: 0 }, edge = { kind: 'handle' as const, i: 1 };
  assert.equal(opFor(corner, none, 'free'), 'scale');
  assert.equal(opFor(corner, { ...none, ctrl: true }, 'free'), 'distort');
  assert.equal(opFor(edge, { ...none, ctrl: true, shift: true }, 'free'), 'skew');
  assert.equal(opFor(corner, { ctrl: true, alt: true, shift: true }, 'free'), 'perspective');
  assert.equal(opFor(edge, { ctrl: true, alt: true, shift: true }, 'free'), 'skew');
  assert.equal(opFor(corner, none, 'rotate'), 'rotate');
  assert.equal(opFor(edge, none, 'perspective'), 'scale');
  assert.equal(opFor(corner, none, 'perspective'), 'perspective');
  assert.equal(opFor(edge, none, 'skew'), 'skew');
  assert.equal(opFor(edge, none, 'distort'), 'distort');
  assert.equal(opFor({ kind: 'body' }, { ...none, ctrl: true }, 'free'), 'move');
  assert.equal(opFor({ kind: 'rotate' }, none, 'scale'), 'rotate');
  assert.equal(opFor({ kind: 'ref' }, none, 'free'), 'ref');
});

test('corner scale is proportional by default about the opposite corner; Shift frees it; Alt scales about the reference', () => {
  const s = initialState(B);
  const opts = { linked: true };
  // Drag the bottom-right corner from (100, 50) to (200, 60): x ratio 2 beats y ratio 1.2.
  const p = drag(s, { kind: 'handle', i: 4 }, 'scale', none, [100, 50], [200, 60], opts)!;
  close([p.p.sx, p.p.sy], [2, 2]);
  close(apply(matrixOf(p), 0, 0), [0, 0]);
  const f = drag(s, { kind: 'handle', i: 4 }, 'scale', { ...none, shift: true }, [100, 50], [200, 60], opts)!;
  close([f.p.sx, f.p.sy], [2, 1.2]);
  const a = drag(s, { kind: 'handle', i: 4 }, 'scale', { ...none, shift: true, alt: true }, [100, 50], [150, 75], opts)!;
  close([a.p.sx, a.p.sy], [2, 2]);
  close(apply(matrixOf(a), 50, 25), [50, 25]);
  // An edge scales one axis unless Shift makes it proportional.
  const e = drag(s, { kind: 'handle', i: 3 }, 'scale', none, [100, 25], [150, 25], opts)!;
  close([e.p.sx, e.p.sy], [1.5, 1]);
  const es = drag(s, { kind: 'handle', i: 3 }, 'scale', { ...none, shift: true }, [100, 25], [150, 25], opts)!;
  close([es.p.sx, es.p.sy], [1.5, 1.5]);
});

test('rotate turns about the reference point and Shift snaps the absolute angle to 15 degrees', () => {
  const s = initialState(B);
  const r = drag(s, { kind: 'rotate' }, 'rotate', none, [150, 25], [50, 125], { linked: true })!;
  close([r.p.rotation], [Math.PI / 2]);
  close(apply(matrixOf(r), 50, 25), [50, 25]);
  const snapped = drag(s, { kind: 'rotate' }, 'rotate', { ...none, shift: true }, [150, 25], [150, 25 + 100 * Math.tan((20 * Math.PI) / 180)], { linked: true })!;
  close([snapped.p.rotation], [Math.PI / 12]);
});

test('skewing the top edge shears x by the local delta over the height, the bottom edge stays', () => {
  const s = initialState(B);
  const k = drag(s, { kind: 'handle', i: 1 }, 'skew', none, [50, 0], [75, 0], { linked: true })!;
  close([Math.tan(k.p.skewX)], [-0.5]);
  const m = matrixOf(k);
  close(apply(m, 0, 50), [0, 50]);
  close(apply(m, 0, 0), [25, 0]);
});

test('distort moves one corner; Alt moves the opposite corner by the negative delta; perspective moves the partner', () => {
  const s = initialState(B);
  const d = drag(s, { kind: 'handle', i: 4 }, 'distort', none, [100, 50], [110, 60], { linked: true })!;
  assert.deepEqual(d.quad, [[0, 0], [100, 0], [110, 60], [0, 50]]);
  close(apply(matrixOf(d), 100, 50), [110, 60]);
  const a = drag(s, { kind: 'handle', i: 4 }, 'distort', { ...none, alt: true }, [100, 50], [110, 60], { linked: true })!;
  assert.deepEqual(a.quad, [[-10, -10], [100, 0], [110, 60], [0, 50]]);
  const p = drag(s, { kind: 'handle', i: 0 }, 'perspective', none, [0, 0], [10, 2], { linked: true })!;
  assert.deepEqual(p.quad, [[10, 0], [90, 0], [100, 50], [0, 50]]);
  const py = drag(s, { kind: 'handle', i: 2 }, 'perspective', none, [100, 0], [101, 5], { linked: true })!;
  assert.deepEqual(py.quad, [[0, 0], [100, 5], [100, 45], [0, 50]]);
});

test('moving the reference point leaves the matrix unchanged; the 3x3 grid places it on the bounds', () => {
  const s = drag(initialState(B), { kind: 'rotate' }, 'rotate', none, [150, 25], [50, 125], { linked: true })!;
  const r = setReference(s, [10, 10]);
  close(matrixOf(r), matrixOf(s));
  close(refPoint(r), [10, 10]);
  const g = setReferenceNormalized(s, 0, 0);
  close(refPoint(g), apply(matrixOf(s), 0, 0));
  close(matrixOf(g), matrixOf(s));
});

test('numeric fields: X/Y move the reference, linked W keeps the ratio, commands rotate and flip', () => {
  const s = initialState(B);
  const x = setNumeric(s, 'x', 60, true);
  close(refPoint(x), [60, 25]);
  const w = setNumeric(s, 'w', 50, true);
  close([w.p.sx, w.p.sy], [0.5, 0.5]);
  close(numericValues(setNumeric(s, 'angle', 30, true)).slice(4, 5), [30]);
  close([commandState(s, 'cw').p.rotation], [Math.PI / 2]);
  close([commandState(s, 'flipH').p.sx], [-1]);
  close(apply(matrixOf(commandState(s, '180')), 0, 0), [100, 50]);
});
