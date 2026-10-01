import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { agentTools, registerWebMcp, type WebMcpCtx } from './webmcp.ts';
import type { FilterParam, FilterSpec } from '../filters/schema.ts';

type Tool = { name: string; annotations?: { readOnlyHint?: boolean }; execute: (i: Record<string, unknown>) => Promise<unknown> };

test('WebMCP tools register on a model context and unregister on abort', async () => {
  const tools = new Map<string, Tool>();
  const mc = {
    registerTool(t: Tool, o: { signal: AbortSignal }) {
      tools.set(t.name, t);
      o.signal.addEventListener('abort', () => tools.delete(t.name));
    },
  };
  let ran = 0, made: number[] = [], active: number | null = 1;
  const doc = { name: 'a', width: 4, height: 3, depth: 8, resolution: 72, layers: [{ id: 1, name: 'Background', kind: 'pixel', visible: true }, { id: 2, name: 'G', kind: 'group', visible: false, children: [] }] };
  const summary = { name: 'a', width: 4, height: 3, depth: 8, resolution: 72, activeLayer: 1, layers: [{ id: 1, name: 'Background', kind: 'pixel', visible: true }, { id: 2, name: 'G', kind: 'group', visible: false, children: [] }] };
  let start!: () => void;
  const ready = new Promise<void>(r => { start = r; });
  const ctl = new AbortController();
  const ok = registerWebMcp(mc, {
    ...base,
    ready: () => ready,
    doc: () => doc as never,
    active: () => active,
    selectLayer: id => { active = id; },
    menus: () => ({
      File: [{ label: 'New…', run: () => { ran++; } }, { label: 'Export', run: () => {}, sub: [{ label: 'PNG', run: () => { ran += 10; }, off: true }] }],
      View: [{ label: '✓ Snap', run: async () => { await Promise.resolve(); ran += 100; } }],
    }),
    newDocument: async (w, h) => { made = [w, h]; },
  }, ctl.signal);
  assert.equal(ok, true);
  assert.deepEqual([...tools.keys()].sort(), ['get_document', 'get_preview', 'list_commands', 'list_filters', 'new_document', 'run_command', 'run_filter', 'select_layer']);
  assert.equal(tools.get('get_document')!.annotations?.readOnlyHint, true);
  const call = (name: string, input: Record<string, unknown> = {}) => tools.get(name)!.execute(input);

  let early: unknown = 'pending';
  const first = call('get_document').then(r => { early = r; });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(early, 'pending', 'calls wait until the app has started');
  start();
  await first;

  assert.deepEqual(await call('get_document'), summary);
  assert.deepEqual(await call('list_commands'), [
    { path: 'File > New…', enabled: true }, { path: 'File > Export > PNG', enabled: false }, { path: 'View > Snap', enabled: true, checked: true },
  ]);
  assert.deepEqual(await call('list_commands', { query: 'snap' }), [{ path: 'View > Snap', enabled: true, checked: true }]);

  assert.deepEqual(await call('run_command', { path: 'File > New…' }), { ran: 'File > New…', document: summary });
  assert.equal(ran, 1);
  await call('run_command', { path: 'View > Snap' });
  assert.equal(ran, 101, 'run_command awaits async commands');
  assert.match((await call('run_command', { path: 'File > Export > PNG' }) as { error: string }).error, /disabled/);
  assert.match((await call('run_command', { path: 'File > Nope' }) as { error: string }).error, /Unknown/);

  assert.deepEqual(await call('select_layer', { id: 2 }), { activeLayer: 2 });
  assert.equal(active, 2);
  assert.match((await call('select_layer', { id: 9 }) as { error: string }).error, /No layer/);

  await call('new_document', { width: 640, height: 480 });
  assert.deepEqual(made, [640, 480]);
  assert.match((await call('new_document', { width: 0, height: 480 }) as { error: string }).error, /width/);

  ctl.abort();
  assert.equal(tools.size, 0);
  assert.equal(registerWebMcp(undefined, base, ctl.signal), false);
});

const base: WebMcpCtx = {
  ready: async () => {}, doc: () => null, active: () => null, selectLayer: () => {}, menus: () => ({}), newDocument: async () => {},
  filters: () => [], runFilter: async () => {}, preview: async () => ({ mimeType: 'image/png', data: '', width: 0, height: 0 }),
};
const param = (key: string, kind: FilterParam['kind'], extra: Partial<FilterParam> = {}): FilterParam =>
  ({ key, label: key, kind, min: 0, max: 10, step: 1, unit: '', default: 1, ...extra });

