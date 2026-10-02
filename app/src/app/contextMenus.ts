// Right-click menus (layer row, canvas): flat picks from the menus buildMenus produced, so labels, handlers and
// disabled states stay those of the menu bar.
import type { Item } from './helpers.ts';

type Menus = Record<string, Item[]>;

/**
 * `Menu/Label|Other Label` or `Menu/Submenu/Label`, optionally `=Shown` to rename. `Menu/Label>` expands the
 * enabled entries of a submenu. Missing entries drop out.
 */
function find(menus: Menus, spec: string): Item[] {
  const [path, shown] = spec.split('=');
  const [menu, ...rest] = path.split('/');
  const last = rest.at(-1)!;
  const expand = last.endsWith('>');
  let items: Item[] | undefined = menus[menu];
  for (const seg of rest.slice(0, -1)) items = items?.find(i => i.label === seg)?.sub;
  const names = last.replace(/>$/, '').split('|');
  const item = items?.find(i => names.includes(i.label));
  if (!item) return [];
  if (expand) return (item.sub ?? []).filter(i => !i.off).map(i => ({ ...i, label: `${item.label} ${i.label}` }));
  return [shown ? { ...item, label: shown } : item];
}

/** Groups of specs become one flat list (submenus dropped) with a separator before every group but the first. */
export function pickItems(menus: Menus, groups: string[][]): Item[] {
  return groups.map(g => g.flatMap(s => find(menus, s))).filter(g => g.length)
    .flatMap((g, gi) => g.map((i, k) => ({ ...i, sub: undefined, sep: gi > 0 && k === 0 })));
}

const LAYER_ROW: string[][] = [
  ['Layer/Duplicate Layer', 'Layer/Delete Layer'],
  ['Layer/Group Layers=Group from Layers', 'Layer/Merge Down|Merge Layers|Merge Group', 'Layer/Merge Visible', 'Layer/Flatten Image'],
  ['Layer/Rasterize>', 'Layer/Smart Objects/Convert to Smart Object'],
  ['Layer/Add Layer Mask', 'Layer/Delete Layer Mask', 'Layer/Create Clipping Mask|Release Clipping Mask', 'Layer/Layer Style/Blending Options…=Blending Options…'],
];

/** The layer row menu: the Layer menu picks, then the row-specific items (Copy CSS/SVG, shape attributes). */
export function layerRowItems(menus: Menus, extra: Item[]): Item[] {
  const picked = pickItems(menus, LAYER_ROW);
  return [...picked, ...extra.map((i, k) => (k === 0 && picked.length ? { ...i, sep: true } : i))];
}

const SELECTION: string[][] = [['Select/Deselect', 'Select/Inverse=Select Inverse', 'Select/Feather…'], ['Canvas/Layer via Copy', 'Edit/Free Transform', 'Edit/Fill…', 'Edit/Stroke…']];
const NO_SELECTION: string[][] = [['Select/All=Select All', 'Select/Reselect'], ['Edit/Free Transform']];

/** The canvas menu: selection commands when a pixel selection exists, else Select All / Reselect. */
export function canvasItems(menus: Menus, selection: boolean, viaCopy: Item[]): Item[] {
  return pickItems({ ...menus, Canvas: viaCopy }, selection ? SELECTION : NO_SELECTION);
}
