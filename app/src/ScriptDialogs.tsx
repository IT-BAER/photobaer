// File > Scripts > Image Processor and Load Files into Stack.
import { useImperativeHandle, useRef, useState, useSyncExternalStore, type Ref } from 'react';
import { actions } from './app/actionsStore.ts';

const ACCEPT = 'image/*,.psd,.psb,.exr,.hdr,.svg,.ico';
type DirPicker = { showDirectoryPicker?: (o: object) => Promise<FileSystemDirectoryHandle> };

function pick(multiple: boolean, done: (files: File[]) => void) {
  const input = Object.assign(document.createElement('input'), { type: 'file', multiple, accept: ACCEPT });
  input.onchange = () => done([...input.files ?? []]);
  input.click();
}
const count = (n: number) => (n ? `${n} file${n > 1 ? 's' : ''}` : '');

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
      <label className="radio"><input type="checkbox" checked={fit.on} onChange={e => set({ ...fit, on: e.currentTarget.checked })} /> Resize to Fit</label>
      <label>W <input type="number" aria-label={`${label} width`} min={1} max={300000} value={fit.w} disabled={!fit.on} onChange={e => set({ ...fit, w: Math.max(1, e.currentTarget.valueAsNumber || 1) })} /> px</label>
      <label>H <input type="number" aria-label={`${label} height`} min={1} max={300000} value={fit.h} disabled={!fit.on} onChange={e => set({ ...fit, h: Math.max(1, e.currentTarget.valueAsNumber || 1) })} /> px</label>
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
    <dialog ref={dialog} className="mode-dialog batch-dialog" aria-label="Image Processor">
      <form onSubmit={e => { e.preventDefault(); if (!ready) return; dialog.current?.close(); start(o); }}>
        <h2>Image Processor</h2>
        <fieldset>
          <legend>Select the images to process</legend>
          <label className="radio"><input type="radio" name="ip-source" checked={o.source === 'opened'} onChange={() => setO({ ...o, source: 'opened' })} /> Use Open Images</label>
          <div className="row">
            <label className="radio"><input type="radio" name="ip-source" checked={o.source === 'files'} onChange={() => setO({ ...o, source: 'files' })} /> Files</label>
            <button type="button" onClick={() => pick(true, files => setO(p => ({ ...p, source: 'files', files })))}>Choose…</button>
            <span className="hint">{count(o.files.length)}</span>
          </div>
        </fieldset>
        <fieldset>
          <legend>Select location to save processed images</legend>
          {canFolder && <div className="row">
            <label className="radio"><input type="radio" name="ip-dest" checked={o.dest === 'folder'} onChange={() => setO({ ...o, dest: 'folder' })} /> Folder</label>
            <button type="button" onClick={() => void pickFolder()}>Choose…</button>
            <span className="hint">{o.folder?.name ?? ''}</span>
          </div>}
          <label className="radio"><input type="radio" name="ip-dest" checked={o.dest === 'download'} onChange={() => setO({ ...o, dest: 'download' })} /> Downloads</label>
          <p className="hint">In a folder each type goes into a subfolder named JPEG, PSD or PNG.</p>
        </fieldset>
        <fieldset>
          <legend>File Type</legend>
          <div className="row">
            <label className="radio"><input type="checkbox" checked={o.jpeg.on} onChange={e => setO({ ...o, jpeg: { ...o.jpeg, on: e.currentTarget.checked } })} /> Save as JPEG</label>
            <label>Quality <input type="number" aria-label="JPEG quality" min={0} max={12} value={o.jpeg.quality} onChange={e => setO({ ...o, jpeg: { ...o.jpeg, quality: Math.min(12, Math.max(0, Math.round(e.currentTarget.valueAsNumber) || 0)) } })} /></label>
            <label className="radio"><input type="checkbox" checked={o.jpeg.srgb} onChange={e => setO({ ...o, jpeg: { ...o.jpeg, srgb: e.currentTarget.checked } })} /> Convert Profile to sRGB</label>
          </div>
          <FitFields label="JPEG" fit={o.jpeg.fit} set={f => setO({ ...o, jpeg: { ...o.jpeg, fit: f } })} />
          <label className="radio"><input type="checkbox" checked={o.psd.on} onChange={e => setO({ ...o, psd: { ...o.psd, on: e.currentTarget.checked } })} /> Save as PSD</label>
          <FitFields label="PSD" fit={o.psd.fit} set={f => setO({ ...o, psd: { ...o.psd, fit: f } })} />
          <label className="radio"><input type="checkbox" checked={o.png.on} onChange={e => setO({ ...o, png: { ...o.png, on: e.currentTarget.checked } })} /> Save as PNG</label>
          <FitFields label="PNG" fit={o.png.fit} set={f => setO({ ...o, png: { ...o.png, fit: f } })} />
        </fieldset>
        <fieldset>
          <legend>Preferences</legend>
          <div className="row">
            <label className="radio"><input type="checkbox" checked={o.action.on} disabled={!actions.sets.length} onChange={e => setO({ ...o, action: { ...o.action, on: e.currentTarget.checked } })} /> Run Action</label>
            <select aria-label="Set" value={o.action.setId} disabled={!o.action.on} onChange={e => { const s = actions.sets.find(x => x.id === e.currentTarget.value); setO({ ...o, action: { ...o.action, setId: e.currentTarget.value, actionId: s?.actions[0]?.id ?? '' } }); }}>
              {actions.sets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select aria-label="Action" value={o.action.actionId} disabled={!o.action.on} onChange={e => setO({ ...o, action: { ...o.action, actionId: e.currentTarget.value } })}>
              {set?.actions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <p className="hint">Errors are written to a report and the other images go on.</p>
        </fieldset>
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary" disabled={!ready}>Run</button>
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
    <dialog ref={dialog} className="mode-dialog batch-dialog" aria-label="Load Layers">
      <form onSubmit={e => { e.preventDefault(); if (!files.length) return; dialog.current?.close(); start(files, align, smart); }}>
        <h2>Load Layers</h2>
        <div className="row">
          <button type="button" onClick={() => pick(true, f => setFiles(p => [...p, ...f]))}>Browse…</button>
          <button type="button" disabled={!files.length} onClick={() => setFiles([])}>Remove All</button>
          <span className="hint">{count(files.length)}</span>
        </div>
        {files.length > 0 && <ol className="hint">{files.map((f, i) => <li key={i}>{f.name}</li>)}</ol>}
        <label className="radio"><input type="checkbox" checked={align} onChange={e => setAlign(e.currentTarget.checked)} /> Attempt to Automatically Align Source Images</label>
        <label className="radio"><input type="checkbox" checked={smart} onChange={e => setSmart(e.currentTarget.checked)} /> Create Smart Object after Loading Layers</label>
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary" disabled={!files.length}>OK</button>
        </div>
      </form>
    </dialog>
  );
}
