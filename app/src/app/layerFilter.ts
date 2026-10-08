import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { LayerNode } from '../engine.worker.ts';

export type KindFilter = 'pixel' | 'adjustment' | 'type' | 'shape' | 'smart';
export const KIND_FILTERS: { kind: KindFilter; label: MessageDescriptor }[] = [
  { kind: 'pixel', label: msg`Pixel layers` }, { kind: 'adjustment', label: msg`Adjustment and fill layers` },
  { kind: 'type', label: msg`Type layers` }, { kind: 'shape', label: msg`Shape layers` }, { kind: 'smart', label: msg`Smart objects` },
];

const kindOf = (n: LayerNode): KindFilter | null =>
  n.kind === 'fill' ? 'adjustment' : n.kind === 'text' ? 'type' : n.kind === 'group' ? null : n.kind;

// The tree reduced to the nodes `keep` accepts, each with its subtree; a group stays (with its kept
// descendants) if any descendant is kept.
function filterTree(nodes: LayerNode[], keep: (n: LayerNode) => boolean): LayerNode[] {
  return nodes.flatMap(n => {
    if (keep(n)) return [n];
    const children = n.children ? filterTree(n.children, keep) : [];
    return children.length ? [{ ...n, children }] : [];
  });
}

// The tree reduced to layers of the picked kinds. No picked kinds: the tree unchanged.
export function filterLayers(nodes: LayerNode[], kinds: ReadonlySet<KindFilter>): LayerNode[] {
  if (!kinds.size) return nodes;
  return filterTree(nodes, n => !n.children && kinds.has(kindOf(n)!));
}

// Layers panel name filter: case-insensitive substring. Blank text: the tree unchanged.
export function filterByName(nodes: LayerNode[], text: string): LayerNode[] {
  const q = text.trim().toLowerCase();
  return q ? filterTree(nodes, n => n.name.toLowerCase().includes(q)) : nodes;
}

// Select > Isolate Layers: only the listed layers and the groups holding them.
export const filterIds = (nodes: LayerNode[], ids: readonly number[]) => filterTree(nodes, n => ids.includes(n.id));
