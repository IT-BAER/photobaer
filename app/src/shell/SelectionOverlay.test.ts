import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revealsPast, SelectionOverlay, sharpPatch, withCoarse } from './SelectionOverlay.ts';

// A 2D context stub: every method is a no-op except clearRect, which counts redraws.
function stubCanvas() {
  const stats = { clears: 0 };
  const ctx: Record<string | symbol, unknown> = new Proxy({}, {
    get: (t, k) => (k === 'clearRect' ? () => { stats.clears++; } : k in t ? (t as Record<string | symbol, unknown>)[k] : () => {}),
    set: (t, k, v) => { (t as Record<string | symbol, unknown>)[k] = v; return true; },
  });
  const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  (ctx as { canvas: unknown }).canvas = canvas;
  return { canvas, stats };
}

test('preview changes redraw on the next animation frame, once per frame', () => {
  const frames: FrameRequestCallback[] = [];
  const g = globalThis as { requestAnimationFrame?: unknown };
  const saved = g.requestAnimationFrame;
  g.requestAnimationFrame = (cb: FrameRequestCallback) => frames.push(cb);
  const { canvas, stats } = stubCanvas();
  const o = new SelectionOverlay(canvas);
  try {
    o.draw({ zoom: 1, rot: 0, cx: 50, cy: 50 }, 100, 100, 1);
    const before = stats.clears;
    o.setPreview({ kind: 'rect', x: 10, y: 10, w: 20, h: 20 });
    o.setPreview({ kind: 'rect', x: 10, y: 10, w: 30, h: 30 });
    assert.equal(frames.length, 1);
    frames.shift()!(0);
    assert.equal(stats.clears, before + 1);
  } finally {
    o.setPreview(null);
    g.requestAnimationFrame = saved;
  }
});

