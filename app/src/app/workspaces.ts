// Window > Workspace state. Built-ins are immutable; custom workspaces are strict snapshots.
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { i18n } from '../i18n/index.ts';

export const PANEL_KEYS = [
  'actions', 'adjustments', 'channels', 'cloneSource', 'navigator', 'layerComps', 'paths', 'properties', 'styles', 'patterns', 'gradients', 'shapes',
  'character', 'paragraph', 'characterStyles', 'paragraphStyles', 'glyphs', 'histogram', 'info', 'toolPresets', 'notes', 'measurementLog',
] as const;
export type WorkspacePanel = typeof PANEL_KEYS[number];
export type WorkspaceDockTab = 'color' | 'swatches' | 'brushSettings' | 'brushes';
// Sidebar sections: 'tabs' is the Color/Swatches/Brush group; layers and history are always shown with a document.
export const DOCK_KEYS = ['tabs', 'layers', 'history', ...PANEL_KEYS] as const;
export type DockKey = typeof DOCK_KEYS[number];
// Default top-to-bottom order of the sidebar sections; the user's order is kept per browser.
export const DOCK_DEFAULT_ORDER: readonly DockKey[] = [
  'tabs', 'adjustments', 'styles', 'patterns', 'gradients', 'cloneSource', 'navigator', 'histogram', 'info', 'notes', 'measurementLog',
  'toolPresets', 'shapes', 'properties', 'character', 'paragraph', 'characterStyles', 'paragraphStyles', 'glyphs',
  'layers', 'history', 'channels', 'layerComps', 'actions', 'paths',
];
export interface DockEntry { height?: number; collapsed?: boolean }
export type DockLayout = Partial<Record<DockKey, DockEntry>>;
export const DOCK_MIN_HEIGHT = 48;
export const DOCK_MAX_HEIGHT = 2000;

export interface WorkspaceSettings extends Record<WorkspacePanel, boolean> {
  dockTab: WorkspaceDockTab;
  dock: DockLayout;
}
export interface NamedWorkspace { name: string; settings: WorkspaceSettings }
export interface WorkspaceState {
  selected: string;
  locked: boolean;
  custom: NamedWorkspace[];
  settings: WorkspaceSettings;
}
export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  actions: false, adjustments: false, channels: false, cloneSource: false, navigator: false, layerComps: false,
  paths: false, properties: false, styles: false, patterns: false, gradients: false, shapes: false, dockTab: 'color',
  character: false, paragraph: false, characterStyles: false, paragraphStyles: false, glyphs: false,
  histogram: false, info: false, toolPresets: false, notes: false, measurementLog: false, dock: {},
};

const preset = (name: string, patch: Partial<WorkspaceSettings> = {}): NamedWorkspace => ({
  name, settings: { ...DEFAULT_WORKSPACE_SETTINGS, ...patch },
});

export const BUILTIN_WORKSPACES: readonly NamedWorkspace[] = [
  preset('Essentials'),
  preset('Photography', { adjustments: true, channels: true, navigator: true, properties: true }),
  preset('Painting', { patterns: true, gradients: true, shapes: true, dockTab: 'brushes' }),
  preset('Motion', { actions: true, properties: true }),
  preset('Graphic and Web', { properties: true, styles: true, patterns: true, gradients: true, shapes: true, character: true, paragraph: true, dockTab: 'swatches' }),
];

// Built-in names are stored keys; only their display text is translated. Custom names show as typed.
const BUILTIN_LABEL: Record<string, MessageDescriptor> = {
  Essentials: msg`Essentials`, Photography: msg`Photography`, Painting: msg`Painting`, Motion: msg`Motion`, 'Graphic and Web': msg`Graphic and Web`,
};
export const workspaceLabel = (name: string) => (Object.hasOwn(BUILTIN_LABEL, name) ? i18n._(BUILTIN_LABEL[name]) : name);

export const MAX_WORKSPACE_NAME = 64;
const STORAGE_KEY = 'photobaer.workspaces';
const DOCK_TABS: readonly WorkspaceDockTab[] = ['color', 'swatches', 'brushSettings', 'brushes'];
const BUILTIN_NAMES = new Set(BUILTIN_WORKSPACES.map(w => w.name));

const copyDock = (dock: DockLayout): DockLayout => Object.fromEntries(Object.entries(dock).map(([k, v]) => [k, { ...v }]));
const copySettings = (settings: WorkspaceSettings): WorkspaceSettings => ({ ...settings, dock: copyDock(settings.dock) });
const clampHeight = (h: number) => Math.round(Math.min(DOCK_MAX_HEIGHT, Math.max(DOCK_MIN_HEIGHT, h)));

function normalizeDock(value: unknown): DockLayout {
  const out: DockLayout = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const record = value as Record<string, unknown>;
  for (const key of DOCK_KEYS) {
    const raw = record[key];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const { height, collapsed } = raw as Record<string, unknown>;
    const entry: DockEntry = {};
    if (typeof height === 'number' && Number.isFinite(height)) entry.height = clampHeight(height);
    if (collapsed === true) entry.collapsed = true;
    if (Object.keys(entry).length) out[key] = entry;
  }
  return out;
}

const withEntry = (dock: DockLayout, key: DockKey, entry: DockEntry): DockLayout => {
  const out = copyDock(dock);
  if (Object.keys(entry).length) out[key] = entry; else delete out[key];
  return out;
};

/** Sets or clears (null) a section's stored height. */
export function resizeDock(dock: DockLayout, key: DockKey, height: number | null): DockLayout {
  const { height: _, ...rest } = dock[key] ?? {};
  return withEntry(dock, key, height === null ? rest : { ...rest, height: clampHeight(height) });
}

