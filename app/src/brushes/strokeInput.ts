// Stroke input helpers: per-stroke sample stride, sample fields, stroke seed, build-up timing.

// Mouse and touch have no usable pressure; the engine sees half pressure (pressure controls off still mean full).
export const NO_PEN_PRESSURE = 0.5;
export type Stride = 3 | 6;

export const strideFor = (pointerType: string): Stride => pointerType === 'pen' ? 6 : 3;

// Sample fields after x, y: pressure[, tiltX, tiltY, twist] (degrees).
export function inputFields(e: { pointerType: string; pressure: number; tiltX: number; tiltY: number; twist: number }, stride: Stride): number[] {
  const pressure = e.pointerType === 'pen' && Number.isFinite(e.pressure) ? Math.min(1, Math.max(0, e.pressure)) : NO_PEN_PRESSURE;
  return stride === 6 ? [pressure, e.tiltX || 0, e.tiltY || 0, e.twist || 0] : [pressure];
}

// murmur3 finalizer: a well-mixed 32-bit hash.
function fmix32(h: number) {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export const strokeSeed = (layerId: number, counter: number) => fmix32(Math.imul(layerId, 0x9e3779b1) ^ fmix32(counter));

export const BUILD_UP_RATE = 60; // dabs per second
const MAX_TICK_MS = 100;

// Time-debt accumulator for build-up: tick(now) returns how many dabs to emit at the last sample. Time up to the
// latest move does not count, and one tick adds at most MAX_TICK_MS of debt so a stalled tab does not burst.
export class BuildUp {
  #last: number;
  #debt = 0;
  constructor(now: number) { this.#last = now; }
  moved(now: number) { this.#last = Math.max(this.#last, now); }
  tick(now: number): number {
    const dt = Math.min(MAX_TICK_MS, Math.max(0, now - this.#last));
    this.#last = Math.max(this.#last, now);
    this.#debt += dt / 1000 * BUILD_UP_RATE;
    const n = Math.floor(this.#debt);
    this.#debt -= n;
    return n;
  }
}
