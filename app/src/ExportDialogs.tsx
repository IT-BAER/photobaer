// File > Export: Export As, Save for Web, Export Preferences, and Layers/Artboards to Files and Artboards to PDF.
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { i18n } from './i18n/index.ts';
import { client } from './client.ts';
import { formatNumber } from './i18n/numbers.ts';
import type { Dither } from './app/webExport.ts';
import type { ExportFormat, ExportOptions } from './worker/helpers.ts';
import { NumberInput } from './shell/NumberInput.tsx';

export const FORMAT_LABEL: Record<ExportFormat, string> = { png: 'PNG', png8: 'PNG-8', jpeg: 'JPEG', webp: 'WebP', gif: 'GIF', tiff: 'TIFF', bmp: 'BMP', tga: 'Targa' };
export const EXT: Record<ExportFormat, string> = { png: 'png', png8: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif', tiff: 'tif', bmp: 'bmp', tga: 'tga' };
const LOSSY = (f: ExportFormat) => f === 'jpeg' || f === 'webp';
const INDEXED = (f: ExportFormat) => f === 'gif' || f === 'png8';
const FORMATS = Object.keys(FORMAT_LABEL) as ExportFormat[];
type DirPicker = { showDirectoryPicker?: (o: object) => Promise<FileSystemDirectoryHandle> };
export const canFolder = () => !!(window as unknown as DirPicker).showDirectoryPicker;
export interface ExportTarget { layers: number[]; name: string }
export interface ExportDialogHandle { open(target?: ExportTarget): void }

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

const kb = (n: number) => (n < 1024 * 1024 ? `${formatNumber(n / 1024, 1)} KB` : `${formatNumber(n / 1024 / 1024, 2)} MB`);

type Estimate = { bytes: number; width: number; height: number; blob: Blob } | string | null;

// Encoded size and file of each option set, made in the worker 250 ms after the last change while `on`.
function useEstimates(opts: ExportOptions[], on: boolean) {
  const [out, setOut] = useState<Estimate[]>([]);
  const key = JSON.stringify(opts);
  useEffect(() => {
    if (!on) return;
    let dead = false;
    setOut(opts.map(() => null));
    const timer = setTimeout(async () => {
      const r: Estimate[] = [];
      for (const o of opts) {
        try { const a = await client.call('exportAsset', o); r.push({ bytes: a.blob.size, width: a.width, height: a.height, blob: a.blob }); }
        catch (e) { r.push((e as Error).message); }
        if (dead) return;
        setOut([...r, ...opts.slice(r.length).map(() => null)]);
      }
    }, 250);
    return () => { dead = true; clearTimeout(timer); };
  }, [key, on]);
  return out;
}

// An encoded file shown as an image on a checkerboard; `active` outlines it, a click picks it.
function Preview({ blob, caption, active, pick }: { blob: Blob | null; caption: string; active?: boolean; pick?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) { setUrl(null); return; }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return (
    <figure className={`export-preview${active ? ' active' : ''}`} onClick={pick}>
      <div className="export-preview-image">{url ? <img src={url} alt={caption} /> : <span className="hint">…</span>}</div>
      <figcaption className="hint">{caption}</figcaption>
    </figure>
  );
}
const caption = (label: string, e: Estimate) => e == null ? `${label} · …` : typeof e === 'string' ? `${label} · ${e}` : `${label} · ${kb(e.bytes)} · ${e.width}×${e.height}`;
// Formats an <img> cannot show are previewed through a PNG of the same pixels.
const SHOWN = (f: ExportFormat) => f !== 'tiff' && f !== 'tga';

const RESAMPLE: [string, MessageDescriptor][] = [
  ['auto', msg`Automatic`], ['bicubicSmoother', msg`Bicubic Smoother`], ['bicubicSharper', msg`Bicubic Sharper`], ['bicubic', msg`Bicubic`],
  ['bilinear', msg`Bilinear`], ['nearest', msg`Nearest Neighbor`], ['lanczos3', msg`Lanczos 3`],
];
const px = (v: number) => Math.min(65536, Math.max(1, Math.round(v) || 1));

export interface ExportRow { key: number; scale: number; suffix: string; format: ExportFormat; quality: number }
/** Export As image size and canvas size at 1x (null: the rendered size, the image size) and resample method. */
export interface ExportSizing { size: [number, number] | null; canvas: [number, number] | null; resample: string }
export const sizingOptions = (s: ExportSizing): Partial<ExportOptions> => ({ size: s.size ?? undefined, canvas: s.canvas ?? undefined, resample: s.resample });

export function ExportAsDialog({ ref, start }: { ref: Ref<ExportDialogHandle>; start: (rows: ExportRow[], target: ExportTarget | undefined, sizing: ExportSizing) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<ExportTarget>();
  const [rows, setRows] = useState<ExportRow[]>([{ key: 1, scale: 1, suffix: '', format: 'png', quality: 85 }]);
  const [sel, setSel] = useState(1);
  const [natural, setNatural] = useState<[number, number] | null>(null);
  const [sizing, setSizing] = useState<ExportSizing>({ size: null, canvas: null, resample: 'auto' });
  useImperativeHandle(ref, () => ({
    open(next) {
      setTarget(next); setOpen(true); setNatural(null); setSizing(s => ({ ...s, size: null, canvas: null }));
      void client.call('exportSize', next ? { layers: next.layers, trim: true, reveal: true } : {}).then(setNatural, () => setNatural(null));
      dialog.current?.showModal();
    },
  }));
  const targetOptions = target ? { layers: target.layers, trim: true, reveal: true } : {};
  const extra = { ...targetOptions, ...sizingOptions(sizing) };
  const est = useEstimates(rows.map(r => assetOptions(r.format, r.scale, r.quality, extra)), open);
  const row = rows.find(r => r.key === sel) ?? rows[0], at = rows.indexOf(row);
  const [shown] = useEstimates(SHOWN(row.format) ? [] : [assetOptions('png', row.scale, 100, extra)], open);
  const set = (k: number, p: Partial<ExportRow>) => setRows(rs => rs.map(r => (r.key === k ? { ...r, ...p } : r)));
  const close = () => { setOpen(false); dialog.current?.close(); };
  const [nw, nh] = natural ?? [1, 1], size = sizing.size ?? natural, canvas = sizing.canvas ?? size;
  const setSize = (w: number, h: number) => setSizing(s => ({ ...s, size: [px(w), px(h)] }));
  const preview = SHOWN(row.format) ? est[at] : shown;
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog export-dialog" aria-label={t`Export As`} onClose={() => setOpen(false)}>
      <form onSubmit={e => { e.preventDefault(); close(); start(rows, target, sizing); }}>
        <h2><Trans>Export As</Trans></h2>
        <div className="export-as-body">
          <Preview blob={preview && typeof preview !== 'string' ? preview.blob : null} caption={caption(row.suffix || FORMAT_LABEL[row.format], est[at])} />
          <div className="export-as-settings">
            <fieldset>
              <legend><Trans>Image Size</Trans></legend>
              <div className="row">
                <label><Trans>W</Trans> <NumberInput aria-label={t`Image width`} min={1} max={65536} disabled={!size} value={size?.[0] ?? 0} onValue={v => setSize(v, v * nh / nw)} /> px</label>
                <label><Trans>H</Trans> <NumberInput aria-label={t`Image height`} min={1} max={65536} disabled={!size} value={size?.[1] ?? 0} onValue={v => setSize(v * nw / nh, v)} /> px</label>
                <label><Trans>Scale</Trans> <NumberInput aria-label={t`Image scale`} min={1} max={10000} disabled={!size} value={size ? Math.round(size[0] / nw * 100) : 100} onValue={v => setSize(nw * v / 100, nh * v / 100)} /> %</label>
              </div>
              <label><Trans>Resample</Trans> <select value={sizing.resample} onChange={e => setSizing({ ...sizing, resample: e.currentTarget.value })}>
                {RESAMPLE.map(([v, m]) => <option key={v} value={v}>{i18n._(m)}</option>)}
              </select></label>
            </fieldset>
            <fieldset>
              <legend><Trans>Canvas Size</Trans></legend>
              <div className="row">
                <label><Trans>W</Trans> <NumberInput aria-label={t`Canvas width`} min={1} max={65536} disabled={!canvas} value={canvas?.[0] ?? 0} onValue={v => setSizing(s => ({ ...s, canvas: [px(v), canvas![1]] }))} /> px</label>
                <label><Trans>H</Trans> <NumberInput aria-label={t`Canvas height`} min={1} max={65536} disabled={!canvas} value={canvas?.[1] ?? 0} onValue={v => setSizing(s => ({ ...s, canvas: [canvas![0], px(v)] }))} /> px</label>
                <button type="button" disabled={!sizing.canvas && !sizing.size} onClick={() => setSizing(s => ({ ...s, size: null, canvas: null }))}><Trans>Reset</Trans></button>
              </div>
            </fieldset>
          </div>
        </div>
        <table className="export-rows">
          <thead><tr><th><Trans>Size</Trans></th><th><Trans>Suffix</Trans></th><th><Trans>Format</Trans></th><th><Trans>Quality</Trans></th><th><Trans>Estimate</Trans></th><th /></tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const e = est[i];
              return (
                <tr key={r.key} className={r.key === row.key ? 'selected' : ''} onClick={() => setSel(r.key)}>
                  <td><select aria-label={t`Size`} value={r.scale} onChange={ev => set(r.key, { scale: Number(ev.currentTarget.value) })}>
                    {[0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4].map(s => <option key={s} value={s}>{s}x</option>)}
                  </select></td>
                  <td><input aria-label={t`Suffix`} value={r.suffix} onChange={ev => set(r.key, { suffix: ev.currentTarget.value })} /></td>
                  <td><select aria-label={t`Format`} value={r.format} onChange={ev => set(r.key, { format: ev.currentTarget.value as ExportFormat })}>
                    {FORMATS.map(f => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
                  </select></td>
                  <td>{LOSSY(r.format)
                    ? <NumberInput aria-label={t`Quality`} min={1} max={100} value={r.quality} onValue={v => set(r.key, { quality: Math.min(100, Math.max(1, Math.round(v) || 1)) })} />
                    : <span className="hint">-</span>}</td>
                  <td className="hint">{e == null ? '…' : typeof e === 'string' ? e : `${kb(e.bytes)} · ${e.width}×${e.height}`}</td>
                  <td><button type="button" disabled={rows.length === 1} onClick={() => setRows(rs => rs.filter(x => x.key !== r.key))}><Trans>Remove</Trans></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="row">
          <button type="button" onClick={() => setRows(rs => [...rs, { key: Math.max(...rs.map(x => x.key)) + 1, scale: rs.length + 1, suffix: `@${rs.length + 1}x`, format: 'png', quality: 85 }])}><Trans>Add Size</Trans></button>
        </div>
        <p className="hint">{rows.length > 1 ? (canFolder() ? t`All sizes are written into one folder, chosen next.` : t`Each size downloads as its own file.`) : t`The file location is chosen next.`}</p>
        <div className="actions">
          <button type="button" onClick={close}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>Export</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export interface WebOptions { format: ExportFormat; scale: number; quality: number; colors: number; dither: Dither; matte: [number, number, number] | null }
export const webOptions = (w: WebOptions) => assetOptions(w.format, w.scale, w.quality, { colors: w.colors, dither: w.dither, matte: w.matte ?? undefined });

/** The 4-Up panes of `o`: lossy formats at half and a quarter of the quality, GIF and PNG-8 with half and a quarter
 * of the colors, other formats next to JPEG 60 and PNG-8. */
export function webVariants(o: WebOptions): WebOptions[] {
  if (LOSSY(o.format)) return [o, { ...o, quality: Math.max(1, Math.round(o.quality / 2)) }, { ...o, quality: Math.max(1, Math.round(o.quality / 4)) }];
  if (INDEXED(o.format)) return [o, { ...o, colors: Math.max(2, o.colors >> 1) }, { ...o, colors: Math.max(2, o.colors >> 2) }];
  return [o, { ...o, format: 'jpeg', quality: 60 }, { ...o, format: 'png8', colors: 256 }];
}

type WebView = 'original' | 'optimized' | '2up' | '4up';
const WEB_VIEWS: [WebView, MessageDescriptor][] = [['original', msg`Original`], ['optimized', msg`Optimized`], ['2up', msg`2-Up`], ['4up', msg`4-Up`]];
const hexRgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export function SaveForWebDialog({ ref, size, start }: { ref: Ref<ExportDialogHandle>; size: [number, number]; start: (o: WebOptions) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<WebView>('optimized');
  const [panes, setPanes] = useState<WebOptions[]>([{ format: 'jpeg', scale: 1, quality: 60, colors: 256, dither: 'diffusion', matte: null }]);
  const [active, setActive] = useState(0);
  const [matte, setMatte] = useState<'none' | 'white' | 'black' | 'custom'>('none');
  const [custom, setCustom] = useState('#808080');
  const matteRgb: WebOptions['matte'] = matte === 'none' ? null : matte === 'white' ? [255, 255, 255] : matte === 'black' ? [0, 0, 0] : hexRgb(custom);
  useImperativeHandle(ref, () => ({ open() { setOpen(true); dialog.current?.showModal(); } }));
  const o = { ...(panes[active] ?? panes[0]), matte: matteRgb };
  const setO = (p: WebOptions) => setPanes(ps => ps.map((x, i) => (i === active ? p : x)));
  const shown = view === '4up' ? panes.map(p => ({ ...p, matte: matteRgb })) : view === 'original' ? [] : [o];
  const original = view === 'optimized' ? [] : [assetOptions('png', o.scale, 100, {})];
  const est = useEstimates([...original, ...shown.map(webOptions)], open);
  const e = view === 'original' ? null : est[original.length + (view === '4up' ? active : 0)];
  function pickView(v: WebView) {
    if (v === '4up' && view !== '4up') { setPanes(webVariants(panes[active] ?? panes[0])); setActive(0); }
    if (v !== '4up' && view === '4up') { setPanes([panes[active]]); setActive(0); }
    setView(v);
  }
  const close = () => { setOpen(false); dialog.current?.close(); };
  const size1 = e != null && typeof e !== 'string' ? kb(e.bytes) : '';
  const dims = e != null && typeof e !== 'string' ? `${e.width}×${e.height}` : '';
  const pct = e != null && typeof e !== 'string' ? formatNumber(e.bytes / (size[0] * size[1] * 4) * 100, 1) : '';
  const reason = typeof e === 'string' ? e : '';
  const paneLabel = (p: WebOptions) => `${FORMAT_LABEL[p.format]}${LOSSY(p.format) ? ` ${p.quality}` : INDEXED(p.format) ? ` ${p.colors}` : ''}`;
  const blobOf = (x: Estimate) => (x && typeof x !== 'string' ? x.blob : null);
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog export-dialog" aria-label={t`Save for Web`} onClose={() => setOpen(false)}>
      <form onSubmit={ev => { ev.preventDefault(); close(); start(o); }}>
        <h2><Trans>Save for Web</Trans></h2>
        <div className="panel-tabs" role="tablist">
          {WEB_VIEWS.map(([v, m]) => <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'primary' : ''} onClick={() => pickView(v)}>{i18n._(m)}</button>)}
        </div>
        <div className={`web-views web-${view}`}>
          {original.length > 0 && <Preview blob={blobOf(est[0])} caption={caption(t`Original`, est[0])} />}
          {shown.map((p, i) => (
            <Preview key={i} blob={blobOf(est[original.length + i])} caption={caption(paneLabel(p), est[original.length + i])}
              active={view === '4up' && i === active} pick={view === '4up' ? () => setActive(i) : undefined} />
          ))}
        </div>
        <div className="row">
          <label><Trans>Format</Trans> <select value={o.format} onChange={ev => setO({ ...o, format: ev.currentTarget.value as ExportFormat })}>
            {(['jpeg', 'png', 'png8', 'gif', 'webp'] as const).map(f => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
          </select></label>
          <label><Trans>Scale</Trans> <select value={o.scale} onChange={ev => setO({ ...o, scale: Number(ev.currentTarget.value) })}>
            {[0.25, 0.5, 0.75, 1].map(s => <option key={s} value={s}>{s * 100}%</option>)}
          </select></label>
        </div>
        {LOSSY(o.format) && <div className="row"><label><Trans>Quality</Trans> <NumberInput min={1} max={100} value={o.quality} onValue={v => setO({ ...o, quality: Math.min(100, Math.max(1, Math.round(v) || 1)) })} /> %</label></div>}
        {INDEXED(o.format) && <div className="row">
          <label><Trans>Colors</Trans> <NumberInput min={2} max={256} value={o.colors} onValue={v => setO({ ...o, colors: Math.min(256, Math.max(2, Math.round(v) || 2)) })} /></label>
          <label><Trans>Dither</Trans> <select value={o.dither} onChange={ev => setO({ ...o, dither: ev.currentTarget.value as Dither })}>
            <option value="none">{t`None`}</option><option value="diffusion">{t`Diffusion`}</option><option value="pattern">{t`Pattern`}</option>
          </select></label>
        </div>}
        <div className="row">
          <label><Trans>Matte</Trans> <select value={matte} onChange={ev => setMatte(ev.currentTarget.value as typeof matte)}>
            <option value="none">{t`None`}</option><option value="white">{t`White`}</option><option value="black">{t`Black`}</option><option value="custom">{t`Custom`}</option>
          </select></label>
          {matte === 'custom' && <input type="color" aria-label={t`Matte color`} value={custom} onChange={ev => setCustom(ev.currentTarget.value)} />}
        </div>
        {view !== 'original' && <p className="hint">{e == null ? t`Measuring…` : typeof e === 'string' ? t`Cannot encode: ${reason}` : t`${size1} · ${dims} · ${pct}% of the uncompressed image`}</p>}
        <div className="actions">
          <button type="button" onClick={close}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>Save</Trans></button>
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
    <dialog ref={dialog} className="mode-dialog batch-dialog" aria-label={t`Export Preferences`}>
      <form onSubmit={e => { e.preventDefault(); savePrefs(p); dialog.current?.close(); }}>
        <h2><Trans>Export Preferences</Trans></h2>
        <div className="row">
          <label><Trans>Quick Export Format</Trans> <select value={p.format} onChange={e => setP({ ...p, format: e.currentTarget.value as ExportPrefs['format'] })}>
            <option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option>
          </select></label>
          {p.format !== 'png' && <label><Trans>Quality</Trans> <NumberInput min={1} max={100} value={p.quality} onValue={v => setP({ ...p, quality: Math.min(100, Math.max(1, Math.round(v) || 1)) })} /> %</label>}
        </div>
        <label className="radio"><input type="radio" name="xp-ask" checked={p.ask} onChange={() => setP({ ...p, ask: true })} /> <Trans>Ask where to export each time</Trans></label>
        <label className="radio"><input type="radio" name="xp-ask" checked={!p.ask} onChange={() => setP({ ...p, ask: false })} /> <Trans>Export files to the browser's downloads</Trans></label>
        <label className="radio"><input type="checkbox" checked={p.icc} onChange={e => setP({ ...p, icc: e.currentTarget.checked })} /> <Trans>Embed the color profile (PNG, JPEG and WebP)</Trans></label>
        <label className="radio"><input type="checkbox" checked={p.meta} onChange={e => setP({ ...p, meta: e.currentTarget.checked })} /> <Trans>Embed File Info: copyright and contact (PNG and JPEG)</Trans></label>
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
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
  const title = { layers: t`Layers to Files`, artboards: t`Artboards to Files`, pdf: t`Artboards to PDF`, datasets: t`Data Sets as Files` }[o.kind];
  const sets = o.kind === 'datasets';
  const ready = o.kind === 'pdf' || o.dest !== 'folder' || !!o.folder;
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog" aria-label={title}>
      <form onSubmit={e => { e.preventDefault(); if (!ready) return; dialog.current?.close(); start(o); }}>
        <h2>{title}</h2>
        {o.kind !== 'pdf' && <fieldset>
          <legend><Trans>Destination</Trans></legend>
          {canFolder() && <div className="row">
            <label className="radio"><input type="radio" name="fx-dest" checked={o.dest === 'folder'} onChange={() => setO({ ...o, dest: 'folder' })} /> <Trans>Folder</Trans></label>
            <button type="button" onClick={() => void pickFolder()}><Trans>Choose…</Trans></button>
            <span className="hint">{o.folder?.name ?? ''}</span>
          </div>}
          <label className="radio"><input type="radio" name="fx-dest" checked={o.dest === 'download'} onChange={() => setO({ ...o, dest: 'download' })} /> <Trans>Downloads</Trans></label>
        </fieldset>}
        <div className="row">
          {sets && <label><Trans>File Type</Trans> <select value={o.setFormat} onChange={e => setO({ ...o, setFormat: e.currentTarget.value as FilesOptions['setFormat'] })}>
            <option value="psd">PSD</option><option value="png">PNG</option><option value="jpeg">JPEG</option>
          </select></label>}
          {o.kind !== 'pdf' && !sets && <label><Trans>File Type</Trans> <select value={o.format} onChange={e => setO({ ...o, format: e.currentTarget.value as ExportFormat })}>
            {FORMATS.map(f => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
          </select></label>}
          {o.kind !== 'pdf' && !sets && <label><Trans>Size</Trans> <select value={o.scale} onChange={e => setO({ ...o, scale: Number(e.currentTarget.value) })}>
            {[0.5, 1, 2, 3].map(s => <option key={s} value={s}>{s * 100}%</option>)}
          </select></label>}
          {(o.kind === 'pdf' || (sets ? o.setFormat === 'jpeg' : LOSSY(o.format))) && <label>{o.kind === 'pdf' ? t`JPEG Quality` : t`Quality`} <NumberInput min={1} max={100} value={o.quality} onValue={v => setO({ ...o, quality: Math.min(100, Math.max(1, Math.round(v) || 1)) })} /> %</label>}
        </div>
        {o.kind === 'layers' && <>
          <label className="radio"><input type="checkbox" checked={o.trim} onChange={e => setO({ ...o, trim: e.currentTarget.checked })} /> <Trans>Trim to layer pixels</Trans></label>
          <label className="radio"><input type="checkbox" checked={o.nested} onChange={e => setO({ ...o, nested: e.currentTarget.checked })} /> <Trans>Include layers inside groups</Trans></label>
          <label className="radio"><input type="checkbox" checked={o.skipHidden} onChange={e => setO({ ...o, skipHidden: e.currentTarget.checked })} /> <Trans>Visible layers only</Trans></label>
        </>}
        {o.kind === 'pdf' && <p className="hint"><Trans>One page per artboard, at the document resolution.</Trans></p>}
        {sets && <p className="hint"><Trans>One file per data set, named after the document and the data set.</Trans></p>}
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary" disabled={!ready}><Trans>Run</Trans></button>
        </div>
      </form>
    </dialog>
  );
}
