import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDENTITY, apply, denormalize, homography, identityParams, invert, isIdentity, mul, normalize, rectQuad, transformMatrix, type Mat3, type Quad } from './matrix.ts';

const close = (a: number[], b: number[], eps = 1e-9) => {
  assert.equal(a.length, b.length);
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= eps, `index ${i}: ${v} vs ${b[i]}`));
};

test('scale applies before skew and skew before rotation, about the reference point', () => {
  const ref: [number, number] = [10, 20];
  const m = transformMatrix({ ...identityParams(), sx: 2, rotation: Math.PI / 2 }, ref, { x: 0, y: 0, w: 20, h: 40 }, null);
  // (11, 20) is 1 px right of ref: scaled to 2 px, then rotated 90 degrees clockwise (y down) to 2 px below.
  close(apply(m, 11, 20), [10, 22]);
  // Skew then rotate: x' = x + tan(45) y for a point 1 px below ref, then rotated 90 degrees.
  const k = transformMatrix({ ...identityParams(), skewX: Math.PI / 4, rotation: Math.PI / 2 }, ref, { x: 0, y: 0, w: 20, h: 40 }, null);
  close(apply(k, 10, 21), [9, 21]);
  // The reference point stays put under scale, skew and rotation; translation is added last.
  const t = transformMatrix({ tx: 5, ty: -3, rotation: 0.7, sx: 1.5, sy: 0.5, skewX: 0.2, skewY: -0.1 }, ref, { x: 0, y: 0, w: 20, h: 40 }, null);
  close(apply(t, 10, 20), [15, 17]);
});

test('the homography maps the unit square corners exactly onto the quad, with h33 = 1', () => {
  const unit: Quad = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const q: Quad = [[2, 3], [10, 1], [12, 9], [1, 7]];
  const h = homography(unit, q);
  assert.equal(h[8], 1);
  unit.forEach((p, i) => close(apply(h, p[0], p[1]), q[i]));
  close(homography(unit, unit), IDENTITY);
});

test('a quad session multiplies the affine part after the source rect homography', () => {
  const b = { x: 0, y: 0, w: 10, h: 10 };
  const q: Quad = [[0, 0], [10, 0], [12, 12], [0, 10]];
  const m = transformMatrix({ ...identityParams(), tx: 100 }, [5, 5], b, q);
  close(apply(m, 10, 10), [112, 12]);
  close(apply(m, 0, 0), [100, 0]);
  close(transformMatrix(identityParams(), [5, 5], b, rectQuad(b)), IDENTITY);
});

test('invert gives the inverse of affine and projective maps, null when singular', () => {
  const m: Mat3 = [2, 1, 3, -1, 4, 5, 0.001, 0.002, 1];
  close(mul(m, invert(m)!), IDENTITY);
  close(mul(invert(m)!, m), IDENTITY);
  assert.equal(invert([1, 2, 0, 2, 4, 0, 0, 0, 1]), null);
});

test('normalize and denormalize replay a transform on other bounds (Transform Again)', () => {
  const b = { x: 10, y: 10, w: 20, h: 40 };
  // Scale 2 about the centre of b.
  const m = transformMatrix({ ...identityParams(), sx: 2, sy: 2 }, [20, 30], b, null);
  const n = normalize(m, b);
  close(denormalize(n, b), m);
  // Replayed on a 100 x 10 rect at (0, 0): scales 2 about that rect's centre.
  const m2 = denormalize(n, { x: 0, y: 0, w: 100, h: 10 });
  close(apply(m2, 50, 5), [50, 5]);
  close(apply(m2, 0, 0), [-50, -5]);
  assert.ok(isIdentity(normalize(IDENTITY, b)));
  assert.ok(!isIdentity(n));
});
