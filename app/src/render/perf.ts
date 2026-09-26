import type { Viewer } from '../viewer.ts';

// sampled: the pointer sample that started this strokeTo batch. sent: just before client.call
// ('strokeTo', ...), i.e. after the per-rAF coalescing wait. resolved: when that call's promise
// settles, i.e. after the full worker round trip (postMessage + engine stroke_to + postMessage back).
export interface Marks { sampled: number; sent: number; resolved: number }
export interface Breakdown { queue: number[]; worker: number[]; draw: number[]; work: number[] }
// recordPreview: the main-thread work of one free transform preview frame (state update and overlay draw), ms.
export interface PerfProbe { recordSample(version: number, marks: Marks): void; samples(): number[]; breakdown(): Breakdown; recordPreview(ms: number): void; previews(): number[] }

/// Test-only, behind `?perftest=1` (like gpuTestHook): for each strokeTo, the time from the pointer
/// sample that produced it to the first viewer frame that actually drew that version, split into the
/// per-rAF coalescing wait, the worker round trip, and the tile-fetch-plus-draw tail. Without the
/// query parameter this wires nothing onto the viewer and returns null.
export function perfTestHook(viewer: Viewer): PerfProbe | null {
  if (!new URLSearchParams(location.search).has('perftest')) return null;
  const pending = new Map<number, Marks>();
  const total: number[] = [];
  const queue: number[] = [];
  const worker: number[] = [];
  const draw: number[] = [];
  // Per-frame work: strokeTo sent until its tiles are stored, without the wait for the next frame.
  const work: number[] = [];
  viewer.onVersionDrawn = (version, readyAt) => {
    const m = pending.get(version);
    if (!m) return;
    const now = performance.now();
    queue.push(m.sent - m.sampled);
    worker.push(m.resolved - m.sent);
    draw.push(now - m.resolved);
    total.push(now - m.sampled);
    work.push(Math.max(m.resolved, readyAt) - m.sent);
    pending.delete(version);
  };
  const previews: number[] = [];
  return {
    recordSample: (version, marks) => pending.set(version, marks), samples: () => total, breakdown: () => ({ queue, worker, draw, work }),
    recordPreview: ms => previews.push(ms), previews: () => previews,
  };
}
