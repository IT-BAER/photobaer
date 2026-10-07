// File > Open of a .pdf: Import PDF picks pages (rendered over the crop or media box at a chosen size) or the
// images in the file; each opens as its own document, then converts to the chosen mode and bit depth.
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { MessageDescriptor } from '@lingui/core';
import { msg, plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { i18n } from './i18n/index.ts';
import type { PdfImageRef } from './app/pdf.ts';
import { boxReader } from './app/pdfBoxes.ts';
import { pixels, rasterSize, type RasterSize } from './app/rasterSize.ts';
import { RasterFields } from './SvgDialog.tsx';

export type PdfMode = 'rgb' | 'gray' | 'cmyk' | 'lab';
export interface PdfImport { files: File[]; ppi: number; mode: PdfMode; depth: 8 | 16 }
export interface PdfDialogHandle {
  ask(file: File): Promise<PdfImport | null>;
}

const pdfjs = () => import('./app/pdf.ts');
const isPassword = (e: unknown) => (e as Error)?.name === 'PasswordException';
const MODES: [PdfMode, MessageDescriptor][] = [['gray', msg`Grayscale`], ['rgb', msg`RGB Color`], ['cmyk', msg`CMYK Color`], ['lab', msg`Lab Color`]];

export function PdfDialog({ ref, setError }: { ref: Ref<PdfDialogHandle>; setError: (msg: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const answer = useRef<((a: PdfImport | null) => void) | null>(null);
  const job = useRef(0);
  const urls = useRef<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [password, setPassword] = useState<{ value: string; wrong: boolean } | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [sizes, setSizes] = useState<[number, number][]>([]);
  // Media box and its rotated size per page; null where the file gives none (the crop is used).
  const [media, setMedia] = useState<({ box: number[]; size: [number, number] } | null)[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set([1]));
  const [select, setSelect] = useState<'pages' | 'images'>('pages');
  const [cropTo, setCropTo] = useState<'crop' | 'media'>('crop');
  const [images, setImages] = useState<{ img: PdfImageRef; url: string }[] | null>(null);
  const [pickedImages, setPickedImages] = useState<Set<string>>(new Set());
  const [imagesDone, setImagesDone] = useState(false);
  const [size, setSize] = useState(rasterSize(300));
  // Enter commits a size field on blur just before the form submits, so OK reads the newest size here.
  const latest = useRef(size);
  const set = (s: RasterSize) => { latest.current = s; setSize(s); };
  const [mode, setMode] = useState<PdfMode>('rgb');
  const [depth, setDepth] = useState<8 | 16>(8);
  const [busy, setBusy] = useState(false);

  async function load(f: File, pw?: string) {
    const j = ++job.current;
    try {
      const { loadPdf, thumbnail } = await pdfjs();
      const doc = await loadPdf(new Uint8Array(await f.arrayBuffer()), pw);
      if (j !== job.current) { void doc.loadingTask.destroy(); return; }
      setPassword(null);
      setPdf(doc);
      const sz: [number, number][] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const v = (await doc.getPage(n)).getViewport({ scale: 1 });
        sz.push([v.width, v.height]);
      }
      if (j !== job.current) return;
      setSizes(sz);
      for (let n = 1; n <= doc.numPages && j === job.current; n++) {
        const url = await thumbnail(doc, n, 96);
        urls.current.push(url);
        if (j === job.current) setThumbs(prev => [...prev, url]);
      }
    } catch (e) {
      if (j !== job.current) return;
      if (isPassword(e)) setPassword({ value: '', wrong: pw !== undefined });
      else { close(null); { const name = f.name, reason = (e as Error).message; setError(t`Could not open ${name}: ${reason}`); }; }
    }
  }

  async function loadMedia() {
    if (!pdf || !file || media) return;
    const j = job.current;
    try {
      const { pageSize } = await pdfjs();
      const read = boxReader(new Uint8Array(await file.arrayBuffer()));
      const out: ({ box: number[]; size: [number, number] } | null)[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n), b = page.ref ? await read(page.ref) : null;
        out.push(b ? { box: b.media, size: await pageSize(pdf, n, b.media) } : null);
      }
      if (j === job.current) setMedia(out);
    } catch (e) { { const reason = (e as Error).message; setError(t`Could not read the media boxes: ${reason}`); }; }
  }

  async function loadImages() {
    if (!pdf || images) return;
    const j = job.current;
    setImages([]);
    try {
      const { pageImages, thumbnail } = await pdfjs();
      const all: { img: PdfImageRef; url: string }[] = [];
      for (let n = 1; n <= pdf.numPages && j === job.current; n++) {
        for (const img of await pageImages(pdf, n)) {
          const url = await thumbnail(null, n, 96, img.canvas);
          urls.current.push(url);
          all.push({ img, url });
        }
        if (j === job.current) setImages([...all]);
      }
      if (j !== job.current) return;
      if (all.length) setPickedImages(new Set([all[0].img.key]));
      setImagesDone(true);
    } catch (e) { { const reason = (e as Error).message; setError(t`Could not read the images: ${reason}`); }; }
  }

  useImperativeHandle(ref, () => ({
    ask(f) {
      answer.current?.(null);
      setFile(f); setPdf(null); setThumbs([]); setSizes([]); setMedia(null); setPicked(new Set([1])); setPassword(null); setBusy(false);
      setSelect('pages'); setCropTo('crop'); setImages(null); setPickedImages(new Set()); setImagesDone(false);
      dialog.current?.showModal();
      void load(f);
      return new Promise(r => { answer.current = r; });
    },
  }));

  function close(a: PdfImport | null) {
    job.current++;
    const r = answer.current;
    answer.current = null;
    dialog.current?.close();
    void pdf?.loadingTask.destroy();
    setPdf(null);
    setImages(null);
    for (const u of urls.current.splice(0)) URL.revokeObjectURL(u);
    r?.(a);
  }

  async function ok() {
    if (!pdf || !file) return;
    setBusy(true);
    try {
      const { renderPage, imagePng } = await pdfjs();
      const base = file.name.replace(/\.[^.]+$/, '');
      const files: File[] = [];
      if (select === 'images') {
        let k = 0;
        for (const { img } of images ?? []) {
          k++;
          if (pickedImages.has(img.key)) files.push(new File([await imagePng(img)], `${base}-image-${k}.png`, { type: 'image/png' }));
        }
        // Images open at their own pixels; 72 ppi keeps their print size equal to their pixel count in pt.
        close({ files, ppi: 72, mode, depth });
        return;
      }
      const s = latest.current;
      for (const n of [...picked].sort((a, b) => a - b)) {
        const box = cropTo === 'media' ? media?.[n - 1]?.box : undefined;
        const png = await renderPage(pdf, n, s.sx, s.sy, box);
        files.push(new File([png], `${base}${pdf.numPages > 1 ? `-${n}` : ''}.png`, { type: 'image/png' }));
      }
      close({ files, ppi: s.ppi, mode, depth });
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
    }
  }

  const toggle = (n: number) => setPicked(p => { const s = new Set(p); if (s.has(n)) s.delete(n); else s.add(n); return s; });
  const toggleImage = (k: string) => setPickedImages(p => { const s = new Set(p); if (s.has(k)) s.delete(k); else s.add(k); return s; });
  const firstPage = [...picked].sort((a, b) => a - b)[0];
  const base = (cropTo === 'media' && media?.[firstPage - 1]?.size) || sizes[firstPage - 1];
  const ready = select === 'images' ? pickedImages.size > 0 : !!pdf && picked.size > 0 && (cropTo === 'crop' || !!media);

  return (
    <dialog ref={dialog} className="mode-dialog pdf-dialog" aria-label={t`Import PDF`} onClose={() => { if (answer.current) close(null); }}>
      {file && (
        <form onSubmit={e => { e.preventDefault(); if (password) { setPassword(null); void load(file, password.value); } else void ok(); }}>
          <h2><Trans>Import PDF</Trans></h2>
          {password ? <>
            <p>{password.wrong ? t`The password is wrong. ${file.name} is protected.` : t`${file.name} is protected.`}</p>
            <label><Trans>PDF password</Trans> <input type="password" aria-label={t`PDF password`} autoFocus value={password.value} onChange={e => setPassword({ value: e.currentTarget.value, wrong: password.wrong })} /></label>
          </> : <>
            <div className="row" role="radiogroup" aria-label={t`Select`}>
              <label className="check"><input type="radio" name="pdf-select" checked={select === 'pages'} onChange={() => setSelect('pages')} /> <Trans>Pages</Trans></label>
              <label className="check"><input type="radio" name="pdf-select" checked={select === 'images'} onChange={() => { setSelect('images'); void loadImages(); }} /> <Trans>Images</Trans></label>
            </div>
            {select === 'pages' ? <>
              <div className="pdf-pages" role="listbox" aria-label={t`Pages`} aria-multiselectable="true">
                {sizes.map((_, i) => (
                  <button type="button" key={i} role="option" aria-selected={picked.has(i + 1)} className={picked.has(i + 1) ? 'on' : ''} onClick={() => toggle(i + 1)}>
                    {thumbs[i] ? <img src={thumbs[i]} alt="" /> : <span className="pdf-blank" />}
                    <span>{i + 1}</span>
                  </button>
                ))}
                {!sizes.length && <p><Trans>Reading {file.name}…</Trans></p>}
              </div>
              <div className="row">
                <button type="button" onClick={() => setPicked(new Set(sizes.map((_, i) => i + 1)))}><Trans>Select All</Trans></button>
                <button type="button" onClick={() => setPicked(new Set())}><Trans>Deselect All</Trans></button>
              </div>
              <label><Trans>Crop To</Trans> <select aria-label={t`Crop To`} value={cropTo} onChange={e => { const v = e.currentTarget.value as 'crop' | 'media'; setCropTo(v); if (v === 'media') void loadMedia(); }}>
                <option value="crop">{t`Crop Box`}</option>
                <option value="media">{t`Media Box`}</option>
              </select></label>
              {base && <RasterFields base={base} size={size} set={set} />}
              {base && picked.size > 1 && <p className="hint">{plural(picked.size, { one: `Page ${firstPage} shown; # page at the same scale.`, other: `Page ${firstPage} shown; # pages at the same scale.` })}</p>}
            </> : (
              <div className="pdf-pages" role="listbox" aria-label={t`Images`} aria-multiselectable="true">
                {(images ?? []).map(({ img, url }, i) => (
                  <button type="button" key={img.key} role="option" aria-selected={pickedImages.has(img.key)} className={pickedImages.has(img.key) ? 'on' : ''} onClick={() => toggleImage(img.key)}>
                    <img src={url} alt="" />
                    <span>{i + 1}: {img.width} x {img.height}</span>
                  </button>
                ))}
                {!images?.length && <p>{imagesDone ? t`The PDF has no images.` : t`Reading the images…`}</p>}
              </div>
            )}
            <label><Trans>Mode</Trans> <select aria-label={t`Mode`} value={mode} onChange={e => setMode(e.currentTarget.value as PdfMode)}>
              {MODES.map(([v, l]) => <option key={v} value={v}>{i18n._(l)}</option>)}
            </select></label>
            <label><Trans>Bit Depth</Trans> <select aria-label={t`Bit Depth`} value={depth} onChange={e => setDepth(+e.currentTarget.value as 8 | 16)}>
              <option value={8}>{t`8 bit`}</option>
              <option value={16}>{t`16 bit`}</option>
            </select></label>
            {select === 'pages' && base && <p className="hint">{pixels(size, base).join(' x ')} px</p>}
          </>}
          <div className="actions">
            <button type="button" onClick={() => close(null)}><Trans>Cancel</Trans></button>
            <button type="submit" className="primary" disabled={busy || (!password && !ready)}>{password ? t`Unlock` : t`OK`}</button>
          </div>
        </form>
      )}
    </dialog>
  );
}
