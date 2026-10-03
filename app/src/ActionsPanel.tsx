// Window > Actions: record worker edits as steps, play them on any document, save and load sets.
import { useSyncExternalStore } from 'react';
import { ChevronDown, ChevronRight, Circle, Eye, EyeOff, FilePlus, Folder, FolderOpen, FolderPlus, LayoutGrid, ListTree, OctagonPause, Play, Save, Square, Trash2 } from 'lucide-react';
import { client } from './client.ts';
import type { DocInfo } from './engine.worker.ts';
import type { Active } from './LayersPanel.tsx';
import type { ActionStep } from './actions.ts';
import { actions } from './app/actionsStore.ts';

type Run = (label: string | null, p: () => Promise<DocInfo | null>) => Promise<void>;

const ICON = { size: 16, strokeWidth: 1.75 };

// Plays `steps` in segments split at stop steps through `play` (false when the segment failed);
// false when a segment failed or a stop ended playback.
export async function playSteps(steps: ActionStep[], play: (seg: ActionStep[], resume: boolean) => Promise<boolean>): Promise<boolean> {
  let resume = false;
  for (let i = 0; i < steps.length;) {
    const s = steps[i];
    if (s.stop) {
      const go = s.stop.allowContinue ? confirm(`${s.stop.message}\n\nContinue playing the action?`) : (alert(s.stop.message), false);
      if (!go) return false;
      i++;
      continue;
    }
    const end = steps.findIndex((x, j) => j > i && x.stop);
    const seg = steps.slice(i, end < 0 ? steps.length : end);
    if (!await play(seg, resume)) return false;
    resume = true;
    i += seg.length;
  }
  return true;
}

