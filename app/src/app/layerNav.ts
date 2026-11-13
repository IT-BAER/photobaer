import type { LayerNode } from '../worker/types.ts';

export type LayerStep = 'above' | 'below' | 'top' | 'bottom';

// The Layers panel's rows top to bottom: a group before its children, a collapsed group without them.
export function panelRows(nodes: LayerNode[], collapsed: ReadonlySet<number>): number[] {
  return [...nodes].reverse().flatMap(n => [n.id, ...(n.children && !collapsed.has(n.id) ? panelRows(n.children, collapsed) : [])]);
}

// The row `id` shows in: its own, or the nearest collapsed group's that hides it.
function rowOf(nodes: LayerNode[], rows: number[], id: number): number {
  const path: number[] = [];
  const find = (list: LayerNode[]): boolean => list.some(n => {
    path.push(n.id);
    if (n.id === id || (n.children && find(n.children))) return true;
    path.pop();
    return false;
  });
  if (!find(nodes)) return -1;
  for (let i = path.length - 1; i >= 0; i--) {
    const row = rows.indexOf(path[i]);
    if (row >= 0) return row;
  }
  return -1;
}

// Alt+] / Alt+[ / Alt+. / Alt+, (Photoshop): the layer one row above or below the active one, or the top or bottom
// row; without an active layer above starts at the top and below at the bottom. Null when there are no layers.
export function layerStep(nodes: LayerNode[], collapsed: ReadonlySet<number>, active: number | null, step: LayerStep): number | null {
  const rows = panelRows(nodes, collapsed);
  if (!rows.length) return null;
  const cur = active === null ? -1 : rowOf(nodes, rows, active);
  const last = rows.length - 1;
  const at = step === 'top' || (step === 'above' && cur < 0) ? 0
    : step === 'bottom' || (step === 'below' && cur < 0) ? last
      : step === 'above' ? Math.max(0, cur - 1) : Math.min(last, cur + 1);
  return rows[at];
}
