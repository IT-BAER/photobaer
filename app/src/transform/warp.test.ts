import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pt } from './matrix.ts';
import { STYLES, defaultPreset, dragPoint, dragSurface, engineMesh, evaluate, gridOf, hitPoint, identityMesh, meshModified, nearestSplit, parameterAt, pickStyle, presetMesh, removeSplit, removeSplitAt, setGrid, split, splitAt, surfaceWeights, type Mesh, type Preset, type Style } from './warp.ts';

const near = (a: Pt[], b: Pt[], eps = 1e-9) => {
  assert.equal(a.length, b.length);
  a.forEach((p, i) => assert.ok(Math.abs(p[0] - b[i][0]) <= eps && Math.abs(p[1] - b[i][1]) <= eps, `point ${i}: ${p} vs ${b[i]}`));
};
const B = { x: 0, y: 0, w: 100, h: 50 };
const preset = (style: Style, extra: Partial<Preset> = {}): Preset => ({ ...defaultPreset(style), bend: 0.5, ...extra });

// Bend 0.5 on 100x50, distortions 0: hand-evaluated envelopes (Q = pi/4, E = 4/3 (sqrt 2 - 1), radius 50 sqrt 2),
// degree-elevated to one 4x4 patch.
const GOLDEN: Record<string, Pt[]> = {
  arc: [[-35.3553390593, 14.6446609407], [11.7851130198, -32.4957911384], [88.2148869802, -32.4957911384], [135.3553390593, 14.6446609407], [-23.5702260396, 26.4297739604], [17.0614878437, -14.2019399228], [82.9385121563, -14.2019399228], [123.5702260396, 26.4297739604], [-11.7851130198, 38.2148869802], [22.3378626676, 4.0919112928], [77.6621373324, 4.0919112928], [111.7851130198, 38.2148869802], [0, 50], [27.6142374915, 22.3857625085], [72.3857625085, 22.3857625085], [100, 50]],
  arcUpper: [[0, 0], [27.6142374915, -27.6142374915], [72.3857625085, -27.6142374915], [100, 0], [0, 16.6666666667], [29.5206027721, -1.7428249944], [70.4793972279, -1.7428249944], [100, 16.6666666667], [0, 33.3333333333], [31.4269680527, 24.1285875028], [68.5730319473, 24.1285875028], [100, 33.3333333333], [0, 50], [33.3333333333, 50], [66.6666666667, 50], [100, 50]],
  arcLower: [[0, 0], [33.3333333333, 0], [66.6666666667, 0], [100, 0], [0, 16.6666666667], [31.4269680527, 25.8714124972], [68.5730319473, 25.8714124972], [100, 16.6666666667], [0, 33.3333333333], [29.5206027721, 51.7428249944], [70.4793972279, 51.7428249944], [100, 33.3333333333], [0, 50], [27.6142374915, 77.6142374915], [72.3857625085, 77.6142374915], [100, 50]],
  arch: [[0, 0], [27.6142374915, -27.6142374915], [72.3857625085, -27.6142374915], [100, 0], [0, 16.6666666667], [27.6142374915, -10.9475708249], [72.3857625085, -10.9475708249], [100, 16.6666666667], [0, 33.3333333333], [27.6142374915, 5.7190958418], [72.3857625085, 5.7190958418], [100, 33.3333333333], [0, 50], [27.6142374915, 22.3857625085], [72.3857625085, 22.3857625085], [100, 50]],
  bulge: [[0, 0], [27.6142374915, -27.6142374915], [72.3857625085, -27.6142374915], [100, 0], [0, 16.6666666667], [27.6142374915, 7.4619208362], [72.3857625085, 7.4619208362], [100, 16.6666666667], [0, 33.3333333333], [27.6142374915, 42.5380791638], [72.3857625085, 42.5380791638], [100, 33.3333333333], [0, 50], [27.6142374915, 77.6142374915], [72.3857625085, 77.6142374915], [100, 50]],
  shellUpper: [[-35.3553390593, 14.6446609407], [11.7851130198, -32.4957911384], [88.2148869802, -32.4957911384], [135.3553390593, 14.6446609407], [-23.5702260396, 26.4297739604], [33.3333333333, 16.6666666667], [66.6666666667, 16.6666666667], [123.5702260396, 26.4297739604], [0, 33.3333333333], [33.3333333333, 33.3333333333], [66.6666666667, 33.3333333333], [100, 33.3333333333], [0, 50], [33.3333333333, 50], [66.6666666667, 50], [100, 50]],
  shellLower: [[0, 0], [33.3333333333, 0], [66.6666666667, 0], [100, 0], [0, 16.6666666667], [33.3333333333, 16.6666666667], [66.6666666667, 16.6666666667], [100, 16.6666666667], [-23.5702260396, 23.5702260396], [33.3333333333, 33.3333333333], [66.6666666667, 33.3333333333], [123.5702260396, 23.5702260396], [-35.3553390593, 35.3553390593], [11.7851130198, 82.4957911384], [88.2148869802, 82.4957911384], [135.3553390593, 35.3553390593]],
  flag: [[0, 0], [33.3333333333, -50], [66.6666666667, 50], [100, 0], [0, 16.6666666667], [33.3333333333, -33.3333333333], [66.6666666667, 66.6666666667], [100, 16.6666666667], [0, 33.3333333333], [33.3333333333, -16.6666666667], [66.6666666667, 83.3333333333], [100, 33.3333333333], [0, 50], [33.3333333333, 0], [66.6666666667, 100], [100, 50]],
  wave: [[0, 0], [33.3333333333, 0], [66.6666666667, 0], [100, 0], [0, 16.6666666667], [33.3333333333, 50], [66.6666666667, -16.6666666667], [100, 16.6666666667], [0, 33.3333333333], [33.3333333333, 66.6666666667], [66.6666666667, 0], [100, 33.3333333333], [0, 50], [33.3333333333, 50], [66.6666666667, 50], [100, 50]],
  fish: [[0, 0], [33.3333333333, -50], [66.6666666667, 50], [100, 0], [0, 16.6666666667], [33.3333333333, 0], [66.6666666667, 33.3333333333], [100, 16.6666666667], [0, 33.3333333333], [33.3333333333, 50], [66.6666666667, 16.6666666667], [100, 33.3333333333], [0, 50], [33.3333333333, 100], [66.6666666667, 0], [100, 50]],
  rise: [[0, 50], [33.3333333333, 50], [66.6666666667, 0], [100, 0], [0, 66.6666666667], [33.3333333333, 66.6666666667], [66.6666666667, 16.6666666667], [100, 16.6666666667], [0, 83.3333333333], [33.3333333333, 83.3333333333], [66.6666666667, 33.3333333333], [100, 33.3333333333], [0, 100], [33.3333333333, 100], [66.6666666667, 50], [100, 50]],
  fisheye: [[0, 0], [33.3333333333, 0], [66.6666666667, 0], [100, 0], [0, 16.6666666667], [0, 0], [100, 0], [100, 16.6666666667], [0, 33.3333333333], [0, 50], [100, 50], [100, 33.3333333333], [0, 50], [33.3333333333, 50], [66.6666666667, 50], [100, 50]],
  inflate: [[0, 0], [33.3333333333, -8.3333333333], [66.6666666667, -8.3333333333], [100, 0], [-16.6666666667, 16.6666666667], [27.7777777778, 13.8888888889], [72.2222222222, 13.8888888889], [116.6666666667, 16.6666666667], [-16.6666666667, 33.3333333333], [27.7777777778, 36.1111111111], [72.2222222222, 36.1111111111], [116.6666666667, 33.3333333333], [0, 50], [33.3333333333, 58.3333333333], [66.6666666667, 58.3333333333], [100, 50]],
  squeeze: [[0, 0], [33.3333333333, -8.3333333333], [66.6666666667, -8.3333333333], [100, 0], [16.6666666667, 16.6666666667], [38.8888888889, 13.8888888889], [61.1111111111, 13.8888888889], [83.3333333333, 16.6666666667], [16.6666666667, 33.3333333333], [38.8888888889, 36.1111111111], [61.1111111111, 36.1111111111], [83.3333333333, 33.3333333333], [0, 50], [33.3333333333, 58.3333333333], [66.6666666667, 58.3333333333], [100, 50]],
  twist: [[0, 0], [33.3333333333, 0], [66.6666666667, 0], [100, 0], [0, 16.6666666667], [83.3333333333, 16.6666666667], [66.6666666667, 41.6666666667], [100, 16.6666666667], [0, 33.3333333333], [33.3333333333, 8.3333333333], [16.6666666667, 33.3333333333], [100, 33.3333333333], [0, 50], [33.3333333333, 50], [66.6666666667, 50], [100, 50]],
  // Vertical: extent 50 along y, cross extent 100, built then transposed into a 2x4 envelope.
  arcVertical: [[29.2893218813, -70.7106781187], [52.8595479209, -47.1404520791], [76.4297739604, -23.5702260396], [100, 0], [-23.5702260396, -17.8511301978], [13.0174763917, -7.2983805499], [49.605178823, 3.2543690979], [86.1928812542, 13.8071187458], [-23.5702260396, 67.8511301978], [13.0174763917, 57.2983805499], [49.605178823, 46.7456309021], [86.1928812542, 36.1928812542], [29.2893218813, 120.7106781187], [52.8595479209, 97.1404520791], [76.4297739604, 73.5702260396], [100, 50]],
  // Horizontal 0.3, vertical -0.4 on bounds at (10, 20): rows scale 1.4 / 0.6, then columns 0.7 / 0.9 / 1.1 / 1.3.
  arcDistorted: [[-46.0728534806, 39.9479617996], [8.502627441, -27.1128004963], [115.5043109857, -35.5911434438], [192.9220958855, 29.3413600818], [-25.1901093879, 48.1975409134], [20.5234427212, -1.6777716538], [100.812203421, -4.5038859696], [154.1398568562, 44.6620070075], [-4.3073652952, 56.4471200273], [32.5442580014, 23.7572571888], [86.1200958564, 26.5833715046], [115.3576178269, 59.9826539332], [16.5753787975, 64.6966991411], [44.5650732816, 49.1922860313], [71.4279882917, 57.6706289788], [76.5753787975, 75.3033008589]],
};

