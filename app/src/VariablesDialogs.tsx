// Image > Variables (Define and Data Sets tabs), Image > Apply Data Set and File > Import > Variable Data Sets.
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { flatNodes } from './layers.ts';
import { importDataSets, setBinding, valueOf, type DataSet, type VariableKind, type Variables } from './app/variables.ts';
import type { LayerNode } from './worker/types.ts';

const KINDS: [VariableKind, string][] = [['visibility', 'Visibility'], ['text', 'Text Replacement']];
type Draft = Record<VariableKind, { on: boolean; name: string }>;
const draftOf = (m: Variables, layer: number): Draft => Object.fromEntries(KINDS.map(([k]) => {
  const v = m.variables.find(v => v.layer === layer && v.kind === k);
  return [k, { on: !!v, name: v?.name ?? '' }];
})) as Draft;

// A new data set starts from the layers' current state.
function currentValues(m: Variables, nodes: LayerNode[]): Record<string, string> {
  return Object.fromEntries(m.variables.map(v => {
    const n = nodes.find(n => n.id === v.layer);
    return [v.name, v.kind === 'visibility' ? (n?.visible === false ? 'hidden' : 'visible') : n?.text?.text ?? ''];
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
  useImperativeHandle(ref, () => ({
    open(t, model, layers, active) {
      const list = flatNodes(layers).filter(n => n.kind !== 'group');
      const l = list.find(n => n.id === active)?.id ?? list[0]?.id ?? null;
      setTab(t); setM(model); setNodes(list); setLayer(l); setDraft(l === null ? null : draftOf(model, l)); setError(''); setNote(''); setApply(true);
      pickSet(model.active ?? model.data_sets[0]?.name ?? null);
      dialog.current?.showModal();
    },
  }));
  const pickSet = (name: string | null) => { setSet(name); setSetName(name ?? ''); };
  const node = nodes.find(n => n.id === layer);
  const current = m.data_sets.find(d => d.name === set);

  function edit(kind: VariableKind, p: Partial<Draft[VariableKind]>) {
    if (layer === null || !draft) return;
    const d = { ...draft, [kind]: { ...draft[kind], ...p } };
    setDraft(d);
    try {
      setM(setBinding(m, layer, kind, d[kind].on ? d[kind].name : null));
      setError('');
    } catch (e) { setError((e as Error).message); }
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
    if (!name.trim() || m.data_sets.some(d => d.name === name)) { setError(name.trim() ? `A data set named "${name}" already exists.` : 'A data set needs a name.'); return; }
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
    <dialog ref={dialog} className="mode-dialog batch-dialog variables-dialog" aria-label="Variables">
      <form onSubmit={e => { e.preventDefault(); if (error) return; dialog.current?.close(); commit(m, tab === 'sets' && apply ? set : null); }}>
        <h2>Variables</h2>
        <div className="row" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'define'} className={tab === 'define' ? 'primary' : ''} onClick={() => setTab('define')}>Define</button>
          <button type="button" role="tab" aria-selected={tab === 'sets'} className={tab === 'sets' ? 'primary' : ''} onClick={() => setTab('sets')}>Data Sets</button>
        </div>
        {tab === 'define' ? (node && draft ? <>
          <label>Layer <select value={layer ?? ''} onChange={e => switchLayer(Number(e.currentTarget.value))}>
            {nodes.map(n => <option key={n.id} value={n.id}>{n.name}{m.variables.some(v => v.layer === n.id) ? ' *' : ''}</option>)}
          </select></label>
          {KINDS.filter(([k]) => k === 'visibility' || node.kind === 'text').map(([k, label]) => (
            <div className="row" key={k}>
              <label className="radio"><input type="checkbox" checked={draft[k].on} onChange={e => edit(k, { on: e.currentTarget.checked, name: draft[k].name || `${k === 'text' ? 'text' : 'visible'}_${node.id}` })} /> {label}</label>
              <label>Name <input value={draft[k].name} disabled={!draft[k].on} aria-label={`${label} name`} onChange={e => edit(k, { name: e.currentTarget.value })} /></label>
            </div>
          ))}
          <p className="hint">Names use letters, digits and underscore, not starting with a digit. Pixel replacement is not available.</p>
        </> : <p className="hint">The document has no layer to bind.</p>) : (m.variables.length ? <>
          <div className="row">
            <label>Data Set <select value={set ?? ''} onChange={e => { pickSet(e.currentTarget.value || null); setError(''); }}>
              {!m.data_sets.length && <option value="">None</option>}
              {m.data_sets.map(d => <option key={d.name} value={d.name}>{d.name}</option>)}
            </select></label>
            <button type="button" aria-label="Previous data set" onClick={() => step(-1)}>◀</button>
            <button type="button" aria-label="Next data set" onClick={() => step(1)}>▶</button>
            <button type="button" onClick={newSet}>New</button>
            <button type="button" onClick={deleteSet} disabled={!current}>Delete</button>
          </div>
          {current && <>
            <label>Name <input value={setName} onChange={e => renameSet(e.currentTarget.value)} /></label>
            <div className="variables-values">
              {m.variables.map(v => {
                const value = valueOf(current, v.name) ?? '';
                const where = nodes.find(n => n.id === v.layer)?.name ?? 'missing layer';
                return <label key={v.name}>{v.name} <span className="hint">({where})</span> {v.kind === 'visibility'
                  ? <select value={value} onChange={e => setValue(v.name, e.currentTarget.value)}>
                    {['', 'visible', 'hidden'].concat(['', 'visible', 'hidden'].includes(value) ? [] : [value]).map(o => <option key={o} value={o}>{o || '(unchanged)'}</option>)}
                  </select>
                  : <textarea rows={2} value={value} onChange={e => setValue(v.name, e.currentTarget.value)} />}</label>;
              })}
            </div>
          </>}
          <div className="row">
            <button type="button" onClick={() => importInto(m, (n, report) => { setM(n); pickSet(n.active ?? n.data_sets[0]?.name ?? null); setError(''); setNote(report); })}>Import…</button>
            <button type="button" onClick={() => exportCsv(m)} disabled={!m.data_sets.length}>Export CSV…</button>
          </div>
          <label className="radio"><input type="checkbox" checked={apply} onChange={e => setApply(e.currentTarget.checked)} disabled={!current} /> Apply this data set on OK</label>
        </> : <p className="hint">Define a variable on the Define tab first.</p>)}
        {note && <p className="hint" role="status">{note}</p>}
        {error && <p className="hint bad" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary" disabled={!!error}>OK</button>
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
      const report = [`Imported ${r.added} data set${r.added === 1 ? '' : 's'}.`,
        r.unknown.length ? `Columns without a variable: ${r.unknown.join(', ')}.` : '',
        r.missing.length ? `Variables without a column: ${r.missing.join(', ')}.` : '', r.warnings[0] ?? ''].filter(Boolean).join(' ');
      job.current.done(r.model, report);
    } catch (e) { setError((e as Error).message); }
  }
  return (
    <dialog ref={dialog} className="mode-dialog batch-dialog" aria-label="Import Data Sets">
      <form onSubmit={e => { e.preventDefault(); void run(); }}>
        <h2>Import Data Sets</h2>
        <label>File <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={e => { setFile(e.currentTarget.files?.[0] ?? null); setError(''); }} /></label>
        <p className="hint">UTF-8 text, comma, semicolon or tab separated; the first row names the variables.</p>
        <label className="radio"><input type="checkbox" checked={names} onChange={e => setNames(e.currentTarget.checked)} /> Use the first column for data set names</label>
        <label className="radio"><input type="checkbox" checked={replace} onChange={e => setReplace(e.currentTarget.checked)} /> Replace existing data sets</label>
        {error && <p className="hint bad" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary" disabled={!file}>OK</button>
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
    <dialog ref={dialog} className="mode-dialog batch-dialog" aria-label="Apply Data Set">
      <form onSubmit={e => { e.preventDefault(); dialog.current?.close(); apply(name); }}>
        <h2>Apply Data Set</h2>
        <label>Data Set <select value={name} onChange={e => setName(e.currentTarget.value)}>
          {m?.data_sets.map(d => <option key={d.name} value={d.name}>{d.name}</option>)}
        </select></label>
        <dl className="variables-preview">
          {m?.variables.map(v => <div key={v.name}><dt>{v.name}</dt><dd>{(set && valueOf(set, v.name)) ?? '(unchanged)'}</dd></div>)}
        </dl>
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary" disabled={!name}>Apply</button>
        </div>
      </form>
    </dialog>
  );
}
