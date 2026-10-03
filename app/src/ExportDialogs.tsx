// File > Export: Export As, Save for Web, Export Preferences, and Layers/Artboards to Files and Artboards to PDF.
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { client } from './client.ts';
import type { Dither } from './app/webExport.ts';
import type { ExportFormat, ExportOptions } from './worker/helpers.ts';

export const FORMAT_LABEL: Record<ExportFormat, string> = { png: 'PNG', png8: 'PNG-8', jpeg: 'JPEG', webp: 'WebP', gif: 'GIF' };
export const EXT: Record<ExportFormat, string> = { png: 'png', png8: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' };
const LOSSY = (f: ExportFormat) => f === 'jpeg' || f === 'webp';
const INDEXED = (f: ExportFormat) => f === 'gif' || f === 'png8';
const FORMATS = Object.keys(FORMAT_LABEL) as ExportFormat[];
type DirPicker = { showDirectoryPicker?: (o: object) => Promise<FileSystemDirectoryHandle> };
export const canFolder = () => !!(window as unknown as DirPicker).showDirectoryPicker;
export interface ExportDialogHandle { open(): void }

// Export Preferences: the Quick Export format and whether it asks for a location (else a browser download).
export interface ExportPrefs { format: 'png' | 'jpeg' | 'webp'; quality: number; ask: boolean; icc: boolean; meta: boolean }
const PREFS_KEY = 'photobaer.exportPrefs';
export function exportPrefs(): ExportPrefs {
  const d: ExportPrefs = { format: 'png', quality: 90, ask: true, icc: true, meta: false };
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }; } catch { return d; }
}
function savePrefs(p: ExportPrefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage blocked: the defaults stay */ }
}

/** Worker options from dialog values; quality is 1-100. */
export const assetOptions = (format: ExportFormat, scale: number, quality: number, extra: Partial<ExportOptions> = {}): ExportOptions =>
  ({ format, scale, quality: quality / 100, colors: 256, dither: 'diffusion', icc: exportPrefs().icc, meta: exportPrefs().meta, ...extra });

const kb = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);

// Encoded size of each option set, measured in the worker 250 ms after the last change while `on`.
function useEstimates(opts: ExportOptions[], on: boolean) {
  const [out, setOut] = useState<({ bytes: number; width: number; height: number } | string | null)[]>([]);
  const key = JSON.stringify(opts);
  useEffect(() => {
    if (!on) return;
    let dead = false;
    setOut(opts.map(() => null));
    const t = setTimeout(async () => {
      const r: typeof out = [];
      for (const o of opts) {
        try { const a = await client.call('exportAsset', o); r.push({ bytes: a.blob.size, width: a.width, height: a.height }); }
        catch (e) { r.push((e as Error).message); }
        if (dead) return;
        setOut([...r, ...opts.slice(r.length).map(() => null)]);
      }
    }, 250);
    return () => { dead = true; clearTimeout(t); };
  }, [key, on]);
  return out;
}

export interface ExportRow { key: number; scale: number; suffix: string; format: ExportFormat; quality: number }

