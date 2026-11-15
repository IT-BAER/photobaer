// Layer > Link Layers, Select Linked Layers and the Layers panel color labels.
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { flatNodes } from '../layers.ts';
import { tl, type Item } from './helpers.ts';
import type { LayerColor, LayerNode } from '../worker/types.ts';

export const LAYER_COLORS: [LayerColor, MessageDescriptor][] = [
  ['none', msg`No Color`], ['red', msg`Red`], ['orange', msg`Orange`], ['yellow', msg`Yellow`],
  ['green', msg`Green`], ['blue', msg`Blue`], ['violet', msg`Violet`], ['gray', msg`Gray`],
];

// The Link Layers toggle as [layer id, link group] changes: a selection that is one link group (or one linked
// layer) unlinks, any other selection of two or more layers links into a new group; a group left with one
// layer dissolves. Null when there is nothing to link.
export function linkChanges(tree: LayerNode[], selected: number[]): { linked: boolean; changes: [number, number][] } | null {
  const all = flatNodes(tree), link = new Map(all.map(n => [n.id, n.link ?? 0]));
  const sel = selected.filter(id => link.has(id));
  const groups = new Set(sel.map(id => link.get(id)!));
  const first = link.get(sel[0]) ?? 0;
  const unlink = first !== 0 && groups.size === 1;
  if (!unlink && sel.length < 2) return null;
  const next = unlink ? 0 : Math.max(0, ...link.values()) + 1;
  const after = new Map(link);
  for (const id of sel) after.set(id, next);
  const counts = new Map<number, number>();
  for (const g of after.values()) if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
  for (const [id, g] of after) if (g && counts.get(g)! < 2) after.set(id, 0);
  const changes: [number, number][] = sel.map(id => [id, after.get(id)!]);
  for (const n of all) if (!sel.includes(n.id) && after.get(n.id) !== link.get(n.id)) changes.push([n.id, after.get(n.id)!]);
  return { linked: !unlink, changes };
}

// The `setPropsMany` arguments that apply `linkChanges`.
export const linkCall = ({ linked, changes }: { linked: boolean; changes: [number, number][] }) =>
  [changes.map(([id, link]): [number, { link: number }] => [id, { link }]), linked ? 'Link Layers' : 'Unlink Layers'] as const;

// `ids` plus every layer that shares a link group with one of them.
export function linkedIds(tree: LayerNode[], ids: number[]): number[] {
  const all = flatNodes(tree);
  const groups = new Set(all.filter(n => ids.includes(n.id) && n.link).map(n => n.link));
  return [...ids, ...all.filter(n => !ids.includes(n.id) && n.link && groups.has(n.link)).map(n => n.id)];
}

// Layer Color applies to the selected layers and everything inside a selected group.
export function colorTargets(tree: LayerNode[], ids: number[]): number[] {
  const out = new Set<number>();
  for (const n of flatNodes(tree)) if (ids.includes(n.id)) for (const m of [n, ...flatNodes(n.children ?? [])]) out.add(m.id);
  return [...out];
}

// The layer context menu's color items: checked when every target has that color.
export function colorItems(tree: LayerNode[], ids: number[], set: (ids: number[], color: LayerColor) => void): Item[] {
  const targets = colorTargets(tree, ids), all = flatNodes(tree);
  const has = (c: LayerColor) => targets.length > 0 && targets.every(id => (all.find(n => n.id === id)?.color ?? 'none') === c);
  return LAYER_COLORS.map(([c, label], i) => ({ ...tl(label, has(c)), sep: i === 0, run: () => set(targets, c) }));
}
