// Window > Workspace state. Built-ins are immutable; custom workspaces are strict snapshots.

export const PANEL_KEYS = [
  'actions', 'adjustments', 'channels', 'cloneSource', 'navigator', 'layerComps', 'paths', 'properties', 'styles', 'patterns', 'gradients', 'shapes',
  'character', 'paragraph', 'characterStyles', 'paragraphStyles', 'glyphs', 'histogram', 'info', 'toolPresets', 'notes', 'measurementLog',
] as const;
export type WorkspacePanel = typeof PANEL_KEYS[number];
export type WorkspaceDockTab = 'color' | 'swatches' | 'brushSettings' | 'brushes';

export interface WorkspaceSettings extends Record<WorkspacePanel, boolean> {
  dockTab: WorkspaceDockTab;
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
  histogram: false, info: false, toolPresets: false, notes: false, measurementLog: false,
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

export const MAX_WORKSPACE_NAME = 64;
const STORAGE_KEY = 'photobaer.workspaces';
const DOCK_TABS: readonly WorkspaceDockTab[] = ['color', 'swatches', 'brushSettings', 'brushes'];
const BUILTIN_NAMES = new Set(BUILTIN_WORKSPACES.map(w => w.name));

const copySettings = (settings: WorkspaceSettings): WorkspaceSettings => ({ ...settings });
const copyWorkspace = (workspace: NamedWorkspace): NamedWorkspace => ({ name: workspace.name, settings: copySettings(workspace.settings) });
const builtIn = (name: string) => BUILTIN_WORKSPACES.find(w => w.name === name);
const customWorkspace = (state: Pick<WorkspaceState, 'custom'>, name: string) => state.custom.find(w => w.name === name);
const named = (state: Pick<WorkspaceState, 'custom'>, name: string) => builtIn(name) ?? customWorkspace(state, name);

const ADDED_PANEL_KEYS = new Set<WorkspacePanel>(['histogram', 'info', 'toolPresets', 'notes', 'measurementLog']);

function normalizeSettings(value: unknown): WorkspaceSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const settings = value as Record<string, unknown>;
  if (!DOCK_TABS.includes(settings.dockTab as WorkspaceDockTab)) return null;
  const out = { dockTab: settings.dockTab } as WorkspaceSettings;
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
