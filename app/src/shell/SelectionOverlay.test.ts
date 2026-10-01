import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SelectionOverlay } from './SelectionOverlay.ts';

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
