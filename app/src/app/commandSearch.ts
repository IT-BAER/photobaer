import { itemId, type Item } from './helpers.ts';

// `path`/`label` are what the user sees; `en`/`enLabel` the English ids, which search matches too.
export interface Command { path: string; label: string; en: string; enLabel: string; keys?: string; off: boolean; run: () => void }

export const MAX_RESULTS = 50;

/** Every leaf item of the menus in menu order; submenu parents are not commands, their children are. */
export function flattenMenus(menus: Record<string, Item[]>): Command[] {
  const out: Command[] = [];
  const walk = (items: Item[], trail: string[], en: string[]) => {
    for (const i of items) {
      if (!i.label) continue;
      if (i.sub) walk(i.sub, [...trail, i.label], [...en, itemId(i)]);
      else out.push({ path: [...trail, i.label].join(' > '), label: i.label, en: [...en, itemId(i)].join(' > '), enLabel: itemId(i), keys: i.keys, off: !!i.off, run: i.run });
    }
  };
  for (const [name, items] of Object.entries(menus)) walk(items, [name], [name]);
  return out;
}

// 0 label starts with the query, 1 every word starts a word of the label, 2 every word in the label, 3 path only.
function rank(text: string, q: string, words: string[]): number {
  const label = text.toLowerCase();
  if (label.startsWith(q)) return 0;
  if (words.every(w => label.startsWith(w) || label.includes(` ${w}`))) return 1;
  return words.every(w => label.includes(w)) ? 2 : 3;
}

export function searchCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const all = (p: string) => { const s = p.toLowerCase(); return words.every(w => s.includes(w)); };
  return commands
    .filter(c => all(c.path) || all(c.en))
    .map((c, i) => ({ c, i, r: Math.min(rank(c.label, q, words), rank(c.enLabel, q, words)) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, MAX_RESULTS)
    .map(x => x.c);
}
