// Menu consumers resolve items by their stable English id, so translated labels do not break them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findMenuItem, itemId, tl, type Item } from './helpers.ts';
import { i18n } from '../i18n/index.ts';
import { canvasItems, pickItems } from './contextMenus.ts';
import { flattenMenus, searchCommands } from './commandSearch.ts';
import { agentTools, type WebMcpCtx } from './webmcp.ts';

// A translated item: the label is what the user sees, the id the English source text.
const tr = (id: string, extra: Partial<Item> = {}): Item => ({ id, label: `«${id}»`, run: () => {}, ...extra });
let ran = '';
const menus: Record<string, Item[]> = {
  Layer: [tr('Layer via Copy', { run: () => { ran = 'copy'; } }), tr('Rasterize', { sub: [tr('Type', { off: true }), tr('Shape')] })],
  Select: [tr('All'), tr('Deselect'), tr('Inverse'), tr('Modify', { sub: [tr('Feather…')] }), tr('Reselect')],
  Edit: [tr('Free Transform'), tr('Fill…'), tr('Stroke…')],
  Image: [tr('Adjustments', { sub: [tr('Invert', { run: () => { ran = 'invert'; } })] })],
  View: [{ id: 'Snap', label: '✓ «Snap»', run: () => {} }],
};

test('itemId is the id, else the label', () => {
  assert.equal(itemId(tr('Copy')), 'Copy');
  assert.equal(itemId({ label: 'Paste', run: () => {} }), 'Paste');
});

test('tl keeps the English source text as id and shows the active language, with an optional check mark', () => {
  const d = { id: 'x1', message: 'Snap' };
  i18n.loadAndActivate({ locale: 'de', messages: { x1: 'Ausrichten' } });
  try {
    assert.deepEqual(tl(d), { id: 'Snap', label: 'Ausrichten' });
    assert.deepEqual(tl(d, true), { id: 'Snap', label: '✓ Ausrichten' });
  } finally {
    i18n.loadAndActivate({ locale: 'en', messages: {} });
  }
  assert.deepEqual(tl(d, false), { id: 'Snap', label: 'Snap' });
});

test('findMenuItem searches top level and submenus by id', () => {
  assert.equal(findMenuItem(menus, id => id === 'Invert')?.label, '«Invert»');
  assert.equal(findMenuItem(menus, id => id.startsWith('Layer via')), menus.Layer[0]);
  assert.equal(findMenuItem(menus, id => id === '«Invert»'), undefined, 'labels are not matched');
});

test('context menus pick translated items by English path and show the translated label', () => {
  assert.deepEqual(canvasItems(menus, true).map(i => i.label), ['«Deselect»', 'Select Inverse', '«Feather…»', '«Layer via Copy»', '«Free Transform»', '«Fill…»', '«Stroke…»']);
  assert.deepEqual(pickItems(menus, [['Layer/Rasterize>']]).map(i => [i.id, i.label]), [['Rasterize Shape', '«Rasterize» «Shape»']]);
});

test('command search finds translated commands by the localized and the English name', () => {
  const all = flattenMenus(menus);
  assert.deepEqual(searchCommands(all, 'invert').map(c => c.label), ['«Invert»']);
  assert.deepEqual(searchCommands(all, '«invert').map(c => c.label), ['«Invert»']);
  assert.deepEqual(searchCommands(all, 'adjustments invert').map(c => c.label), ['«Invert»']);
});

test('WebMCP paths stay English with translated labels; the label is listed when it differs', async () => {
  const ctx: WebMcpCtx = {
    ready: async () => {}, doc: () => null, active: () => null, selectLayer: () => {}, menus: () => menus, newDocument: async () => {},
    filters: () => [], runFilter: async () => {}, preview: async () => ({ mimeType: 'image/png', data: '', width: 0, height: 0 }),
  };
  const tools = new Map(agentTools(ctx).map(t => [t.name, t]));
  const list = await tools.get('list_commands')!.execute({ query: 'adjustments' });
  assert.deepEqual(list, [{ path: 'Image > Adjustments > Invert', label: 'Image > «Adjustments» > «Invert»',enabled: true }]);
  assert.deepEqual(await tools.get('list_commands')!.execute({ query: 'snap' }), [{ path: 'View > Snap', label: 'View > «Snap»', enabled: true, checked: true }]);
  ran = '';
  await tools.get('run_command')!.execute({ path: 'Layer > Layer via Copy' });
  assert.equal(ran, 'copy');
});
