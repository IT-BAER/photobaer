// Independent implementation of the docs/M4.md section 9 warp formulas; writes warp_golden.json.
// Run: node engine/src/testdata/warp_golden.mjs
import { writeFileSync } from 'node:fs';

const B = { x: 10, y: 20, w: 200, h: 50 };
const styles = ['arc', 'arc_lower', 'arc_upper', 'arch', 'bulge', 'shell_lower', 'shell_upper', 'flag', 'wave', 'fish', 'rise', 'fisheye', 'inflate', 'squeeze', 'twist'];

function warp(style, b, H, V, px, py) {
  const u = (px - B.x) / B.w, v = (py - B.y) / B.h;
  let X = 2 * u - 1, Y = 2 * v - 1;
  if (H) Y *= 1 + H * X;
  if (V) X *= 1 + V * Y;
  const hw = B.w / 2, hh = B.h / 2, arc = -b * hh * (1 - X * X);
  let dx = 0, dy = 0;
  if (style === 'arc') dy = arc;
  else if (style === 'arc_lower') dy = arc * v;
  else if (style === 'arc_upper') dy = arc * (1 - v);
  else if (style === 'arch') dy = arc * (0.5 + 0.5 * v);
  else if (style === 'bulge') dy = Y * hh * b * (1 - X * X);
  else if (style === 'shell_lower') { dy = arc * v; dx = -b * X * hw * 0.3 * v; }
  else if (style === 'shell_upper') { dy = arc * (1 - v); dx = -b * X * hw * 0.3 * (1 - v); }
  else if (style === 'flag') dy = -b * hh * Math.sin(2 * Math.PI * u);
  else if (style === 'wave') dy = -b * hh * Math.sin(2 * Math.PI * u) * (1 - 2 * v);
  else if (style === 'fish') dy = -Y * hh * b * X * X;
  else if (style === 'rise') dy = -b * hh * X;
  else if (style === 'fisheye') { const E = 1 + b * (1 - Math.min(1, Math.hypot(X, Y)) ** 2); dx = X * (E - 1) * hw; dy = Y * (E - 1) * hh; }
  else if (style === 'inflate') { dx = X * b * (1 - Y * Y) * hw; dy = Y * b * (1 - X * X) * hh; }
  else if (style === 'squeeze') { dx = -X * b * (1 - Y * Y) * hw; dy = -Y * b * (1 - X * X) * hh; }
  else if (style === 'twist') {
    const a = b * Math.PI * Math.min(1, Math.hypot(X, Y)), qx = X * hw, qy = Y * hh;
    dx = qx * Math.cos(a) - qy * Math.sin(a) - qx; dy = qx * Math.sin(a) + qy * Math.cos(a) - qy;
  }
  return [B.x + (X + 1) * hw + dx, B.y + (Y + 1) * hh + dy];
}

const pts = [[10, 20], [60, 30], [110, 45], [185, 62], [210, 70], [37, 58]];
const params = [[0.5, 0, 0], [-0.8, 0.3, -0.2], [1, -1, 0.6]];
const cases = [];
for (const s of styles) for (const [b, H, V] of params) for (const [x, y] of pts) cases.push({ style: s, bend: b, horizontal: H, vertical: V, p: [x, y], q: warp(s, b, H, V, x, y) });
writeFileSync(new URL('./warp_golden.json', import.meta.url), JSON.stringify({ bounds: [B.x, B.y, B.w, B.h], cases }));
console.log(cases.length);
