import { msg, t } from '@lingui/core/macro';
import { TOOLS, type OptionSchema } from '../shell/tools.ts';
import type { Rgb } from '../shell/color.ts';
import type { BrushPreset } from '../brushes/preset.ts';
import { PAINT_TOOLS } from './helpers.ts';

export const TOOL_PRESET_VERSION = 1 as const;
export const MAX_TOOL_PRESETS = 256;
export const MAX_TOOL_PRESET_NAME = 64;
const MAX_ID = 128;
const MAX_STRING = 1024;
const STORAGE_KEY = 'photobaer.toolPresets';

export interface ToolPresetColors { fg: Rgb; bg: Rgb }
export interface ToolPreset {
  id: string;
  name: string;
  tool: string;
  options: Record<string, number | string | boolean>;
  brushPresetId: string | null;
  colors?: ToolPresetColors;
}
export interface ToolPresetLibrary { version: typeof TOOL_PRESET_VERSION; presets: ToolPreset[] }
export interface ToolPresetStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export type NewToolPreset = Omit<ToolPreset, 'id'>;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const ownTool = (id: string) => Object.hasOwn(TOOLS, id);
const cleanName = (value: string) => {
  const name = value.trim();
  if (!name) throw new Error(t`Tool preset name cannot be empty.`);
  if (name.length > MAX_TOOL_PRESET_NAME) { const max = MAX_TOOL_PRESET_NAME; throw new Error(t`Tool preset name must be ${max} characters or fewer.`); };
  return name;
};
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID && value !== '__proto__' && value !== 'constructor' && value !== 'prototype';
const color = (value: unknown): value is Rgb => Array.isArray(value) && value.length === 3 && value.every(x => Number.isInteger(x) && x >= 0 && x <= 255);
const PAINT_OPTION_EXTRAS: Record<string, OptionSchema> = Object.fromEntries(([
  { id: 'hardness', kind: 'percent', label: msg`Hardness`, default: 100, min: 0, max: 100 },
  { id: 'spacing', kind: 'number', label: msg`Spacing`, default: 25, min: 1, max: 1000 },
  { id: 'roundness', kind: 'percent', label: msg`Roundness`, default: 100, min: 1, max: 100 },
  { id: 'angle', kind: 'number', label: msg`Angle`, default: 0, min: -180, max: 180 },
  { id: 'flipX', kind: 'boolean', label: msg`Flip X`, default: false },
  { id: 'flipY', kind: 'boolean', label: msg`Flip Y`, default: false },
  { id: 'airbrush', kind: 'boolean', label: msg`Build-up`, default: false },
  { id: 'wetEdges', kind: 'boolean', label: msg`Wet Edges`, default: false },
  { id: 'smoothing', kind: 'percent', label: msg`Smoothing`, default: 10, min: 0, max: 100 },
  { id: 'opacity', kind: 'percent', label: msg`Opacity`, default: 100, min: 0, max: 100 },
  { id: 'flow', kind: 'percent', label: msg`Flow`, default: 100, min: 0, max: 100 },
  { id: 'pulledString', kind: 'boolean', label: msg`Pulled String`, default: false },
  { id: 'strokeCatchUp', kind: 'boolean', label: msg`Stroke Catch-up`, default: true },
  { id: 'catchUpOnStrokeEnd', kind: 'boolean', label: msg`Catch-up on Stroke End`, default: false },
  { id: 'adjustForZoom', kind: 'boolean', label: msg`Adjust for Zoom`, default: true },
] satisfies OptionSchema[]).map(schema => [schema.id, schema]));

function validateOption(schema: OptionSchema, value: unknown) {
  const option = schema.id;
  if (schema.kind === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(t`${option} must be a boolean.`);
    return value;
  }
  if (schema.kind === 'number' || schema.kind === 'percent') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(t`${option} must be finite.`);
    if (schema.min !== undefined && value < schema.min || schema.max !== undefined && value > schema.max) throw new Error(t`${option} is outside its allowed range.`);
    return value;
  }
  if (typeof value !== 'string' || value.length > MAX_STRING) throw new Error(t`${option} must be a bounded string.`);
  if ((schema.kind === 'select' || schema.kind === 'segmented') && !schema.choices?.includes(value)) throw new Error(t`${option} has an unsupported choice.`);
  if (schema.kind === 'color' && value !== '' && !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(t`${option} is not a valid color.`);
  return value;
}

