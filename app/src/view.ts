export const TILE = 256;

// zoom: CSS px per document px; rot: radians clockwise on screen; (cx, cy): document point at the viewport center.
export interface View { zoom: number; rot: number; cx: number; cy: number }

export function screenToDoc(v: View, sx: number, sy: number, w: number, h: number): [number, number] {
  const px = (sx - w / 2) / v.zoom, py = (sy - h / 2) / v.zoom;
  const c = Math.cos(v.rot), s = Math.sin(v.rot);
  return [v.cx + c * px + s * py, v.cy - s * px + c * py];
}

export function docToScreen(v: View, dx: number, dy: number, w: number, h: number): [number, number] {
  const x = dx - v.cx, y = dy - v.cy;
  const c = Math.cos(v.rot), s = Math.sin(v.rot);
  return [w / 2 + v.zoom * (c * x - s * y), h / 2 + v.zoom * (s * x + c * y)];
}

export function zoomAt(v: View, factor: number, sx: number, sy: number, w: number, h: number): View {
  const zoom = Math.min(64, Math.max(1 / 256, v.zoom * factor));
  const [dx, dy] = screenToDoc(v, sx, sy, w, h);
  const [ox, oy] = screenToDoc({ ...v, zoom, cx: 0, cy: 0 }, sx, sy, w, h);
  return { ...v, zoom, cx: dx - ox, cy: dy - oy };
}

// Interpolates a to b at t in [0, 1]: zoom in log space, and the document point under screen (sx, sy)
// moves linearly, so an anchored zoom (both ends share that point) keeps it fixed on screen.
export function tweenView(a: View, b: View, t: number, sx: number, sy: number, w: number, h: number): View {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const zoom = a.zoom * (b.zoom / a.zoom) ** t, rot = a.rot + (b.rot - a.rot) * t;
  const [ax, ay] = screenToDoc(a, sx, sy, w, h), [bx, by] = screenToDoc(b, sx, sy, w, h);
  const [ox, oy] = screenToDoc({ zoom, rot, cx: 0, cy: 0 }, sx, sy, w, h);
  return { zoom, rot, cx: ax + (bx - ax) * t - ox, cy: ay + (by - ay) * t - oy };
}

export function panBy(v: View, dsx: number, dsy: number): View {
  const c = Math.cos(v.rot), s = Math.sin(v.rot);
  const px = dsx / v.zoom, py = dsy / v.zoom;
  return { ...v, cx: v.cx - (c * px + s * py), cy: v.cy - (-s * px + c * py) };
}

// Screen pan [dsx, dsy] for one frame of a tool drag with the pointer at (px, py) outside the viewport:
// faster farther out, and only while the document's screen bounds extend past that viewport edge.
export function edgeScroll(v: View, px: number, py: number, w: number, h: number, docW: number, docH: number): [number, number] {
  const q = [docToScreen(v, 0, 0, w, h), docToScreen(v, docW, 0, w, h), docToScreen(v, docW, docH, w, h), docToScreen(v, 0, docH, w, h)];
  const axis = (p: number, size: number, lo: number, hi: number) => {
    const out = p < 0 ? p : p > size ? p - size : 0;
    if (!out) return 0;
    const step = Math.min(40, 4 + Math.abs(out) / 4);
    return out < 0 ? Math.max(0, Math.min(step, -lo)) : -Math.max(0, Math.min(step, hi - size));
  };
  const xs = q.map(p => p[0]), ys = q.map(p => p[1]);
  return [axis(px, w, Math.min(...xs), Math.max(...xs)) + 0, axis(py, h, Math.min(...ys), Math.max(...ys)) + 0];
}

export function fit(docW: number, docH: number, w: number, h: number): View {
  return { zoom: 0.95 * Math.min(w / docW, h / docH), rot: 0, cx: docW / 2, cy: docH / 2 };
}

export function levelFor(zoom: number, dpr: number, maxLevel: number): number {
  const l = Math.floor(Math.log2(1 / (zoom * dpr)) + 1e-9);
  return Math.min(maxLevel, Math.max(0, l));
}