test('filters run by id with validated params merged over the defaults', async () => {
  const spec: FilterSpec = {
    id: 'blur.gaussian', label: 'Gaussian Blur', group: 'blur', exec: 'local', alpha: 'kept', preview: true, rgb_only: false,
    params: [param('radius', 'number', { unit: 'px' }), param('n', 'int'), param('mode', 'select', { default: 'a', choices: ['a', 'b'] }), param('on', 'bool', { default: false }), param('seed', 'seed', { min: 5, max: 5 }), param('data', 'blob', { default: null })],
  };
  let ran: [string, Record<string, unknown>] | null = null;
  const tools = Object.fromEntries(agentTools({
    ...base, doc: () => ({ name: 'a', width: 1, height: 1, depth: 8, resolution: 72, layers: [] }) as never, active: () => 1, filters: () => [spec],
    runFilter: async (id, params) => { ran = [id, params]; },
  }).map(t => [t.name, t]));
  const call = (name: string, input: Record<string, unknown> = {}) => tools[name].execute(input);

  assert.deepEqual(await call('list_filters', { query: 'gauss' }), [{
    id: 'blur.gaussian', label: 'Gaussian Blur', group: 'blur',
    params: [
      { key: 'radius', kind: 'number', min: 0, max: 10, unit: 'px', default: 1 }, { key: 'n', kind: 'int', min: 0, max: 10, default: 1 },
      { key: 'mode', kind: 'select', choices: ['a', 'b'], default: 'a' }, { key: 'on', kind: 'bool', default: false },
    ],
  }]);
  assert.deepEqual(await call('list_filters', { query: 'zzz' }), []);

  await call('run_filter', { id: 'blur.gaussian', params: { radius: 2.5, mode: 'b' } });
  assert.deepEqual(ran, ['blur.gaussian', { radius: 2.5, n: 1, mode: 'b', on: false, seed: 5 }]);
  const err = async (input: Record<string, unknown>) => ((await call('run_filter', input)) as { error: string }).error;
  assert.match(await err({ id: 'nope' }), /Unknown filter/);
  assert.match(await err({ id: 'blur.gaussian', params: { radius: 11 } }), /radius must be a number from 0 to 10/);
  assert.match(await err({ id: 'blur.gaussian', params: { n: 1.5 } }), /n must be an integer/);
  assert.match(await err({ id: 'blur.gaussian', params: { mode: 'c' } }), /mode must be one of a, b/);
  assert.match(await err({ id: 'blur.gaussian', params: { on: 1 } }), /on must be true or false/);
  assert.match(await err({ id: 'blur.gaussian', params: { data: 1 } }), /Unknown param data/);

  const none = Object.fromEntries(agentTools({ ...base, filters: () => [spec] }).map(t => [t.name, t]));
  assert.match(((await none.run_filter.execute({ id: 'blur.gaussian' })) as { error: string }).error, /No document/);
});

// Agents such as Codex read the tool list once at start, so photobaer-mcp ships a copy of it.
test('photobaer-mcp ships the current tool list (UPDATE_TOOLS=1 rewrites it)', async () => {
  const file = new URL('../../../mcp/src/tools.ts', import.meta.url);
  const tools = agentTools(base).map(({ execute: _, ...t }) => t);
  if (process.env.UPDATE_TOOLS) await writeFile(file, `// Generated by app/src/app/webmcp.test.ts with UPDATE_TOOLS=1; do not edit.\nexport const PAGE_TOOLS = ${JSON.stringify(tools, null, 2)};\n`);
  assert.deepEqual((await import(file.href)).PAGE_TOOLS, tools);
});

test('get_preview returns the composite as an image within the size bound', async () => {
  let asked = 0;
  const tools = Object.fromEntries(agentTools({
    ...base, doc: () => ({ name: 'a', width: 1, height: 1, depth: 8, resolution: 72, layers: [] }) as never,
    preview: async max => { asked = max; return { mimeType: 'image/png', data: 'AAAA', width: 4, height: 2 }; },
  }).map(t => [t.name, t]));
  assert.deepEqual(await tools.get_preview.execute({}), { image: { mimeType: 'image/png', data: 'AAAA' }, width: 4, height: 2 });
  assert.equal(asked, 1024);
  await tools.get_preview.execute({ maxSide: 300 });
  assert.equal(asked, 300);
  assert.match(((await tools.get_preview.execute({ maxSide: 9000 })) as { error: string }).error, /maxSide/);
});
