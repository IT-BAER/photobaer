import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_WORKSPACES, DEFAULT_WORKSPACE_SETTINGS, addWorkspace, deleteWorkspace, loadWorkspaces, lockWorkspace,
  DOCK_MAX_HEIGHT, DOCK_MIN_HEIGHT, resetWorkspace, resizeDock, saveWorkspaces, selectWorkspace, toggleDock, type WorkspaceSettings, type WorkspaceStorage,
} from './workspaces.ts';

const storage = (initial: string | null = null): WorkspaceStorage & { value: string | null } => ({
  value: initial,
  getItem() { return this.value; },
  setItem(_key, value) { this.value = value; },
});

const changed = (patch: Partial<WorkspaceSettings> = {}): WorkspaceSettings => ({
  ...DEFAULT_WORKSPACE_SETTINGS, actions: true, dockTab: 'brushes', ...patch,
});

test('built-in workspaces load with the App defaults and select their snapshots', () => {
  const s = loadWorkspaces(storage());
  assert.deepEqual(BUILTIN_WORKSPACES.map(w => w.name), ['Essentials', 'Photography', 'Painting', 'Motion', 'Graphic and Web']);
  assert.equal(s.selected, 'Essentials');
  assert.equal(s.locked, false);
  assert.deepEqual(s.settings, DEFAULT_WORKSPACE_SETTINGS);
  const painting = selectWorkspace(s, 'Painting');
  assert.equal(painting.selected, 'Painting');
  assert.equal(painting.settings.dockTab, 'brushes');
  assert.notEqual(painting.settings, BUILTIN_WORKSPACES[2].settings, 'selection returns an independent snapshot');
  const graphic = selectWorkspace(s, 'Graphic and Web');
  assert.equal(graphic.settings.character, true);
  assert.equal(graphic.settings.paragraph, true);
});

test('custom workspaces save, replace, select, delete, and survive storage', () => {
  let s = loadWorkspaces(storage());
  s = addWorkspace(s, '  Retouch  ', changed());
  assert.equal(s.selected, 'Retouch');
  assert.deepEqual(s.custom, [{ name: 'Retouch', settings: changed() }]);
  s = addWorkspace(s, 'Retouch', changed({ navigator: true }));
  assert.equal(s.custom.length, 1);
  assert.equal(s.settings.navigator, true);

  const mem = storage();
  saveWorkspaces(mem, lockWorkspace(s, true));
  const loaded = loadWorkspaces(mem);
  assert.equal(loaded.selected, 'Retouch');
  assert.equal(loaded.locked, true);
  assert.equal(loaded.settings.navigator, true);

  const removed = deleteWorkspace(loaded, 'Retouch');
  assert.equal(removed.selected, 'Essentials');
  assert.deepEqual(removed.custom, []);
  assert.deepEqual(removed.settings, DEFAULT_WORKSPACE_SETTINGS);
});

test('current layout persists separately and select or reset restores the named snapshot', () => {
  const named = addWorkspace(loadWorkspaces(storage()), 'Retouch', changed({ paths: true, glyphs: true }));
  const current = { ...named, settings: { ...named.settings, paths: false, navigator: true, glyphs: false, characterStyles: true } };
  const mem = storage();
  saveWorkspaces(mem, current);
  const loaded = loadWorkspaces(mem);
  assert.equal(loaded.settings.paths, false);
  assert.equal(loaded.settings.navigator, true);
  assert.equal(loaded.settings.glyphs, false);
  assert.equal(loaded.settings.characterStyles, true);
  assert.deepEqual(selectWorkspace(loaded, 'Retouch').settings, named.settings);
  assert.deepEqual(resetWorkspace(loaded).settings, named.settings);
});

test('storage write failures propagate to the caller', () => {
  const broken: WorkspaceStorage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  assert.throws(() => saveWorkspaces(broken, loadWorkspaces(storage())), /quota/);
});

test('storage read and accessor failures propagate without creating an empty saved library', () => {
  const broken: WorkspaceStorage = { getItem: () => { throw new Error('read denied'); }, setItem: () => assert.fail('must not write') };
  assert.throws(() => loadWorkspaces(broken), /read denied/);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('storage accessor denied'); } });
  try { assert.throws(() => loadWorkspaces(), /storage accessor denied/); }
  finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('names are bounded, nonempty, and cannot collide with built-ins', () => {
  const s = loadWorkspaces(storage());
  assert.throws(() => addWorkspace(s, '   ', changed()), /name/i);
  assert.throws(() => addWorkspace(s, 'Essentials', changed()), /built-in/i);
  assert.throws(() => addWorkspace(s, 'x'.repeat(65), changed()), /64/);
  assert.throws(() => selectWorkspace(s, 'constructor'), /workspace/i);
  assert.throws(() => deleteWorkspace(s, 'Photography'), /built-in/i);
});