test('every preset at bend 0.5 gives the hand-evaluated 4x4 control points', () => {
  const styles = STYLES.filter(s => s !== 'none' && s !== 'custom');
  assert.equal(styles.length, 15);
  for (const s of styles) {
    const m = presetMesh(preset(s), B);
    assert.deepEqual([m.cols, m.rows, m.columnStops, m.rowStops], [1, 1, [0, 1], [0, 1]]);
    near(m.points, GOLDEN[s]);
  }
});

test('vertical orientation transposes the envelope; distortions scale rows then columns, then the bounds origin is added', () => {
  near(presetMesh(preset('arc', { orientation: 'vertical' }), B).points, GOLDEN.arcVertical);
  const r = { x: 10, y: 20, w: 100, h: 50 };
  const m = presetMesh(preset('arc', { horizontalDistortion: 0.3, verticalDistortion: -0.4 }), r);
  near(m.points, GOLDEN.arcDistorted);
  assert.deepEqual(m.bounds, r);
});

test('a negative bend mirrors the arc vertically; twist below 0 moves the other coordinates; values clamp to -1..1', () => {
  const flipped = GOLDEN.arc.map((_, i) => { const p = GOLDEN.arc[(3 - Math.floor(i / 4)) * 4 + i % 4]; return [p[0], 50 - p[1]] as Pt; });
  near(presetMesh(preset('arc', { bend: -0.5 }), B).points, flipped);
  const tw = presetMesh(preset('twist', { bend: -0.5 }), B).points;
  near([tw[5], tw[6], tw[9], tw[10]], [[100 / 3, 125 / 3], [50 / 3, 50 / 3], [250 / 3, 100 / 3], [200 / 3, 25 / 3]]);
  near(presetMesh(preset('rise', { bend: 3 }), B).points, presetMesh(preset('rise', { bend: 1 }), B).points);
  near(presetMesh(preset('arc', { verticalDistortion: -7 }), B).points, presetMesh(preset('arc', { verticalDistortion: -1 }), B).points);
});

