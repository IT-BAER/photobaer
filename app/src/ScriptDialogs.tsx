// File > Scripts > Image Processor and Load Files into Stack.
import { useImperativeHandle, useRef, useState, useSyncExternalStore, type Ref } from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { actions } from './app/actionsStore.ts';
import { NumberInput } from './shell/NumberInput.tsx';

const ACCEPT = 'image/*,.psd,.psb,.exr,.hdr,.svg,.ico';
type DirPicker = { showDirectoryPicker?: (o: object) => Promise<FileSystemDirectoryHandle> };

function pick(multiple: boolean, done: (files: File[]) => void) {
  const input = Object.assign(document.createElement('input'), { type: 'file', multiple, accept: ACCEPT });
  input.onchange = () => done([...input.files ?? []]);
  input.click();
}
const count = (n: number) => (n ? plural(n, { one: '# file', other: '# files' }) : '');

export interface Fit { on: boolean; w: number; h: number }
export interface ImageProcessorOptions {
  source: 'opened' | 'files'; files: File[];
  dest: 'folder' | 'download'; folder: FileSystemDirectoryHandle | null;
  jpeg: { on: boolean; quality: number; srgb: boolean; fit: Fit };
  psd: { on: boolean; fit: Fit };
  png: { on: boolean; fit: Fit };
  action: { on: boolean; setId: string; actionId: string };
}
export interface ScriptDialogHandle { open(): void }

function FitFields({ fit, set, label }: { fit: Fit; set: (f: Fit) => void; label: string }) {
  return (
    <div className="row">
      <label className="radio"><input type="checkbox" checked={fit.on} onChange={e => set({ ...fit, on: e.currentTarget.checked })} /> <Trans>Resize to Fit</Trans></label>
      <label><Trans>W</Trans> <NumberInput aria-label={t`${label} width`} min={1} max={300000} value={fit.w} disabled={!fit.on} onValue={v => set({ ...fit, w: Math.max(1, v || 1) })} /> px</label>
      <label><Trans>H</Trans> <NumberInput aria-label={t`${label} height`} min={1} max={300000} value={fit.h} disabled={!fit.on} onValue={v => set({ ...fit, h: Math.max(1, v || 1) })} /> px</label>
    </div>
  );
}

