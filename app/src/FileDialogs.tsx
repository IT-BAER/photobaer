// File > File Info and File > Print.
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { client } from './client.ts';
import { errorLabel } from './i18n/errors.ts';
import { formatNumber } from './i18n/numbers.ts';
import { applyTemplate, emptyInfo, rawXmpInfo, xmpPacket, type FileInfo, type TemplateMode } from './app/fileInfo.ts';
import { cameraRows } from './app/cameraData.ts';
import { PAPERS, printLayout, type PrintSettings } from './app/print.ts';
import { NumberInput } from './shell/NumberInput.tsx';

export interface FileInfoHandle { open(info: FileInfo | null): void }

type InfoTab = 'basic' | 'camera' | 'origin' | 'iptc' | 'xmp';
type Core = Exclude<keyof FileInfo, 'keywords' | 'extra' | 'camera'>;
const CORE = new Set<string>(['title', 'author', 'description', 'copyright', 'copyright_url']);

// The worker's warning text, translated by errorLabel.
const CUT = 'File Info values over the limits were shortened.';
// Saved templates (name to XMP packet) stay in this browser, like Photoshop's metadata template folder.
const TEMPLATES = 'photobaer.fileInfoTemplates';
function loadTemplates(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(TEMPLATES) ?? '{}');
    return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) : {};
  } catch { return {}; }
}
function storeTemplates(m: Record<string, string>) { try { localStorage.setItem(TEMPLATES, JSON.stringify(m)); } catch { /* storage blocked */ } }

