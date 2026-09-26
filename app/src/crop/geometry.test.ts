import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cropActive, cropCancel, cropCommit, cropDown, cropMove, cropRatio, cropUp, croppedSize, hitCrop, newCropState, newPerspState,
  overlayLines, perspDown, perspMove, perspSize, perspUp, resizeCrop, roundOut, snapCropDrag, straightenAngle, type CropCtx,
} from './geometry.ts';

const R = { x: 10, y: 10, w: 100, h: 50 };
const close = (a: number[], b: number[]) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${a} vs ${b}`));

test('hitCrop finds the 8 handles within the radius in order, then the body, else nothing', () => {
  assert.equal(hitCrop(R, [14, 13], 5.5), 'topLeft');
  assert.equal(hitCrop(R, [16, 10], 5.5), 'body', '6 doc px from the corner is outside the radius but inside the rect');
  assert.equal(hitCrop(R, [60, 7], 5.5), 'top');
  assert.equal(hitCrop(R, [113, 35], 5.5), 'right');
  assert.equal(hitCrop(R, [60, 60], 5.5), 'bottom');
  assert.equal(hitCrop(R, [7, 62], 5.5), 'bottomLeft');
  assert.equal(hitCrop(R, [50, 30], 5.5), 'body');
  assert.equal(hitCrop(R, [200, 30], 5.5), null);
  assert.equal(hitCrop({ x: 0, y: 0, w: 4, h: 4 }, [2, 2], 11), 'topLeft', 'overlapping handles: the first in order wins');
});

test('resizeCrop moves the owned edges, normalizes flipped edges and moves the body', () => {
  assert.deepEqual(resizeCrop(R, 'bottomRight', 10, 5, null), { x: 10, y: 10, w: 110, h: 55 });
  assert.deepEqual(resizeCrop(R, 'left', 150, 0, null), { x: 110, y: 10, w: 50, h: 50 });
  assert.deepEqual(resizeCrop(R, 'top', 99, 99, null), { x: 10, y: 60, w: 100, h: 49 });
  assert.deepEqual(resizeCrop(R, 'body', -5, 7, null), { x: 5, y: 17, w: 100, h: 50 });
});

test('the ratio sets h = w / r, or w = h * r for top and bottom, keeping the normalized top-left', () => {
  assert.deepEqual(resizeCrop(R, 'bottomRight', 0, 0, 2), { x: 10, y: 10, w: 100, h: 50 });
  assert.deepEqual(resizeCrop(R, 'right', 20, 0, 2), { x: 10, y: 10, w: 120, h: 60 });
  assert.deepEqual(resizeCrop(R, 'top', 0, -10, 2), { x: 10, y: 0, w: 120, h: 60 });
  assert.deepEqual(resizeCrop(R, 'topLeft', -20, 0, 1), { x: -10, y: 10, w: 120, h: 120 }, 'not anchored on the opposite corner');
  assert.deepEqual(resizeCrop({ x: 5, y: 5, w: 0, h: 0 }, 'bottomRight', 10, 0, 2), { x: 5, y: 5, w: 10, h: 0 }, 'no ratio on an empty rect');
});

test('cropRatio: presets, original, and W/H only when free and both are positive', () => {
  assert.equal(cropRatio({ ratio: 'free', ratioWidth: 0, ratioHeight: 0 }, 200, 100), null);
  assert.equal(cropRatio({ ratio: 'free', ratioWidth: 3, ratioHeight: 0 }, 200, 100), null);
  assert.equal(cropRatio({ ratio: 'free', ratioWidth: 3, ratioHeight: 2 }, 200, 100), 1.5);
  assert.equal(cropRatio({ ratio: 'original', ratioWidth: 3, ratioHeight: 2 }, 200, 100), 2);
  assert.equal(cropRatio({ ratio: '4:5', ratioWidth: 3, ratioHeight: 2 }, 200, 100), 0.8);
  assert.equal(cropRatio({ ratio: '5:7' }, 200, 100), 5 / 7);
  assert.equal(cropRatio({ ratio: '16:9' }, 200, 100), 16 / 9);
  assert.equal(cropRatio({ ratio: '1:1' }, 200, 100), 1);
  assert.equal(cropRatio({ ratio: '2:3' }, 200, 100), 2 / 3);
});

test('straightenAngle folds the line angle into [-45, 45)', () => {
  assert.equal(straightenAngle([0, 0], [10, 0]), 0);
  assert.equal(straightenAngle([0, 0], [10, 10]), -45);
  assert.equal(straightenAngle([0, 0], [0, 10]), 0);
  close([straightenAngle([0, 0], [10, 1])], [Math.atan2(1, 10) * 180 / Math.PI]);
  close([straightenAngle([0, 0], [-10, 1])], [-Math.atan2(1, 10) * 180 / Math.PI]);
});

test('overlayLines per overlay kind', () => {
  const r = { x: 0, y: 0, w: 90, h: 60 };
  assert.deepEqual(overlayLines(r, 'none'), []);
  assert.deepEqual(overlayLines(r, 'thirds'), [[30, 0, 30, 60], [60, 0, 60, 60], [0, 20, 90, 20], [0, 40, 90, 40]]);
  assert.deepEqual(overlayLines({ x: 0, y: 0, w: 64, h: 40 }, 'grid'), [[16, 0, 16, 40], [32, 0, 32, 40], [48, 0, 48, 40], [0, 16, 64, 16], [0, 32, 64, 32]]);
  const big = overlayLines({ x: 0, y: 0, w: 400, h: 200 }, 'grid');
  assert.deepEqual([big.filter(l => l[0] === l[2]).length, big.filter(l => l[1] === l[3]).length], [15, 7], 'step = min(w, h) / 8 = 25');
  assert.deepEqual(overlayLines(r, 'diagonal'), [[0, 0, 90, 60], [90, 0, 0, 60]]);
  assert.deepEqual(overlayLines({ x: 0, y: 0, w: 100, h: 50 }, 'triangle'), [[0, 0, 100, 50], [100, 0, 50, 25], [0, 50, 50, 25]]);
  const p = 0.6180339887498949;
  close(overlayLines({ x: 0, y: 0, w: 100, h: 50 }, 'golden ratio').flat(), [100 * p, 0, 100 * p, 50, 100 - 100 * p, 0, 100 - 100 * p, 50, 0, 50 * p, 100, 50 * p, 0, 50 - 50 * p, 100, 50 - 50 * p]);
  assert.deepEqual(overlayLines({ x: 0, y: 0, w: 100, h: 60 }, 'golden spiral'), [[60, 0, 60, 60], [60, 20, 100, 20], [80, 0, 80, 20], [80, 0, 80, 20]]);
});

test('roundOut floors the top-left and ceils the bottom-right; croppedSize maps a straightened rect like the engine', () => {
  assert.deepEqual(roundOut({ x: 1.5, y: 2.2, w: 3, h: 3 }), { x: 1, y: 2, w: 4, h: 4 });
  assert.deepEqual(croppedSize({ x: 10, y: 10, w: 50, h: 20 }, 0, 100, 50), [50, 20]);
  assert.deepEqual(croppedSize({ x: 0.5, y: 0, w: 10, h: 10 }, 0, 100, 50), [11, 10]);
  assert.deepEqual(croppedSize({ x: 10, y: 10, w: 50, h: 20 }, 10, 100, 50), [53, 29]);
});

test('snapCropDrag: the body snaps left, centre or right; an edge only its own edge; catch 6 and hold 10 screen px', () => {
  let r = snapCropDrag({ x: 3, y: 0, w: 40, h: 40 }, 'body', -1, 30, 100, 100, { x: null, y: null }, 1);
  assert.deepEqual([r.dx, r.dy], [-3, 30]);
  r = snapCropDrag({ x: 3, y: 0, w: 40, h: 40 }, 'body', 5, 30, 100, 100, r.lock, 1);
  assert.equal(r.dx, -3, 'held within 10 px');
  r = snapCropDrag({ x: 3, y: 0, w: 40, h: 40 }, 'body', 8, 30, 100, 100, r.lock, 1);
  assert.equal(r.dx, 7, 'released and caught by the right edge at the centre');
  r = snapCropDrag({ x: 0, y: 0, w: 40, h: 40 }, 'right', 8, 3, 100, 100, { x: null, y: null }, 1);
  assert.deepEqual([r.dx, r.dy], [10, 3], 'the right handle has no y anchor');
  r = snapCropDrag({ x: 0, y: 0, w: 40, h: 40 }, 'right', 8, 3, 100, 100, { x: null, y: null }, 4);
  assert.deepEqual([r.dx, r.dy], [8, 3], 'at 400% the catch is 1.5 doc px');
});

const ctx = (o: Partial<CropCtx> = {}): CropCtx => ({ docW: 100, docH: 80, zoom: 1, ratio: null, straighten: false, ...o });
const up = { shift: false, alt: false }, alt = { shift: false, alt: true }, shift = { shift: true, alt: false };

test('crop pointer: the box starts as the canvas, the body moves it, and a press elsewhere starts a new box', () => {
  const s = newCropState();
  assert.equal(cropActive(s), false);
  cropDown(s, [50, 40], ctx());
  cropMove(s, [60, 45], alt, ctx());
  cropUp(s, [60, 45], alt, ctx());
  assert.deepEqual(s.rect, { x: 10, y: 5, w: 100, h: 80 }, 'the box may extend past the canvas');
  assert.equal(cropActive(s), true);
  s.rect = { x: 0, y: 0, w: 50, h: 50 };
  cropDown(s, [80, 70], ctx());
  assert.deepEqual(s.rect, { x: 80, y: 70, w: 0, h: 0 });
  cropMove(s, [90, 75], alt, ctx());
  assert.deepEqual(s.rect, { x: 80, y: 70, w: 10, h: 5 });
  cropMove(s, [70, 60], alt, ctx());
  assert.deepEqual(s.rect, { x: 70, y: 60, w: 10, h: 10 }, 'dragging past the start flips');
  cropMove(s, [80, 70], alt, ctx());
  assert.deepEqual(s.rect, { x: 80, y: 70, w: 0, h: 0 }, 'back at the origin');
  cropUp(s, [80, 70], alt, ctx());
  assert.deepEqual([s.rect, cropActive(s)], [null, false], 'a click without a drag leaves no box');
  s.rect = { x: 0, y: 0, w: 50, h: 50 };
  cropDown(s, [97, 3], ctx());
  assert.deepEqual(s.rect, { x: 100, y: 0, w: 0, h: 0 }, 'the new box start snaps to the canvas');
});

test('crop pointer: the ratio applies unless Shift is held; Alt turns snapping off', () => {
  const s = newCropState();
  s.rect = { x: 0, y: 0, w: 20, h: 20 };
  cropDown(s, [60, 50], ctx());
  cropMove(s, [70, 55], alt, ctx({ ratio: 1 }));
  assert.deepEqual(s.rect, { x: 60, y: 50, w: 10, h: 10 });
  cropMove(s, [70, 55], { shift: true, alt: true }, ctx({ ratio: 1 }));
  assert.deepEqual(s.rect, { x: 60, y: 50, w: 10, h: 5 });
  cropMove(s, [96, 55], shift, ctx());
  assert.deepEqual(s.rect, { x: 60, y: 50, w: 40, h: 5 }, 'snapped to the right canvas edge');
  cropMove(s, [96, 55], { shift: true, alt: true }, ctx());
  assert.deepEqual(s.rect, { x: 60, y: 50, w: 36, h: 5 });
});

test('crop pointer: straighten measures the dragged line, keeps the box and reports the angle', () => {
  const s = newCropState();
  cropDown(s, [0, 0], ctx({ straighten: true }));
  cropMove(s, [5, 0], up, ctx({ straighten: true }));
  assert.deepEqual(s.line, [[0, 0], [5, 0]]);
  const a = cropUp(s, [10, 1], up, ctx({ straighten: true }));
  close([a!, s.angle], [Math.atan2(1, 10) * 180 / Math.PI, Math.atan2(1, 10) * 180 / Math.PI]);
  assert.deepEqual([s.rect, s.line, cropActive(s)], [null, null, true]);
  cropCancel(s);
  assert.deepEqual([s.rect, s.angle, cropActive(s)], [null, 0, false]);
});

test('cropCommit: rounded-out rect and angle, nothing for the untouched canvas, an empty box stays', () => {
  const s = newCropState();
  assert.equal(cropCommit(s, 100, 80), null);
  s.rect = { x: 10.5, y: 10, w: 20, h: 20 };
  assert.deepEqual(cropCommit(s, 100, 80), { rect: { x: 10, y: 10, w: 21, h: 20 }, angle: 0 });
  assert.deepEqual([s.rect, s.angle], [null, 0]);
  s.rect = { x: 10, y: 10, w: 0, h: 5 };
  assert.equal(cropCommit(s, 100, 80), null);
  assert.deepEqual(s.rect, { x: 10, y: 10, w: 0, h: 5 });
  s.rect = { x: 0, y: 0, w: 100, h: 80 };
  assert.equal(cropCommit(s, 100, 80), null);
  assert.equal(s.rect, null);
  s.angle = 5;
  assert.deepEqual(cropCommit(s, 100, 80), { rect: { x: 0, y: 0, w: 100, h: 80 }, angle: 5 });
  assert.equal(s.angle, 0);
});

const pctx = { docW: 1000, docH: 1000, zoom: 1 };
function click(s: ReturnType<typeof newPerspState>, p: [number, number], out: [number, number] = [0, 0]) {
  perspDown(s, p, pctx);
  return perspUp(s, p, pctx, ...out);
}

test('perspective: clicks place corners in order, the 4th release reports the auto size, a 5th click restarts', () => {
  const s = newPerspState();
  assert.equal(click(s, [100, 100]), null);
  click(s, [400, 100]);
  click(s, [400, 300]);
  assert.deepEqual(click(s, [100, 300]), [300, 200]);
  assert.deepEqual(s.corners, [[100, 100], [400, 100], [400, 300], [100, 300]]);
  assert.deepEqual(click(s, [100, 300], [640, 480]), [640, 480], 'set output values win');
  click(s, [700, 700]);
  assert.deepEqual(s.corners, [[700, 700]]);
});

test('perspective: a press within 10 screen px drags that corner; corners snap to the canvas', () => {
  const s = newPerspState();
  for (const p of [[100, 100], [400, 100], [400, 300], [100, 300]] as [number, number][]) click(s, p);
  perspDown(s, [403, 104], pctx);
  perspMove(s, [420, 90], pctx);
  perspUp(s, [420, 90], pctx, 0, 0);
  assert.deepEqual(s.corners, [[100, 100], [420, 90], [400, 300], [100, 300]]);
  perspDown(s, [100, 311], { ...pctx, zoom: 2 });
  assert.equal(s.corners.length, 1, '11 doc px at 200% is 22 screen px: a restart');
  const t = newPerspState();
  click(t, [3, 200]);
  assert.deepEqual(t.corners, [[0, 200]]);
});

test('perspSize: auto size from the edge lengths, at least 1 px', () => {
  assert.deepEqual(perspSize([[0, 0], [10, 0], [12, 20], [0, 21]], 0, 0), [11, 21]);
  assert.deepEqual(perspSize([[5, 5], [5, 5], [5, 5], [5, 5]], 0, 0), [1, 1]);
  assert.deepEqual(perspSize([[0, 0], [10, 0], [10, 10], [0, 10]], 30, 0), [10, 10], 'both outputs must be set');
});
