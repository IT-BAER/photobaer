import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SelectionOverlay, sharpPatch } from './SelectionOverlay.ts';

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