export function FileInfoDialog({ ref, commit }: { ref: Ref<FileInfoHandle>; commit: (i: FileInfo) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [i, setI] = useState(emptyInfo);
  const [keywords, setKeywords] = useState('');
  const [tab, setTab] = useState<InfoTab>('basic');
  const [raw, setRaw] = useState<{ text: string; edited: boolean }>({ text: '', edited: false });
  const [error, setError] = useState('');
  const [templates, setTemplates] = useState<Record<string, string>>({});
  const [template, setTemplate] = useState('');
  const [mode, setMode] = useState<TemplateMode>('replace');
  const [name, setName] = useState('');
  const show = (v: FileInfo) => { setI(v); setKeywords(v.keywords.join(', ')); };
  useImperativeHandle(ref, () => ({
    open(info) {
      show(info ?? emptyInfo()); setTab('basic'); setError(''); setTemplates(loadTemplates()); setTemplate(''); setName('');
      dialog.current?.showModal();
    },
  }));
  const value = (): FileInfo => ({ ...i, keywords: keywords.split(/[,;]/).map(k => k.trim()).filter(Boolean) });
  // The edited Raw Data read back; false (with the message shown) while it is not well-formed.
  const leaveRaw = (onCut?: () => void): FileInfo | false => {
    if (tab !== 'xmp' || !raw.edited) return value();
    const v = rawXmpInfo(raw.text, value(), () => { setError(errorLabel(CUT)); onCut?.(); });
    if (!v) { setError(t`The XMP is not well-formed. Correct it before you leave Raw Data.`); return false; }
    show(v);
    return v;
  };
  const go = (to: InfoTab) => {
    setError('');
    const v = leaveRaw();
    if (!v) return;
    if (to === 'xmp') setRaw({ text: xmpPacket(v), edited: false });
    setTab(to);
  };
  const get = (k: string) => (CORE.has(k) ? i[k as Core] : i.extra?.[k] ?? '');
  const set = (k: string, v: string) => setI(CORE.has(k) ? { ...i, [k]: v } : { ...i, extra: { ...i.extra, [k]: v } });
  const field = (label: string, k: string) => <label>{label} <input value={get(k)} onChange={e => set(k, e.currentTarget.value)} /></label>;
  const area = (label: string, k: string) => <label>{label} <textarea rows={3} value={get(k)} onChange={e => set(k, e.currentTarget.value)} /></label>;
  const choice = (label: string, k: string, options: [string, string][]) =>
    <label>{label} <select value={get(k)} onChange={e => set(k, e.currentTarget.value)}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>;
  const date = (label: string, k: string) => {
    const v = get(k), d = /^\d{4}-\d\d-\d\d/.test(v) ? v.slice(0, 10) : '';
    return <label>{label} <input type="date" value={d} onChange={e => set(k, e.currentTarget.value ? e.currentTarget.value + (d ? v.slice(10) : '') : '')} /></label>;
  };
  const keywordField = <>
    <label><Trans>Keywords</Trans> <input value={keywords} onChange={e => setKeywords(e.currentTarget.value)} /></label>
    <p className="hint"><Trans>Separate keywords with commas or semicolons.</Trans></p>
  </>;
  const tabButton = (id: InfoTab, label: string) =>
    <button type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'primary' : ''} onClick={() => go(id)}>{label}</button>;
  // A template never carries Camera Data.
  const packet = (v: FileInfo) => xmpPacket({ ...v, camera: undefined });
  const apply = (x: string) => {
    setError('');
    const v = leaveRaw();
    if (!v) return;
    const tpl = rawXmpInfo(x, emptyInfo(), () => setError(errorLabel(CUT)));
    if (!tpl) { setError(t`The template is not a well-formed XMP file.`); return; }
    const r = applyTemplate(v, tpl, mode);
    show(r);
    if (tab === 'xmp') setRaw({ text: xmpPacket(r), edited: false });
  };
  const saveTemplate = () => {
    const v = leaveRaw(), n = name.trim();
    if (!v || !n) return;
    const m = { ...templates, [n]: packet(v) };
    storeTemplates(m); setTemplates(m); setTemplate(n); setName('');
  };
  const deleteTemplate = () => {
    if (!template) return;
    const m = { ...templates };
    delete m[template];
    storeTemplates(m); setTemplates(m); setTemplate('');
  };
  const exportTemplate = () => {
    const v = leaveRaw();
    if (!v) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([packet(v)], { type: 'application/rdf+xml' }));
    a.download = `${(name.trim() || template || 'metadata').replace(/[\\/:*?"<>|]/g, '_')}.xmp`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  };
  const cameraList = cameraRows(i.camera ?? {});
  const urgency: [string, string][] = [['', t`None`], ['1', t`High`], ['2', '2'], ['3', '3'], ['4', '4'], ['5', t`Normal`], ['6', '6'], ['7', '7'], ['8', t`Low`]];
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog file-info-dialog" aria-label={t`File Info`}>
      {/* Shortened Raw Data stays open with the warning and the shortened packet; the next OK commits it. */}
      <form onSubmit={e => {
        e.preventDefault(); let cut = false;
        const v = leaveRaw(() => { cut = true; }); if (!v) return;
        if (cut) { setRaw({ text: xmpPacket(v), edited: false }); return; }
        dialog.current?.close(); commit(v);
      }}>
        <h2><Trans>File Info</Trans></h2>
        <div className="row" role="tablist">
          {tabButton('basic', t`Basic`)}
          {tabButton('camera', t`Camera Data`)}
          {tabButton('origin', t`Origin`)}
          {tabButton('iptc', 'IPTC')}
          {tabButton('xmp', t`Raw Data`)}
        </div>
        <div className="file-info-body" role="tabpanel">
          {tab === 'basic' && <>
            {field(t`Document Title`, 'title')}
            {field(t`Author`, 'author')}
            {field(t`Author Title`, 'photoshop:AuthorsPosition')}
            {area(t`Description`, 'description')}
            {choice(t`Rating`, 'xmp:Rating', [['', t`None`], ['-1', t`Reject`], ['1', '★'], ['2', '★★'], ['3', '★★★'], ['4', '★★★★'], ['5', '★★★★★']])}
            {field(t`Description Writer`, 'photoshop:CaptionWriter')}
            {keywordField}
            {choice(t`Copyright Status`, 'xmpRights:Marked', [['', t`Unknown`], ['True', t`Copyrighted`], ['False', t`Public Domain`]])}
            {field(t`Copyright Notice`, 'copyright')}
            {field(t`Copyright Info URL`, 'copyright_url')}
          </>}
          {tab === 'camera' && (cameraList.length
            ? <table className="camera-data"><tbody>{cameraList.map(r => <tr key={r.key}><th scope="row">{r.label}</th><td>{r.value}</td></tr>)}</tbody></table>
            : <p className="hint"><Trans>This document has no camera data. It is read from the EXIF data of opened JPEG, PNG, WebP and PSD files.</Trans></p>)}
          {tab === 'origin' && <>
            {date(t`Date Created`, 'photoshop:DateCreated')}
            {field(t`City`, 'photoshop:City')}
            {field(t`State/Province`, 'photoshop:State')}
            {field(t`Country`, 'photoshop:Country')}
            {field(t`Credit Line`, 'photoshop:Credit')}
            {field(t`Source`, 'photoshop:Source')}
            {field(t`Headline`, 'photoshop:Headline')}
            {area(t`Instructions`, 'photoshop:Instructions')}
            {field(t`Transmission Reference`, 'photoshop:TransmissionReference')}
            {choice(t`Urgency`, 'photoshop:Urgency', urgency)}
          </>}
          {tab === 'iptc' && <>
            <fieldset><legend><Trans>IPTC Contact</Trans></legend>
              {field(t`Creator`, 'author')}
              {field(t`Creator's Job Title`, 'photoshop:AuthorsPosition')}
              {field(t`Address`, 'Iptc4xmpCore:CiAdrExtadr')}
              {field(t`City`, 'Iptc4xmpCore:CiAdrCity')}
              {field(t`State/Province`, 'Iptc4xmpCore:CiAdrRegion')}
              {field(t`Postal Code`, 'Iptc4xmpCore:CiAdrPcode')}
              {field(t`Country`, 'Iptc4xmpCore:CiAdrCtry')}
              {field(t`Phone(s)`, 'Iptc4xmpCore:CiTelWork')}
              {field(t`Email(s)`, 'Iptc4xmpCore:CiEmailWork')}
              {field(t`Website(s)`, 'Iptc4xmpCore:CiUrlWork')}
            </fieldset>
            <fieldset><legend><Trans>IPTC Content</Trans></legend>
              {field(t`Headline`, 'photoshop:Headline')}
              {area(t`Description`, 'description')}
              {keywordField}
              {field(t`IPTC Subject Code`, 'Iptc4xmpCore:SubjectCode')}
              {field(t`Description Writer`, 'photoshop:CaptionWriter')}
            </fieldset>
            <fieldset><legend><Trans>IPTC Image</Trans></legend>
              {date(t`Date Created`, 'photoshop:DateCreated')}
              {field(t`Intellectual Genre`, 'Iptc4xmpCore:IntellectualGenre')}
              {field(t`IPTC Scene Code`, 'Iptc4xmpCore:Scene')}
              {field(t`Sublocation`, 'Iptc4xmpCore:Location')}
              {field(t`City`, 'photoshop:City')}
              {field(t`State/Province`, 'photoshop:State')}
              {field(t`Country`, 'photoshop:Country')}
              {field(t`ISO Country Code`, 'Iptc4xmpCore:CountryCode')}
            </fieldset>
            <fieldset><legend><Trans>IPTC Status</Trans></legend>
              {field(t`Title`, 'title')}
              {field(t`Job Identifier`, 'photoshop:TransmissionReference')}
              {area(t`Instructions`, 'photoshop:Instructions')}
              {field(t`Credit Line`, 'photoshop:Credit')}
              {field(t`Source`, 'photoshop:Source')}
              {field(t`Copyright Notice`, 'copyright')}
              {area(t`Rights Usage Terms`, 'xmpRights:UsageTerms')}
            </fieldset>
            <p className="hint"><Trans>Separate several subject codes, scene codes, phones, emails or websites with semicolons.</Trans></p>
          </>}
          {tab === 'xmp' && <>
            <textarea className="xmp" aria-label={t`XMP packet`} rows={16} spellCheck={false} value={raw.text}
              onChange={e => { setRaw({ text: e.currentTarget.value, edited: true }); setError(''); }} />
            <p className="hint"><Trans>Saved into PSD files, and into PNG and JPEG exports when Export Preferences include File Info.</Trans></p>
          </>}
        </div>
        {error && <p className="hint bad" role="alert">{error}</p>}
        <fieldset><legend><Trans>Templates</Trans></legend>
          <div className="row">
            <select aria-label={t`Template`} value={template} onChange={e => setTemplate(e.currentTarget.value)}>
              <option value="">{t`Choose a template`}</option>
              {Object.keys(templates).sort().map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            <button type="button" disabled={!template} onClick={() => apply(templates[template])}><Trans>Apply</Trans></button>
            <button type="button" disabled={!template} onClick={deleteTemplate}><Trans>Delete</Trans></button>
          </div>
          <select aria-label={t`When applying a template`} value={mode} onChange={e => setMode(e.currentTarget.value as TemplateMode)}>
            <option value="clear">{t`Clear existing properties and replace with template properties`}</option>
            <option value="replace">{t`Keep original metadata but replace matching properties from template`}</option>
            <option value="append">{t`Keep original metadata, but append matching properties from template`}</option>
          </select>
          <div className="row">
            <input aria-label={t`Template name`} value={name} onChange={e => setName(e.currentTarget.value)} />
            <button type="button" disabled={!name.trim()} onClick={saveTemplate}><Trans>Save Template</Trans></button>
            <button type="button" onClick={() => importInput.current?.click()}><Trans>Import...</Trans></button>
            <button type="button" onClick={exportTemplate}><Trans>Export...</Trans></button>
            <input ref={importInput} type="file" hidden accept=".xmp,application/rdf+xml" aria-label={t`Import metadata template`}
              onChange={e => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) void f.text().then(apply, () => setError(t`The template is not a well-formed XMP file.`)); }} />
          </div>
        </fieldset>
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
    const w = formatNumber(l.widthMm, 1), h = formatNumber(l.heightMm, 1), pct = Math.round(l.scale * 100), pw = formatNumber(l.pageWidthMm, 0), ph = formatNumber(l.pageHeightMm, 0);
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
