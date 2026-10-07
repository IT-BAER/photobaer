// Image > Mode dialogs: Bitmap, Duotone, Indexed Color and Color Table.
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { MessageDescriptor } from '@lingui/core';
import { i18n } from './i18n/index.ts';
import { client } from './client.ts';
import type { DocInfo } from './engine.worker.ts';
import type { BitmapMethod, InkCurve, ModeSpec } from './worker/types.ts';
import { INK_CURVE_INPUTS, inkCurve } from './app/inkCurve.ts';
import type { BrushLibrary } from './brushes/store.ts';
import { PatternPicker } from './PresetPanels.tsx';
import { colorTablePreset, fitTable, readTableFile, TABLE_PRESETS, writeAct } from './app/colorTable.ts';
import { NumberInput } from './shell/NumberInput.tsx';

type Rgb3 = [number, number, number];
export type ModeDialogKind = 'bitmap' | 'duotone' | 'indexed' | 'table';
export interface ModeDialogHandle { open(kind: ModeDialogKind): void }

type Indexed = Extract<ModeSpec, { mode: 'indexed' }>;
type Halftone = Extract<BitmapMethod, { method: 'halftone' }>;
const SHAPES: [Halftone['shape'], MessageDescriptor][] = [['round', msg`Round`], ['ellipse', msg`Ellipse`], ['line', msg`Line`], ['square', msg`Square`], ['cross', msg`Cross`], ['diamond', msg`Diamond`]];
const INK_TYPES = [msg`Monotone`, msg`Duotone`, msg`Tritone`, msg`Quadtone`];
const DEFAULT_INKS: Rgb3[] = [[0, 0, 0], [228, 120, 40], [40, 110, 190], [230, 200, 40]];
const hex = (c: Rgb3) => `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
const rgb = (h: string): Rgb3 => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as Rgb3;
// Duotone Curve inputs in % ink; the 0 and 100 fields start set, the rest empty (skipped).
const CURVE_INPUTS = INK_CURVE_INPUTS;
const IDENTITY: InkCurve = CURVE_INPUTS.map((_, i) => (i === 0 ? 0 : i === 12 ? 100 : null));
// Indexed Color Matte; Foreground and Background are the swatches, None is no matte.
const MATTES: [string, MessageDescriptor][] = [['none', msg`None`], ['foreground', msg`Foreground Color`], ['background', msg`Background Color`], ['white', msg`White`],
  ['black', msg`Black`], ['gray', msg`50% Gray`], ['netscape', msg`Netscape Gray`], ['custom', msg`Custom...`]];
const MATTE_RGB: Record<string, Rgb3> = { white: [255, 255, 255], black: [0, 0, 0], gray: [128, 128, 128], netscape: [191, 191, 191] };

// Color Table grid with its preset select, Load (.act, .aco) and Save (.act); presets resample to
// the table length, and with `fixed` (an Indexed document's table) a loaded table fits it too.
function TableEditor({ table, preset, fixed = false, set, onError }: {
  table: Rgb3[]; preset: string; fixed?: boolean; set: (table: Rgb3[], preset: string) => void; onError: (msg: string) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  async function load(f: File) {
    try {
      const loaded = readTableFile(f.name, new Uint8Array(await f.arrayBuffer()));
      set(fixed ? fitTable(loaded, table.length) : loaded, 'custom');
    } catch (e) {
      onError((e as Error).message);
    }
  }
  function save() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([writeAct(table)], { type: 'application/octet-stream' }));
    a.download = 'Color Table.act';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  }
  return (<>
    <div className="row">
      <button type="button" onClick={() => file.current?.click()}><Trans>Load...</Trans></button>
      <button type="button" onClick={save}><Trans>Save...</Trans></button>
      <input ref={file} type="file" hidden accept=".act,.aco" aria-label={t`Load color table`}
        onChange={e => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) void load(f); }} />
    </div>
    <label><Trans>Table</Trans> <select aria-label={t`Table`} value={preset} onChange={e => {
      const p = e.currentTarget.value;
      set(p === 'custom' ? table : colorTablePreset(p, table.length), p);
    }}>
      <option value="custom">{t`Custom`}</option>
      {TABLE_PRESETS.map(([v, l]) => <option key={v} value={v}>{i18n._(l)}</option>)}
    </select></label>
    <div className="color-table" role="group" aria-label={t`Colors`}>
      {table.map((c, i) => (
        <label key={i} className="color-table-cell" style={{ background: hex(c) }} title={`${i}: ${c.join(', ')}`}>
          <input type="color" aria-label={t`Color ${i}`} value={hex(c)}
            onChange={e => { const v = rgb(e.currentTarget.value); set(table.map((x, j) => (j === i ? v : x)), 'custom'); }} />
        </label>
      ))}
    </div>
  </>);
}

// Ink indices of the overprint colors in the engine's order: 1+2, 1+3, 2+3, 1+2+3 ...
const overName = (s: number[]) => s.map(v => v + 1).join('+');
function overprintSets(n: number): number[][] {
  const sets = Array.from({ length: 1 << n }, (_, m) => [...Array(n).keys()].filter(i => m & (1 << i))).filter(s => s.length > 1);
  return sets.sort((a, b) => { const i = a.findIndex((v, k) => v !== b[k]); return a.length - b.length || a[i] - b[i]; });
}

// Overprint colors the engine uses when none are set: the inks multiplied.
const multiplied = (inks: Rgb3[]) =>
  overprintSets(inks.length).map(s => [0, 1, 2].map(k => Math.round(s.reduce((p, i) => p * inks[i][k] / 255, 1) * 255)) as Rgb3);

function CurveIcon({ curve }: { curve: InkCurve }) {
  const pts = Array.from({ length: 17 }, (_, x) => `${x},${16 - inkCurve(curve, x / 16) * 16}`);
  return <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true"><polyline points={pts.join(' ')} fill="none" stroke="currentColor" /></svg>;
}

export function ModeDialog({ ref, doc, library = null, fg = [0, 0, 0], bg = [255, 255, 255], show, setError }: {
  ref: Ref<ModeDialogHandle>; doc: DocInfo | null; library?: BrushLibrary | null; fg?: Rgb3; bg?: Rgb3; show: (d: DocInfo | null) => void; setError: (msg: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<ModeDialogKind | null>(null);
  const [method, setMethod] = useState<BitmapMethod['method']>('diffusion');
  // Bitmap output in ppi, shown per inch or per cm.
  const [ppi, setPpi] = useState(72);
  const [perCm, setPerCm] = useState(false);
  const [screen, setScreen] = useState<Halftone>({ method: 'halftone', frequency: 53, unit: 'inch', angle: 45, shape: 'round' });
  const [pattern, setPattern] = useState('');
  const [inks, setInks] = useState<Rgb3[]>(DEFAULT_INKS.slice(0, 1));
  const [curves, setCurves] = useState<InkCurve[]>([IDENTITY]);
  // Null: the inks multiplied, as the engine stores no overprints.
  const [overprints, setOverprints] = useState<Rgb3[] | null>(null);
  // Duotone Curve or Overprint Colors sub-dialog; its edits apply on its OK.
  const sub = useRef<HTMLDialogElement>(null);
  const [edit, setEdit] = useState<{ ink: number; curve: InkCurve } | { over: Rgb3[] } | { table: Rgb3[]; preset: string } | null>(null);
  const [ix, setIx] = useState<Indexed>({ mode: 'indexed', palette: 'adaptive', colors: 256, forced: 'black_white', transparency: true, dither: 'diffusion', amount: 0.75 });
  const [table, setTable] = useState<Rgb3[]>([]);
  const [preset, setPreset] = useState('custom');
  // Indexed Color: the last conversion's table (Palette: Previous) and the Matte choice.
  const [previous, setPrevious] = useState<Rgb3[] | null>(null);
  const [matte, setMatte] = useState('none');
  const [matteColor, setMatteColor] = useState<Rgb3>([255, 255, 255]);

  useImperativeHandle(ref, () => ({
    open(k) {
      setKind(k);
      if (k === 'bitmap' && doc) { setPpi(doc.resolution); setPattern(p => (doc.patterns.some(x => x.id === p) ? p : doc.patterns[0]?.id ?? '')); }
      if (k === 'duotone') {
        const m = doc?.mode?.kind === 'duotone' ? doc.mode : null;
        setInks(m?.inks ?? DEFAULT_INKS.slice(0, 1));
        setCurves(m?.curves ?? Array(m?.inks.length ?? 1).fill(IDENTITY));
        setOverprints(m?.overprints ?? null);
      }
      if (k === 'table' && doc?.mode?.kind === 'indexed') { setTable(doc.mode.table); setPreset('custom'); }
      if (k === 'indexed') {
        client.call('previousColorTable').then(t => {
          setPrevious(t);
          if (!t) setIx(x => (x.palette === 'previous' ? { ...x, palette: 'adaptive' } : x));
        }, () => setPrevious(null));
      }
      dialog.current?.showModal();
    },
  }), [doc]);

  function bitmap(): ModeSpec {
    const m: BitmapMethod = method === 'halftone' ? screen : method === 'custom' ? { method, pattern } : { method };
    return { mode: 'bitmap', ...m, ...(doc && ppi !== doc.resolution ? { resolution: ppi } : {}) };
  }

  function indexed(): Indexed {
    const m = { foreground: fg, background: bg, custom: matteColor, ...MATTE_RGB }[matte] ?? null;
    return { ...ix, table: ix.palette === 'custom' ? ix.table : undefined, matte: m };
  }

  function ok() {
    dialog.current?.close();
    const run = kind === 'table'
      ? client.call('setColorTable', table)
      : client.call('setColorMode', kind === 'bitmap' ? bitmap() : kind === 'duotone' ? { mode: 'duotone', inks, curves, ...(overprints ? { overprints } : {}) } : indexed());
    run.then(show, e => setError((e as Error).message));
  }

  const name = { bitmap: t`Bitmap`, duotone: t`Duotone Options`, indexed: t`Indexed Color`, table: t`Color Table` }[kind ?? 'bitmap'];
  const fixedCount = ix.palette !== 'uniform' && ix.palette !== 'adaptive';
  const ownTable = ix.palette === 'custom' || ix.palette === 'previous';
  // Custom starts from its last table, the document's table, or the table the chosen palette makes now.
  const customStart = async (): Promise<Rgb3[]> => {
    const own = ix.table ?? (doc?.mode?.kind === 'indexed' ? doc.mode.table : null) ?? (ix.palette === 'previous' ? previous : null);
    if (own) return own;
    const live = ix.palette === 'custom' ? null : await client.call('indexedTable', indexed()).catch(() => null);
    return live ?? previous ?? colorTablePreset('grayscale', ix.colors);
  };
  function openSub(e: { ink: number; curve: InkCurve } | { over: Rgb3[] } | { table: Rgb3[]; preset: string }) {
    setEdit(e);
    sub.current?.showModal();
  }

  function subOk() {
    if (edit && 'ink' in edit) setCurves(curves.map((c, j) => (j === edit.ink ? edit.curve : c)));
    else if (edit && 'table' in edit) setIx({ ...ix, palette: 'custom', table: edit.table, colors: edit.table.length });
    else if (edit) setOverprints(edit.over);
    sub.current?.close();
  }

  const inkNo = edit && 'ink' in edit ? edit.ink + 1 : 0;
  const inputRes = +(perCm ? (doc?.resolution ?? 0) / 2.54 : doc?.resolution ?? 0).toFixed(2);
  const inputUnit = perCm ? t`Pixels/cm` : t`Pixels/Inch`;
  const subName = edit && 'ink' in edit ? t`Duotone Curve: Ink ${inkNo}` : edit && 'table' in edit ? t`Color Table` : t`Overprint Colors`;
  return (<>
    <dialog ref={dialog} className="mode-dialog" aria-label={name} onClose={() => setKind(null)}>
      {doc && kind && (
        <form onSubmit={e => { e.preventDefault(); ok(); }}>
          <h2>{name}</h2>
          {kind === 'bitmap' && <>
            <label><Trans>Input {inputRes} {inputUnit}</Trans></label>
            <label><Trans>Output</Trans> <NumberInput aria-label={t`Output`} min={0.01} step="any" value={+(perCm ? ppi / 2.54 : ppi).toFixed(2)}
              onValue={v => { if (v > 0) setPpi(perCm ? v * 2.54 : v); }} />
              <select aria-label={t`Output unit`} value={perCm ? 'cm' : 'inch'} onChange={e => setPerCm(e.currentTarget.value === 'cm')}>
                <option value="inch">{t`Pixels/Inch`}</option>
                <option value="cm">{t`Pixels/cm`}</option>
              </select></label>
            <label><Trans>Method</Trans> <select aria-label={t`Method`} value={method} onChange={e => setMethod(e.currentTarget.value as typeof method)}>
              <option value="threshold">{t`50% Threshold`}</option>
              <option value="pattern">{t`Pattern Dither`}</option>
              <option value="diffusion">{t`Diffusion Dither`}</option>
              <option value="halftone">{t`Halftone Screen`}</option>
              <option value="custom">{t`Custom Pattern`}</option>
            </select></label>
            {method === 'halftone' && <>
              <label><Trans>Frequency</Trans> <NumberInput aria-label={t`Frequency`} min={1} max={999} step="any" value={screen.frequency}
                onValue={v => setScreen({ ...screen, frequency: Math.min(999, Math.max(1, v)) })} />
                <select aria-label={t`Frequency unit`} value={screen.unit} onChange={e => setScreen({ ...screen, unit: e.currentTarget.value as Halftone['unit'] })}>
                  <option value="inch">{t`Lines/Inch`}</option>
                  <option value="cm">{t`Lines/cm`}</option>
                </select></label>
              <label><Trans>Angle</Trans> <NumberInput aria-label={t`Angle`} min={-180} max={180} value={screen.angle}
                onValue={v => setScreen({ ...screen, angle: Math.min(180, Math.max(-180, v)) })} /> °</label>
              <label><Trans>Shape</Trans> <select aria-label={t`Shape`} value={screen.shape} onChange={e => setScreen({ ...screen, shape: e.currentTarget.value as Halftone['shape'] })}>
                {SHAPES.map(([v, l]) => <option key={v} value={v}>{i18n._(l)}</option>)}
              </select></label>
            </>}
            {method === 'custom' && (
              <PatternPicker doc={doc} library={library} value={pattern} set={setPattern} onDoc={d => show(d)} onError={setError} />
            )}
          </>}
          {kind === 'duotone' && <>
            <label><Trans>Type</Trans> <select aria-label={t`Type`} value={inks.length} onChange={e => {
              const n = Number(e.currentTarget.value);
              setInks(Array.from({ length: n }, (_, i) => inks[i] ?? DEFAULT_INKS[i]));
              setCurves(Array.from({ length: n }, (_, i) => curves[i] ?? IDENTITY));
              setOverprints(null);
            }}>
              {INK_TYPES.map((d, i) => <option key={d.message} value={i + 1}>{i18n._(d)}</option>)}
            </select></label>
            {inks.map((c, i) => { const ink = i + 1; return (
              <div key={i} className="duotone-ink">
                <button type="button" aria-label={t`Ink ${ink} curve`} title={t`Duotone Curve`} onClick={() => openSub({ ink: i, curve: curves[i] ?? IDENTITY })}>
                  <CurveIcon curve={curves[i] ?? IDENTITY} />
                </button>
                <label><Trans>Ink {ink}</Trans> <input type="color" aria-label={t`Ink ${ink}`} value={hex(c)}
                  onChange={e => { const v = rgb(e.currentTarget.value); setInks(inks.map((x, j) => (j === i ? v : x))); setOverprints(null); }} /></label>
              </div>
            ); })}
            <button type="button" disabled={inks.length < 2} onClick={() => openSub({ over: overprints ?? multiplied(inks) })}><Trans>Overprint Colors…</Trans></button>
          </>}
          {kind === 'indexed' && <>
            <label><Trans>Palette</Trans> <select aria-label={t`Palette`} value={ix.palette} onChange={e => {
              const p = e.currentTarget.value as Indexed['palette'];
              if (p === 'custom') void customStart().then(table => openSub({ table, preset: 'custom' }));
              else setIx({ ...ix, palette: p, ...(p === 'previous' && previous ? { colors: previous.length } : {}) });
            }}>
              <option value="exact">{t`Exact`}</option>
              <option value="web">{t`Web`}</option>
              <option value="uniform">{t`Uniform`}</option>
              <option value="adaptive">{t`Local (Adaptive)`}</option>
              <option value="custom">{t`Custom...`}</option>
              <option value="previous" disabled={!previous}>{t`Previous`}</option>
            </select></label>
            {ix.palette === 'custom' && <button type="button" onClick={() => void customStart().then(table => openSub({ table, preset: 'custom' }))}><Trans>Edit Table...</Trans></button>}
            <label><Trans>Colors</Trans> <NumberInput aria-label={t`Colors`} min={2} max={256} disabled={fixedCount} value={ix.colors}
              onValue={n => { const v = Math.round(n); setIx({ ...ix, colors: Math.min(256, Math.max(2, v)) }); }} /></label>
            <label><Trans>Forced</Trans> <select aria-label={t`Forced`} value={ix.forced} disabled={ownTable} onChange={e => setIx({ ...ix, forced: e.currentTarget.value as Indexed['forced'] })}>
              <option value="none">{t`None`}</option>
              <option value="black_white">{t`Black and White`}</option>
              <option value="primaries">{t`Primaries`}</option>
              <option value="web">{t`Web`}</option>
            </select></label>
            <label><input type="checkbox" checked={ix.transparency} onChange={e => setIx({ ...ix, transparency: e.currentTarget.checked })} /> <Trans>Transparency</Trans></label>
            <label><Trans>Matte</Trans> <select aria-label={t`Matte`} value={matte} onChange={e => setMatte(e.currentTarget.value)}>
              {MATTES.map(([v, l]) => <option key={v} value={v}>{i18n._(l)}</option>)}
            </select>
              {matte === 'custom' && <input type="color" aria-label={t`Matte color`} value={hex(matteColor)} onChange={e => setMatteColor(rgb(e.currentTarget.value))} />}</label>
            <label><Trans>Dither</Trans> <select aria-label={t`Dither`} value={ix.dither} onChange={e => setIx({ ...ix, dither: e.currentTarget.value as Indexed['dither'] })}>
              <option value="none">{t`None`}</option>
              <option value="diffusion">{t`Diffusion`}</option>
              <option value="pattern">{t`Pattern`}</option>
              <option value="noise">{t`Noise`}</option>
            </select></label>
            <label><Trans>Amount</Trans> <NumberInput aria-label={t`Amount`} min={0} max={100} disabled={ix.dither === 'none'} value={Math.round(ix.amount * 100)}
              onValue={v => setIx({ ...ix, amount: Math.min(100, Math.max(0, v)) / 100 })} /> %</label>
          </>}
          {kind === 'table' && <TableEditor table={table} preset={preset} fixed set={(t, p) => { setTable(t); setPreset(p); }} onError={setError} />}
          <div className="actions">
            <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
            <button type="submit" className="primary" disabled={kind === 'bitmap' && method === 'custom' && !pattern}><Trans>OK</Trans></button>
          </div>
        </form>
      )}
    </dialog>
    <dialog ref={sub} className="mode-dialog" aria-label={subName} onClose={() => setEdit(null)}>
      {edit && (
        <form onSubmit={e => { e.preventDefault(); subOk(); }}>
          <h2>{subName}</h2>
          {'ink' in edit ? (
            <div className="duotone-curve">
              {CURVE_INPUTS.map((x, i) => (
                <label key={x}>{x}: <NumberInput aria-label={`${x}%`} min={0} max={100} step="any" value={edit.curve[i] ?? ''}
                  onValue={v => setEdit({ ...edit, curve: edit.curve.map((y, j) => (j !== i ? y : Math.min(100, Math.max(0, v)))) })}
                  onInput={e => { if (e.currentTarget.value.trim() === '') setEdit({ ...edit, curve: edit.curve.map((y, j) => (j !== i ? y : null)) }); }} /> %</label>
              ))}
            </div>
          ) : 'table' in edit ? (
            <TableEditor table={edit.table} preset={edit.preset} set={(table, preset) => setEdit({ table, preset })} onError={setError} />
          ) : overprintSets(inks.length).map((s, i) => {
            const combo = overName(s);
            return (
              <label key={i}>{combo.replaceAll('+', ' + ')} <input type="color" aria-label={t`Overprint ${combo}`} value={hex(edit.over[i])}
                onChange={e => { const v = rgb(e.currentTarget.value); setEdit({ over: edit.over.map((x, j) => (j === i ? v : x)) }); }} /></label>
            );
          })}
          <div className="actions">
            <button type="button" onClick={() => sub.current?.close()}><Trans>Cancel</Trans></button>
            <button type="submit" className="primary"><Trans>OK</Trans></button>
          </div>
        </form>
      )}
    </dialog>
  </>);
}