// The doc rect [x, y, w, h] bounding the (rotated) viewport, in whole px clamped to the document.
export function visibleRect(v: View, w: number, h: number, docW: number, docH: number): [number, number, number, number] {
  const q = [screenToDoc(v, 0, 0, w, h), screenToDoc(v, w, 0, w, h), screenToDoc(v, w, h, w, h), screenToDoc(v, 0, h, w, h)];
  const xs = q.map(p => p[0]), ys = q.map(p => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(docW, Math.ceil(Math.max(...xs))), y1 = Math.min(docH, Math.ceil(Math.max(...ys)));
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}

// Tiles of the given level that intersect the rotated viewport, nearest to the viewport center first.
export function visibleTiles(v: View, w: number, h: number, level: number, docW: number, docH: number): [number, number][] {
  const size = TILE << level;
  const q = [screenToDoc(v, 0, 0, w, h), screenToDoc(v, w, 0, w, h), screenToDoc(v, w, h, w, h), screenToDoc(v, 0, h, w, h)];
  const xs = q.map(p => p[0]), ys = q.map(p => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) / size)), x1 = Math.min(Math.ceil(docW / size), Math.ceil(Math.max(...xs) / size));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) / size)), y1 = Math.min(Math.ceil(docH / size), Math.ceil(Math.max(...ys) / size));
  // Separating-axis test against the two edge normals of the viewport quad.
  const axes = [[q[1][1] - q[0][1], q[0][0] - q[1][0]], [q[2][1] - q[1][1], q[1][0] - q[2][0]]];
  const spans = axes.map(([ax, ay]) => { const p = q.map(([x, y]) => x * ax + y * ay); return [Math.min(...p), Math.max(...p)]; });
  const out: [number, number][] = [];
  for (let ty = y0; ty < y1; ty++) {
    for (let tx = x0; tx < x1; tx++) {
      const cs = [[tx * size, ty * size], [(tx + 1) * size, ty * size], [tx * size, (ty + 1) * size], [(tx + 1) * size, (ty + 1) * size]];
      const hit = axes.every(([ax, ay], i) => {
        const p = cs.map(([x, y]) => x * ax + y * ay);
        return Math.max(...p) >= spans[i][0] && Math.min(...p) <= spans[i][1];
      });
      if (hit) out.push([tx, ty]);
    }
  }
  const d = (t: [number, number]) => ((t[0] + 0.5) * size - v.cx) ** 2 + ((t[1] + 0.5) * size - v.cy) ** 2;
  return out.sort((a, b) => d(a) - d(b));
}

// A stroke frame's dirty doc rect only refetches the tiles it overlaps; every other entry current at
// `version - 1` (strokeTo bumps the version by exactly one) moves to `version`. Entries that were
// already stale stay stale. An empty rect (no dab this frame) refetches nothing new.
export function invalidateEntries(cache: Map<string, { version: number }>, version: number, rect: readonly number[]) {
  const hit = rect.length === 4;
  const [rx, ry, rw, rh] = rect;
  for (const [key, e] of cache) {
    const [level, tx, ty] = key.split('/').map(Number);
    const size = TILE << level;
    const x0 = tx * size, y0 = ty * size;
    const intersects = hit && rx < x0 + size && rx + rw > x0 && ry < y0 + size && ry + rh > y0;
    if (!intersects && e.version === version - 1) e.version = version;
  }
}

// Row-major 2x3 affine matrix from document coordinates to WebGPU/WebGL clip space.
export function clipMatrix(v: View, w: number, h: number): number[] {
  const c = Math.cos(v.rot), s = Math.sin(v.rot);
  const ax = 2 * v.zoom / w, ay = -2 * v.zoom / h;
  const m = [ax * c, -ax * s, 0, ay * s, ay * c, 0];
  m[2] = -(m[0] * v.cx + m[1] * v.cy);
  m[5] = -(m[3] * v.cx + m[4] * v.cy);
  return m;
}
