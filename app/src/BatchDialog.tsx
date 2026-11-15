// File > Automate > Batch: plays an action on the open documents or on picked files. The same dialog creates a
// droplet (no source; a folder destination is chosen when the droplet runs) and runs an opened droplet.
import { useImperativeHandle, useRef, useState, useSyncExternalStore, type Ref } from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ActionSet } from './actions.ts';
import { actions } from './app/actionsStore.ts';
import type { DropletOptions } from './app/droplets.ts';

export type BatchFormat = 'psd' | 'png' | 'jpeg';
export interface BatchOptions {
  setId: string; actionId: string;
  source: 'opened' | 'files'; files: File[];
  dest: 'none' | 'folder' | 'download'; folder: FileSystemDirectoryHandle | null; format: BatchFormat;
  errors: 'stop' | 'log';
}
export type BatchMode = { mode: 'batch' } | { mode: 'droplet' } | { mode: 'run'; set: ActionSet; actionId: string; options: DropletOptions; files: File[] };
export interface BatchDialogHandle { open(m?: BatchMode): void }

type DirPicker = { showDirectoryPicker?: (o: object) => Promise<FileSystemDirectoryHandle> };

export function BatchDialog({ ref, start }: { ref: Ref<BatchDialogHandle>; start: (o: BatchOptions, m: BatchMode) => void }) {
  useSyncExternalStore(actions.subscribe, actions.version);
  const dialog = useRef<HTMLDialogElement>(null);
  const [o, setO] = useState<BatchOptions>({ setId: '', actionId: '', source: 'opened', files: [], dest: 'none', folder: null, format: 'png', errors: 'stop' });
  const [m, setM] = useState<BatchMode>({ mode: 'batch' });
  const sets = m.mode === 'run' ? [m.set] : actions.sets;
  const set = sets.find(s => s.id === o.setId);
  const canFolder = !!(window as unknown as DirPicker).showDirectoryPicker;

  useImperativeHandle(ref, () => ({
    open(next = { mode: 'batch' }) {
      setM(next);
      if (next.mode === 'run') {
        const { dest, format, errors } = next.options;
        setO({ setId: next.set.id, actionId: next.actionId, source: 'files', files: next.files, dest: dest === 'folder' && !canFolder ? 'download' : dest, folder: null, format, errors });
      } else {
        const s = actions.set ?? actions.sets[0];
        const a = (actions.set === s ? actions.action : undefined) ?? s?.actions[0];
        setO(p => ({ ...p, setId: s?.id ?? '', actionId: a?.id ?? '', files: [], folder: null, ...(next.mode === 'droplet' ? { source: 'files' as const, dest: 'download' as const } : {}) }));
      }
      dialog.current?.showModal();
    },
  }));

  function pickFiles() {
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: 'image/*,.psd,.psb,.exr,.hdr,.svg,.ico' });
    input.onchange = () => setO(p => ({ ...p, source: 'files', files: [...input.files ?? []] }));
    input.click();
  }
  async function pickFolder() {
    try {
      const folder = await (window as unknown as DirPicker).showDirectoryPicker!({ mode: 'readwrite' });
      setO(p => ({ ...p, dest: 'folder', folder }));
    } catch { /* cancelled */ }
  }

  const create = m.mode === 'droplet', running = m.mode === 'run';
  const ready = !!set?.actions.some(a => a.id === o.actionId) && (create || o.source === 'opened' || o.files.length > 0) && (create || o.dest !== 'folder' || !!o.folder);
  const title = create ? t`Create Droplet` : running ? t`Run Droplet` : t`Batch`;
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog" aria-label={title}>
      <form onSubmit={e => { e.preventDefault(); if (!ready) return; dialog.current?.close(); start(o, m); }}>
        <h2>{title}</h2>
        <fieldset>
          <legend><Trans>Play</Trans></legend>
          <label><Trans>Set</Trans> <select aria-label={t`Set`} value={o.setId} disabled={running} onChange={e => { const s = sets.find(x => x.id === e.currentTarget.value); setO({ ...o, setId: e.currentTarget.value, actionId: s?.actions[0]?.id ?? '' }); }}>
            {sets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></label>
          <label><Trans>Action</Trans> <select aria-label={t`Action`} value={o.actionId} disabled={running} onChange={e => setO({ ...o, actionId: e.currentTarget.value })}>
            {set?.actions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select></label>
          {!sets.length && <p className="hint"><Trans>Record an action in Window › Actions first.</Trans></p>}
        </fieldset>
        {!create && <fieldset>
          <legend><Trans>Source</Trans></legend>
          {!running && <label className="radio"><input type="radio" name="batch-source" checked={o.source === 'opened'} onChange={() => setO({ ...o, source: 'opened' })} /> <Trans>Opened Files</Trans></label>}
          <div className="row">
            <label className="radio"><input type="radio" name="batch-source" checked={o.source === 'files'} onChange={() => setO({ ...o, source: 'files' })} /> <Trans>Files</Trans></label>
            <button type="button" onClick={pickFiles}><Trans>Choose…</Trans></button>
            <span className="hint">{o.files.length ? plural(o.files.length, { one: '# file', other: '# files' }) : ''}</span>
          </div>
        </fieldset>}
        <fieldset>
          <legend><Trans>Destination</Trans></legend>
          <label className="radio"><input type="radio" name="batch-dest" checked={o.dest === 'none'} onChange={() => setO({ ...o, dest: 'none' })} /> <Trans>None</Trans></label>
          {canFolder && <div className="row">
            <label className="radio"><input type="radio" name="batch-dest" checked={o.dest === 'folder'} onChange={() => setO({ ...o, dest: 'folder' })} /> <Trans>Folder</Trans></label>
            {create ? <span className="hint"><Trans>chosen when the droplet runs</Trans></span> : <>
              <button type="button" onClick={() => void pickFolder()}><Trans>Choose…</Trans></button>
              <span className="hint">{o.folder?.name ?? ''}</span>
            </>}
          </div>}
          <label className="radio"><input type="radio" name="batch-dest" checked={o.dest === 'download'} onChange={() => setO({ ...o, dest: 'download' })} /> <Trans>Downloads</Trans></label>
          <label><Trans>Format</Trans> <select aria-label={t`Format`} value={o.format} disabled={o.dest === 'none'} onChange={e => setO({ ...o, format: e.currentTarget.value as BatchFormat })}>
            <option value="psd">Photoshop (PSD)</option><option value="png">PNG</option><option value="jpeg">JPEG</option>
          </select></label>
          {!create && <p className="hint"><Trans>Files from the Files source close after they are saved; open documents stay open.</Trans></p>}
        </fieldset>
        <label><Trans>Errors</Trans> <select aria-label={t`Errors`} value={o.errors} onChange={e => setO({ ...o, errors: e.currentTarget.value as BatchOptions['errors'] })}>
          <option value="stop">{t`Stop for Errors`}</option><option value="log">{t`Log Errors to a Report`}</option>
        </select></label>
        {create && <p className="hint"><Trans>The droplet is saved as a .pbdroplet file. Open it in photobaer (File › Open, or drop it on the window together with images) to run the action on images.</Trans></p>}
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary" disabled={!ready}>{create ? <Trans>Save</Trans> : <Trans>OK</Trans>}</button>
        </div>
      </form>
    </dialog>
  );
}
