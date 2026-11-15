// Actions panel state: sets of recorded actions, the selection and the recording target, kept in IndexedDB.
import { t } from '@lingui/core/macro';
import '../i18n/index.ts'; // activates English before `t` runs outside the app (node tests)
import { ACTION_KEY, CONDITIONS, fromJson, stepFields, toJson, type Action, type ActionSet, type ActionStep, type Conditional } from '../actions.ts';

export interface Selection { set?: string; action?: string; step?: string }

const DB = 'photobaer-actions', STORE = 'sets', KEY = 'all';
function idb<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined);
  return new Promise((res, rej) => {
    const o = indexedDB.open(DB, 1);
    o.onupgradeneeded = () => o.result.createObjectStore(STORE);
    o.onerror = () => rej(o.error);
    o.onsuccess = () => {
      const d = o.result, r = f(d.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => { res(r.result as T); d.close(); };
      r.onerror = () => { rej(r.error); d.close(); };
    };
  });
}

const uid = () => crypto.randomUUID();
const actionName = (v: unknown) => v === null || typeof v === 'string';
const validCond = (c: Conditional | undefined): c is Conditional =>
  !!c && (CONDITIONS as readonly string[]).includes(c.if) && actionName(c.then) && actionName(c.else) && (c.then !== null || c.else !== null);
const isObject = <T>(v: T): v is NonNullable<T> => typeof v === 'object' && v !== null;

// A set read from a file, with new ids and only the parts photobaer knows; null when it is not a set.
export function cleanSet(set: ActionSet | undefined): ActionSet | null {
  if (!set || typeof set.name !== 'string' || !Array.isArray(set.actions)) return null;
  return {
    id: uid(), name: set.name,
    actions: set.actions.filter(isObject).map(a => ({
      id: uid(), name: String(a.name),
      ...(typeof a.key === 'string' && ACTION_KEY.test(a.key) ? { key: a.key } : {}),
      steps: (Array.isArray(a.steps) ? a.steps : []).filter(isObject).map(s => ({
        id: uid(), label: String(s.label), enabled: s.enabled !== false, calls: Array.isArray(s.calls) ? s.calls.filter(c => typeof c?.op === 'string' && Array.isArray(c.args)) : [],
        ...(s.stop ? { stop: { message: String(s.stop.message), allowContinue: !!s.stop.allowContinue } } : {}),
        ...(typeof s.dialog === 'boolean' ? { dialog: s.dialog } : {}),
        ...(Array.isArray(s.menu?.path) && s.menu.path.length && s.menu.path.every(p => typeof p === 'string') ? { menu: { path: [...s.menu.path] } } : {}),
        ...(validCond(s.cond) ? { cond: { if: s.cond.if, then: s.cond.then, else: s.cond.else } } : {}),
      })),
    })),
  };
}
// One exported set file: `{ photobaerActions: 1, set }` as toJson text.
const FILE_TAG = 'photobaerActions';

export class ActionsStore {
  sets: ActionSet[] = [];
  sel: Selection = {};
  recording: { set: string; action: string } | null = null;
  buttonMode = false;
  // Expanded sets and actions in the tree.
  open = new Set<string>();
  #version = 0;
  #listeners = new Set<() => void>();