export function ActionsPanel({ has, active, run, setError }: { has: boolean; active: Active | null; run: Run; setError: (e: string | null) => void }) {
  useSyncExternalStore(actions.subscribe, actions.version);
  const { sets, sel, recording } = actions;
  const attempt = (f: () => unknown) => { try { f(); } catch (e) { setError((e as Error).message); } };

  async function record() {
    if (recording) return;
    if (!actions.action) {
      const name = prompt('Action name', `Action ${sets.reduce((n, s) => n + s.actions.length, 0) + 1}`);
      if (!name) return;
      actions.newAction(name);
    }
    try {
      await client.call('recordStart');
      actions.startRecording();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function stop() {
    await client.call('recordStop').catch(() => {});
    actions.stopRecording();
  }
  async function play(setId?: string, actionId?: string) {
    if (recording) { setError('Stop recording first.'); return; }
    if (setId) actions.select({ set: setId, action: actionId });
    const steps = actions.playable();
    if (!steps.length) { setError(actions.action ? 'The action has no enabled steps.' : 'Select an action to play.'); return; }
    if (!has) { setError('Open a document to play an action.'); return; }
    await playSteps(steps, async (seg, resume) => {
      let ok = false;
      await run('Playing action…', async () => { const d = await client.call('playAction', seg, active?.id ?? null, resume); ok = true; return d; });
      return ok;
    });
  }
  function newSet() {
    const name = prompt('Set name', `Set ${sets.length + 1}`);
    if (name) actions.newSet(name);
  }
  function newAction() {
    const name = prompt('Action name', `Action ${sets.reduce((n, s) => n + s.actions.length, 0) + 1}`);
    if (name) { actions.newAction(name); void record(); }
  }
  function insertStop() {
    const message = prompt('Message shown when playback reaches this stop', '');
    if (message === null) return;
    attempt(() => actions.insertStop(message, confirm('Allow Continue? (OK = playback can continue, Cancel = playback ends here)')));
  }
  function rename(id: string, old: string) {
    const name = prompt('Name', old);
    if (name) actions.rename(id, name);
  }
  function save() {
    attempt(() => {
      const set = actions.set;
      if (!set) throw new Error('Select a set to save.');
      const url = URL.createObjectURL(new Blob([actions.exportSet(set.id)], { type: 'application/json' }));
      Object.assign(document.createElement('a'), { href: url, download: `${set.name}.actions.json` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  function load() {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
    input.onchange = async () => {
      const f = input.files?.[0];
      if (f) { try { actions.importSet(await f.text()); } catch (e) { setError(`Could not load ${f.name}: ${(e as Error).message}`); } }
    };
    input.click();
  }

  const expanded = (id: string) => actions.open.has(id);
  const toggleOpen = (id: string) => actions.toggleOpen(id);

  return (
    <div className="layers-panel actions-panel">
      <div className="panel-tabs"><span className="panel-tab">Actions</span></div>
      {actions.buttonMode ? (
        <div className="actions-buttons">
          {sets.flatMap(s => s.actions.map(a => (
            <button key={a.id} title={`${s.name} › ${a.name}`} onClick={() => void play(s.id, a.id)}>{a.name}</button>
          )))}
          {!sets.some(s => s.actions.length) && <p className="panel-hint">No actions. Record one or load a set.</p>}
        </div>
      ) : (
        <div className="layers-tree" role="tree" aria-label="Actions">
          {!sets.length && <p className="panel-hint">No action sets. Record an action or load a set.</p>}
          {sets.map(s => (
            <div key={s.id} role="treeitem" aria-expanded={expanded(s.id)}>
              <div className={`action-row${sel.set === s.id && !sel.action ? ' selected' : ''}`} onClick={() => actions.select({ set: s.id })} onDoubleClick={() => rename(s.id, s.name)}>
                <span className="action-eye" />
                <button className="action-twisty" aria-label="Expand set" onClick={e => { e.stopPropagation(); toggleOpen(s.id); }}>{expanded(s.id) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
                <Folder size={14} /> <span className="action-name">{s.name}</span>
              </div>
              {expanded(s.id) && s.actions.map(a => {
                const all = a.steps.every(x => x.enabled), none = a.steps.every(x => !x.enabled);
                return (
                  <div key={a.id} role="treeitem" aria-expanded={expanded(a.id)}>
                    <div className={`action-row indent1${sel.action === a.id && !sel.step ? ' selected' : ''}`} onClick={() => actions.select({ set: s.id, action: a.id })} onDoubleClick={() => rename(a.id, a.name)}>
                      <button className="action-eye" aria-label="Enable every step" onClick={e => { e.stopPropagation(); actions.toggleAction(a.id); }}>{none && a.steps.length ? <EyeOff size={14} /> : <Eye size={14} className={all ? '' : 'dim'} />}</button>
                      <button className="action-twisty" aria-label="Expand action" onClick={e => { e.stopPropagation(); toggleOpen(a.id); }}>{expanded(a.id) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
                      {recording?.action === a.id && <Circle size={9} fill="currentColor" className="rec" aria-label="Recording" />}
                      <span className="action-name">{a.name}</span>
                      <span className="action-count">{a.steps.length}</span>
                    </div>
                    {expanded(a.id) && a.steps.map(st => (
                      <div key={st.id} className={`action-row indent2${sel.step === st.id ? ' selected' : ''}${st.enabled ? '' : ' off'}`} onClick={() => actions.select({ set: s.id, action: a.id, step: st.id })} title={st.stop?.message ?? st.calls.map(c => c.op).join(', ')}>
                        <button className="action-eye" aria-label="Enable this step" onClick={e => { e.stopPropagation(); actions.toggleStep(st.id); }}>{st.enabled ? <Eye size={14} /> : <EyeOff size={14} />}</button>
                        {st.stop && <OctagonPause size={13} />}
                        <span className="action-name">{st.label}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <div className="layers-footer">
        <button aria-label="Stop recording" title="Stop recording" disabled={!recording} onClick={() => void stop()}><Square {...ICON} /></button>
        <button aria-label="Begin recording" title="Begin recording" className={recording ? 'recording' : ''} disabled={!!recording} onClick={() => void record()}><Circle {...ICON} /></button>
        <button aria-label="Play the selected action" title="Play the selected action" disabled={!!recording} onClick={() => void play()}><Play {...ICON} /></button>
        <button aria-label="New set" title="New set" onClick={newSet}><FolderPlus {...ICON} /></button>
        <button aria-label="New action" title="New action" disabled={!!recording} onClick={newAction}><FilePlus {...ICON} /></button>
        <button aria-label="Insert stop" title="Insert stop" disabled={!actions.action} onClick={insertStop}><OctagonPause {...ICON} /></button>
        <button aria-label="Delete" title="Delete the selected step, action or set" disabled={!sel.set} onClick={() => attempt(() => actions.deleteSelected())}><Trash2 {...ICON} /></button>
        <button aria-label="Load actions" title="Load actions (.json)" onClick={load}><FolderOpen {...ICON} /></button>
        <button aria-label="Save the selected set" title="Save the selected set" disabled={!actions.set} onClick={save}><Save {...ICON} /></button>
        <button aria-label={actions.buttonMode ? 'Show the action tree' : 'Button mode'} title={actions.buttonMode ? 'Show the action tree' : 'Button mode'} onClick={() => actions.setButtonMode(!actions.buttonMode)}>
          {actions.buttonMode ? <ListTree {...ICON} /> : <LayoutGrid {...ICON} />}
        </button>
      </div>
    </div>
  );
}
