// Image > Variables (Define and Data Sets tabs), Image > Apply Data Set and File > Import > Variable Data Sets.
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { MessageDescriptor } from '@lingui/core';
import { msg, plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { i18n } from './i18n/index.ts';
import { errorText } from './i18n/errors.ts';
import { client } from './client.ts';
import { flatNodes } from './layers.ts';
import {
  defaultPixels, imageKey, importDataSets, setBinding, setPixelOptions, valueOf, type DataSet, type PixelMethod, type PixelOptions, type VariableKind, type Variables,
} from './app/variables.ts';
import type { LayerNode } from './worker/types.ts';

const KINDS: [VariableKind, MessageDescriptor][] = [['visibility', msg`Visibility`], ['text', msg`Text Replacement`], ['pixels', msg`Pixel Replacement`]];
const DEFAULT_NAME: Record<VariableKind, string> = { visibility: 'visible', text: 'text', pixels: 'image' };
const METHODS: [PixelMethod, MessageDescriptor][] = [['fit', msg`Fit`], ['fill', msg`Fill`], ['as_is', msg`As Is`], ['conform', msg`Conform`]];
const ALIGNS: MessageDescriptor[] = [
  msg`Top Left`, msg`Top Center`, msg`Top Right`, msg`Center Left`, msg`Center`, msg`Center Right`, msg`Bottom Left`, msg`Bottom Center`, msg`Bottom Right`,
];
const IMAGE_TYPES = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,.psd,.psb';
const kindFits = (k: VariableKind, n: LayerNode) => k === 'visibility' || (k === 'text' ? n.kind === 'text' : n.kind === 'pixel');
type Draft = Record<VariableKind, { on: boolean; name: string }>;
const draftOf = (m: Variables, layer: number): Draft => Object.fromEntries(KINDS.map(([k]) => {
  const v = m.variables.find(v => v.layer === layer && v.kind === k);
  return [k, { on: !!v, name: v?.name ?? '' }];
})) as Draft;

// A new data set starts from the layers' current state.
function currentValues(m: Variables, nodes: LayerNode[]): Record<string, string> {
  return Object.fromEntries(m.variables.map(v => {
    const n = nodes.find(n => n.id === v.layer);
    return [v.name, v.kind === 'visibility' ? (n?.visible === false ? 'hidden' : 'visible') : v.kind === 'text' ? n?.text?.text ?? '' : ''];
  }));
}

export interface VariablesHandle { open(tab: 'define' | 'sets', m: Variables, layers: LayerNode[], active: number | null): void }
type ImportInto = (m: Variables, done: (m: Variables, report: string) => void) => void;

export function VariablesDialog({ ref, commit, importInto, exportCsv }:
  { ref: Ref<VariablesHandle>; commit: (m: Variables, apply: string | null) => void; importInto: ImportInto; exportCsv: (m: Variables) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<'define' | 'sets'>('define');
  const [m, setM] = useState<Variables>({ variables: [], data_sets: [], active: null });
  const [nodes, setNodes] = useState<LayerNode[]>([]);
  const [layer, setLayer] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [set, setSet] = useState<string | null>(null);
  const [setName, setSetName] = useState('');
  const [error, setError] = useState('');
  const [apply, setApply] = useState(true);
  const [note, setNote] = useState('');
  const [loaded, setLoaded] = useState<string[]>([]);
  const imageInput = useRef<HTMLInputElement>(null);
  const picking = useRef<string | null>(null);
  useImperativeHandle(ref, () => ({
    open(which, model, layers, active) {
      const list = flatNodes(layers).filter(n => n.kind !== 'group');
      const l = list.find(n => n.id === active)?.id ?? list[0]?.id ?? null;
      setTab(which); setM(model); setNodes(list); setLayer(l); setDraft(l === null ? null : draftOf(model, l)); setError(''); setNote(''); setApply(true);
      pickSet(model.active ?? model.data_sets[0]?.name ?? null);
      void client.call('variableImageNames').then(setLoaded, () => {});
      dialog.current?.showModal();
    },
  }));
  // Images picked here stay loaded for this session; with one variable picking, its value becomes the file name.
  async function loadImages(files: File[]) {
    try {
      setLoaded(await client.call('loadVariableImages', await Promise.all(files.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })))));
      if (picking.current && files[0]) setValue(picking.current, files[0].name);
      setError('');
    } catch (e) { setError(errorText(e)); }
    picking.current = null;
  }
  const pixelsOf = (id: number): PixelOptions => m.variables.find(v => v.layer === id && v.kind === 'pixels')?.pixels ?? defaultPixels();
  const setPixels = (o: Partial<PixelOptions>) => {
    if (layer === null) return;
    try { setM(setPixelOptions(m, layer, { ...pixelsOf(layer), ...o })); } catch (e) { setError(errorText(e)); }
  };
  const pickSet = (name: string | null) => { setSet(name); setSetName(name ?? ''); };
  const node = nodes.find(n => n.id === layer);
  const current = m.data_sets.find(d => d.name === set);
  const hasPixels = m.variables.some(v => v.kind === 'pixels');

  function edit(kind: VariableKind, p: Partial<Draft[VariableKind]>) {
    if (layer === null || !draft) return;
    const d = { ...draft, [kind]: { ...draft[kind], ...p } };
    setDraft(d);
    try {
      setM(setBinding(m, layer, kind, d[kind].on ? d[kind].name : null));
      setError('');
    } catch (e) { setError(errorText(e)); }
  }
  const switchLayer = (id: number) => { setLayer(id); setDraft(draftOf(m, id)); setError(''); };
  const putSets = (data_sets: DataSet[], active = m.active) => setM({ ...m, data_sets, active: data_sets.some(d => d.name === active) ? active : null });
  function newSet() {
    let k = m.data_sets.length + 1;
    while (m.data_sets.some(d => d.name === `Data Set ${k}`)) k++;
    const d = { name: `Data Set ${k}`, values: current ? { ...current.values } : currentValues(m, nodes) };
    putSets([...m.data_sets, d]);
    pickSet(d.name);
  }
  function deleteSet() {
    const i = m.data_sets.findIndex(d => d.name === set);
    const rest = m.data_sets.filter(d => d.name !== set);
    putSets(rest);
    pickSet(rest[Math.min(i, rest.length - 1)]?.name ?? null);
  }
  function renameSet(name: string) {
    setSetName(name);
    if (!current || name === set) { setError(''); return; }
    if (!name.trim() || m.data_sets.some(d => d.name === name)) { setError(name.trim() ? t`A data set named "${name}" already exists.` : t`A data set needs a name.`); return; }
    putSets(m.data_sets.map(d => d === current ? { ...d, name } : d), m.active === set ? name : m.active);
    setSet(name);
    setError('');
  }
  const setValue = (name: string, value: string) => current && putSets(m.data_sets.map(d => d === current ? { ...d, values: { ...d.values, [name]: value } } : d));
  const step = (by: number) => {
    const i = m.data_sets.findIndex(d => d.name === set) + by;
    if (i >= 0 && i < m.data_sets.length) { pickSet(m.data_sets[i].name); setError(''); }
  };

  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog variables-dialog" aria-label={t`Variables`}>
      <form onSubmit={e => { e.preventDefault(); if (error) return; dialog.current?.close(); commit(m, tab === 'sets' && apply ? set : null); }}>
        <h2><Trans>Variables</Trans></h2>
        <div className="row" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'define'} className={tab === 'define' ? 'primary' : ''} onClick={() => setTab('define')}><Trans>Define</Trans></button>
          <button type="button" role="tab" aria-selected={tab === 'sets'} className={tab === 'sets' ? 'primary' : ''} onClick={() => setTab('sets')}><Trans>Data Sets</Trans></button>
        </div>
        {tab === 'define' ? (node && draft ? <>
          <label><Trans>Layer</Trans> <select value={layer ?? ''} onChange={e => switchLayer(Number(e.currentTarget.value))}>
            {nodes.map(n => <option key={n.id} value={n.id}>{n.name}{m.variables.some(v => v.layer === n.id) ? ' *' : ''}</option>)}
          </select></label>
          {KINDS.filter(([k]) => kindFits(k, node)).map(([k, d]) => {
            const label = i18n._(d), nameLabel = t`${label} name`;
            return (
            <div className="row" key={k}>
              <label className="radio"><input type="checkbox" checked={draft[k].on} onChange={e => edit(k, { on: e.currentTarget.checked, name: draft[k].name || `${DEFAULT_NAME[k]}_${node.id}` })} /> {label}</label>
              <label><Trans>Name</Trans> <input value={draft[k].name} disabled={!draft[k].on} aria-label={nameLabel} onChange={e => edit(k, { name: e.currentTarget.value })} /></label>
            </div>
            );
          })}
          {node.kind === 'pixel' && draft.pixels.on && (() => {
            const o = pixelsOf(node.id), at = Math.round(o.align[1] * 2) * 3 + Math.round(o.align[0] * 2);
            return <fieldset><legend><Trans>Pixel Replacement</Trans></legend>
              <label><Trans>Method</Trans> <select value={o.method} onChange={e => setPixels({ method: e.currentTarget.value as PixelMethod })}>
                {METHODS.map(([v, d]) => <option key={v} value={v}>{i18n._(d)}</option>)}
              </select></label>
              <div className="row">
                <span><Trans>Alignment</Trans></span>
                <div className="align-grid" role="radiogroup" aria-label={t`Alignment`}>
                  {ALIGNS.map((d, i) => <button key={i} type="button" role="radio" aria-checked={i === at} aria-label={i18n._(d)} className={i === at ? 'primary' : ''}
                    onClick={() => setPixels({ align: [(i % 3) / 2, Math.floor(i / 3) / 2] })} />)}
                </div>
              </div>
              <label className="radio"><input type="checkbox" checked={o.clip} onChange={e => setPixels({ clip: e.currentTarget.checked })} /> <Trans>Clip to Bounding Box</Trans></label>
            </fieldset>;
          })()}
          <p className="hint"><Trans>Names use letters, digits and underscore, not starting with a digit.</Trans></p>
        </> : <p className="hint"><Trans>The document has no layer to bind.</Trans></p>) : (m.variables.length ? <>
          <div className="row">
            <label><Trans>Data Set</Trans> <select value={set ?? ''} onChange={e => { pickSet(e.currentTarget.value || null); setError(''); }}>
              {!m.data_sets.length && <option value="">{t`None`}</option>}
              {m.data_sets.map(d => <option key={d.name} value={d.name}>{d.name}</option>)}
            </select></label>
            <button type="button" aria-label={t`Previous data set`} onClick={() => step(-1)}>◀</button>
            <button type="button" aria-label={t`Next data set`} onClick={() => step(1)}>▶</button>
            <button type="button" onClick={newSet}><Trans>New</Trans></button>
            <button type="button" onClick={deleteSet} disabled={!current}><Trans>Delete</Trans></button>
          </div>
          {current && <>
            <label><Trans>Name</Trans> <input value={setName} onChange={e => renameSet(e.currentTarget.value)} /></label>
            <div className="variables-values">
              {m.variables.map(v => {
                const value = valueOf(current, v.name) ?? '', unchanged = t`(unchanged)`;
                const where = nodes.find(n => n.id === v.layer)?.name ?? t`missing layer`;
                if (v.kind === 'pixels') {
                  const missing = value.trim() !== '' && !loaded.includes(imageKey(value));
                  return <div key={v.name} className="row">
                    <label>{v.name} <span className="hint">({where})</span> <input value={value} placeholder={unchanged} onChange={e => setValue(v.name, e.currentTarget.value)} /></label>
                    <button type="button" onClick={() => { picking.current = v.name; imageInput.current?.click(); }}><Trans>Select File...</Trans></button>
                    {missing && <span className="hint bad"><Trans>not loaded</Trans></span>}
                  </div>;
                }
                return <label key={v.name}>{v.name} <span className="hint">({where})</span> {v.kind === 'visibility'
                  ? <select value={value} onChange={e => setValue(v.name, e.currentTarget.value)}>
                    {['', 'visible', 'hidden'].concat(['', 'visible', 'hidden'].includes(value) ? [] : [value]).map(o => <option key={o} value={o}>{o || unchanged}</option>)}
                  </select>
                  : <textarea rows={2} value={value} onChange={e => setValue(v.name, e.currentTarget.value)} />}</label>;
              })}
            </div>
          </>}
          <div className="row">
            <button type="button" onClick={() => importInto(m, (n, report) => { setM(n); pickSet(n.active ?? n.data_sets[0]?.name ?? null); setError(''); setNote(report); })}><Trans>Import…</Trans></button>
            <button type="button" onClick={() => exportCsv(m)} disabled={!m.data_sets.length}><Trans>Export CSV…</Trans></button>
            {hasPixels && <button type="button" onClick={() => { picking.current = null; imageInput.current?.click(); }}><Trans>Load Images...</Trans></button>}
            <input ref={imageInput} type="file" hidden multiple accept={IMAGE_TYPES} aria-label={t`Replacement images`}
              onChange={e => { const f = [...(e.currentTarget.files ?? [])]; e.currentTarget.value = ''; if (f.length) void loadImages(f); }} />
          </div>
          {hasPixels && <p className="hint"><Trans>Pixel Replacement values are file names. Images you select or load stay available until the page is reloaded.</Trans></p>}
          <label className="radio"><input type="checkbox" checked={apply} onChange={e => setApply(e.currentTarget.checked)} disabled={!current} /> <Trans>Apply this data set on OK</Trans></label>
        </> : <p className="hint"><Trans>Define a variable on the Define tab first.</Trans></p>)}
        {note && <p className="hint" role="status">{note}</p>}
        {error && <p className="hint bad" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary" disabled={!!error}><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export interface ImportSetsHandle { open(m: Variables, done: (m: Variables, report: string) => void): void }

export function ImportDataSetsDialog({ ref }: { ref: Ref<ImportSetsHandle> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const job = useRef<{ m: Variables; done: (m: Variables, report: string) => void } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [names, setNames] = useState(true);
  const [replace, setReplace] = useState(true);
  const [error, setError] = useState('');
  useImperativeHandle(ref, () => ({ open(m, done) { job.current = { m, done }; setFile(null); setError(''); dialog.current?.showModal(); } }));
  async function run() {
    if (!file || !job.current) return;
    try {
      const r = importDataSets(job.current.m, await file.text(), { firstColumnIsName: names, replace });
      dialog.current?.close();
      const added = r.added, unknown = r.unknown.join(', '), missing = r.missing.join(', ');
      const report = [plural(added, { one: 'Imported # data set.', other: 'Imported # data sets.' }),
        r.unknown.length ? t`Columns without a variable: ${unknown}.` : '',
        r.missing.length ? t`Variables without a column: ${missing}.` : '', r.warnings[0] ?? ''].filter(Boolean).join(' ');
      job.current.done(r.model, report);
    } catch (e) { setError(errorText(e)); }
  }
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog" aria-label={t`Import Data Sets`}>
      <form onSubmit={e => { e.preventDefault(); void run(); }}>
        <h2><Trans>Import Data Sets</Trans></h2>
        <label><Trans>File</Trans> <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={e => { setFile(e.currentTarget.files?.[0] ?? null); setError(''); }} /></label>
        <p className="hint"><Trans>UTF-8 text, comma, semicolon or tab separated; the first row names the variables.</Trans></p>
        <label className="radio"><input type="checkbox" checked={names} onChange={e => setNames(e.currentTarget.checked)} /> <Trans>Use the first column for data set names</Trans></label>
        <label className="radio"><input type="checkbox" checked={replace} onChange={e => setReplace(e.currentTarget.checked)} /> <Trans>Replace existing data sets</Trans></label>
        {error && <p className="hint bad" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary" disabled={!file}><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export interface ApplySetHandle { open(m: Variables): void }

export function ApplyDataSetDialog({ ref, apply }: { ref: Ref<ApplySetHandle>; apply: (name: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [m, setM] = useState<Variables | null>(null);
  const [name, setName] = useState('');
  useImperativeHandle(ref, () => ({ open(model) { setM(model); setName(model.active ?? model.data_sets[0]?.name ?? ''); dialog.current?.showModal(); } }));
  const set = m?.data_sets.find(d => d.name === name);
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog" aria-label={t`Apply Data Set`}>
      <form onSubmit={e => { e.preventDefault(); dialog.current?.close(); apply(name); }}>
        <h2><Trans>Apply Data Set</Trans></h2>
        <label><Trans>Data Set</Trans> <select value={name} onChange={e => setName(e.currentTarget.value)}>
          {m?.data_sets.map(d => <option key={d.name} value={d.name}>{d.name}</option>)}
        </select></label>
        <dl className="variables-preview">
          {m?.variables.map(v => <div key={v.name}><dt>{v.name}</dt><dd>{(set && valueOf(set, v.name)) ?? t`(unchanged)`}</dd></div>)}
        </dl>
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary" disabled={!name}><Trans>Apply</Trans></button>
        </div>
      </form>
    </dialog>
  );
}
