import test from 'node:test';
import assert from 'node:assert/strict';
import type { Item } from './helpers.ts';
import { filterShortcuts, shortcutGroups, shortcutsHtml } from './shortcutList.ts';

const item = (label: string, keys?: string, sub?: Item[]): Item => ({ label, keys, sub, run: () => {} });
const menus: Record<string, Item[]> = {
  File: [item('New…', 'Alt+Ctrl+N'), item('Export', '›', [item('Export As…', 'Alt+Shift+Ctrl+W'), item('Quick Export')])],
  Help: [item('About…')],
};

test('menu groups list items with keys, submenus with their path, and skip menus without keys', () => {
  const g = shortcutGroups(menus, m => `[${m}]`);
  assert.deepEqual(g[0], { id: 'File', title: '[File]', rows: [{ command: 'New…', keys: 'Alt+Ctrl+N' }, { command: 'Export > Export As…', keys: 'Alt+Shift+Ctrl+W' }] });
  assert.ok(!g.some(x => x.id === 'Help'));
  const tools = g.find(x => x.id === 'Tools')!;
  assert.ok(tools.rows.some(r => r.command === 'Move' && r.keys === 'V'));
  assert.ok(tools.rows.some(r => r.command === 'Zoom' && r.keys === 'Z'));
  assert.ok(g.find(x => x.id === 'Other')!.rows.some(r => r.keys === 'Alt+['));
});

test('filter matches every word in the command or keys and drops empty groups', () => {
  const g = shortcutGroups(menus, m => m);
  const f = filterShortcuts(g, 'export alt');
  assert.deepEqual(f.map(x => x.id), ['File']);
  assert.deepEqual(f[0].rows.map(r => r.command), ['Export > Export As…']);
  assert.equal(filterShortcuts(g, '  ').length, g.length);
});

test('the summary page escapes text', () => {
  const html = shortcutsHtml([{ id: 'x', title: 'A & B', rows: [{ command: '<x>', keys: 'Ctrl+<' }] }], 'Keys', ['Command', 'Shortcut']);
  assert.ok(html.includes('<h2>A &amp; B</h2>'));
  assert.ok(html.includes('<td>&lt;x&gt;</td><td><kbd>Ctrl+&lt;</kbd></td>'));
});