export function toggleDock(dock: DockLayout, key: DockKey): DockLayout {
  const { collapsed, ...rest } = dock[key] ?? {};
  return withEntry(dock, key, collapsed ? rest : { ...rest, collapsed: true });
}
const copyWorkspace = (workspace: NamedWorkspace): NamedWorkspace => ({ name: workspace.name, settings: copySettings(workspace.settings) });
const builtIn = (name: string) => BUILTIN_WORKSPACES.find(w => w.name === name);
const customWorkspace = (state: Pick<WorkspaceState, 'custom'>, name: string) => state.custom.find(w => w.name === name);
const named = (state: Pick<WorkspaceState, 'custom'>, name: string) => builtIn(name) ?? customWorkspace(state, name);

const ADDED_PANEL_KEYS = new Set<WorkspacePanel>(['histogram', 'info', 'toolPresets', 'notes', 'measurementLog']);

function normalizeSettings(value: unknown): WorkspaceSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const settings = value as Record<string, unknown>;
  if (!DOCK_TABS.includes(settings.dockTab as WorkspaceDockTab)) return null;
  const out = { dockTab: settings.dockTab, dock: normalizeDock(settings.dock) } as WorkspaceSettings;
  for (const key of PANEL_KEYS) {
    if (settings[key] === undefined && ADDED_PANEL_KEYS.has(key)) out[key] = false;
    else if (typeof settings[key] === 'boolean') out[key] = settings[key];
    else return null;
  }
  return out;
}

function cleanName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error('Workspace name cannot be empty.');
  if (name.length > MAX_WORKSPACE_NAME) throw new Error(`Workspace name must be ${MAX_WORKSPACE_NAME} characters or fewer.`);
  return name;
}

export function loadWorkspaces(storage: WorkspaceStorage = localStorage): WorkspaceState {
  const raw = storage.getItem(STORAGE_KEY);
  let value: unknown;
  try { value = JSON.parse(raw ?? '{}'); } catch { value = {}; }
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const custom: NamedWorkspace[] = [];
  const seen = new Set<string>();
  if (Array.isArray(record.custom)) {
    for (const item of record.custom) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.name !== 'string' || candidate.name !== candidate.name.trim() || !candidate.name || candidate.name.length > MAX_WORKSPACE_NAME) continue;
      const settings = normalizeSettings(candidate.settings);
      if (BUILTIN_NAMES.has(candidate.name) || seen.has(candidate.name) || !settings) continue;
      seen.add(candidate.name);
      custom.push({ name: candidate.name, settings });
    }
  }
  const requested = typeof record.selected === 'string' ? record.selected : 'Essentials';
  const selected = named({ custom }, requested) ? requested : 'Essentials';
  const workspace = named({ custom }, selected)!;
  const settings = normalizeSettings(record.settings) ?? workspace.settings;
  return { selected, locked: typeof record.locked === 'boolean' ? record.locked : false, custom, settings: copySettings(settings) };
}

export function saveWorkspaces(storage: WorkspaceStorage, state: WorkspaceState): WorkspaceState {
  const saved: WorkspaceState = {
    selected: state.selected, locked: state.locked, custom: state.custom.map(copyWorkspace), settings: copySettings(state.settings),
  };
  storage.setItem(STORAGE_KEY, JSON.stringify(saved));
  return saved;
}

export function addWorkspace(state: WorkspaceState, value: string, settings: WorkspaceSettings): WorkspaceState {
  const name = cleanName(value);
  if (BUILTIN_NAMES.has(name)) throw new Error(`Workspace name collides with the built-in workspace "${name}".`);
  const normalized = normalizeSettings(settings);
  if (!normalized) throw new Error('Workspace settings are invalid.');
  const workspace = { name, settings: normalized };
  const found = state.custom.findIndex(w => w.name === name);
  const custom = state.custom.map(copyWorkspace);
  if (found < 0) custom.push(workspace); else custom[found] = workspace;
  return { selected: name, locked: state.locked, custom, settings: copySettings(workspace.settings) };
}

export function deleteWorkspace(state: WorkspaceState, value: string): WorkspaceState {
  const name = cleanName(value);
  if (BUILTIN_NAMES.has(name)) throw new Error('Built-in workspaces cannot be deleted.');
  if (!customWorkspace(state, name)) throw new Error(`Unknown workspace: ${name}`);
  const custom = state.custom.filter(w => w.name !== name).map(copyWorkspace);
  if (state.selected !== name) return { ...state, custom, settings: copySettings(state.settings) };
  return { selected: 'Essentials', locked: state.locked, custom, settings: copySettings(DEFAULT_WORKSPACE_SETTINGS) };
}

export function selectWorkspace(state: WorkspaceState, name: string): WorkspaceState {
  const workspace = named(state, name);
  if (!workspace) throw new Error(`Unknown workspace: ${name}`);
  return { selected: name, locked: state.locked, custom: state.custom.map(copyWorkspace), settings: copySettings(workspace.settings) };
}

export function resetWorkspace(state: WorkspaceState): WorkspaceState {
  const workspace = named(state, state.selected);
  if (!workspace) throw new Error(`Unknown workspace: ${state.selected}`);
  return { ...state, custom: state.custom.map(copyWorkspace), settings: copySettings(workspace.settings) };
}

export function lockWorkspace(state: WorkspaceState, locked: boolean): WorkspaceState {
  return { ...state, locked, custom: state.custom.map(copyWorkspace), settings: copySettings(state.settings) };
}
