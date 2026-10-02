// Retouch tool logic (docs/M5.md section 9). Clone Source slots (D12): 5 app-wide slots, not saved with the document.
// A slot maps destination point p to source anchor + M (p - origin); M undoes the slot's scale,
// flip and rotation, so scale 50 % reads 2 source px per destination px.
export interface Point { x: number; y: number }
export type OverlayMode = 'normal' | 'darken' | 'lighten' | 'difference';
export interface CloneSlot {
  anchor: Point | null; key: string | null; layerId: number | null;
  // The destination origin of the aligned strokes; offset = alignedOrigin - anchor.
  alignedOrigin: (Point & { key: string }) | null;
  rotation: number; scaleX: number; scaleY: number; flipX: boolean; flipY: boolean; scaleLinked: boolean; lockOffset: boolean;
  showOverlay: boolean; overlayOpacity: number; overlayMode: OverlayMode; overlayClipped: boolean; overlayAutoHide: boolean; overlayInverted: boolean;
}
export interface SourceMap { anchor: [number, number]; origin: [number, number]; m: [number, number, number, number] }

export const SLOT_COUNT = 5;
export const emptySlot = (): CloneSlot => ({
  anchor: null, key: null, layerId: null, alignedOrigin: null, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false,
  scaleLinked: true, lockOffset: false, showOverlay: true, overlayOpacity: 1, overlayMode: 'normal', overlayClipped: true,
  overlayAutoHide: true, overlayInverted: false,
});

export function sourceMap(s: CloneSlot, origin: Point): SourceMap | null {
  if (!s.anchor) return null;
  const r = s.rotation * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
  const sx = (s.flipX ? -1 : 1) * (s.scaleX || 1), sy = (s.flipY ? -1 : 1) * (s.scaleY || 1);
  return { anchor: [s.anchor.x, s.anchor.y], origin: [origin.x, origin.y], m: [cos / sx, sin / sx, -sin / sy, cos / sy] };
}

export function mapPoint(t: SourceMap, x: number, y: number): [number, number] {
  const dx = x - t.origin[0], dy = y - t.origin[1], [a, b, c, d] = t.m;
  return [t.anchor[0] + a * dx + b * dy, t.anchor[1] + c * dx + d * dy];
}

export class CloneSources {
  slots: CloneSlot[] = Array.from({ length: SLOT_COUNT }, emptySlot);
  active = 0;
  #listeners = new Set<() => void>();
  #version = 0;

  subscribe = (f: () => void) => { this.#listeners.add(f); return () => { this.#listeners.delete(f); }; };
  version = () => this.#version;
  #changed() { this.#version++; for (const f of this.#listeners) f(); }

  slot(i = this.active) { return this.slots[Math.max(0, Math.min(SLOT_COUNT - 1, i))]; }
  setActive(i: number) { if (i >= 0 && i < SLOT_COUNT) { this.active = i; this.#changed(); } }
  update(i: number, patch: Partial<CloneSlot>) {
    if (i < 0 || i >= SLOT_COUNT) return;
    this.slots[i] = { ...this.slots[i], ...patch };
    this.#changed();
  }
  offset(s = this.slot()): Point {
    return s.anchor && s.alignedOrigin ? { x: s.alignedOrigin.x - s.anchor.x, y: s.alignedOrigin.y - s.anchor.y } : { x: 0, y: 0 };
  }
  // Alt-click: a locked offset carries over to the new anchor, otherwise the next stroke sets it.
  setAnchor(p: Point, key: string, layerId: number | null) {
    const s = this.slot(), o = this.offset(s);
    const alignedOrigin = s.lockOffset && s.alignedOrigin ? { ...s.alignedOrigin, x: p.x + o.x, y: p.y + o.y } : null;
    this.update(this.active, { anchor: { ...p }, key, layerId, alignedOrigin });
  }
  setOffset(axis: 'x' | 'y', v: number, key: string) {
    const s = this.slot();
    if (!s.anchor || !Number.isFinite(v)) return;
    const o = { ...this.offset(s), [axis]: v };
    this.update(this.active, { alignedOrigin: { x: s.anchor.x + o.x, y: s.anchor.y + o.y, key } });
  }
  resetTransform() { this.update(this.active, { rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false }); }

  // Aligned (or a locked offset) keeps this document's aligned origin, else the stroke starts at the anchor.
  strokeOrigin(sample: Point, key: string, aligned: boolean, s = this.slot()): Point {
    return (aligned || s.lockOffset) && s.alignedOrigin?.key === key ? s.alignedOrigin : sample;
  }
  beginStroke(sample: Point, key: string, aligned: boolean): SourceMap | null {
    const s = this.slot();
    if (!s.anchor) return null;
    const o = this.strokeOrigin(sample, key, aligned, s);
    this.update(this.active, { alignedOrigin: { x: o.x, y: o.y, key } });
    return sourceMap(this.slot(), o);
  }
}

export const cloneSources = new CloneSources();

// A click (under 2 px of drag on an axis) takes the 40 x 40 box around it.
export function redEyeRect(a: [number, number], b: [number, number]): [number, number, number, number] {
  const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
  const r = w < 2 || h < 2 ? [a[0] - 20, a[1] - 20, 40, 40] : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), w, h];
  return r.map(Math.round) as [number, number, number, number];
}

// The source point under `pointer` and the map that reads it: aligned strokes keep the aligned
// origin of this document, otherwise the next stroke starts at the anchor.
export function cloneOverlaySource(c: CloneSources, pointer: [number, number], key: string, aligned: boolean) {
  const s = c.slot();
  if (!s.anchor || s.key !== key) return null;
  const map = sourceMap(s, c.strokeOrigin({ x: pointer[0], y: pointer[1] }, key, aligned))!;
  return { map, src: mapPoint(map, pointer[0], pointer[1]) };
}

// In place on straight RGBA: the round tip clip (when clipped), invert, the overlay mode against
// `dest` (the destination composite at the same points) and the overlay opacity.
export function tintOverlay(
  px: Uint8ClampedArray, w: number, h: number,
  o: { clipped: boolean; opacity: number; inverted: boolean; mode?: OverlayMode; dest?: Uint8ClampedArray },
) {
  const rx = w / 2, ry = h / 2;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const p = (j * w + i) * 4;
      const nx = (i + 0.5 - rx) / rx, ny = (j + 0.5 - ry) / ry;
      if (o.clipped && nx * nx + ny * ny > 1) { px[p + 3] = 0; continue; }
      for (let k = 0; k < 3; k++) {
        const v = o.inverted ? 255 - px[p + k] : px[p + k], d = o.dest?.[p + k];
        px[p + k] = d === undefined || o.mode === 'normal' ? v
          : o.mode === 'difference' ? Math.abs(d - v) : o.mode === 'darken' ? Math.min(d, v) : Math.max(d, v);
      }
      px[p + 3] = px[p + 3] * o.opacity;
    }
  }
}