test('none and custom give the identity mesh; distortions are ignored for none', () => {
  const id = identityMesh(B);
  near(id.points, Array.from({ length: 16 }, (_, i) => [(i % 4) * 100 / 3, Math.floor(i / 4) * 50 / 3] as Pt));
  near(presetMesh(preset('none', { horizontalDistortion: 0.5, verticalDistortion: 0.5 }), B).points, id.points);
  near(presetMesh(preset('custom'), B).points, id.points);
  near([evaluate(id, 0.3, 0.7)], [[30, 35]]);
});

test('picking a style from none or custom sets bend 0.5; otherwise the bend is kept', () => {
  assert.deepEqual(defaultPreset(), { style: 'none', bend: 0, horizontalDistortion: 0, verticalDistortion: 0, orientation: 'horizontal' });
  assert.equal(pickStyle(defaultPreset('none'), 'arc').bend, 0.5);
  assert.equal(pickStyle({ ...defaultPreset('custom'), bend: -0.2 }, 'flag').bend, 0.5);
  const p = pickStyle({ ...defaultPreset('arc'), bend: -0.2 }, 'flag');
  assert.deepEqual([p.style, p.bend], ['flag', -0.2]);
});

const samples: [number, number][] = [[0, 0], [1, 1], [0.1, 0.9], [0.33, 0.5], [0.5, 0.25], [0.77, 0.13], [0.999, 0.4]];
const same = (a: Mesh, b: Mesh, eps = 1e-9) => near(samples.map(([s, t]) => evaluate(a, s, t)), samples.map(([s, t]) => evaluate(b, s, t)), eps);

