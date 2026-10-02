import type { Item } from './helpers.ts';

export interface Command { path: string; label: string; keys?: string; off: boolean; run: () => void }

export const MAX_RESULTS = 50;

/** Every leaf item of the menus in menu order; submenu parents are not commands, their children are. */
export function flattenMenus(menus: Record<string, Item[]>): Command[] {
  const out: Command[] = [];
  const walk = (items: Item[], trail: string[]) => {
    for (const i of items) {
      if (!i.label) continue;
      if (i.sub) walk(i.sub, [...trail, i.label]);
      else out.push({ path: [...trail, i.label].join(' > '), label: i.label, keys: i.keys, off: !!i.off, run: i.run });
    }
  };
  for (const [name, items] of Object.entries(menus)) walk(items, [name]);
  return out;
}

// 0 label starts with the query, 1 every word starts a word of the label, 2 every word in the label, 3 path only.
function rank(c: Command, q: string, words: string[]): number {
  const label = c.label.toLowerCase();
  if (label.startsWith(q)) return 0;
  if (words.every(w => label.startsWith(w) || label.includes(` ${w}`))) return 1;
  return words.every(w => label.includes(w)) ? 2 : 3;
}

export function searchCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  return commands
    .filter(c => { const p = c.path.toLowerCase(); return words.every(w => p.includes(w)); })
    .map((c, i) => ({ c, i, r: rank(c, q, words) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, MAX_RESULTS)
    .map(x => x.c);
}