  subscribe = (f: () => void) => { this.#listeners.add(f); return () => { this.#listeners.delete(f); }; };
  version = () => this.#version;
  #emit(save = true) {
    this.#version++;
    for (const f of this.#listeners) f();
    if (save) void idb('readwrite', s => s.put(toJson(this.sets), KEY)).catch(() => {});
  }

  async load() {
    const s = await idb<string>('readonly', st => st.get(KEY)).catch(() => undefined);
    if (s && !this.sets.length) { this.sets = fromJson<ActionSet[]>(s); this.#emit(false); }
  }

  get set() { return this.sets.find(s => s.id === this.sel.set); }
  get action(): Action | undefined { return this.set?.actions.find(a => a.id === this.sel.action); }

  select(sel: Selection) { this.sel = sel; this.#emit(false); }
  setButtonMode(on: boolean) { this.buttonMode = on; this.#emit(false); }
  toggleOpen(id: string) { if (this.open.has(id)) this.open.delete(id); else this.open.add(id); this.#emit(false); }

  newSet(name: string) {
    const set: ActionSet = { id: uid(), name, actions: [] };
    this.sets = [...this.sets, set];
    this.sel = { set: set.id };
    this.open.add(set.id);
    this.#emit();
    return set;
  }

  #nextSetName() { const next = this.sets.length + 1; return t`Set ${next}`; }

  // In the selected set, or a new "Set 1" when there is none.
  newAction(name: string) {
    const set = this.set ?? this.newSet(this.#nextSetName());
    const action: Action = { id: uid(), name, steps: [] };
    set.actions = [...set.actions, action];
    this.sel = { set: set.id, action: action.id };
    this.open.add(set.id).add(action.id);
    this.#emit();
    return action;
  }

  startRecording() {
    const a = this.action;
    if (!a) throw new Error(t`Select an action to record into.`);
    this.recording = { set: this.sel.set!, action: a.id };
    this.#emit(false);
  }
  stopRecording() { this.recording = null; this.#emit(false); }

  // A recorded step goes after the selected step of the recording action, else at its end.
  #insert(step: ActionStep, actionId: string) {
    const a = this.sets.flatMap(s => s.actions).find(x => x.id === actionId);
    if (!a) return;
    const i = this.sel.action === actionId && this.sel.step ? a.steps.findIndex(s => s.id === this.sel.step) : -1;
    const at = i >= 0 ? i + 1 : a.steps.length;
    a.steps = [...a.steps.slice(0, at), step, ...a.steps.slice(at)];
    if (this.sel.action === actionId && this.sel.step) this.sel = { ...this.sel, step: step.id };
    this.#emit();
  }
  addStep(step: ActionStep) { if (this.recording) this.#insert(step, this.recording.action); }
  insertStop(message: string, allowContinue: boolean) {
    const a = this.action;
    if (!a) throw new Error(t`Select an action first.`);
    this.#insert({ id: uid(), label: 'Stop', enabled: true, calls: [], stop: { message, allowContinue } }, a.id);
  }
  // A menu item by the English ids of its menu path, e.g. ["Image", "Image Size…"].
  insertMenuItem(path: string[]) {
    const a = this.action;
    if (!a) throw new Error(t`Select an action first.`);
    this.#insert({ id: uid(), label: 'Menu Item', enabled: true, calls: [], menu: { path } }, a.id);
  }
  // A new conditional step, or new settings for the conditional step `stepId`.
  insertConditional(cond: Conditional, stepId?: string) {
    const a = this.action;
    if (!a) throw new Error(t`Select an action first.`);
    if (cond.then === null && cond.else === null) throw new Error(t`Choose an action for Then or Else.`);
    const old = stepId ? a.steps.find(s => s.id === stepId && s.cond) : undefined;
    if (old) { old.cond = cond; this.#emit(); return; }
    this.#insert({ id: uid(), label: 'Conditional', enabled: true, calls: [], cond }, a.id);
  }

  toggleStep(stepId: string) {
    for (const s of this.sets) for (const a of s.actions) for (const st of a.steps) if (st.id === stepId) st.enabled = !st.enabled;
    this.#emit();
  }
  toggleAction(actionId: string) {
    const a = this.sets.flatMap(s => s.actions).find(x => x.id === actionId);
    if (!a) return;
    const on = !a.steps.every(s => s.enabled);
    for (const st of a.steps) st.enabled = on;
    this.#emit();
  }
  // Dialog toggles exist only on steps with dialog values; the action's toggle sets all of them.
  toggleDialog(stepId: string) {
    for (const s of this.sets) for (const a of s.actions) for (const st of a.steps) if (st.id === stepId && stepFields(st).length) st.dialog = !st.dialog;
    this.#emit();
  }
  toggleActionDialogs(actionId: string) {
    const steps = this.sets.flatMap(s => s.actions).find(x => x.id === actionId)?.steps.filter(st => stepFields(st).length) ?? [];
    const on = !steps.every(st => st.dialog);
    for (const st of steps) st.dialog = on;
    this.#emit();
  }

  // Action Options: a function key belongs to one action, so assigning it takes it from the action that had it.
  setActionOptions(actionId: string, o: { name: string; key: string | null }) {
    if (o.key !== null && !ACTION_KEY.test(o.key)) throw new Error(t`Choose a function key from F2 to F12.`);
    const all = this.sets.flatMap(s => s.actions), a = all.find(x => x.id === actionId);
    if (!a) return;
    for (const x of all) if (o.key && x.key === o.key) delete x.key;
    a.name = o.name;
    if (o.key) a.key = o.key; else delete a.key;
    this.#emit();
  }
  byKey(key: string): { set: ActionSet; action: Action } | undefined {
    for (const set of this.sets) for (const action of set.actions) if (action.key === key) return { set, action };
  }

  rename(id: string, name: string) {
    for (const s of this.sets) { if (s.id === id) s.name = name; for (const a of s.actions) if (a.id === id) a.name = name; }
    this.#emit();
  }

  // Deletes the selected step, else action, else set.
  deleteSelected() {
    const { set, action, step } = this.sel;
    if (this.recording && (this.recording.action === action || (!action && this.recording.set === set))) throw new Error(t`Stop recording first.`);
    const s = this.set, a = this.action;
    if (step && a) { a.steps = a.steps.filter(x => x.id !== step); this.sel = { set, action }; }
    else if (action && s) { s.actions = s.actions.filter(x => x.id !== action); this.sel = { set }; }
    else if (set) { this.sets = this.sets.filter(x => x.id !== set); this.sel = {}; }
    this.#emit();
  }

  // Steps to play: the enabled ones of the selected action, from the selected step on.
  playable(): ActionStep[] {
    const a = this.action;
    if (!a) return [];
    const from = this.sel.step ? Math.max(0, a.steps.findIndex(s => s.id === this.sel.step)) : 0;
    return a.steps.slice(from).filter(s => s.enabled);
  }

  exportSet(setId: string): string {
    const set = this.sets.find(s => s.id === setId);
    if (!set) throw new Error(t`Select a set to save.`);
    return toJson({ [FILE_TAG]: 1, set });
  }

  // A loaded set gets new ids, so loading the same file twice keeps both copies apart.
  importSet(text: string) {
    let v: { [FILE_TAG]?: number; set?: ActionSet };
    try { v = fromJson(text); } catch { throw new Error(t`This is not a photobaer actions file.`); }
    const fresh = v?.[FILE_TAG] === 1 ? cleanSet(v.set) : null;
    if (!fresh) throw new Error(t`This is not a photobaer actions file.`);
    // A loaded key that another action already has stays with that action.
    for (const a of fresh.actions) if (a.key && this.byKey(a.key)) delete a.key;
    this.sets = [...this.sets, fresh];
    this.sel = { set: fresh.id };
    this.#emit();
    return fresh;
  }
}

export const actions = new ActionsStore();
if (typeof indexedDB !== 'undefined') void actions.load();