test('split inserts a stop and keeps the shape; remove split restores the control points', () => {
  const arc = presetMesh(preset('arc'), B);
  const v = split(arc, 'vertical', 0.37);
  assert.deepEqual([v.cols, v.rows, v.points.length, v.columnStops], [2, 1, 28, [0, 0.37, 1]]);
  same(v, arc);
  const vh = split(v, 'horizontal', 0.6);
  assert.deepEqual([vh.cols, vh.rows, vh.points.length, vh.rowStops], [2, 2, 49, [0, 0.6, 1]]);
  same(vh, arc);
  const vv = split(vh, 'vertical', 0.8);
  assert.deepEqual(vv.columnStops, [0, 0.37, 0.8, 1]);
  same(vv, arc);
  near(removeSplit(removeSplit(removeSplit(vv, 'vertical', 2), 'horizontal', 1), 'vertical', 1).points, arc.points);
  const back = removeSplit(vv, 'vertical', 1);
  assert.deepEqual(back.columnStops, [0, 0.8, 1]);
  same(back, arc);
  // A split on an existing stop or an edge, and removing an edge stop, change nothing.
  assert.equal(split(v, 'vertical', 0.37), v);
  assert.equal(split(arc, 'vertical', 1), arc);
  assert.equal(removeSplit(v, 'vertical', 0), v);
  assert.equal(removeSplit(v, 'horizontal', 1), v);
});

test('the nearest interior stop to a point is found in parameter space, columns win a tie', () => {
  const m = split(split(identityMesh(B), 'vertical', 0.5), 'horizontal', 0.3);
  assert.deepEqual(nearestSplit(m, 45, 40), { axis: 'vertical', boundary: 1 });
  assert.deepEqual(nearestSplit(m, 10, 16), { axis: 'horizontal', boundary: 1 });
  assert.equal(nearestSplit(identityMesh(B), 50, 25), null);
});

test('grid presets remove every split, then split at s/n; the surface is unchanged and the style becomes custom', () => {
  const arc = presetMesh(preset('arc'), B);
  const w = { mesh: split(arc, 'vertical', 0.2), preset: preset('arc') };
  const g3 = setGrid(w, 3);
  assert.equal(g3.preset.style, 'custom');
  assert.equal(w.preset.style, 'arc');
  assert.deepEqual([g3.mesh.cols, g3.mesh.rows, g3.mesh.points.length], [3, 3, 100]);
  near(g3.mesh.columnStops.map(v => [v, 0] as Pt), [[0, 0], [1 / 3, 0], [2 / 3, 0], [1, 0]]);
  same(g3.mesh, arc);
  for (const n of [4, 5]) {
    const g = setGrid(w, n).mesh;
    assert.deepEqual([g.cols, g.rows], [n, n]);
    same(g, arc);
  }
  near(setGrid(g3, 1).mesh.points, arc.points);
  same(setGrid({ mesh: identityMesh(B), preset: defaultPreset() }, 3).mesh, identityMesh(B));
});

test('point to parameters: a coarse search then Newton lands on the surface point', () => {
  const m = split(presetMesh(preset('bulge'), B), 'vertical', 0.4);
  for (const [s, t] of [[0.25, 0.6], [0.7, 0.1], [0.5, 0.5]]) {
    const p = evaluate(m, s, t);
    const r = parameterAt(m, p[0], p[1]);
    assert.ok(Math.abs(r.u - s) < 1e-6 && Math.abs(r.v - t) < 1e-6 && r.distance < 1e-6, `${s},${t}: ${JSON.stringify(r)}`);
  }
  assert.ok(parameterAt(m, -500, 25).distance > 100);
});

test('surface drag moves the grabbed point exactly to the cursor and only that patch\'s non-corner points', () => {
  const w = { mesh: split(presetMesh(preset('arc'), B), 'vertical', 0.4), preset: preset('arc') };
  const grab = evaluate(w.mesh, 0.7, 0.35);
  const weights = surfaceWeights(w.mesh, grab[0], grab[1], 2);
  assert.ok(weights);
  const { u, v } = parameterAt(w.mesh, grab[0], grab[1]);
  const out = dragSurface(w, weights, 7, -3);
  assert.equal(out.preset.style, 'custom');
  near([evaluate(out.mesh, u, v)], [[grab[0] + 7, grab[1] - 3]], 1e-6);
  // Patch 1 spans control columns 3..6; its corners (columns 3 and 6 on rows 0 and 3) and patch 0 stay put.
  const stride = 7;
  out.mesh.points.forEach((p, i) => {
    const r = Math.floor(i / stride), c = i % stride;
    const moved = p[0] !== w.mesh.points[i][0] || p[1] !== w.mesh.points[i][1];
    if (c < 3 || ((c === 3 || c === 6) && (r === 0 || r === 3))) assert.ok(!moved, `point ${i} moved`);
  });
  assert.equal(surfaceWeights(w.mesh, 50, 500, 2), null);
});

