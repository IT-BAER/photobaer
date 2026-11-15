// Actions panel dialogs: the values of a step whose dialog is on (shown while the action plays), Action Options,
// Insert Menu Item and Insert Conditional.
import { useImperativeHandle, useRef, useState, type Ref, type RefObject } from 'react';
import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { ACTION_FKEYS, CONDITIONS, stepFields, withFields, type ActionStep, type Condition, type Conditional, type Field } from './actions.ts';
import { actions } from './app/actionsStore.ts';
import { i18n } from './i18n/index.ts';
import { historyLabel } from './i18n/history.ts';
import { keysLabel } from './i18n/keys.ts';

export const CONDITION_LABEL: Record<Condition, MessageDescriptor> = {
  landscape: msg`Document Is Landscape`, square: msg`Document Is Square`, rgb: msg`Document Is RGB Mode`, cmyk: msg`Document Is CMYK Mode`,
  gray: msg`Document Is Grayscale Mode`, lab: msg`Document Is Lab Mode`, layers: msg`Document Has Layers`, selection: msg`Document Has Selection`,
  background: msg`Layer Is Background`, visible: msg`Layer Is Visible`, pixelMask: msg`Layer Has Pixel Mask`, vectorMask: msg`Layer Has Vector Mask`,
  effects: msg`Layer Has Effects`, pixel: msg`Layer Is Pixel Layer`, text: msg`Layer Is Type Layer`, shape: msg`Layer Is Shape Layer`,
  smart: msg`Layer Is Smart Object`, adjustment: msg`Layer Is Adjustment Layer`, fill: msg`Layer Is Fill Layer`, group: msg`Layer Is Group`,
};

// The text of a conditional step in the Actions panel.
export function conditionalText(c: Conditional) {
  const cond = i18n._(CONDITION_LABEL[c.if]), none = t({ message: 'None', context: 'action' });
  const then = c.then ?? none, otherwise = c.else ?? none;
  return t`If ${cond} Then Play Action “${then}” Else Play Action “${otherwise}”`;
}

export type MenuCapture = RefObject<((path: string[]) => void) | null>;
export interface InsertMenuItemHandle { open(): void }