export function ImageProcessorDialog({ ref, start }: { ref: Ref<ScriptDialogHandle>; start: (o: ImageProcessorOptions) => void }) {
  useSyncExternalStore(actions.subscribe, actions.version);
  const dialog = useRef<HTMLDialogElement>(null);
  const canFolder = !!(window as unknown as DirPicker).showDirectoryPicker;
  const fit = { on: false, w: 1024, h: 1024 };
  const [o, setO] = useState<ImageProcessorOptions>({
    source: 'opened', files: [], dest: canFolder ? 'folder' : 'download', folder: null,
    jpeg: { on: true, quality: 5, srgb: true, fit }, psd: { on: false, fit }, png: { on: false, fit },
    action: { on: false, setId: '', actionId: '' },
  });
  const set = actions.sets.find(s => s.id === o.action.setId);

  useImperativeHandle(ref, () => ({
    open() {
      const s = actions.set ?? actions.sets[0];
      setO(p => ({ ...p, files: [], folder: null, action: { ...p.action, setId: s?.id ?? '', actionId: s?.actions[0]?.id ?? '' } }));
      dialog.current?.showModal();
    },
  }));
  async function pickFolder() {
    try {
      const folder = await (window as unknown as DirPicker).showDirectoryPicker!({ mode: 'readwrite' });
      setO(p => ({ ...p, dest: 'folder', folder }));
    } catch { /* cancelled */ }
  }

  const ready = (o.source === 'opened' || o.files.length > 0) && (o.dest !== 'folder' || !!o.folder) && (o.jpeg.on || o.psd.on || o.png.on)
    && (!o.action.on || !!set?.actions.some(a => a.id === o.action.actionId));
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog" aria-label={t`Image Processor`}>
      <form onSubmit={e => { e.preventDefault(); if (!ready) return; dialog.current?.close(); start(o); }}>
        <h2><Trans>Image Processor</Trans></h2>
        <fieldset>
          <legend><Trans>Select the images to process</Trans></legend>
          <label className="radio"><input type="radio" name="ip-source" checked={o.source === 'opened'} onChange={() => setO({ ...o, source: 'opened' })} /> <Trans>Use Open Images</Trans></label>
          <div className="row">
            <label className="radio"><input type="radio" name="ip-source" checked={o.source === 'files'} onChange={() => setO({ ...o, source: 'files' })} /> <Trans>Files</Trans></label>
            <button type="button" onClick={() => pick(true, files => setO(p => ({ ...p, source: 'files', files })))}><Trans>Choose…</Trans></button>
            <span className="hint">{count(o.files.length)}</span>
          </div>
        </fieldset>
        <fieldset>
          <legend><Trans>Select location to save processed images</Trans></legend>
          {canFolder && <div className="row">
            <label className="radio"><input type="radio" name="ip-dest" checked={o.dest === 'folder'} onChange={() => setO({ ...o, dest: 'folder' })} /> <Trans>Folder</Trans></label>
            <button type="button" onClick={() => void pickFolder()}><Trans>Choose…</Trans></button>
            <span className="hint">{o.folder?.name ?? ''}</span>
          </div>}
          <label className="radio"><input type="radio" name="ip-dest" checked={o.dest === 'download'} onChange={() => setO({ ...o, dest: 'download' })} /> <Trans>Downloads</Trans></label>
          <p className="hint"><Trans>In a folder each type goes into a subfolder named JPEG, PSD or PNG.</Trans></p>
        </fieldset>
        <fieldset>
          <legend><Trans>File Type</Trans></legend>
          <div className="row">
            <label className="radio"><input type="checkbox" checked={o.jpeg.on} onChange={e => setO({ ...o, jpeg: { ...o.jpeg, on: e.currentTarget.checked } })} /> <Trans>Save as JPEG</Trans></label>
            <label><Trans>Quality</Trans> <NumberInput aria-label={t`JPEG quality`} min={0} max={12} value={o.jpeg.quality} onValue={v => setO({ ...o, jpeg: { ...o.jpeg, quality: Math.min(12, Math.max(0, Math.round(v) || 0)) } })} /></label>
            <label className="radio"><input type="checkbox" checked={o.jpeg.srgb} onChange={e => setO({ ...o, jpeg: { ...o.jpeg, srgb: e.currentTarget.checked } })} /> <Trans>Convert Profile to sRGB</Trans></label>
          </div>
          <FitFields label="JPEG" fit={o.jpeg.fit} set={f => setO({ ...o, jpeg: { ...o.jpeg, fit: f } })} />
          <label className="radio"><input type="checkbox" checked={o.psd.on} onChange={e => setO({ ...o, psd: { ...o.psd, on: e.currentTarget.checked } })} /> <Trans>Save as PSD</Trans></label>
          <FitFields label="PSD" fit={o.psd.fit} set={f => setO({ ...o, psd: { ...o.psd, fit: f } })} />
          <label className="radio"><input type="checkbox" checked={o.png.on} onChange={e => setO({ ...o, png: { ...o.png, on: e.currentTarget.checked } })} /> <Trans>Save as PNG</Trans></label>
          <FitFields label="PNG" fit={o.png.fit} set={f => setO({ ...o, png: { ...o.png, fit: f } })} />
        </fieldset>
        <fieldset>
          <legend><Trans>Preferences</Trans></legend>
          <div className="row">
            <label className="radio"><input type="checkbox" checked={o.action.on} disabled={!actions.sets.length} onChange={e => setO({ ...o, action: { ...o.action, on: e.currentTarget.checked } })} /> <Trans>Run Action</Trans></label>
            <select aria-label={t`Set`} value={o.action.setId} disabled={!o.action.on} onChange={e => { const s = actions.sets.find(x => x.id === e.currentTarget.value); setO({ ...o, action: { ...o.action, setId: e.currentTarget.value, actionId: s?.actions[0]?.id ?? '' } }); }}>
              {actions.sets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select aria-label={t`Action`} value={o.action.actionId} disabled={!o.action.on} onChange={e => setO({ ...o, action: { ...o.action, actionId: e.currentTarget.value } })}>
              {set?.actions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <p className="hint"><Trans>Errors are written to a report and the other images go on.</Trans></p>
        </fieldset>
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary" disabled={!ready}><Trans>Run</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export function LoadStackDialog({ ref, start }: { ref: Ref<ScriptDialogHandle>; start: (files: File[], align: boolean, smart: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [align, setAlign] = useState(false);
  const [smart, setSmart] = useState(false);
  useImperativeHandle(ref, () => ({ open() { setFiles([]); dialog.current?.showModal(); } }));
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog" aria-label={t`Load Layers`}>
      <form onSubmit={e => { e.preventDefault(); if (!files.length) return; dialog.current?.close(); start(files, align, smart); }}>
        <h2><Trans>Load Layers</Trans></h2>
        <div className="row">
          <button type="button" onClick={() => pick(true, f => setFiles(p => [...p, ...f]))}><Trans>Browse…</Trans></button>
          <button type="button" disabled={!files.length} onClick={() => setFiles([])}><Trans>Remove All</Trans></button>
          <span className="hint">{count(files.length)}</span>
        </div>
        {files.length > 0 && <ol className="hint">{files.map((f, i) => <li key={i}>{f.name}</li>)}</ol>}
        <label className="radio"><input type="checkbox" checked={align} onChange={e => setAlign(e.currentTarget.checked)} /> <Trans>Attempt to Automatically Align Source Images</Trans></label>
        <label className="radio"><input type="checkbox" checked={smart} onChange={e => setSmart(e.currentTarget.checked)} /> <Trans>Create Smart Object after Loading Layers</Trans></label>
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary" disabled={!files.length}><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}
