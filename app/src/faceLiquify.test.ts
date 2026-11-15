import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faceAt, faceField, FACE_ZERO, fromLandmarks, setEye, type Face, type FaceSettings } from './faceLiquify.ts';

// A frontal face in a 1000 x 1000 document (doc px); the oval uses indices no feature uses.
const W = 1000, H = 1000, OVAL = Array.from({ length: 16 }, (_, i) => 400 + i);
const PTS: Record<number, [number, number]> = {
  33: [380, 400], 133: [460, 400], 159: [420, 385], 145: [420, 415],
  362: [540, 400], 263: [620, 400], 386: [580, 385], 374: [580, 415],
  168: [500, 400], 1: [500, 520], 2: [500, 540], 129: [465, 530], 358: [535, 530],
  61: [440, 620], 291: [560, 620], 0: [500, 600], 13: [500, 615], 14: [500, 625], 17: [500, 645],
  105: [420, 360], 334: [580, 360], 10: [500, 250], 152: [500, 760],
};
OVAL.forEach((n, i) => { const a = (i / OVAL.length) * Math.PI * 2; PTS[n] = [500 + 170 * Math.cos(a), 505 + 255 * Math.sin(a)]; });

// `turn` rotates the face by 90 degrees clockwise about the document centre.
function face(turn = false): Face {
  const p = new Float32Array(478 * 2).fill(0.5);
  for (const [k, [x, y]] of Object.entries(PTS)) {
    const [a, b] = turn ? [1000 - y, x] : [x, y];
    p[Number(k) * 2] = a / W;
    p[Number(k) * 2 + 1] = b / H;
  }
  return fromLandmarks(p, OVAL, W, H);
}

const SP = 10, COLS = 101, ROWS = 101;
const at = (f: Float32Array, x: number, y: number) => { const i = ((y / SP) * COLS + x / SP) * 2; return [f[i], f[i + 1]]; };
const with_ = (patch: Partial<FaceSettings>): FaceSettings => ({ ...FACE_ZERO, ...patch });

test('Face-Aware Liquify: zero sliders give no field', () => {
  assert.equal(faceField([face()], [FACE_ZERO], COLS, ROWS, SP), null);
  assert.equal(faceField([], [], COLS, ROWS, SP), null);
});

test('Face-Aware Liquify: Eye Size enlarges one eye and leaves the rest', () => {
  const f = faceField([face()], [with_({ eyeSize: [50, 0] })], COLS, ROWS, SP)!;
  assert.equal(f.length, COLS * ROWS * 2);
  const [dx] = at(f, 450, 400);
  assert.ok(dx < -1, `inside the eye, right of its centre, the source is closer to the centre (${dx})`);
  assert.ok(at(f, 390, 400)[0] > 1, 'left of the centre it moves the other way');
  assert.deepEqual(at(f, 600, 400), [0, 0], 'the other eye stays');
  assert.deepEqual(at(f, 100, 100), [0, 0], 'far away nothing moves');
  assert.deepEqual(at(f, 500, 700), [0, 0]);
});

test('Face-Aware Liquify: linked eye sliders set both eyes', () => {
  assert.deepEqual(setEye(FACE_ZERO, 'eyeSize', 1, 40, true).eyeSize, [40, 40]);
  assert.deepEqual(setEye(FACE_ZERO, 'eyeTilt', 1, -30, false).eyeTilt, [0, -30]);
  assert.deepEqual(setEye(FACE_ZERO, 'eyeTilt', 0, 120, false).eyeTilt, [100, 0], 'values stay in -100..100');
  assert.deepEqual(FACE_ZERO.eyeTilt, [0, 0], 'the defaults are not changed');
});

test('Face-Aware Liquify: Face Width widens both sides; Forehead acts only above the brows', () => {
  const f = faceField([face()], [with_({ faceWidth: 100 })], COLS, ROWS, SP)!;
  assert.ok(at(f, 660, 500)[0] < -2, 'right edge samples from further in');
  assert.ok(at(f, 340, 500)[0] > 2, 'left edge samples from further in');
  assert.ok(Math.abs(at(f, 500, 500)[0]) < 0.5, 'the middle stays');
  const g = faceField([face()], [with_({ forehead: 100 })], COLS, ROWS, SP)!;
  assert.ok(at(g, 500, 300)[1] > 2, 'a taller forehead moves content up, so the source is lower');
  assert.deepEqual(at(g, 500, 520), [0, 0], 'below the brows nothing moves');
});

test('Face-Aware Liquify: the field follows the face orientation', () => {
  // Turned 90 degrees clockwise, the face's width runs along the image y axis.
  const f = faceField([face(true)], [with_({ faceWidth: 100 })], COLS, ROWS, SP)!;
  const [dx, dy] = at(f, 500, 660);
  assert.ok(Math.abs(dy) > 2 && Math.abs(dx) < Math.abs(dy) / 4, `width acts along y (${dx}, ${dy})`);
});

test('Face-Aware Liquify: every slider at its limit keeps the mesh from folding', () => {
  for (const v of [100, -100]) {
    const all = { ...with_({}), eyeSize: [v, v], eyeHeight: [v, v], eyeWidth: [v, v], eyeTilt: [v, v] } as FaceSettings;
    for (const k of Object.keys(all) as (keyof FaceSettings)[]) if (!Array.isArray(all[k])) (all as Record<string, unknown>)[k] = v;
    const f = faceField([face()], [all], COLS, ROWS, SP)!;
    let worst = Infinity;
    for (let r = 0; r < ROWS - 1; r++) for (let c = 0; c < COLS - 1; c++) {
      const k = (r * COLS + c) * 2;
      worst = Math.min(worst, SP + f[k + 2] - f[k], SP + f[k + COLS * 2 + 1] - f[k + 1]);
    }
    assert.ok(worst > 0, `neighbouring nodes keep their order at ${v} (closest ${worst.toFixed(2)} px)`);
  }
});

test('Face-Aware Liquify: the face under the pointer', () => {
  const a = face(), b = face(true);
  assert.equal(faceAt([a], 500, 500), 0);
  assert.equal(faceAt([], 500, 500), -1);
  assert.equal(faceAt([a, b], 495, 380), 0, 'inside face a only');
});
