// The English menu tree (ids, labels, shortcuts) is a public surface: shortcuts, context menus, command search and
// WebMCP paths depend on it. Translation must not change it; UPDATE_MENUS=1 rewrites the snapshot on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import type { MenuCtx } from './menus.ts';
import type { TypeCtx } from './typeMenu.ts';
import type { Item } from './helpers.ts';
import type { LayerNode } from '../worker/types.ts';

// client.ts starts the engine worker on import; menus only need its methods to exist.
(globalThis as any).Worker ??= class { postMessage() {} addEventListener() {} };
const { buildMenus } = await import('./menus.ts');
const { typeContextItems, typeMenuItems } = await import('./typeMenu.ts');
const { itemId } = await import('./helpers.ts');
const { initSync, filter_schema } = await import('../engine-pkg/photobaer_engine.js');
initSync({ module: readFileSync(new URL('../engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });
const filterSpecs = JSON.parse(filter_schema()) as MenuCtx['filterSpecs'];

const SNAPSHOT = new URL('menuTree.en.json', import.meta.url);

// Ids are compared without the check mark: translated items keep it in the label only.
// Any property, call, iteration or string conversion works: every flag reads as set, every list as empty.
const stub: any = new Proxy(function () {}, {
  get: (_, p) => (p === Symbol.toPrimitive ? () => '' : p === Symbol.iterator ? function* () {} : p === 'length' ? 0 : stub),
  apply: () => stub,
});
const ctx = <T,>(over: Partial<T> = {}) => new Proxy(over, { get: (o, p) => (p in o ? (o as any)[p] : stub) }) as T;

type Row = [string, string, string?, Row[]?];
const rows = (items: Item[]): Row[] => items.map(i => {
  const r: Row = [itemId(i).replace(/^✓ /, ''), i.label];
  if (i.keys || i.sub) r.push(i.keys ?? '');
  if (i.sub) r.push(rows(i.sub));
  return r;
});

test('English menu tree is unchanged', () => {
  const typeCtx = ctx<TypeCtx>();
  const menus = buildMenus(ctx<MenuCtx>({ typeItems: typeMenuItems(typeCtx), recent: [], filterSpecs }));
  const tree = {
    menus: Object.fromEntries(Object.entries(menus).map(([k, v]) => [k, rows(v)])),
    typeContext: rows(typeContextItems(ctx<LayerNode>(), typeCtx)),
  };
  const json = `${JSON.stringify(tree, null, 1)}\n`;
  if (process.env.UPDATE_MENUS) writeFileSync(SNAPSHOT, json);
  assert.equal(json, readFileSync(SNAPSHOT, 'utf8'));
});
