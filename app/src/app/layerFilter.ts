import type { LayerNode } from '../engine.worker.ts';

export type KindFilter = 'pixel' | 'adjustment' | 'type' | 'shape' | 'smart';
export const KIND_FILTERS: { kind: KindFilter; label: string }[] = [
  { kind: 'pixel', label: 'Pixel layers' }, { kind: 'adjustment', label: 'Adjustment and fill layers' },
  { kind: 'type', label: 'Type layers' }, { kind: 'shape', label: 'Shape layers' }, { kind: 'smart', label: 'Smart objects' },
];

const kindOf = (n: LayerNode): KindFilter | null =>
  n.kind === 'fill' ? 'adjustment' : n.kind === 'text' ? 'type' : n.kind === 'group' ? null : n.kind;

// The tree reduced to layers of the picked kinds; a group stays (with its matching descendants) if any descendant matches.
// No picked kinds: the tree unchanged.
export function filterLayers(nodes: LayerNode[], kinds: ReadonlySet<KindFilter>): LayerNode[] {
  if (!kinds.size) return nodes;
  return nodes.flatMap(n => {
    if (!n.children) return kinds.has(kindOf(n)!) ? [n] : [];
    const children = filterLayers(n.children, kinds);
    return children.length ? [{ ...n, children }] : [];
  });
}
