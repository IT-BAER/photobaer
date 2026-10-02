// WebMCP (W3C CG draft): exposes document info and the menu commands to in-browser agents.
import type { DocInfo, LayerNode } from '../worker/types.ts';
import type { Item } from './helpers.ts';
import { locate } from '../layers.ts';
import { defaults, visibleParams, type FilterParam, type FilterSpec } from '../filters/schema.ts';
import type { ParamValue } from '../filters/lastFilter.ts';

export interface ToolDef {
  name: string; title: string; description: string; inputSchema: object;
  annotations: { readOnlyHint?: boolean; consequentialHint?: boolean };
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}
export interface ModelContext { registerTool(tool: ToolDef, options: { signal: AbortSignal }): void }
export interface WebMcpCtx {
  // Resolves once the engine has started; calls before that would race its init.
  ready: () => Promise<void>;
  doc: () => DocInfo | null;
  active: () => number | null;
  selectLayer: (id: number) => void;
  menus: () => Record<string, Item[]>;
  newDocument: (width: number, height: number) => Promise<unknown>;
  filters: () => FilterSpec[];
  // Applies a filter to the active layer; rejects with the engine's message.
  runFilter: (id: string, params: Record<string, ParamValue>) => Promise<unknown>;
  // The flattened document scaled to fit maxSide, base64-encoded.
  preview: (maxSide: number) => Promise<{ mimeType: string; data: string; width: number; height: number }>;
}
type Layer = { id: number; name: string; kind: LayerNode['kind']; visible: boolean; children?: Layer[] };
type Command = { path: string; enabled: boolean; checked?: true; item: Item };

const SEP = ' > ';
const MAX_SIDE = 65536;
const CHECK = '✓ ';

function layerTree(nodes: LayerNode[]): Layer[] {
  return nodes.map(n => ({ id: n.id, name: n.name, kind: n.kind, visible: n.visible, ...(n.children ? { children: layerTree(n.children) } : {}) }));
}
function summary(ctx: WebMcpCtx) {
  const d = ctx.doc();
  return d && { name: d.name, width: d.width, height: d.height, depth: d.depth, resolution: d.resolution, activeLayer: ctx.active(), layers: layerTree(d.layers) };
}

// Toggle items carry a leading checkmark in their label; the path drops it so it stays stable.
function leaves(items: Item[], prefix: string, off = false): Command[] {
  return items.flatMap(i => {
    const checked = i.label.startsWith(CHECK), path = prefix + (checked ? i.label.slice(CHECK.length) : i.label), disabled = off || !!i.off;
    return i.sub ? leaves(i.sub, path + SEP, disabled) : [{ path, enabled: !disabled, ...(checked ? { checked: true as const } : {}), item: i }];
  });
}
const commands = (ctx: WebMcpCtx) => Object.entries(ctx.menus()).flatMap(([menu, items]) => leaves(items, menu + SEP));

function side(v: unknown, name: string, min = 1, max = MAX_SIDE) {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return v as number;
}

