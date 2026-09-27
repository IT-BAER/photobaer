export interface Rect { x: number; y: number; w: number; h: number }
export interface AxisLock { anchor: number; target: number }
export interface SnapAxes { x: AxisLock | null; y: AxisLock | null }

// View > Snap (master) and View > Snap To (docs/M4.md section 12); stored in app settings.
export interface SnapSettings {
  enabled: boolean; guides: boolean; grid: boolean; layers: boolean; documentBounds: boolean; artboards: boolean;
}
export const DEFAULT_SNAP_SETTINGS: SnapSettings = {
  enabled: true, guides: true, grid: true, layers: true, documentBounds: true, artboards: true,
};
const SNAP_STORE_KEY = 'photobaer:snap';
export function loadSnapSettings(): SnapSettings {
  try {
    const raw = globalThis.localStorage?.getItem(SNAP_STORE_KEY);
    if (raw) return { ...DEFAULT_SNAP_SETTINGS, ...JSON.parse(raw) };
  } catch { /* storage unavailable or corrupt: fall back to defaults */ }
  return { ...DEFAULT_SNAP_SETTINGS };
}
export function saveSnapSettings(s: SnapSettings) {
  try {
    globalThis.localStorage?.setItem(SNAP_STORE_KEY, JSON.stringify(s));
  } catch { /* storage unavailable: settings stay session-only */ }
}

// Nearest multiple of `spacing` to `v`. Grid snapping quantizes to the nearest grid line rather
// than matching a bounded target list (own choice: the reference build stores a Snap To Grid
// toggle but no consuming/target code was found for it - docs/M4.md gap B17).
export function gridLine(v: number, spacing: number): number {
  return Math.round(v / spacing) * spacing;
}

// [start, center, end] anchors of `r` along `axis`.
export function rectAnchors(r: Rect, axis: 'x' | 'y'): [number, number, number] {
  return axis === 'x' ? [r.x, r.x + r.w / 2, r.x + r.w] : [r.y, r.y + r.h / 2, r.y + r.h];
}

// Best anchor/target pair for one axis: smallest |target - (anchor + offset)| within `catchDoc`.
// A `prevLock` pair stays selected as long as its own distance is within `releaseDoc`, so the
// axis does not chatter between two close targets (hysteresis).
export function snapAxis(
  anchors: number[], targets: number[], offset: number, prevLock: AxisLock | null,
  catchDoc: number, releaseDoc: number, gridSpacing?: number,
): AxisLock | null {
  if (prevLock && Math.abs(prevLock.target - (prevLock.anchor + offset)) <= releaseDoc) return prevLock;
  let best: AxisLock | null = null;
  let bestDist = catchDoc;
  for (const a of anchors) {
    const ts = gridSpacing ? [...targets, gridLine(a + offset, gridSpacing)] : targets;
    for (const t of ts) {
      const d = Math.abs(t - (a + offset));
      if (d <= bestDist) { bestDist = d; best = { anchor: a, target: t }; }
    }
  }
  return best;
}

// Snaps a drag offset for the moving rect's anchors against document/layer targets; each axis
// locks independently. `zoom` scales the screen-px catch/release thresholds into document px.
export function snapOffset(
  moving: Rect, targetsX: number[], targetsY: number[], dx: number, dy: number,
  prev: SnapAxes, zoom: number, catchPx = 6, releasePx = 10, gridX?: number, gridY?: number,
): { dx: number; dy: number; lock: SnapAxes } {
  const catchDoc = catchPx / zoom, releaseDoc = releasePx / zoom;
  const lockX = snapAxis(rectAnchors(moving, 'x'), targetsX, dx, prev.x, catchDoc, releaseDoc, gridX);
  const lockY = snapAxis(rectAnchors(moving, 'y'), targetsY, dy, prev.y, catchDoc, releaseDoc, gridY);
  return {
    dx: lockX ? lockX.target - lockX.anchor : dx,
    dy: lockY ? lockY.target - lockY.anchor : dy,
    lock: { x: lockX, y: lockY },
  };
}

// snapOffset with an optional Shift constraint: the drag is projected onto the nearest 45 degree
// direction; a snapped axis along that direction leads and the other axis follows it.
export function constrainedSnap(
  moving: Rect, targetsX: number[], targetsY: number[], dx: number, dy: number,
  prev: SnapAxes, zoom: number, constrain: boolean, gridX?: number, gridY?: number,
): { dx: number; dy: number; lock: SnapAxes } {
  if (!constrain || (dx === 0 && dy === 0)) return snapOffset(moving, targetsX, targetsY, dx, dy, prev, zoom, 6, 10, gridX, gridY);
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const ux = Math.round(Math.cos(a) * 1e9) / 1e9, uy = Math.round(Math.sin(a) * 1e9) / 1e9;
  const p = dx * ux + dy * uy, cx = p * ux, cy = p * uy;
  const r = snapOffset(moving, targetsX, targetsY, cx, cy, prev, zoom, 6, 10, gridX, gridY);
  if (r.lock.x && ux) return { dx: r.dx, dy: (r.dx / ux) * uy, lock: { x: r.lock.x, y: null } };
  if (r.lock.y && uy) return { dx: (r.dy / uy) * ux, dy: r.dy, lock: { x: null, y: r.lock.y } };
  return { dx: cx, dy: cy, lock: { x: null, y: null } };
}
