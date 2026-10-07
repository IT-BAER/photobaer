// File > Open of an .svg: Rasterize SVG Format sets the pixel size and resolution the drawing renders at.
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { pixels, rasterSize, setHeight, setPpi, setWidth, svgSize, type RasterSize } from './app/rasterSize.ts';
import { rasterSvg } from './app/files.ts';
import { Num } from './PropertiesPanel.tsx';

export interface SvgDialogHandle {
  ask(file: File): Promise<{ file: File; ppi: number } | null>;
}

// Width, Height (px), Resolution (ppi) and Constrain Proportions over a base size at 72 ppi.
export function RasterFields({ base, size, set }: { base: [number, number]; size: RasterSize; set: (s: RasterSize) => void }) {
  const [w, h] = pixels(size, base);
  return <>
    <Num label={t`Width (px)`} value={w} min={1} max={32767} onCommit={v => set(setWidth(size, base, Math.round(v)))} />
    <Num label={t`Height (px)`} value={h} min={1} max={32767} onCommit={v => set(setHeight(size, base, Math.round(v)))} />
    <Num label={t`Resolution (ppi)`} value={size.ppi} min={1} max={2400} onCommit={v => set(setPpi(size, Math.round(v)))} />
    <label className="check"><input type="checkbox" checked={size.constrain} onChange={e => set({ ...size, constrain: e.currentTarget.checked })} /> <Trans>Constrain Proportions</Trans></label>
  </>;
}

export function SvgDialog({ ref, setError }: { ref: Ref<SvgDialogHandle>; setError: (msg: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const answer = useRef<((a: { file: File; ppi: number } | null) => void) | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [base, setBase] = useState<[number, number]>([300, 150]);
  const [size, setSize] = useState(rasterSize(72));
  // Enter commits a field on blur just before the form submits, so OK reads the newest size here.
  const latest = useRef(size);
  const set = (s: RasterSize) => { latest.current = s; setSize(s); };
  const [busy, setBusy] = useState(false);

  useImperativeHandle(ref, () => ({
    async ask(f) {
      answer.current?.(null);
      setBase(svgSize(await f.text()));
      setFile(f); set(rasterSize(72)); setBusy(false);
      dialog.current?.showModal();
      return new Promise(r => { answer.current = r; });
    },
  }));

  function close(a: { file: File; ppi: number } | null) {
    const r = answer.current;
    answer.current = null;
    dialog.current?.close();
    r?.(a);
  }

  async function ok() {
    if (!file) return;
    setBusy(true);
    try {
      const s = latest.current;
      close({ file: await rasterSvg(file, pixels(s, base)), ppi: s.ppi });
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
    }
  }

  const hint = file ? t`${file.name}: ${+base[0].toFixed(2)} x ${+base[1].toFixed(2)} px at 72 ppi` : '';
  return (
    <dialog ref={dialog} className="mode-dialog svg-dialog" aria-label={t`Rasterize SVG Format`} onClose={() => { if (answer.current) close(null); }}>
      {file && (
        <form onSubmit={e => { e.preventDefault(); void ok(); }}>
          <h2><Trans>Rasterize SVG Format</Trans></h2>
          <p className="hint">{hint}</p>
          <RasterFields base={base} size={size} set={set} />
          <div className="actions">
            <button type="button" onClick={() => close(null)}><Trans>Cancel</Trans></button>
            <button type="submit" className="primary" disabled={busy}><Trans>OK</Trans></button>
          </div>
        </form>
      )}
    </dialog>
  );
}