// Agents set the visible params; seeds and blobs keep their defaults.
function filterInfo(s: FilterSpec) {
  return {
    id: s.id, label: s.label, group: s.group,
    params: visibleParams(s).map(p => {
      const range = p.kind === 'select' ? { choices: p.choices } : p.kind === 'bool' ? {} : { min: p.min, max: p.max, ...(p.unit ? { unit: p.unit } : {}) };
      return { key: p.key, kind: p.kind, ...range, default: p.default };
    }),
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function checkParam(p: FilterParam, v: unknown): ParamValue {
  const ok = (cond: boolean, what: string) => { if (!cond) throw new Error(`${p.key} must be ${what}`); return v as ParamValue; };
  switch (p.kind) {
    case 'select': return ok(typeof v === 'string' && !!p.choices?.includes(v), `one of ${p.choices?.join(', ')}`);
    case 'bool': return ok(typeof v === 'boolean', 'true or false');
    case 'int': return ok(Number.isInteger(v) && (v as number) >= p.min && (v as number) <= p.max, `an integer from ${p.min} to ${p.max}`);
    case 'point': return ok(!!v && isNum((v as { x: unknown }).x) && isNum((v as { y: unknown }).y), 'an object {x, y} of numbers');
    case 'kernel': return ok(Array.isArray(v) && v.length === 25 && v.every(isNum), 'an array of 25 numbers');
    case 'curve': return ok(Array.isArray(v) && v.every(c => isNum(c?.y) && isNum(c?.offset)), 'an array of {y, offset} numbers');
    case 'path': return ok(Array.isArray(v) && v.every(c => isNum(c?.x) && isNum(c?.y)), 'an array of {x, y} numbers from 0 to 1');
    case 'paths': return ok(Array.isArray(v) && v.length > 0 && v.every(q => Array.isArray(q) && q.length >= 2 && q.every(c => isNum(c?.x) && isNum(c?.y))), 'an array of paths, each an array of 2 or more {x, y} numbers from 0 to 1');
    case 'pins': return ok(Array.isArray(v) && v.length > 0 && v.every(c => isNum(c?.x) && isNum(c?.y) && isNum(c?.blur)), 'an array of {x, y, blur} numbers (x, y from 0 to 1, blur in px)');
    case 'stack': return ok(Array.isArray(v) && v.every(l => typeof l?.kind === 'string' && typeof l?.enabled === 'boolean' && !!l?.params && typeof l.params === 'object'), 'an array of {kind, enabled, params} effect layers (kinds from list_filters, group gallery.*)');
    case 'lights': return ok(Array.isArray(v) && v.every(l => !!l && typeof l === 'object'), 'an array of light objects');
    default: return ok(isNum(v) && v >= p.min && v <= p.max, `a number from ${p.min} to ${p.max}`);
  }
}
function filterParams(s: FilterSpec, input: unknown) {
  const out = defaults(s), byKey = new Map(visibleParams(s).map(p => [p.key, p]));
  for (const [k, v] of Object.entries(input && typeof input === 'object' ? input : {})) {
    const p = byKey.get(k);
    if (!p) throw new Error(`Unknown param ${k}. Valid params: ${[...byKey.keys()].join(', ') || 'none'}`);
    out[k] = checkParam(p, v);
  }
  return out;
}

// State setters render on a scheduler task; a timer task after it reads the committed active layer.
const settle = () => new Promise(r => setTimeout(r, 0));

// Chrome forwards a thrown error only as an exception object that agent bridges drop, so errors are returned as output.
const safe = (ready: WebMcpCtx['ready'], f: ToolDef['execute']): ToolDef['execute'] => async input => {
  try { await ready(); return await f(input); } catch (e) { return { error: (e as Error).message }; }
};

const needDoc = (ctx: WebMcpCtx) => { if (!ctx.doc() || ctx.active() === null) throw new Error('No document is open. Use new_document or open a file first.'); };

// The tools shared by WebMCP and the agent bridge; execute never throws, errors come back as { error }.
export function agentTools(ctx: WebMcpCtx): ToolDef[] {
  const tools: ToolDef[] = [
    {
      name: 'get_document', title: 'Get document',
      description: 'Returns the open document: name, size in pixels, bit depth, resolution, the active layer id and the layer tree (top layer last). Returns null when no document is open.',
      inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true },
      execute: async () => summary(ctx),
    },
    {
      name: 'list_commands', title: 'List menu commands',
      description: `Lists menu commands as paths like "Image${SEP}Adjustments${SEP}Invert", whether each is enabled now, and checked: true for active toggles. Pass query to filter by a case-insensitive substring of the path.`,
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true },
      execute: async ({ query }) => {
        const q = typeof query === 'string' ? query.toLowerCase() : '';
        return commands(ctx).filter(c => c.path.toLowerCase().includes(q)).map(({ item: _, ...c }) => c);
      },
    },
    {
      name: 'run_command', title: 'Run menu command',
      description: 'Runs one enabled menu command by its path from list_commands on the active layer and returns the updated document. '
        + 'Commands ending in "…" open a dialog in the page: fill and confirm it with your browser tools, or ask the user to.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      annotations: { consequentialHint: true },
      execute: async ({ path }) => {
        const c = commands(ctx).find(c => c.path === path);
        if (!c) throw new Error(`Unknown command: ${String(path)}. Use list_commands to find the exact path.`);
        if (!c.enabled) throw new Error(`Command is disabled: ${c.path}`);
        await c.item.run();
        await settle();
        return { ran: c.path, document: summary(ctx) };
      },
    },
    {
      name: 'select_layer', title: 'Select layer',
      description: 'Makes the layer with this id (from get_document) the active layer that commands act on.',
      inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      annotations: {},
      execute: async ({ id }) => {
        const d = ctx.doc();
        if (!d || typeof id !== 'number' || !locate(d.layers, id)) throw new Error(`No layer with id ${String(id)}`);
        ctx.selectLayer(id);
        return { activeLayer: id };
      },
    },
    {
      name: 'new_document', title: 'New document',
      description: 'Creates a new 8-bit RGB document with a white background, in pixels.',
      inputSchema: {
        type: 'object', required: ['width', 'height'],
        properties: { width: { type: 'integer', minimum: 1, maximum: MAX_SIDE }, height: { type: 'integer', minimum: 1, maximum: MAX_SIDE } },
      },
      annotations: { consequentialHint: true },
      execute: async ({ width, height }) => {
        await ctx.newDocument(side(width, 'width'), side(height, 'height'));
        await settle();
        return summary(ctx);
      },
    },
    {
      name: 'list_filters', title: 'List filters',
      description: 'Lists filters with their id and settable params (kind, range or choices, default). Pass query to filter by a case-insensitive substring of the id, label or group.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true },
      execute: async ({ query }) => {
        const q = typeof query === 'string' ? query.toLowerCase() : '';
        return ctx.filters().filter(s => `${s.id} ${s.label} ${s.group}`.toLowerCase().includes(q)).map(filterInfo);
      },
    },
    {
      name: 'run_filter', title: 'Run filter',
      description: 'Applies a filter by id (from list_filters) to the active layer without opening a dialog. Params not given keep their defaults. Returns the updated document.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, params: { type: 'object' } }, required: ['id'] },
      annotations: { consequentialHint: true },
      execute: async ({ id, params }) => {
        const s = ctx.filters().find(s => s.id === id);
        if (!s) throw new Error(`Unknown filter: ${String(id)}. Use list_filters to find the id.`);
        const p = filterParams(s, params);
        needDoc(ctx);
        await ctx.runFilter(s.id, p);
        await settle();
        return { ran: s.id, document: summary(ctx) };
      },
    },
    {
      name: 'get_preview', title: 'Get preview',
      description: 'Returns the flattened document as a PNG image, scaled to fit maxSide pixels (default 1024), so you can see the result.',
      inputSchema: { type: 'object', properties: { maxSide: { type: 'integer', minimum: 64, maximum: 4096 } } }, annotations: { readOnlyHint: true },
      execute: async ({ maxSide }) => {
        const max = maxSide === undefined ? 1024 : side(maxSide, 'maxSide', 64, 4096);
        if (!ctx.doc()) throw new Error('No document is open.');
        const { mimeType, data, width, height } = await ctx.preview(max);
        return { image: { mimeType, data }, width, height };
      },
    },
  ];
  return tools.map(t => ({ ...t, execute: safe(ctx.ready, t.execute) }));
}

// Returns false when the browser has no model context; the signal unregisters every tool.
export function registerWebMcp(mc: ModelContext | undefined, ctx: WebMcpCtx, signal: AbortSignal): boolean {
  if (!mc) return false;
  for (const t of agentTools(ctx)) mc.registerTool(t, { signal });
  return true;
}
