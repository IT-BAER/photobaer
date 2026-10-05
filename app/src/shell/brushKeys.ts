import type { PaintingCursor } from './preferences.ts';
// Pure brush-tool keyboard/drag logic (docs/M2.md section 4 Shortcuts), kept free of the DOM so it
// is unit-testable; App.tsx wires these into the global key handler and the Ctrl+Alt+right-drag gesture.

const COMBO_MS = 800;

// [ / ] size step: bigger brushes move in bigger jumps (1 / 5 / 10 px), clamped at a 1 px minimum.
export function stepSize(size: number, larger: boolean): number {
  const step = size < 10 ? 1 : size < 100 ? 5 : 10;
  return Math.max(1, size + (larger ? step : -step));
}

// Shift+[ / Shift+] hardness: snaps to the next 25% grid line in the given direction, clamped 0-100.
export function stepHardness(hardness: number, larger: boolean): number {
  const n = larger ? Math.floor(hardness / 25) + 1 : Math.ceil(hardness / 25) - 1;
  return Math.min(100, Math.max(0, n * 25));
}

export interface DigitState { digit: string; time: number }

// A digit sets 10x% (0 = 100%); a second digit within 800ms combines with the first into the exact
// two-digit value and the combo resets (no chaining into a third digit).
export function digitOption(prev: DigitState | null, digit: string, now: number): { value: number; state: DigitState | null } {
  if (prev && now - prev.time <= COMBO_MS) {
    const n = Number(prev.digit + digit);
    return { value: n === 0 ? 100 : n, state: null };
  }
  const n = Number(digit);
  return { value: n === 0 ? 100 : n * 10, state: { digit, time: now } };
}

// The precise cursor (crosshair) replaces the outline once it would draw under 6 screen px, or
// whenever Caps Lock is on.
export function showCrosshair(outlineScreenPx: number, capsLock: boolean): boolean {
  return capsLock || outlineScreenPx < 6;
}

// Preferences > Cursors > Painting Cursors: the outline diameter as a multiple of the brush size, 0 for the
// crosshair only. Full Size includes the soft skirt (2x at hardness 0); Caps Lock swaps outline and crosshair.
export function outlineScale(pref: PaintingCursor, hardness: number, capsLock: boolean): number {
  const outlined = (pref === 'normal' || pref === 'full') !== capsLock;
  return !outlined ? 0 : pref === 'full' ? 2 - Math.min(100, Math.max(0, hardness)) / 100 : 1;
}

// Ctrl+Alt+right-drag: horizontal screen px resize 1:1, vertical screen px change hardness 1:1 per
// px (drag up = harder, matching the outline preview moving the same way the pointer does).
export function dragResize(startSize: number, startHardness: number, dx: number, dy: number): { size: number; hardness: number } {
  return {
    size: Math.min(5000, Math.max(1, Math.round(startSize + dx))),
    hardness: Math.min(100, Math.max(0, Math.round(startHardness - dy))),
  };
}
