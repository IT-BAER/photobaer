// File > File Info and File > Print.
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { client } from './client.ts';
import { emptyInfo, xmpPacket, type FileInfo } from './app/fileInfo.ts';
import { PAPERS, printLayout, type PrintSettings } from './app/print.ts';
import { NumberInput } from './shell/NumberInput.tsx';

export interface FileInfoHandle { open(info: FileInfo | null): void }

export function FileInfoDialog({ ref, commit }: { ref: Ref<FileInfoHandle>; commit: (i: FileInfo) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [i, setI] = useState(emptyInfo);
  const [keywords, setKeywords] = useState('');
  const [tab, setTab] = useState<'description' | 'xmp'>('description');
  useImperativeHandle(ref, () => ({
    open(info) { const v = info ?? emptyInfo(); setI(v); setKeywords(v.keywords.join(', ')); setTab('description'); dialog.current?.showModal(); },
  }));
  const value = (): FileInfo => ({ ...i, keywords: keywords.split(/[,;]/).map(k => k.trim()).filter(Boolean) });
  const text = (label: string, k: Exclude<keyof FileInfo, 'keywords'>) =>
    <label>{label} <input value={i[k]} onChange={e => setI({ ...i, [k]: e.currentTarget.value })} /></label>;
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog file-info-dialog" aria-label={t`File Info`}>
      <form onSubmit={e => { e.preventDefault(); dialog.current?.close(); commit(value()); }}>
        <h2><Trans>File Info</Trans></h2>
        <div className="row" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'description'} className={tab === 'description' ? 'primary' : ''} onClick={() => setTab('description')}><Trans>Description</Trans></button>
          <button type="button" role="tab" aria-selected={tab === 'xmp'} className={tab === 'xmp' ? 'primary' : ''} onClick={() => setTab('xmp')}><Trans>Raw XMP</Trans></button>
        </div>
        {tab === 'description' ? <>
          {text(t`Document Title`, 'title')}
          {text(t`Author`, 'author')}
          <label><Trans>Description</Trans> <textarea rows={3} value={i.description} onChange={e => setI({ ...i, description: e.currentTarget.value })} /></label>
          <label><Trans>Keywords</Trans> <input value={keywords} onChange={e => setKeywords(e.currentTarget.value)} /></label>
          <p className="hint"><Trans>Separate keywords with commas or semicolons.</Trans></p>
          {text(t`Copyright Notice`, 'copyright')}
          {text(t`Copyright Info URL`, 'copyright_url')}
        </> : <>
          <textarea className="xmp" aria-label={t`XMP packet`} readOnly rows={12} spellCheck={false} value={xmpPacket(value())} />
          <p className="hint"><Trans>Saved into PSD files, and into PNG and JPEG exports when Export Preferences include File Info.</Trans></p>
        </>}
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export interface PrintDoc { width: number; height: number; resolution: number }
export interface PrintHandle { open(d: PrintDoc): void }

// The image position follows a drag on the preview (offsets from the margins, in mm).
export function PrintDialog({ ref, settings, start }: { ref: Ref<PrintHandle>; settings: PrintSettings; start: (s: PrintSettings) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [d, setD] = useState<PrintDoc | null>(null);
  const [s, setS] = useState(settings);
  const [src, setSrc] = useState('');
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  useImperativeHandle(ref, () => ({ open(doc) { setD(doc); setS(settings); dialog.current?.showModal(); } }));
  useEffect(() => {
    if (!d) return;
    let url = '', dead = false;
    setSrc('');
    const scale = Math.min(1, 1200 / Math.max(d.width, d.height));
    client.call('exportAsset', { format: 'png', quality: 1, scale, colors: 256, dither: 'none', icc: false })
      .then(r => { if (!dead) { url = URL.createObjectURL(r.blob); setSrc(url); } }, () => {});
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  }, [d]);
  const set = (p: Partial<PrintSettings>) => setS(o => ({ ...o, ...p }));
  const num = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
  const l = d ? printLayout(d.width, d.height, d.resolution, s) : null;
  const close = () => { dialog.current?.close(); setD(null); };
  const outside = l && (l.xMm < s.marginMm - 0.01 || l.yMm < s.marginMm - 0.01 || l.xMm + l.widthMm > l.pageWidthMm - s.marginMm + 0.01 || l.yMm + l.heightMm > l.pageHeightMm - s.marginMm + 0.01);
  let sizeText = '';
  if (l) {
    const w = l.widthMm.toFixed(1), h = l.heightMm.toFixed(1), pct = Math.round(l.scale * 100), pw = l.pageWidthMm.toFixed(0), ph = l.pageHeightMm.toFixed(0);
    sizeText = t`${w} × ${h} mm at ${pct}% on a ${pw} × ${ph} mm page.`;
  }
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog print-dialog" aria-label={t`Print`} onClose={() => setD(null)}>
      <form onSubmit={e => { e.preventDefault(); close(); start(s); }}>
        <h2><Trans>Print</Trans></h2>
        <div className="print-layout">
          {l && <svg className="print-preview" role="img" aria-label={t`Print preview`} viewBox={`0 0 ${l.pageWidthMm} ${l.pageHeightMm}`}
            onPointerMove={e => {
              const g = drag.current, r = e.currentTarget.getBoundingClientRect();
              if (!g || g.id !== e.pointerId) return;
              const mm = l.pageWidthMm / r.width, round = (v: number) => Math.round(v * 100) / 100;
              set({ centered: false, offsetXMm: round(g.left + (e.clientX - g.x) * mm - s.marginMm), offsetYMm: round(g.top + (e.clientY - g.y) * mm - s.marginMm) });
            }}
            onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
            <rect width={l.pageWidthMm} height={l.pageHeightMm} fill="#fff" />
            <rect x={s.marginMm} y={s.marginMm} width={Math.max(0, l.pageWidthMm - s.marginMm * 2)} height={Math.max(0, l.pageHeightMm - s.marginMm * 2)} fill="none" stroke="#9ab" strokeWidth={0.3} strokeDasharray="1 1" />
            {src && <image href={src} x={l.xMm} y={l.yMm} width={l.widthMm} height={l.heightMm} preserveAspectRatio="none" style={{ cursor: 'grab' }}
              onPointerDown={e => {
                if (e.button !== 0) return;
                e.preventDefault();
                drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: l.xMm, top: l.yMm };
                e.currentTarget.ownerSVGElement?.setPointerCapture(e.pointerId);
              }} />}
          </svg>}
          <div className="print-settings">
            <div className="row">
              <label><Trans>Paper</Trans> <select value={s.paper} onChange={e => set({ paper: e.currentTarget.value as PrintSettings['paper'] })}>
                {PAPERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select></label>
              <label><Trans>Orientation</Trans> <select value={s.orientation} onChange={e => set({ orientation: e.currentTarget.value as PrintSettings['orientation'] })}>
                <option value="portrait">{t`Portrait`}</option><option value="landscape">{t`Landscape`}</option>
              </select></label>
            </div>
            <div className="row">
              <label><Trans>Scaled Print Size</Trans> <select value={s.sizing} onChange={e => set({ sizing: e.currentTarget.value as PrintSettings['sizing'] })}>
                <option value="fit">{t`Scale to Fit Media`}</option><option value="actual">{t`Actual Size`}</option><option value="custom">{t`Custom`}</option>
              </select></label>
              <label><Trans>Scale</Trans> <NumberInput min={1} max={1000} disabled={s.sizing !== 'custom'} value={Math.round(s.scale * 100)} onValue={v => set({ scale: num(v, 1, 1000) / 100 })} /> %</label>
            </div>
            <div className="row">
              <label><Trans>Margin</Trans> <NumberInput min={0} max={50} step="any" value={s.marginMm} onValue={v => set({ marginMm: num(v, 0, 50) })} /> mm</label>
              <label><Trans>Bleed</Trans> <NumberInput min={0} max={20} step="any" value={s.bleedMm} onValue={v => set({ bleedMm: num(v, 0, 20) })} /> mm</label>
            </div>
            <label className="radio"><input type="checkbox" checked={s.centered} onChange={e => set({ centered: e.currentTarget.checked })} /> <Trans>Center the image on the page</Trans></label>
            {!s.centered && <div className="row">
              <label><Trans>Left</Trans> <NumberInput step="any" value={s.offsetXMm} onValue={v => set({ offsetXMm: num(v, -1000, 1000) })} /> mm</label>
              <label><Trans>Top</Trans> <NumberInput step="any" value={s.offsetYMm} onValue={v => set({ offsetYMm: num(v, -1000, 1000) })} /> mm</label>
            </div>}
            <label className="radio"><input type="checkbox" checked={s.cropMarks} onChange={e => set({ cropMarks: e.currentTarget.checked })} /> <Trans>Crop marks</Trans></label>
            <label className="radio"><input type="checkbox" checked={s.registrationMarks} onChange={e => set({ registrationMarks: e.currentTarget.checked })} /> <Trans>Registration marks</Trans></label>
            <label className="radio"><input type="checkbox" checked={s.labels} onChange={e => set({ labels: e.currentTarget.checked })} /> <Trans context="print option">Label</Trans></label>
            {l && <p className="hint">{sizeText}</p>}
            {outside && <p className="hint" role="alert"><Trans>The image extends past the margins.</Trans></p>}
            <p className="hint"><Trans>Printer, copies and "Save as PDF" are chosen in the browser's print dialog, which opens next.</Trans></p>
          </div>
        </div>
        <div className="actions">
          <button type="button" onClick={close}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary" disabled={!src}><Trans>Print</Trans></button>
        </div>
      </form>
    </dialog>
  );
}