test('malformed stored values are dropped and invalid selection and lock fall back', () => {
  const valid = { name: 'Valid', settings: changed({ paths: true }) };
  const raw = JSON.stringify({
    selected: 'constructor', locked: 'yes', custom: [valid, valid, { name: 'Essentials', settings: changed() }, { name: 'Bad', settings: { actions: true } }, null],
  });
  const s = loadWorkspaces(storage(raw));
  assert.equal(s.selected, 'Essentials');
  assert.equal(s.locked, false);
  assert.deepEqual(s.custom, [valid]);
  assert.deepEqual(s.settings, DEFAULT_WORKSPACE_SETTINGS);
  assert.deepEqual(loadWorkspaces(storage('{broken')), loadWorkspaces(storage()));
});

test('reset restores a built-in preset and lock changes only the lock', () => {
  const selected = selectWorkspace(loadWorkspaces(storage()), 'Photography');
  const edited = { ...selected, settings: changed() };
  const reset = resetWorkspace(edited);
  assert.deepEqual(reset.settings, BUILTIN_WORKSPACES[1].settings);
  assert.deepEqual(lockWorkspace(reset, true), { ...reset, locked: true });
});

test('legacy saved and custom workspaces gain new inspection panels without losing prior state', () => {
  const legacy = changed({ navigator: true }) as unknown as Record<string, unknown>;
  delete legacy.histogram; delete legacy.info; delete legacy.toolPresets;
  const raw = JSON.stringify({ selected: 'Legacy', locked: true, settings: legacy, custom: [{ name: 'Legacy', settings: legacy }] });
  const loaded = loadWorkspaces(storage(raw));
  assert.equal(loaded.selected, 'Legacy');
  assert.equal(loaded.locked, true);
  assert.equal(loaded.custom[0].settings.navigator, true);
  assert.deepEqual([loaded.settings.histogram, loaded.settings.info, loaded.settings.toolPresets], [false, false, false]);
  assert.deepEqual([loaded.custom[0].settings.histogram, loaded.custom[0].settings.info, loaded.custom[0].settings.toolPresets], [false, false, false]);
  const invalid = JSON.parse(raw);
  invalid.custom[0].settings.info = 'yes';
  assert.deepEqual(loadWorkspaces(storage(JSON.stringify(invalid))).custom, []);
});

test('dock layout loads empty for legacy data, normalizes bad entries, and round-trips per workspace', () => {
  const legacy = changed() as unknown as Record<string, unknown>;
  delete legacy.dock;
  assert.deepEqual(loadWorkspaces(storage(JSON.stringify({ settings: legacy }))).settings.dock, {});
  const raw = JSON.stringify({ settings: { ...changed(), dock: {
    layers: { height: 300, collapsed: true }, history: { height: 5 }, properties: { height: 99999, collapsed: 'no' }, bogus: { height: 100 }, color: 'x',
  } } });
  assert.deepEqual(loadWorkspaces(storage(raw)).settings.dock, {
    layers: { height: 300, collapsed: true }, history: { height: DOCK_MIN_HEIGHT }, properties: { height: DOCK_MAX_HEIGHT },
  });
  let s = addWorkspace(loadWorkspaces(storage()), 'Docked', changed({ dock: { history: { height: 180 }, adjustments: { collapsed: true } } }));
  const current = { ...s, settings: { ...s.settings, dock: resizeDock(s.settings.dock, 'history', 240) } };
  const mem = storage();
  saveWorkspaces(mem, current);
  s = loadWorkspaces(mem);
  assert.deepEqual(s.settings.dock, { history: { height: 240 }, adjustments: { collapsed: true } });
  assert.deepEqual(resetWorkspace(s).settings.dock, { history: { height: 180 }, adjustments: { collapsed: true } });
  assert.deepEqual(selectWorkspace(s, 'Essentials').settings.dock, {});
});

test('dock helpers are pure, clamp, toggle, and clear', () => {
  const dock = { history: { height: 200 } };
  const resized = resizeDock(dock, 'history', 10);
  assert.deepEqual(resized, { history: { height: DOCK_MIN_HEIGHT } });
  assert.deepEqual(dock, { history: { height: 200 } });
  assert.deepEqual(toggleDock(dock, 'history'), { history: { height: 200, collapsed: true } });
  assert.deepEqual(toggleDock(toggleDock(dock, 'tabs'), 'tabs'), { history: { height: 200 } });
  assert.deepEqual(resizeDock(dock, 'history', null), {});
  const state = addWorkspace(loadWorkspaces(storage()), 'D', changed({ dock }));
  selectWorkspace(state, 'D').settings.dock.history!.height = 1;
  assert.equal(selectWorkspace(state, 'D').settings.dock.history!.height, 200, 'snapshots copy the dock deeply');
});
