// Right-click menus (layer row, canvas): flat picks from the menus buildMenus produced, so labels, handlers and
// disabled states stay those of the menu bar.
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { i18n } from '../i18n/index.ts';
import { itemId, type Item } from './helpers.ts';

type Menus = Record<string, Item[]>;

// `=Shown` texts of the specs below: the English text is the key, the label is translated.
const SHOWN: Record<string, MessageDescriptor> = {
  'Delete Layer': msg`Delete Layer`, 'Group from Layers': msg`Group from Layers`, 'Blending Options…': msg`Blending Options…`,
  'Select Inverse': msg`Select Inverse`, 'Select All': msg`Select All`,
};

/**
 * `Menu/Id|Other Id` or `Menu/Submenu/Id` (item ids, the English labels), optionally `=Shown` to rename. `Menu/Label>` expands the
 * enabled entries of a submenu. Missing entries drop out.
 */
function find(menus: Menus, spec: string): Item[] {
  const [path, shown] = spec.split('=');
  const [menu, ...rest] = path.split('/');
  const last = rest.at(-1)!;
  const expand = last.endsWith('>');
  let items: Item[] | undefined = menus[menu];
  for (const seg of rest.slice(0, -1)) items = items?.find(i => itemId(i) === seg)?.sub;
  const names = last.replace(/>$/, '').split('|');
  const item = items?.find(i => names.includes(itemId(i)));
  if (!item) return [];
  if (expand) return (item.sub ?? []).filter(i => !i.off).map(i => ({ ...i, id: `${itemId(item)} ${itemId(i)}`, label: `${item.label} ${i.label}` }));
  return [shown ? { ...item, label: SHOWN[shown] ? i18n._(SHOWN[shown]) : shown } : item];
}

/** Groups of specs become one flat list (submenus dropped) with a separator before every group but the first. */
export function pickItems(menus: Menus, groups: string[][]): Item[] {
  return groups.map(g => g.flatMap(s => find(menus, s))).filter(g => g.length)
    .flatMap((g, gi) => g.map((i, k) => ({ ...i, sub: undefined, sep: gi > 0 && k === 0 })));
}

const LAYER_ROW: string[][] = [
  ['Layer/Duplicate Layer', 'Layer/Delete/Layer=Delete Layer'],
  ['Layer/Group Layers=Group from Layers', 'Layer/Merge Down|Merge Layers|Merge Group', 'Layer/Merge Visible', 'Layer/Flatten Image'],
  ['Layer/Rasterize>', 'Layer/Smart Objects/Convert to Smart Object'],
  ['Layer/Add Layer Mask', 'Layer/Delete Layer Mask', 'Layer/Create Clipping Mask|Release Clipping Mask', 'Layer/Layer Style/Blending Options…=Blending Options…'],
];

/** The layer row menu: the Layer menu picks, then the row-specific items (Copy CSS/SVG, shape attributes). */
export function layerRowItems(menus: Menus, extra: Item[]): Item[] {
  const picked = pickItems(menus, LAYER_ROW);
  return [...picked, ...extra.map((i, k) => (k === 0 && picked.length ? { ...i, sep: true } : i))];
}

const SELECTION: string[][] = [['Select/Deselect', 'Select/Inverse=Select Inverse', 'Select/Modify/Feather…'], ['Layer/Layer via Copy', 'Edit/Free Transform', 'Edit/Fill…', 'Edit/Stroke…']];
const NO_SELECTION: string[][] = [['Select/All=Select All', 'Select/Reselect'], ['Edit/Free Transform']];

/** The canvas menu: selection commands when a pixel selection exists, else Select All / Reselect. */
export function canvasItems(menus: Menus, selection: boolean): Item[] {
  return pickItems(menus, selection ? SELECTION : NO_SELECTION);
}