test('dragging an anchor moves its +/-1 neighbour handles rigidly; a handle moves alone', () => {
  const w = setGrid({ mesh: presetMesh(preset('flag'), B), preset: preset('flag') }, 3);
  const stride = 10, anchor = 3 * stride + 3;
  const out = dragPoint(w, anchor, 5, -2);
  assert.equal(out.preset.style, 'custom');
  out.mesh.points.forEach((p, i) => {
    const r = Math.floor(i / stride), c = i % stride;
    const d = Math.abs(r - 3) <= 1 && Math.abs(c - 3) <= 1 ? [5, -2] : [0, 0];
    near([p], [[w.mesh.points[i][0] + d[0], w.mesh.points[i][1] + d[1]]]);
  });
  // Corner anchor: only in-range neighbours move.
  const corner = dragPoint(w, 0, 1, 1).mesh;
  assert.deepEqual([0, 1, 10, 11, 2, 20].map(i => corner.points[i][0] - w.mesh.points[i][0]), [1, 1, 1, 1, 0, 0]);
  const handle = dragPoint(w, 1, 4, 4).mesh;
  near(handle.points, w.mesh.points.map((p, i) => (i === 1 ? [p[0] + 4, p[1] + 4] : p) as Pt));
});

test('the engine mesh is the warp_layer JSON: cols, rows, row-major [x, y] points and the stops', () => {
  const m = split(identityMesh({ x: 2, y: 3, w: 30, h: 60 }), 'horizontal', 0.5);
  const j = JSON.parse(engineMesh(m));
  assert.deepEqual(Object.keys(j).sort(), ['cols', 'columnStops', 'points', 'rowStops', 'rows']);
  assert.deepEqual([j.cols, j.rows, j.columnStops, j.rowStops, j.points.length], [1, 2, [0, 1], [0, 0.5, 1], 28]);
  assert.deepEqual(j.points[0], [2, 3]);
  near(j.points, m.points);
});

test('splitAt splits through the point on one or both axes; removeSplitAt removes the nearest split', () => {
  const m = identityMesh(B), r9 = (a: number[]) => a.map(v => Math.round(v * 1e9) / 1e9);
  const v = splitAt(m, 25, 10, 'vertical');
  assert.deepEqual([v.cols, v.rows, r9(v.columnStops)], [2, 1, [0, 0.25, 1]]);
  const h = splitAt(m, 25, 10, 'horizontal');
  assert.deepEqual([h.cols, h.rows, r9(h.rowStops)], [1, 2, [0, 0.2, 1]]);
  const c = splitAt(m, 25, 10, 'both');
  assert.deepEqual([c.cols, c.rows, r9(c.columnStops), r9(c.rowStops)], [2, 2, [0, 0.25, 1], [0, 0.2, 1]]);
  const r = removeSplitAt(c, 26, 40)!;
  assert.deepEqual([r.cols, r.rows], [1, 2], 'the column split at u 0.25 is nearer than the row split at v 0.2');
  near(removeSplitAt(r, 0, 0)!.points, m.points, 1e-9);
  assert.equal(removeSplitAt(m, 50, 25), null);
});

test('grid value, modified check and the control point hit within a radius', () => {
  const m = identityMesh(B);
  assert.equal(gridOf(m), '1');
  assert.equal(gridOf(setGrid({ mesh: m, preset: defaultPreset() }, 4).mesh), '4');
  assert.equal(gridOf(splitAt(m, 25, 10, 'vertical')), 'custom');
  assert.equal(meshModified(m, identityMesh(B)), false);
  assert.equal(meshModified(splitAt(m, 25, 10, 'vertical'), m), true);
  assert.equal(meshModified(dragPoint({ mesh: m, preset: defaultPreset() }, 5, 1, 0).mesh, m), true);
  const screen = (p: Pt): Pt => [p[0] * 2, p[1] * 2];
  assert.equal(hitPoint(m, screen, [100 / 3 * 2 + 7, 0], 8), 1, 'the nearest point within 8 screen px');
  assert.equal(hitPoint(m, screen, [100 / 3 * 2 + 9, 0], 8), null);
});
