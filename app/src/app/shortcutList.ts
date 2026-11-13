import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { i18n } from '../i18n/index.ts';
import { keysLabel } from '../i18n/keys.ts';
import { SLOTS, TOOLS } from '../shell/tools.ts';
import type { Item } from './helpers.ts';

export interface ShortcutRow { command: string; keys: string }
export interface ShortcutGroup { id: string; title: string; rows: ShortcutRow[] }

// Keys without a menu item (Photoshop lists them under Tools and Panel Menus in Edit > Keyboard Shortcuts).
const OTHER_KEYS: [MessageDescriptor, string][] = [
  [msg`Select Layer Above`, 'Alt+]'], [msg`Select Layer Below`, 'Alt+['], [msg`Select Top Layer`, 'Alt+.'], [msg`Select Bottom Layer`, 'Alt+,'],
  [msg`Add Layer Above to Selection`, 'Alt+Shift+]'], [msg`Add Layer Below to Selection`, 'Alt+Shift+['],
  [msg`Decrease Brush Size`, '['], [msg`Increase Brush Size`, ']'], [msg`Decrease Brush Hardness`, 'Shift+['], [msg`Increase Brush Hardness`, 'Shift+]'],
  [msg`Tool Opacity (10 % steps, two digits for an exact value)`, '0-9'], [msg`Tool Flow (10 % steps)`, 'Shift+0-9'],
  [msg`Cycle Screen Modes (Shift backward)`, 'F'],
  [msg`Default Foreground/Background Colors`, 'D'], [msg`Switch Foreground/Background Colors`, 'X'], [msg`Toggle Quick Mask Mode`, 'Q'],
  [msg`Hand Tool while held`, 'Space'], [msg`Zoom In while held`, 'Ctrl+Space'], [msg`Zoom Out while held`, 'Ctrl+Alt+Space'],
  [msg`Composite Channel`, 'Ctrl+2'], [msg`Red, Green or Blue Channel`, 'Ctrl+3, 4, 5'],
  [msg`Nudge Layer or Selection by 1 px (10 px with Shift)`, '← ↑ → ↓'],
  [msg`Next Tool in the Group`, 'Shift+Tool Key'],
];

const SPACE = msg({ message: 'Space', context: 'keyboard key' });
const TOOL_KEY = msg`Tool Key`;
// Shown keys: the UI language's modifier and key names.
const shown = (keys: string) => keysLabel(keys).replace(/Space/, i18n._(SPACE)).replace('Tool Key', i18n._(TOOL_KEY));

// Every menu command with a shortcut (one group per menu, `title` translates the menu name), the tools and the other keys.
export function shortcutGroups(menus: Record<string, Item[]>, title: (menu: string) => string): ShortcutGroup[] {
  const strip = (label: string) => label.replace(/^✓ /, '');
  const menuRows = (items: Item[], trail: string[]): ShortcutRow[] => items.flatMap(i => [
    ...(i.keys && i.keys !== '›' ? [{ command: [...trail, strip(i.label)].join(' > '), keys: shown(i.keys) }] : []),
    ...(i.sub ? menuRows(i.sub, [...trail, strip(i.label)]) : []),
  ]);
  const groups = Object.entries(menus).map(([name, items]) => ({ id: name, title: title(name), rows: menuRows(items, []) }));
  const tools = SLOTS.filter(s => s.key).flatMap(s => s.tools.map(id => ({ command: i18n._(TOOLS[id].label), keys: shown(s.key.toUpperCase()) })));
  return [
    ...groups.filter(g => g.rows.length),
    { id: 'Tools', title: i18n._(msg`Tools`), rows: tools },
    { id: 'Other', title: i18n._(msg`Other Keys`), rows: OTHER_KEYS.map(([label, keys]) => ({ command: i18n._(label), keys: shown(keys) })) },
  ];
}

// The rows whose command or keys contain every word of `query`.
export function filterShortcuts(groups: ShortcutGroup[], query: string): ShortcutGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return groups;
  return groups.map(g => ({ ...g, rows: g.rows.filter(r => { const s = `${r.command} ${r.keys}`.toLowerCase(); return words.every(w => s.includes(w)); }) }))
    .filter(g => g.rows.length);
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// A standalone HTML page of the groups (Photoshop's Summarize).
export function shortcutsHtml(groups: ShortcutGroup[], heading: string, columns: [string, string]): string {
  const body = groups.map(g => `<h2>${escapeHtml(g.title)}</h2>\n<table><tr><th>${escapeHtml(columns[0])}</th><th>${escapeHtml(columns[1])}</th></tr>\n${
    g.rows.map(r => `<tr><td>${escapeHtml(r.command)}</td><td><kbd>${escapeHtml(r.keys)}</kbd></td></tr>`).join('\n')}</table>`).join('\n');
  return `<!doctype html>\n<html lang="${escapeHtml(i18n.locale)}"><head><meta charset="utf-8"><title>${escapeHtml(heading)}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px}table{border-collapse:collapse;margin-bottom:16px}td,th{border:1px solid #ccc;padding:3px 8px;text-align:left}</style></head>
<body><h1>${escapeHtml(heading)}</h1>\n${body}\n</body></html>\n`;
}
