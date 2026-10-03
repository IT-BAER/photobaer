// File > Open of a .pdf: Import PDF picks pages and a resolution; each page opens as its own document.
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export interface PdfDialogHandle {
  ask(file: File): Promise<{ files: File[]; ppi: number } | null>;
}

const pdfjs = () => import('./app/pdf.ts');
const isPassword = (e: unknown) => (e as Error)?.name === 'PasswordException';

export function PdfDialog({ ref, setError }: { ref: Ref<PdfDialogHandle>; setError: (msg: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const answer = useRef<((a: { files: File[]; ppi: number } | null) => void) | null>(null);
  const job = useRef(0);
  const urls = useRef<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [password, setPassword] = useState<{ value: string; wrong: boolean } | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [sizes, setSizes] = useState<[number, number][]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set([1]));
  const [ppi, setPpi] = useState(300);
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
        if (j === job.current) setThumbs(t => [...t, url]);
      }
    } catch (e) {
      if (j !== job.current) return;
      if (isPassword(e)) setPassword({ value: '', wrong: pw !== undefined });
      else { close(null); setError(`Could not open ${f.name}: ${(e as Error).message}`); }
    }
  }

  useImperativeHandle(ref, () => ({
    ask(f) {
      answer.current?.(null);
      setFile(f); setPdf(null); setThumbs([]); setSizes([]); setPicked(new Set([1])); setPassword(null); setBusy(false);
      dialog.current?.showModal();
      void load(f);
      return new Promise(r => { answer.current = r; });
    },
  }));

  function close(a: { files: File[]; ppi: number } | null) {
    job.current++;
    const r = answer.current;
    answer.current = null;
    dialog.current?.close();
    void pdf?.loadingTask.destroy();
    setPdf(null);
    for (const u of urls.current.splice(0)) URL.revokeObjectURL(u);
    r?.(a);
  }

  async function ok() {
    if (!pdf || !file || !picked.size) return;
    setBusy(true);
    try {
      const { renderPage } = await pdfjs();
      const base = file.name.replace(/\.[^.]+$/, '');
      const files: File[] = [];
      for (const n of [...picked].sort((a, b) => a - b)) {
        const png = await renderPage(pdf, n, ppi / 72);
        files.push(new File([png], `${base}${pdf.numPages > 1 ? `-${n}` : ''}.png`, { type: 'image/png' }));
      }
      close({ files, ppi });
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
    }
  }

  const toggle = (n: number) => setPicked(p => { const s = new Set(p); if (s.has(n)) s.delete(n); else s.add(n); return s; });
  const first = sizes[[...picked].sort((a, b) => a - b)[0] - 1];
  const px = (pt: number) => Math.max(1, Math.round(pt * ppi / 72));

  return (
    <dialog ref={dialog} className="mode-dialog pdf-dialog" aria-label="Import PDF" onClose={() => { if (answer.current) close(null); }}>
      {file && (
        <form onSubmit={e => { e.preventDefault(); if (password) { setPassword(null); void load(file, password.value); } else void ok(); }}>
          <h2>Import PDF</h2>
          {password ? <>
            <p>{password.wrong ? 'The password is wrong. ' : ''}{file.name} is protected.</p>
            <label>PDF password <input type="password" aria-label="PDF password" autoFocus value={password.value} onChange={e => setPassword({ value: e.currentTarget.value, wrong: password.wrong })} /></label>
          </> : <>
            <div className="pdf-pages" role="listbox" aria-label="Pages" aria-multiselectable="true">
              {sizes.map((_, i) => (
                <button type="button" key={i} role="option" aria-selected={picked.has(i + 1)} className={picked.has(i + 1) ? 'on' : ''} onClick={() => toggle(i + 1)}>
                  {thumbs[i] ? <img src={thumbs[i]} alt="" /> : <span className="pdf-blank" />}
                  <span>{i + 1}</span>
                </button>
              ))}
              {!sizes.length && <p>Reading {file.name}…</p>}
            </div>
            <div className="row">
              <button type="button" onClick={() => setPicked(new Set(sizes.map((_, i) => i + 1)))}>Select All</button>
              <button type="button" onClick={() => setPicked(new Set())}>Deselect All</button>
            </div>
            <label>Resolution (ppi) <input type="number" aria-label="Resolution (ppi)" min={1} max={2400} value={ppi} onChange={e => setPpi(Math.max(1, Math.min(2400, +e.currentTarget.value || 72)))} /></label>
            {first && <p className="hint">{px(first[0])} x {px(first[1])} px{picked.size > 1 ? ` (page ${Math.min(...picked)}), ${picked.size} pages` : ''}</p>}
          </>}
          <div className="actions">
            <button type="button" onClick={() => close(null)}>Cancel</button>
            <button type="submit" className="primary" disabled={busy || (!password && (!pdf || !picked.size))}>{password ? 'Unlock' : 'OK'}</button>
          </div>
        </form>
      )}
    </dialog>
  );
}
