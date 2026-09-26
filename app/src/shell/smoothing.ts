// Stroke smoothing (docs/M2.md section 4). Pulled string (the default): the paint point trails the pointer on a
// leash and only moves once the pointer pulls past it. Without it the paint point is a first-order lag of the
// pointer with time constant (80a + 200a^2) ms, a = smoothing / 100; "catch up" keeps pulling it towards a resting
// pointer every frame. "Catch up on stroke end" snaps it to the release point.
export interface SmoothingOpts {
  smoothing: number; // 0-100 %
  adjustForZoom: boolean;
  catchUpOnEnd: boolean;
  pulledString?: boolean; // default true
  catchUp?: boolean; // default false; lag mode only
}

// Below this distance (document px at zoom 1) catch-up lands exactly on the pointer.
const SETTLE_PX = 0.05;

// 1.2 screen px per smoothing percent (10% -> 12px, 100% -> 120px), divided by zoom when adjusting for it.
export function leashPx(smoothingPercent: number, zoom: number, adjustForZoom: boolean): number {
  const px = smoothingPercent * 1.2;
  return adjustForZoom ? px / zoom : px;
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
  #scale: number;
  #tc: number;
  #last: [number, number] | null = null;
  #t = 0;

  constructor(o: SmoothingOpts, zoom: number) {
    this.#o = o;
    this.#zoom = zoom;
    const a = Math.min(1, Math.max(0, o.smoothing / 100));
    this.#scale = o.adjustForZoom && zoom > 0 ? 1 / zoom : 1;
    this.#tc = (80 * a + 200 * a * a) * this.#scale;
  }

  get #pulled() { return this.#o.pulledString ?? true; }

  start(p: [number, number], t = 0) { this.#p = p; this.#last = p; this.#t = t; return p; }
  // `t` is the event time in ms (only the lag mode uses it).
  move(p: [number, number], t = this.#t) {
    const prev = this.#last ?? p, dt = Math.max(0, t - this.#t);
    this.#t = Math.max(this.#t, t);
    this.#last = p;
    const cur = this.#p ?? p;
    if (this.#pulled) this.#p = pullPoint(cur, p, leashPx(this.#o.smoothing, this.#zoom, this.#o.adjustForZoom));
    else if (this.#tc <= 0) this.#p = p;
    else if (dt > 0 && (p[0] !== prev[0] || p[1] !== prev[1])) {
      // Exact lag response over dt to a target moving linearly from prev to p.
      const e = -Math.expm1(-dt / this.#tc), k = 1 - this.#tc * e / dt;
      this.#p = [cur[0] + (prev[0] - cur[0]) * e + (p[0] - prev[0]) * k, cur[1] + (prev[1] - cur[1]) * e + (p[1] - prev[1]) * k];
    }
    return this.#p ?? p;
  }
  // Per-frame pull towards a resting pointer; null when there is nothing to add.
  catchUp(t: number): [number, number] | null {
    const dt = t - this.#t;
    if (!this.#o.catchUp || this.#pulled || !this.#p || !this.#last || dt <= 0) return null;
    this.#t = t;
    const [lx, ly] = this.#last;
    if (this.#p[0] === lx && this.#p[1] === ly) return null;
    const r = this.#tc > 0 ? -Math.expm1(-dt / this.#tc) : 1;
    this.#p = [this.#p[0] + (lx - this.#p[0]) * r, this.#p[1] + (ly - this.#p[1]) * r];
    if (Math.hypot(lx - this.#p[0], ly - this.#p[1]) < SETTLE_PX * this.#scale) this.#p = [lx, ly];
    return this.#p;
  }
  end(p: [number, number], t = this.#t) {
    if (this.#o.catchUpOnEnd) this.#p = p;
    else if (!this.#pulled) this.move(p, t);
    this.#p ??= p;
    return this.#p;
  }
}