function validateOptions(toolId: string, value: unknown): Record<string, number | string | boolean> {
  if (!isRecord(value) || Object.keys(value).length > 64) throw new Error(t`Tool preset options are invalid.`);
  const schemas = new Map(TOOLS[toolId].options.map(option => [option.id, option]));
  if (PAINT_TOOLS.has(toolId)) for (const [id, schema] of Object.entries(PAINT_OPTION_EXTRAS)) if (!schemas.has(id)) schemas.set(id, schema);
  const result: Record<string, number | string | boolean> = {};
  for (const [key, optionValue] of Object.entries(value)) {
    const schema = schemas.get(key);
    if (!schema) throw new Error(t`Unknown tool option: ${key}`);
    result[key] = validateOption(schema, optionValue);
  }
  return result;
}

function validatePreset(value: unknown): ToolPreset {
  if (!isRecord(value) || !validId(value.id) || typeof value.name !== 'string' || value.name !== value.name.trim()) throw new Error(t`Tool preset identity is invalid.`);
  const name = cleanName(value.name);
  if (typeof value.tool !== 'string' || !ownTool(value.tool)) throw new Error(t`Tool preset tool is invalid.`);
  const brushPresetId = value.brushPresetId;
  if (brushPresetId !== null && (!PAINT_TOOLS.has(value.tool) || typeof brushPresetId !== 'string' || !validId(brushPresetId) || brushPresetId.length > MAX_STRING)) throw new Error(t`Tool preset brush identity is invalid.`);
  let colors: ToolPresetColors | undefined;
  if (value.colors !== undefined) {
    if (!isRecord(value.colors) || !color(value.colors.fg) || !color(value.colors.bg)) throw new Error(t`Tool preset colors are invalid.`);
    colors = { fg: [...value.colors.fg], bg: [...value.colors.bg] };
  }
  return { id: value.id, name, tool: value.tool, options: validateOptions(value.tool, value.options), brushPresetId: brushPresetId as string | null, ...(colors ? { colors } : {}) };
}

function validateLibrary(value: unknown): ToolPresetLibrary {
  if (!isRecord(value) || value.version !== TOOL_PRESET_VERSION || !Array.isArray(value.presets) || value.presets.length > MAX_TOOL_PRESETS) throw new Error(t`Tool preset library is invalid.`);
  const presets = value.presets.map(validatePreset), ids = new Set<string>(), names = new Set<string>();
  for (const preset of presets) {
    if (ids.has(preset.id) || names.has(preset.name)) throw new Error(t`Tool preset ids and names must be unique.`);
    ids.add(preset.id); names.add(preset.name);
  }
  return { version: TOOL_PRESET_VERSION, presets };
}

const copy = (library: ToolPresetLibrary): ToolPresetLibrary => structuredClone(library);
const defaultId = () => `tool-${crypto.randomUUID()}`;

export function loadToolPresets(storage: ToolPresetStorage = localStorage): ToolPresetLibrary {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return { version: TOOL_PRESET_VERSION, presets: [] };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(t`The saved tool preset library is not valid JSON.`); }
  return validateLibrary(value);
}

export function saveToolPresets(storage: ToolPresetStorage, library: ToolPresetLibrary): ToolPresetLibrary {
  const valid = validateLibrary(library);
  storage.setItem(STORAGE_KEY, JSON.stringify(valid));
  return valid;
}

export function snapshotToolPreset(name: string, tool: string, options: Record<string, number | string | boolean>, brushPresetId: string | null, colors?: ToolPresetColors): NewToolPreset {
  if (!ownTool(tool)) throw new Error(t`Tool preset tool is invalid.`);
  const { id: _id, ...snapshot } = validatePreset({ id: 'snapshot', name: cleanName(name), tool, options, brushPresetId, ...(colors ? { colors } : {}) });
  return structuredClone(snapshot);
}

