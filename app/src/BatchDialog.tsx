// File > Automate > Batch: plays an action on the open documents or on picked files.
import { useImperativeHandle, useRef, useState, useSyncExternalStore, type Ref } from 'react';
import { actions } from './app/actionsStore.ts';

export type BatchFormat = 'psd' | 'png' | 'jpeg';
export interface BatchOptions {
  setId: string; actionId: string;
  source: 'opened' | 'files'; files: File[];
  dest: 'none' | 'folder' | 'download'; folder: FileSystemDirectoryHandle | null; format: BatchFormat;
  errors: 'stop' | 'log';
}
export interface BatchDialogHandle { open(): void }

type DirPicker = { showDirectoryPicker?: (o: object) => Promise<FileSystemDirectoryHandle> };

export function BatchDialog({ ref, start }: { ref: Ref<BatchDialogHandle>; start: (o: BatchOptions) => void }) {
  useSyncExternalStore(actions.subscribe, actions.version);
  const dialog = useRef<HTMLDialogElement>(null);
  const [o, setO] = useState<BatchOptions>({ setId: '', actionId: '', source: 'opened', files: [], dest: 'none', folder: null, format: 'png', errors: 'stop' });
  const set = actions.sets.find(s => s.id === o.setId);
  const canFolder = !!(window as unknown as DirPicker).showDirectoryPicker;

  useImperativeHandle(ref, () => ({
    open() {
      const s = actions.set ?? actions.sets[0];
      const a = (actions.set === s ? actions.action : undefined) ?? s?.actions[0];
      setO(p => ({ ...p, setId: s?.id ?? '', actionId: a?.id ?? '', files: [], folder: null }));
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

  const ready = !!set?.actions.some(a => a.id === o.actionId) && (o.source === 'opened' || o.files.length > 0) && (o.dest !== 'folder' || !!o.folder);
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog" aria-label="Batch">
      <form onSubmit={e => { e.preventDefault(); if (!ready) return; dialog.current?.close(); start(o); }}>
        <h2>Batch</h2>
        <fieldset>
          <legend>Play</legend>
          <label>Set <select aria-label="Set" value={o.setId} onChange={e => { const s = actions.sets.find(x => x.id === e.currentTarget.value); setO({ ...o, setId: e.currentTarget.value, actionId: s?.actions[0]?.id ?? '' }); }}>
            {actions.sets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></label>
          <label>Action <select aria-label="Action" value={o.actionId} onChange={e => setO({ ...o, actionId: e.currentTarget.value })}>
            {set?.actions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select></label>
          {!actions.sets.length && <p className="hint">Record an action in Window › Actions first.</p>}
        </fieldset>
        <fieldset>
          <legend>Source</legend>
          <label className="radio"><input type="radio" name="batch-source" checked={o.source === 'opened'} onChange={() => setO({ ...o, source: 'opened' })} /> Opened Files</label>
          <div className="row">
            <label className="radio"><input type="radio" name="batch-source" checked={o.source === 'files'} onChange={() => setO({ ...o, source: 'files' })} /> Files</label>
            <button type="button" onClick={pickFiles}>Choose…</button>
            <span className="hint">{o.files.length ? `${o.files.length} file${o.files.length > 1 ? 's' : ''}` : ''}</span>
          </div>
        </fieldset>
        <fieldset>
          <legend>Destination</legend>
          <label className="radio"><input type="radio" name="batch-dest" checked={o.dest === 'none'} onChange={() => setO({ ...o, dest: 'none' })} /> None</label>
          {canFolder && <div className="row">
            <label className="radio"><input type="radio" name="batch-dest" checked={o.dest === 'folder'} onChange={() => setO({ ...o, dest: 'folder' })} /> Folder</label>
            <button type="button" onClick={() => void pickFolder()}>Choose…</button>
            <span className="hint">{o.folder?.name ?? ''}</span>
          </div>}
          <label className="radio"><input type="radio" name="batch-dest" checked={o.dest === 'download'} onChange={() => setO({ ...o, dest: 'download' })} /> Downloads</label>
          <label>Format <select aria-label="Format" value={o.format} disabled={o.dest === 'none'} onChange={e => setO({ ...o, format: e.currentTarget.value as BatchFormat })}>
            <option value="psd">Photoshop (PSD)</option><option value="png">PNG</option><option value="jpeg">JPEG</option>
          </select></label>
          <p className="hint">Files from the Files source close after they are saved; open documents stay open.</p>
        </fieldset>
        <label>Errors <select aria-label="Errors" value={o.errors} onChange={e => setO({ ...o, errors: e.currentTarget.value as BatchOptions['errors'] })}>
          <option value="stop">Stop for Errors</option><option value="log">Log Errors to a Report</option>
        </select></label>
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary" disabled={!ready}>OK</button>
        </div>
      </form>
    </dialog>
  );
}
