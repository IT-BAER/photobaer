import type { View } from '../view.ts';

export type ArrangeMode = 'tabs' | 'vertical' | 'horizontal' | '2-up' | '3-up' | '4-up' | '6-up' | 'float';
export type MatchKind = 'zoom' | 'location' | 'all';

export interface TabViewState<A = { id: number; target: string }> {
  view: View;
  active: A | null;
  picked: number[];
}

export interface ArrangeCell { key: string; row: number; column: number }
export interface ArrangeGrid { rows: number; columns: number; cells: ArrangeCell[] }
export interface FloatRect { x: number; y: number; width: number; height: number }

const CAPACITY: Partial<Record<ArrangeMode, number>> = { tabs: 1, '2-up': 2, '3-up': 3, '4-up': 4, '6-up': 6 };

export function displayedDocumentKeys(mode: ArrangeMode, keys: string[], active: string | null): string[] {
  const unique = [...new Set(keys)];
  if (!unique.length) return [];
  const current = active && unique.includes(active) ? active : null;
  if (mode === 'tabs') return current ? [current] : unique.slice(0, 1);
  const capacity = CAPACITY[mode];
  if (!capacity || unique.length <= capacity) return unique;
  const shown = unique.filter(key => key !== current).slice(0, capacity - (current ? 1 : 0));
  if (current) shown.push(current);
  return shown;
}

export function arrangeGrid(mode: ArrangeMode, keys: string[]): ArrangeGrid {
  let rows = 1, columns = Math.max(1, keys.length);
  if (mode === 'horizontal') { rows = Math.max(1, keys.length); columns = 1; }
  else if (mode === '3-up' || mode === '4-up') { rows = 2; columns = 2; }
  else if (mode === '6-up') { rows = 2; columns = 3; }
  else if (mode === '2-up') { rows = 1; columns = 2; }
  return {
    rows,
    columns,
    cells: keys.map((key, index) => ({ key, row: Math.floor(index / columns) + 1, column: index % columns + 1 })),
  };
}

export function matchDocumentViews<A>(
  states: Map<string, TabViewState<A>>,
  keys: string[],
  activeKey: string,
  source: View,
  kind: MatchKind,
): Map<string, TabViewState<A>> {
  const result = new Map(states);
  for (const key of keys) {
    const previous = states.get(key);
    let view = source;
    if (previous && key !== activeKey) {
      if (kind === 'zoom') view = { ...previous.view, zoom: source.zoom };
      else if (kind === 'location') view = { ...previous.view, cx: source.cx, cy: source.cy };
    }
    result.set(key, {
      view: { ...view },
      active: previous?.active ?? null,
      picked: previous ? [...previous.picked] : [],
    });
  }
  return result;
}

export function clampFloatRect(rect: FloatRect, areaWidth: number, areaHeight: number): FloatRect {
  const width = Math.min(Math.max(120, rect.width), areaWidth);
  const height = Math.min(Math.max(120, rect.height), areaHeight);
  return {
    x: Math.min(Math.max(0, rect.x), Math.max(0, areaWidth - width)),
    y: Math.min(Math.max(0, rect.y), Math.max(0, areaHeight - height)),
    width,
    height,
  };
}

export function reconcileFloatRects(
  keys: string[],
  rects: Record<string, FloatRect>,
  areaWidth: number,
  areaHeight: number,
): Record<string, FloatRect> {
  return Object.fromEntries(keys.map((key, index) => [
    key,
    clampFloatRect(rects[key] ?? { x: 24 + index * 28, y: 20 + index * 24, width: 420, height: 300 }, areaWidth, areaHeight),
  ]));
}