export function addToolPreset(library: ToolPresetLibrary, preset: NewToolPreset, id: () => string = defaultId): ToolPresetLibrary {
  const base = validateLibrary(library);
  if (base.presets.length >= MAX_TOOL_PRESETS) { const max = MAX_TOOL_PRESETS; throw new Error(t`Tool preset library is limited to ${max} entries.`); };
  if (base.presets.some(item => item.name === preset.name)) { const name = preset.name; throw new Error(t`A tool preset named "${name}" already exists.`); };
  let nextId = id();
  if (!validId(nextId) || base.presets.some(item => item.id === nextId)) throw new Error(t`The new tool preset id is invalid or already exists.`);
  return { version: TOOL_PRESET_VERSION, presets: [...base.presets, validatePreset({ ...structuredClone(preset), id: nextId })] };
}

export function renameToolPreset(library: ToolPresetLibrary, id: string, value: string): ToolPresetLibrary {
  const base = validateLibrary(library), name = cleanName(value);
  if (!base.presets.some(preset => preset.id === id)) throw new Error(t`Unknown tool preset.`);
  if (base.presets.some(preset => preset.id !== id && preset.name === name)) throw new Error(t`A tool preset named "${name}" already exists.`);
  return { version: TOOL_PRESET_VERSION, presets: base.presets.map(preset => preset.id === id ? { ...preset, name } : preset) };
}

export function deleteToolPreset(library: ToolPresetLibrary, id: string): ToolPresetLibrary {
  const base = validateLibrary(library);
  if (!base.presets.some(preset => preset.id === id)) throw new Error(t`Unknown tool preset.`);
  return { version: TOOL_PRESET_VERSION, presets: base.presets.filter(preset => preset.id !== id) };
}

export function applyToolPreset(preset: ToolPreset): Omit<ToolPreset, 'id' | 'name'> {
  const valid = validatePreset(preset);
  return structuredClone({ tool: valid.tool, options: valid.options, brushPresetId: valid.brushPresetId, ...(valid.colors ? { colors: valid.colors } : {}) });
}

export function exportToolPresets(library: ToolPresetLibrary): string {
  return JSON.stringify(validateLibrary(library), null, 2);
}

export function importToolPresets(library: ToolPresetLibrary, json: string, id: () => string = defaultId): ToolPresetLibrary {
  if (json.length > 1_000_000) throw new Error(t`Tool preset import is too large.`);
  let imported: ToolPresetLibrary;
  try { imported = validateLibrary(JSON.parse(json)); } catch (error) { throw error instanceof SyntaxError ? new Error('Tool preset import is not valid JSON.') : error; }
  let result = validateLibrary(library);
  for (const source of imported.presets) {
    let name = source.name;
    for (let suffix = 2; result.presets.some(preset => preset.name === name); suffix++) {
      const tail = ` (${suffix})`;
      name = `${source.name.slice(0, MAX_TOOL_PRESET_NAME - tail.length)}${tail}`;
    }
    result = addToolPreset(result, { ...source, name }, id);
  }
  return result;
}

export function validateBrushPresetAssets(preset: BrushPreset, source: { tip(id: string): unknown; pattern(id: string): unknown }) {
  const refs: [kind: 'tip' | 'pattern', id: string][] = [];
  if (preset.tip.kind === 'sampled') refs.push(['tip', preset.tip.tipRef]);
  const dual = preset.dynamics.dualBrush;
  if (dual.enabled && dual.tip?.kind === 'sampled') refs.push(['tip', dual.tip.tipRef]);
  const texture = preset.dynamics.texture;
  if (texture.enabled && texture.patternRef !== null) refs.push(['pattern', texture.patternRef]);
  for (const [kind, id] of refs) if (source[kind](id) === undefined) throw new Error(t`Brush ${kind} asset "${id}" is unavailable.`);
}

// Option keys that name a library asset; an empty value means the tool's default.
const OPTION_ASSETS = [['gradient', 'gradient'], ['pattern', 'pattern'], ['customShape', 'shape']] as const;
export function validateToolOptionAssets(options: Record<string, unknown>, source: Record<'gradient' | 'pattern' | 'shape', (id: string) => unknown>) {
  for (const [key, kind] of OPTION_ASSETS) {
    const id = options[key];
    if (typeof id === 'string' && id !== '' && source[kind](id) === undefined) throw new Error(t`The ${kind} "${id}" is unavailable.`);
  }
}