export function ExportAsDialog({ ref, start }: { ref: Ref<ExportDialogHandle>; start: (rows: ExportRow[]) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ExportRow[]>([{ key: 1, scale: 1, suffix: '', format: 'png', quality: 85 }]);
  useImperativeHandle(ref, () => ({ open() { setOpen(true); dialog.current?.showModal(); } }));
  const est = useEstimates(rows.map(r => assetOptions(r.format, r.scale, r.quality)), open);
  const set = (k: number, p: Partial<ExportRow>) => setRows(rs => rs.map(r => (r.key === k ? { ...r, ...p } : r)));
  const close = () => { setOpen(false); dialog.current?.close(); };
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog export-dialog" aria-label="Export As" onClose={() => setOpen(false)}>
      <form onSubmit={e => { e.preventDefault(); close(); start(rows); }}>
        <h2>Export As</h2>
        <table className="export-rows">
          <thead><tr><th>Size</th><th>Suffix</th><th>Format</th><th>Quality</th><th>Estimate</th><th /></tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const e = est[i];
              return (
                <tr key={r.key}>
                  <td><select aria-label="Size" value={r.scale} onChange={ev => set(r.key, { scale: Number(ev.currentTarget.value) })}>
                    {[0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4].map(s => <option key={s} value={s}>{s}x</option>)}
                  </select></td>
                  <td><input aria-label="Suffix" value={r.suffix} onChange={ev => set(r.key, { suffix: ev.currentTarget.value })} /></td>
                  <td><select aria-label="Format" value={r.format} onChange={ev => set(r.key, { format: ev.currentTarget.value as ExportFormat })}>
                    {FORMATS.map(f => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
                  </select></td>
                  <td>{LOSSY(r.format)
                    ? <input type="number" aria-label="Quality" min={1} max={100} value={r.quality} onChange={ev => set(r.key, { quality: Math.min(100, Math.max(1, Math.round(ev.currentTarget.valueAsNumber) || 1)) })} />
                    : <span className="hint">-</span>}</td>
                  <td className="hint">{e == null ? '…' : typeof e === 'string' ? e : `${kb(e.bytes)} · ${e.width}×${e.height}`}</td>
                  <td><button type="button" disabled={rows.length === 1} onClick={() => setRows(rs => rs.filter(x => x.key !== r.key))}>Remove</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="row">
          <button type="button" onClick={() => setRows(rs => [...rs, { key: Math.max(...rs.map(x => x.key)) + 1, scale: rs.length + 1, suffix: `@${rs.length + 1}x`, format: 'png', quality: 85 }])}>Add Size</button>
        </div>
        <p className="hint">{rows.length > 1 ? (canFolder() ? 'All sizes are written into one folder, chosen next.' : 'Each size downloads as its own file.') : 'The file location is chosen next.'}</p>
        <div className="actions">
          <button type="button" onClick={close}>Cancel</button>
          <button type="submit" className="primary">Export</button>
        </div>
      </form>
    </dialog>
  );
}

export interface WebOptions { format: ExportFormat; scale: number; quality: number; colors: number; dither: Dither }

export function SaveForWebDialog({ ref, size, start }: { ref: Ref<ExportDialogHandle>; size: [number, number]; start: (o: WebOptions) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [o, setO] = useState<WebOptions>({ format: 'jpeg', scale: 1, quality: 60, colors: 256, dither: 'diffusion' });
  useImperativeHandle(ref, () => ({ open() { setOpen(true); dialog.current?.showModal(); } }));
  const [e] = useEstimates([assetOptions(o.format, o.scale, o.quality, { colors: o.colors, dither: o.dither })], open);
  const close = () => { setOpen(false); dialog.current?.close(); };
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog" aria-label="Save for Web" onClose={() => setOpen(false)}>
      <form onSubmit={ev => { ev.preventDefault(); close(); start(o); }}>
        <h2>Save for Web</h2>
        <div className="row">
          <label>Format <select value={o.format} onChange={ev => setO({ ...o, format: ev.currentTarget.value as ExportFormat })}>
            {(['jpeg', 'png', 'png8', 'gif', 'webp'] as const).map(f => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
          </select></label>
          <label>Scale <select value={o.scale} onChange={ev => setO({ ...o, scale: Number(ev.currentTarget.value) })}>
            {[0.25, 0.5, 0.75, 1].map(s => <option key={s} value={s}>{s * 100}%</option>)}
          </select></label>
        </div>
        {LOSSY(o.format) && <div className="row"><label>Quality <input type="number" min={1} max={100} value={o.quality} onChange={ev => setO({ ...o, quality: Math.min(100, Math.max(1, Math.round(ev.currentTarget.valueAsNumber) || 1)) })} /> %</label></div>}
        {INDEXED(o.format) && <div className="row">
          <label>Colors <input type="number" min={2} max={256} value={o.colors} onChange={ev => setO({ ...o, colors: Math.min(256, Math.max(2, Math.round(ev.currentTarget.valueAsNumber) || 2)) })} /></label>
          <label>Dither <select value={o.dither} onChange={ev => setO({ ...o, dither: ev.currentTarget.value as Dither })}>
            <option value="none">None</option><option value="diffusion">Diffusion</option><option value="pattern">Pattern</option>
          </select></label>
        </div>}
        <p className="hint">{e == null ? 'Measuring…' : typeof e === 'string' ? `Cannot encode: ${e}` : `${kb(e.bytes)} · ${e.width}×${e.height} · ${(e.bytes / (size[0] * size[1] * 4) * 100).toFixed(1)}% of the uncompressed image`}</p>
        <div className="actions">
          <button type="button" onClick={close}>Cancel</button>
          <button type="submit" className="primary">Save</button>
        </div>
      </form>
    </dialog>
  );
}

export function ExportPrefsDialog({ ref }: { ref: Ref<ExportDialogHandle> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [p, setP] = useState(exportPrefs);
  useImperativeHandle(ref, () => ({ open() { setP(exportPrefs()); dialog.current?.showModal(); } }));
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog" aria-label="Export Preferences">
      <form onSubmit={e => { e.preventDefault(); savePrefs(p); dialog.current?.close(); }}>
        <h2>Export Preferences</h2>
        <div className="row">
          <label>Quick Export Format <select value={p.format} onChange={e => setP({ ...p, format: e.currentTarget.value as ExportPrefs['format'] })}>
            <option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option>
          </select></label>
          {p.format !== 'png' && <label>Quality <input type="number" min={1} max={100} value={p.quality} onChange={e => setP({ ...p, quality: Math.min(100, Math.max(1, Math.round(e.currentTarget.valueAsNumber) || 1)) })} /> %</label>}
        </div>
        <label className="radio"><input type="radio" name="xp-ask" checked={p.ask} onChange={() => setP({ ...p, ask: true })} /> Ask where to export each time</label>
        <label className="radio"><input type="radio" name="xp-ask" checked={!p.ask} onChange={() => setP({ ...p, ask: false })} /> Export files to the browser's downloads</label>
        <label className="radio"><input type="checkbox" checked={p.icc} onChange={e => setP({ ...p, icc: e.currentTarget.checked })} /> Embed the color profile (PNG and JPEG)</label>
        <label className="radio"><input type="checkbox" checked={p.meta} onChange={e => setP({ ...p, meta: e.currentTarget.checked })} /> Embed File Info: copyright and contact (PNG and JPEG)</label>
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </dialog>
  );
}

export type FilesKind = 'layers' | 'artboards' | 'pdf' | 'datasets';
export interface FilesOptions {
  kind: FilesKind; format: ExportFormat; scale: number; quality: number; trim: boolean; nested: boolean; skipHidden: boolean;
  dest: 'folder' | 'download'; folder: FileSystemDirectoryHandle | null; setFormat: 'psd' | 'png' | 'jpeg';
}
export interface FilesDialogHandle { open(kind: FilesKind): void }

export function FilesExportDialog({ ref, start }: { ref: Ref<FilesDialogHandle>; start: (o: FilesOptions) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [o, setO] = useState<FilesOptions>({ kind: 'layers', format: 'png', scale: 1, quality: 90, trim: true, nested: false, skipHidden: true, dest: canFolder() ? 'folder' : 'download', folder: null, setFormat: 'psd' });
  useImperativeHandle(ref, () => ({ open(kind) { setO(p => ({ ...p, kind, folder: null })); dialog.current?.showModal(); } }));
  async function pickFolder() {
    try { setO({ ...o, dest: 'folder', folder: await (window as unknown as DirPicker).showDirectoryPicker!({ mode: 'readwrite' }) }); } catch { /* cancelled */ }
  }
  const title = { layers: 'Layers to Files', artboards: 'Artboards to Files', pdf: 'Artboards to PDF', datasets: 'Data Sets as Files' }[o.kind];
  const sets = o.kind === 'datasets';
  const ready = o.kind === 'pdf' || o.dest !== 'folder' || !!o.folder;
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog" aria-label={title}>
      <form onSubmit={e => { e.preventDefault(); if (!ready) return; dialog.current?.close(); start(o); }}>
        <h2>{title}</h2>
        {o.kind !== 'pdf' && <fieldset>
          <legend>Destination</legend>
          {canFolder() && <div className="row">
            <label className="radio"><input type="radio" name="fx-dest" checked={o.dest === 'folder'} onChange={() => setO({ ...o, dest: 'folder' })} /> Folder</label>
            <button type="button" onClick={() => void pickFolder()}>Choose…</button>
            <span className="hint">{o.folder?.name ?? ''}</span>
          </div>}
          <label className="radio"><input type="radio" name="fx-dest" checked={o.dest === 'download'} onChange={() => setO({ ...o, dest: 'download' })} /> Downloads</label>
        </fieldset>}
        <div className="row">
          {sets && <label>File Type <select value={o.setFormat} onChange={e => setO({ ...o, setFormat: e.currentTarget.value as FilesOptions['setFormat'] })}>
            <option value="psd">PSD</option><option value="png">PNG</option><option value="jpeg">JPEG</option>
          </select></label>}
          {o.kind !== 'pdf' && !sets && <label>File Type <select value={o.format} onChange={e => setO({ ...o, format: e.currentTarget.value as ExportFormat })}>
            {FORMATS.map(f => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
          </select></label>}
          {o.kind !== 'pdf' && !sets && <label>Size <select value={o.scale} onChange={e => setO({ ...o, scale: Number(e.currentTarget.value) })}>
            {[0.5, 1, 2, 3].map(s => <option key={s} value={s}>{s * 100}%</option>)}
          </select></label>}
          {(o.kind === 'pdf' || (sets ? o.setFormat === 'jpeg' : LOSSY(o.format))) && <label>{o.kind === 'pdf' ? 'JPEG Quality' : 'Quality'} <input type="number" min={1} max={100} value={o.quality} onChange={e => setO({ ...o, quality: Math.min(100, Math.max(1, Math.round(e.currentTarget.valueAsNumber) || 1)) })} /> %</label>}
        </div>
        {o.kind === 'layers' && <>
          <label className="radio"><input type="checkbox" checked={o.trim} onChange={e => setO({ ...o, trim: e.currentTarget.checked })} /> Trim to layer pixels</label>
          <label className="radio"><input type="checkbox" checked={o.nested} onChange={e => setO({ ...o, nested: e.currentTarget.checked })} /> Include layers inside groups</label>
          <label className="radio"><input type="checkbox" checked={o.skipHidden} onChange={e => setO({ ...o, skipHidden: e.currentTarget.checked })} /> Visible layers only</label>
        </>}
        {o.kind === 'pdf' && <p className="hint">One page per artboard, at the document resolution.</p>}
        {sets && <p className="hint">One file per data set, named after the document and the data set.</p>}
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary" disabled={!ready}>Run</button>
        </div>
      </form>
    </dialog>
  );
}
