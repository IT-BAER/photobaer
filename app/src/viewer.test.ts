import test from 'node:test';
import assert from 'node:assert/strict';
import { Viewer, type TileResult } from './viewer.ts';
import type { Frame, Renderer } from './render/renderer.ts';

class FakeCanvas extends EventTarget {
  width = 0;
  height = 0;
  captures: number[] = [];
  getBoundingClientRect() { return { left: 0, top: 0, width: 64, height: 48 }; }
  setPointerCapture(id: number) { this.captures.push(id); }
}

test('destroy releases Viewer lifecycle resources and ignores a late tile', async () => {
  const raf = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  let nextRaf = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { devicePixelRatio: 1 } });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (cb: FrameRequestCallback) => { const id = ++nextRaf; raf.set(id, cb); return id; } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => { cancelled.push(id); raf.delete(id); } });

  const observer = { disconnected: false };
  class FakeResizeObserver {
    constructor(_cb: ResizeObserverCallback) {}
    observe(_target: Element) {}
    disconnect() { observer.disconnected = true; }
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: FakeResizeObserver });

  let draws = 0;
  const renderer: Renderer = { kind: 'webgl2', slots: 8, gpu: null, upload() {}, draw(_frame: Frame) { draws++; } };
  const tileRequest: { finish: ((tile: TileResult) => void) | null } = { finish: null };
  const canvas = new FakeCanvas();
  const viewer = new Viewer(canvas as unknown as HTMLCanvasElement, renderer, () => new Promise(resolve => { tileRequest.finish = resolve; }));
  viewer.setDoc({ docId: 1, version: 1, width: 16, height: 16, maxLevel: 0 });

  const first = raf.entries().next().value as [number, FrameRequestCallback];
  raf.delete(first[0]);
  first[1](0);
  assert.ok(tileRequest.finish, 'the first frame starts a tile request');

  let pointers = 0;
  viewer.onPointer = () => { pointers++; };
  const pointer = new Event('pointerdown', { cancelable: true });
  Object.assign(pointer, { button: 0, pointerId: 1, clientX: 4, clientY: 4, pressure: 1, tiltX: 0, tiltY: 0, twist: 0, pointerType: 'mouse', buttons: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false });
  canvas.dispatchEvent(pointer);
  assert.equal(pointers, 1, 'the input listener was active');

  viewer.redraw();
  const pendingRaf = [...raf.keys()][0];
  const waiter = viewer.drawn(99, 10_000);
  const drawsAtDestroy = draws;
  viewer.destroy();
  await waiter;

  assert.equal(observer.disconnected, true);
  assert.ok(cancelled.includes(pendingRaf));
  canvas.dispatchEvent(pointer);
  assert.equal(pointers, 1, 'destroy removes canvas listeners');

  let fills = 0;
  const finishTile = tileRequest.finish;
  assert.ok(finishTile);
  finishTile({ docId: 1, version: 1, fill: () => { fills++; } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fills, 0, 'a late tile is not uploaded');
  assert.equal(draws, drawsAtDestroy, 'a late tile does not redraw');
  assert.equal(raf.size, 0);
});
