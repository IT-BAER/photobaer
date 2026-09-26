// Pulled-string smoothing (docs/M2.md section 4): the paint point trails the pointer on a leash
// and only moves once the pointer pulls past it; "catch up on stroke end" snaps it to the release
// point so the stroke still ends exactly under the pointer.
export interface SmoothingOpts {
  smoothing: number; // 0-100 %
  adjustForZoom: boolean;
  catchUpOnEnd: boolean;
}

// smoothing% * 100 screen px (10% -> 10px, 100% -> 100px), divided by zoom when adjusting for it.
export function leashPx(smoothingPercent: number, zoom: number, adjustForZoom: boolean): number {
  return adjustForZoom ? smoothingPercent / zoom : smoothingPercent;
}

// Moves `paint` towards `pointer`, staying at most `leash` away from it (the string's length).
export function pullPoint(paint: [number, number], pointer: [number, number], leash: number): [number, number] {
  if (leash <= 0) return pointer;
  const dx = pointer[0] - paint[0], dy = pointer[1] - paint[1];
  const dist = Math.hypot(dx, dy);
  if (dist <= leash) return paint;
  const t = (dist - leash) / dist;
  return [paint[0] + dx * t, paint[1] + dy * t];
}

export class Smoother {
  #p: [number, number] | null = null;
  #o: SmoothingOpts;
  #zoom: number;

  constructor(o: SmoothingOpts, zoom: number) {
    this.#o = o;
    this.#zoom = zoom;
  }

  start(p: [number, number]) { this.#p = p; return p; }
  move(p: [number, number]) {
    this.#p = pullPoint(this.#p ?? p, p, leashPx(this.#o.smoothing, this.#zoom, this.#o.adjustForZoom));
    return this.#p;
  }
  end(p: [number, number]) {
    this.#p = this.#o.catchUpOnEnd ? p : this.#p ?? p;
    return this.#p;
  }
}