test('a moved float lands on whole device pixels, nearest from 200 % view zoom like the stage, the above image last', () => {
  const calls: { m: number[]; smooth: unknown; src: unknown }[] = [];
  let m: number[] = [];
  const ctx: Record<string, unknown> = { canvas: null };
  const canvas = { width: 0, height: 0, getContext: () => proxy } as unknown as HTMLCanvasElement;
  const proxy = new Proxy(ctx, {
    get: (t, k) => k === 'setTransform' ? (...a: number[]) => { m = a; } : k === 'drawImage' ? (src: unknown) => calls.push({ m, smooth: t.imageSmoothingEnabled, src }) : k in t ? t[k as string] : () => {},
    set: (t, k, v) => { t[k as string] = v; return true; },
  });
  const o = new SelectionOverlay(canvas);
  const img = (source: string, f: number) => ({ source: source as unknown as CanvasImageSource, x: 0, y: 0, w: 8, h: 8, f, m: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
  o.setImage({ ...img('moved', 1), m: [1, 0, 3, 0, 1, 0, 0, 0, 1], above: img('above', 0.5) });
  o.draw({ zoom: 1.3, rot: 0, cx: 50, cy: 50 }, 100, 100, 1);
  assert.deepEqual(calls.map(c => c.src), ['moved', 'above']);
  for (const c of calls) assert.ok(Number.isInteger(c.m[4]) && Number.isInteger(c.m[5]), `origin ${c.m[4]}, ${c.m[5]}`);
  assert.deepEqual(calls.map(c => c.m.slice(0, 4).map(v => +v.toFixed(6))), [[1.3, 0, 0, 1.3], [2.6, 0, 0, 2.6]], 'the scale stays exact');
  assert.deepEqual(calls.map(c => c.smooth), [true, true], 'smooth below 200 %, also for the coarser image');
  calls.length = 0;
  o.draw({ zoom: 2.5, rot: 0, cx: 50, cy: 50 }, 100, 100, 1);
  assert.deepEqual(calls.map(c => c.smooth), [false, false]);
});

test('a coarse float image skips the rect its sharp image covers, so soft pixels are drawn once', () => {
  // Records each drawImage with its transform and the clips active then (polygons, even-odd or nonzero).
  type Poly = [number, number][][];
  const draws: { src: { name: string; width: number; height: number }; m: number[]; clips: { polys: Poly; evenodd: boolean }[] }[] = [];
  let m = [1, 0, 0, 1, 0, 0], path: Poly = [], clips: { polys: Poly; evenodd: boolean }[] = [];
  const stack: typeof clips[] = [];
  const ctx = {
    canvas: null as unknown,
    setTransform: (...a: number[]) => { m = a; },
    save: () => { stack.push(clips); },
    restore: () => { clips = stack.pop()!; },
    beginPath: () => { path = []; },
    moveTo: (x: number, y: number) => { path.push([[x, y]]); },
    lineTo: (x: number, y: number) => { if (path.length) path.at(-1)!.push([x, y]); else path.push([[x, y]]); },
    closePath: () => {},
    clip: (rule?: string) => { clips = [...clips, { polys: path, evenodd: rule === 'evenodd' }]; },
    drawImage: (src: { name: string; width: number; height: number }) => { draws.push({ src, m, clips }); },
    clearRect: () => {},
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  ctx.canvas = canvas;
  const crossings = (polys: Poly, x: number, y: number) => polys.reduce((n, p) => n + p.reduce((k, [x0, y0], i) => {
    const [x1, y1] = p[(i + 1) % p.length];
    return (y0 > y) !== (y1 > y) && x < x0 + (y - y0) / (y1 - y0) * (x1 - x0) ? k + 1 : k;
  }, 0), 0);
  const inside = (c: { polys: Poly; evenodd: boolean }, x: number, y: number) => crossings(c.polys, x, y) % 2 === 1;
  const covers = (d: typeof draws[number], x: number, y: number) => {
    const [a, b, c, dd, e, f] = d.m, det = a * dd - b * c;
    const i = (dd * (x - e) - c * (y - f)) / det, j = (a * (y - f) - b * (x - e)) / det;
    return i >= 0 && j >= 0 && i < d.src.width && j < d.src.height && d.clips.every(k => inside(k, x, y));
  };
  const src = (name: string, width: number, height: number) => ({ name, width, height }) as unknown as CanvasImageSource;
  const id = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const o = new SelectionOverlay(canvas);
  o.setImage({
    source: src('coarse', 100, 50), x: 0, y: 0, w: 100, h: 50, f: 0.25, m: [1, 0, 3, 0, 1, 2, 0, 0, 1], clip: [0, 0, 400, 200],
    over: { source: src('sharp', 100, 50), x: 100, y: 50, w: 100, h: 50, f: 1, m: id },
    above: { source: src('aboveCoarse', 100, 50), x: 0, y: 0, w: 100, h: 50, f: 0.25, m: id, over: { source: src('aboveSharp', 60, 40), x: 20, y: 30, w: 60, h: 40, f: 1, m: id } },
  });
  o.draw({ zoom: 1.3, rot: 0, cx: 200, cy: 100 }, 600, 300, 1);
  const at = (name: string, i: number, j: number): [number, number] => {
    const d = draws.find(d => d.src.name === name)!, [a, b, c, dd, e, f] = d.m;
    return [a * i + c * j + e, b * i + dd * j + f];
  };
  const hits = (p: [number, number]) => draws.filter(d => covers(d, ...p)).map(d => d.src.name);
  assert.deepEqual(hits(at('sharp', 50, 25)), ['sharp', 'aboveCoarse'], 'inside the sharp image: the coarse image is not drawn under it');
  assert.deepEqual(hits(at('coarse', 5, 5)), ['coarse', 'aboveCoarse'], 'outside it the coarse image still draws');
  assert.deepEqual(hits(at('aboveSharp', 30, 20)).filter(n => n.startsWith('above')), ['aboveSharp'], 'the same for the layers above');
});

test('sharpPatch asks for the moved image the view reveals past its sharp image, once', () => {
  const img = (x: number, y: number, w: number, h: number, f: number) => ({ source: null as unknown as CanvasImageSource, x, y, w, h, f, m: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
  const coarse = img(0, 0, 1000, 500, 0.25), over = img(800, 400, 800, 400, 0.5);
  const view: [number, number, number, number] = [1800, 900, 400, 200];
  assert.equal(sharpPatch(coarse, over, null, view, 0, 0), null, 'the view lies inside the sharp image');
  assert.equal(sharpPatch(coarse, undefined, null, view, -2000, 0), null, 'a sharp image alone needs no patch');
  assert.deepEqual(sharpPatch(coarse, over, null, view, -1200, 0), [2900, 850, 600, 300], 'the moved pixels now on screen, plus a quarter view');
  assert.equal(sharpPatch(coarse, over, [2900, 850, 600, 300], view, -1200, 0), null, 'already asked for');
  assert.equal(sharpPatch(coarse, over, null, view, 2500, 0), null, 'nothing of the image on screen');
});

test('revealsPast tells when a drag shows canvas in view past the sharp view image', () => {
  const sharp = { source: null as unknown as CanvasImageSource, x: 900, y: 450, w: 400, h: 200, f: 0.5, m: [1, 0, 0, 0, 1, 0, 0, 0, 1], clip: [0, 0, 4000, 2000] };
  const view: [number, number, number, number] = [1800, 900, 800, 400];
  assert.equal(revealsPast(sharp, view, 0, 0), false, 'a press without a drag');
  assert.equal(revealsPast(sharp, view, 1, 0), true, 'one pixel right shows the strip on the left');
  assert.equal(revealsPast(sharp, view, 0, -3), true, 'up shows the strip at the bottom');
  const edge: [number, number, number, number] = [3600, 900, 800, 400], atEdge = { ...sharp, x: 1800, w: 200 };
  assert.equal(revealsPast(atEdge, edge, -100, 0), true, 'left shows the canvas strip on the right');
  assert.equal(revealsPast({ ...atEdge, w: 400 }, edge, -100, 0), false, 'the sharp image reaches past the canvas edge there');
  assert.equal(revealsPast({ ...atEdge, w: 400 }, edge, 100, 0), true, 'right shows the canvas on the left');
});

test('withCoarse puts the whole-layer images under the sharp view images a drag started with', () => {
  const img = (x: number, y: number, w: number, h: number, f: number) => ({ source: null as unknown as CanvasImageSource, x, y, w, h, f, m: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
  const sharp = img(800, 400, 800, 400, 1), up = img(800, 400, 800, 400, 1), coarse = img(0, 0, 1000, 500, 0.25), top = img(0, 0, 1000, 500, 0.25);
  const f = withCoarse({ ...sharp, clip: [0, 0, 4000, 2000], above: up }, coarse, top);
  assert.deepEqual([f.x, f.w, f.f, f.clip], [0, 1000, 0.25, [0, 0, 4000, 2000]], 'the coarse image keeps the canvas clip');
  assert.deepEqual([f.over?.x, f.over?.f, f.over?.above], [800, 1, undefined], 'the sharp image draws over it');
  assert.deepEqual([f.above?.f, f.above?.over?.f], [0.25, 1]);
  assert.equal(sharpPatch(f, f.over, null, [1800, 900, 400, 200], -1200, 0) !== null, true, 'patches resume');
  const alone = withCoarse({ ...sharp }, coarse, null);
  assert.deepEqual([alone.over?.x, alone.above], [800, undefined], 'nothing above stays nothing above');
  assert.equal(withCoarse({ ...sharp, above: up }, null, null).above, up, 'no coarse image keeps the sharp ones');
});

test('the brush outline stays solid while marching ants are shown', () => {
  const g = globalThis as { requestAnimationFrame?: unknown };
  const saved = g.requestAnimationFrame;
  g.requestAnimationFrame = () => 0;
  const strokes: number[][] = [];
  let dash: number[] = [];
  const ctx = new Proxy({}, {
    get: (t, k) => k === 'setLineDash' ? (d: number[]) => { dash = d; } : k === 'stroke' ? () => { strokes.push(dash); }
      : k in t ? (t as Record<string | symbol, unknown>)[k] : () => {},
    set: (t, k, v) => { (t as Record<string | symbol, unknown>)[k] = v; return true; },
  });
  const o = new SelectionOverlay({ width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement);
  try {
    o.setAnts(Float32Array.of(10, 10, 40, 10), 1);
    o.setCursor({ x: 50, y: 50, sizeDoc: 20, shape: 'round', crosshair: false });
    o.draw({ zoom: 1, rot: 0, cx: 50, cy: 50 }, 100, 100, 1);
    assert.ok(strokes.some(d => d.length), 'the ants are dashed');
    assert.deepEqual(strokes.slice(-2), [[], []], 'both cursor strokes are solid');
  } finally {
    o.setAnts(null, 1);
    o.setCursor(null);
    g.requestAnimationFrame = saved;
  }
});