// Insert Menu Item: while the dialog is open, a click on a menu item records it instead of running it.
export function InsertMenuItemDialog({ ref, capture, menuText, setError }: { ref: Ref<InsertMenuItemHandle>; capture: MenuCapture; menuText: (path: string[]) => string; setError: (e: string | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState<string[] | null>(null);
  useImperativeHandle(ref, () => ({
    open() {
      setPath(null);
      capture.current = setPath;
      dialog.current?.show();
    },
  }));
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog menu-item-dialog" aria-label={t`Insert Menu Item`} onClose={() => { capture.current = null; }}>
      <form onSubmit={e => {
        e.preventDefault();
        if (!path) return;
        try { actions.insertMenuItem(path); dialog.current?.close(); } catch (err) { setError((err as Error).message); }
      }}>
        <h2><Trans>Insert Menu Item</Trans></h2>
        <p><Trans>Menu Item:</Trans> <strong>{path ? menuText(path) : t`None Selected`}</strong></p>
        <p className="hint"><Trans>To record a menu item, select a menu item using the mouse.</Trans></p>
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary" disabled={!path}><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export interface ConditionalHandle { open(stepId?: string): void }

// Insert Conditional: If Current, Then Play Action, Else Play Action; with a step id it edits that conditional step.
export function ConditionalDialog({ ref, setError }: { ref: Ref<ConditionalHandle>; setError: (e: string | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [c, setC] = useState<Conditional & { step?: string }>({ if: 'landscape', then: null, else: null });
  useImperativeHandle(ref, () => ({
    open(stepId) {
      const old = stepId ? actions.action?.steps.find(s => s.id === stepId)?.cond : undefined;
      setC(old ? { ...old, step: stepId } : { if: 'landscape', then: null, else: null });
      dialog.current?.showModal();
    },
  }));
  const names = actions.set?.actions.map(a => a.name) ?? [];
  const pick = (label: string, value: string | null, set: (v: string | null) => void) => (
    <label>{label} <select aria-label={label} value={value ?? ''} onChange={e => set(e.currentTarget.value || null)}>
      <option value="">{t({ message: 'None', context: 'action' })}</option>
      {names.map((n, i) => <option key={i} value={n}>{n}</option>)}
    </select></label>
  );
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog" aria-label={t`Conditional Action`}>
      <form onSubmit={e => {
        e.preventDefault();
        try { actions.insertConditional({ if: c.if, then: c.then, else: c.else }, c.step); dialog.current?.close(); } catch (err) { setError((err as Error).message); }
      }}>
        <h2><Trans>Conditional Action</Trans></h2>
        <label><Trans>If Current</Trans> <select aria-label={t`If Current`} value={c.if} onChange={e => setC({ ...c, if: e.currentTarget.value as Condition })}>
          {CONDITIONS.map(k => <option key={k} value={k}>{i18n._(CONDITION_LABEL[k])}</option>)}
        </select></label>
        {pick(t`Then Play Action`, c.then, v => setC({ ...c, then: v }))}
        {pick(t`Else Play Action`, c.else, v => setC({ ...c, else: v }))}
        {c.then === null && c.else === null && <p className="hint"><Trans>Choose an action for Then or Else.</Trans></p>}
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary" disabled={c.then === null && c.else === null}><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export interface ActionOptionsHandle { open(actionId: string): void }

// Name and function key of an action.
export function ActionOptionsDialog({ ref, setError }: { ref: Ref<ActionOptionsHandle>; setError: (e: string | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [o, setO] = useState({ id: '', name: '', fkey: '', shift: false, ctrl: false });
  useImperativeHandle(ref, () => ({
    open(actionId) {
      const a = actions.sets.flatMap(s => s.actions).find(x => x.id === actionId);
      if (!a) return;
      const k = a.key ?? '';
      setO({ id: a.id, name: a.name, fkey: k.replace(/^.*\+/, ''), shift: k.includes('Shift+'), ctrl: k.includes('Ctrl+') });
      dialog.current?.showModal();
    },
  }));
  const key = o.fkey ? `${o.shift ? 'Shift+' : ''}${o.ctrl ? 'Ctrl+' : ''}${o.fkey}` : null;
  const owner = key ? actions.byKey(key)?.action : undefined;
  const other = owner && owner.id !== o.id ? owner.name : null, keyText = keysLabel(key ?? '');
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog" aria-label={t`Action Options`}>
      <form onSubmit={e => {
        e.preventDefault();
        try { actions.setActionOptions(o.id, { name: o.name.trim() || o.name, key }); dialog.current?.close(); } catch (err) { setError((err as Error).message); }
      }}>
        <h2><Trans>Action Options</Trans></h2>
        <label><Trans>Name</Trans> <input aria-label={t`Name`} value={o.name} onChange={e => setO({ ...o, name: e.currentTarget.value })} required /></label>
        <div className="row">
          <label><Trans>Function Key</Trans> <select aria-label={t`Function Key`} value={o.fkey} onChange={e => setO({ ...o, fkey: e.currentTarget.value })}>
            <option value="">{t({ message: 'None', context: 'function key' })}</option>
            {ACTION_FKEYS.map(k => <option key={k} value={k}>{k}</option>)}
          </select></label>
          <label className="check"><input type="checkbox" checked={o.shift} disabled={!o.fkey} onChange={e => setO({ ...o, shift: e.currentTarget.checked })} /> {keysLabel('Shift')}</label>
          <label className="check"><input type="checkbox" checked={o.ctrl} disabled={!o.fkey} onChange={e => setO({ ...o, ctrl: e.currentTarget.checked })} /> {keysLabel('Ctrl')}</label>
        </div>
        {other !== null && <p className="hint"><Trans>{keyText} is used by the action “{other}”. OK moves it to this action.</Trans></p>}
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export interface StepDialogHandle { ask(step: ActionStep): Promise<ActionStep | null> }

// Resolves with the step carrying the values for this run, or null when Cancel ends playback.
export function StepDialog({ ref }: { ref: Ref<StepDialogHandle> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const done = useRef<((s: ActionStep | null) => void) | null>(null);
  // Number fields hold their text while typing; an empty or invalid number keeps the recorded value.
  const [st, setSt] = useState<{ step: ActionStep; values: (string | boolean)[] } | null>(null);

  useImperativeHandle(ref, () => ({
    ask(step) {
      done.current?.(null);
      return new Promise(res => {
        done.current = res;
        setSt({ step, values: stepFields(step).map(f => (typeof f.value === 'boolean' ? f.value : String(f.value))) });
        dialog.current?.showModal();
      });
    },
  }));
  function finish(s: ActionStep | null) {
    dialog.current?.close();
    const f = done.current;
    done.current = null;
    f?.(s);
  }
  const fields = st ? stepFields(st.step) : [];
  const set = (i: number, v: string | boolean) => setSt(p => p && { ...p, values: p.values.map((x, j) => (j === i ? v : x)) });
  const parsed = (): Field['value'][] => fields.map((f, i) => {
    const v = st!.values[i];
    return typeof f.value === 'number' ? (String(v).trim() !== '' && Number.isFinite(+v) ? +v : f.value) : v;
  });

  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog step-dialog" aria-label={t`Action step`} onCancel={e => { e.preventDefault(); finish(null); }}>
      <form onSubmit={e => { e.preventDefault(); if (st) finish(withFields(st.step, parsed())); }}>
        <h2>{st ? historyLabel(st.step.label) : ''}</h2>
        <p className="hint"><Trans>The action pauses at this step. Change the values for this run, or cancel to stop the action.</Trans></p>
        <div className="step-fields">
          {fields.map((f, i) => {
            const v = st!.values[i];
            return (
              <label key={i} className={typeof v === 'boolean' ? 'check' : undefined}>
                {typeof v === 'boolean' ? (
                  <><input type="checkbox" checked={v} onChange={e => set(i, e.currentTarget.checked)} /> {f.label}</>
                ) : (
                  <>{f.label} <input aria-label={f.label} type={typeof f.value === 'number' ? 'number' : 'text'} step="any" value={v} onChange={e => set(i, e.currentTarget.value)} /></>
                )}
              </label>
            );
          })}
        </div>
        <div className="actions">
          <button type="button" onClick={() => finish(null)}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}
