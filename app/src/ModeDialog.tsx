// Image > Mode dialogs: Bitmap, Duotone, Indexed Color and Color Table.
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { client } from './client.ts';
import type { DocInfo } from './engine.worker.ts';
import type { ModeSpec } from './worker/types.ts';
import { colorTablePreset, TABLE_PRESETS } from './app/colorTable.ts';

type Rgb3 = [number, number, number];
export type ModeDialogKind = 'bitmap' | 'duotone' | 'indexed' | 'table';
export interface ModeDialogHandle { open(kind: ModeDialogKind): void }

type Indexed = Extract<ModeSpec, { mode: 'indexed' }>;
const INK_TYPES = ['Monotone', 'Duotone', 'Tritone', 'Quadtone'];
const DEFAULT_INKS: Rgb3[] = [[0, 0, 0], [228, 120, 40], [40, 110, 190], [230, 200, 40]];
const hex = (c: Rgb3) => `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
const rgb = (h: string): Rgb3 => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as Rgb3;

export function ModeDialog({ ref, doc, show, setError }: {
  ref: Ref<ModeDialogHandle>; doc: DocInfo | null; show: (d: DocInfo | null) => void; setError: (msg: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<ModeDialogKind | null>(null);
  const [method, setMethod] = useState<'threshold' | 'pattern' | 'diffusion'>('diffusion');
  const [inks, setInks] = useState<Rgb3[]>(DEFAULT_INKS.slice(0, 1));
  const [ix, setIx] = useState<Indexed>({ mode: 'indexed', palette: 'adaptive', colors: 256, forced: 'black_white', transparency: true, dither: 'diffusion', amount: 0.75 });
  const [table, setTable] = useState<Rgb3[]>([]);
  const [preset, setPreset] = useState('custom');

  useImperativeHandle(ref, () => ({
    open(k) {
      setKind(k);
      if (k === 'duotone') setInks(doc?.mode?.kind === 'duotone' ? doc.mode.inks : DEFAULT_INKS.slice(0, 1));
      if (k === 'table' && doc?.mode?.kind === 'indexed') { setTable(doc.mode.table); setPreset('custom'); }
      dialog.current?.showModal();
    },
  }), [doc]);

  function ok() {
    dialog.current?.close();
    const run = kind === 'table'
      ? client.call('setColorTable', table)
      : client.call('setColorMode', kind === 'bitmap' ? { mode: 'bitmap', method } : kind === 'duotone' ? { mode: 'duotone', inks } : ix);
    run.then(show, e => setError((e as Error).message));
  }

  const name = { bitmap: 'Bitmap', duotone: 'Duotone Options', indexed: 'Indexed Color', table: 'Color Table' }[kind ?? 'bitmap'];
  const fixedCount = ix.palette === 'exact' || ix.palette === 'web';
  return (
    <dialog ref={dialog} className="mode-dialog" aria-label={name} onClose={() => setKind(null)}>
      {doc && kind && (
        <form onSubmit={e => { e.preventDefault(); ok(); }}>
          <h2>{name}</h2>
          {kind === 'bitmap' && (
            <label>Method <select aria-label="Method" value={method} onChange={e => setMethod(e.currentTarget.value as typeof method)}>
              <option value="threshold">50% Threshold</option>
              <option value="pattern">Pattern Dither</option>
              <option value="diffusion">Diffusion Dither</option>
            </select></label>
          )}
          {kind === 'duotone' && <>
            <label>Type <select aria-label="Type" value={inks.length} onChange={e => {
              const n = Number(e.currentTarget.value);
              setInks(Array.from({ length: n }, (_, i) => inks[i] ?? DEFAULT_INKS[i]));
            }}>
              {INK_TYPES.map((t, i) => <option key={t} value={i + 1}>{t}</option>)}
            </select></label>
            {inks.map((c, i) => (
              <label key={i}>Ink {i + 1} <input type="color" aria-label={`Ink ${i + 1}`} value={hex(c)}
                onChange={e => { const v = rgb(e.currentTarget.value); setInks(inks.map((x, j) => (j === i ? v : x))); }} /></label>
            ))}
          </>}
          {kind === 'indexed' && <>
            <label>Palette <select aria-label="Palette" value={ix.palette} onChange={e => setIx({ ...ix, palette: e.currentTarget.value as Indexed['palette'] })}>
              <option value="exact">Exact</option>
              <option value="web">Web</option>
              <option value="uniform">Uniform</option>
              <option value="adaptive">Local (Adaptive)</option>
            </select></label>
            <label>Colors <input type="number" aria-label="Colors" min={2} max={256} disabled={fixedCount} value={ix.colors}
              onChange={e => { const v = Math.round(Number(e.currentTarget.value)); if (Number.isFinite(v)) setIx({ ...ix, colors: Math.min(256, Math.max(2, v)) }); }} /></label>
            <label>Forced <select aria-label="Forced" value={ix.forced} onChange={e => setIx({ ...ix, forced: e.currentTarget.value as Indexed['forced'] })}>
              <option value="none">None</option>
              <option value="black_white">Black and White</option>
              <option value="primaries">Primaries</option>
              <option value="web">Web</option>
            </select></label>
            <label><input type="checkbox" checked={ix.transparency} onChange={e => setIx({ ...ix, transparency: e.currentTarget.checked })} /> Transparency</label>
            <label>Dither <select aria-label="Dither" value={ix.dither} onChange={e => setIx({ ...ix, dither: e.currentTarget.value as Indexed['dither'] })}>
              <option value="none">None</option>
              <option value="diffusion">Diffusion</option>
              <option value="pattern">Pattern</option>
              <option value="noise">Noise</option>
            </select></label>
            <label>Amount <input type="number" aria-label="Amount" min={0} max={100} disabled={ix.dither === 'none'} value={Math.round(ix.amount * 100)}
              onChange={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) setIx({ ...ix, amount: Math.min(100, Math.max(0, v)) / 100 }); }} /> %</label>
          </>}
          {kind === 'table' && <>
            <label>Table <select aria-label="Table" value={preset} onChange={e => {
              const p = e.currentTarget.value;
              setPreset(p);
              if (p !== 'custom') setTable(colorTablePreset(p, table.length));
            }}>
              <option value="custom">Custom</option>
              {TABLE_PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
            <div className="color-table" role="group" aria-label="Colors">
              {table.map((c, i) => (
                <label key={i} className="color-table-cell" style={{ background: hex(c) }} title={`${i}: ${c.join(', ')}`}>
                  <input type="color" aria-label={`Color ${i}`} value={hex(c)}
                    onChange={e => { const v = rgb(e.currentTarget.value); setPreset('custom'); setTable(table.map((x, j) => (j === i ? v : x))); }} />
                </label>
              ))}
            </div>
          </>}
          <div className="actions">
            <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
            <button type="submit" className="primary">OK</button>
          </div>
        </form>
      )}
    </dialog>
  );
}
