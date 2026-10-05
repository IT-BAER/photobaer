import type { LayerNode } from './engine.worker.ts';

export const BLEND_MODES = [
  'normal', 'dissolve', 'darken', 'multiply', 'color burn', 'linear burn', 'darker color', 'lighten', 'screen',
  'color dodge', 'linear dodge', 'lighter color', 'overlay', 'soft light', 'hard light', 'vivid light',
  'linear light', 'pin light', 'hard mix', 'difference', 'exclusion', 'subtract', 'divide', 'hue', 'saturation',
  'color', 'luminosity',
];

// Photoshop's blend modes for 32-bit images; only these keep values above 1 in the engine (`blend::hdr_mode`).
export const HDR_BLEND_MODES = ['normal', 'dissolve', 'darken', 'multiply', 'lighten', 'linear dodge', 'difference', 'hue', 'saturation', 'color', 'luminosity'];

// A blend select's modes for a document `depth`; a 32-bit document keeps `current` listed when it is another mode.
export function blendModesFor(depth: number, current: string): string[] {
  if (depth !== 32) return BLEND_MODES;
  return HDR_BLEND_MODES.includes(current) ? HDR_BLEND_MODES : [...HDR_BLEND_MODES, current];
}

export type Where = 'above' | 'below' | 'into';

// The list holding `id` and its index there; parent 0 is the root.
export function locate(list: LayerNode[], id: number, parent = 0): { parent: number; list: LayerNode[]; index: number } | null {
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return { parent, list, index: i };
    const hit = list[i].children && locate(list[i].children!, id, list[i].id);
    if (hit) return hit;
  }
  return null;
}

export function nodeById(list: LayerNode[], id: number): LayerNode | undefined {
  for (const n of list) {
    if (n.id === id) return n;
    const hit = n.children && nodeById(n.children, id);
    if (hit) return hit;
  }
  return undefined;
}

// moveNode arguments for dropping `drag` above, below or into `target` (index counts after removal),
// or null for an invalid or no-op drop. Lists are bottom to top, so "above" is the higher index.
export function dropTarget(tree: LayerNode[], drag: number, target: number, where: Where) {
  const d = locate(tree, drag), t = locate(tree, target);
  if (!d || !t || drag === target) return null;
  const dragged = d.list[d.index];
  if (dragged.children && locate(dragged.children, target)) return null;
  let parent = t.parent, list = t.list, index = where === 'above' ? t.index + 1 : t.index;
  if (where === 'into') {
    const g = t.list[t.index];
    if (!g.children) return null;
    parent = g.id;
    list = g.children;
    index = list.length;
  }
  if (list === d.list && d.index < index) index--;
  if (list === d.list && d.index === index) return null;
  return { parent, index };
}

/** Every node of the tree, parents before their children. */
export const flatNodes = (list: LayerNode[]): LayerNode[] => list.flatMap(n => [n, ...flatNodes(n.children ?? [])]);
