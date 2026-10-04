// Window > Notes and Window > Measurement Log.
import { useState } from 'react';
import { pickColumns } from './app/analysis.ts';
import { formatValue, toCsv, type Annotations, type MeasureRow } from './app/measure.ts';
import type { DocInfo } from './worker/types.ts';

interface NotesProps {
  doc: DocInfo | null; selected: number | null; select: (id: number | null) => void;
  commit: (a: Annotations, label: string) => void;
}

export function NotesPanel({ doc, selected, select, commit }: NotesProps) {
  const notes = doc?.annotations.notes ?? [];
  const i = notes.findIndex(n => n.id === selected);
  const note = i >= 0 ? notes[i] : null;
  const a = doc?.annotations;
  return (
    <section className="inspection-panel" aria-label="Notes">
      <h2>Notes</h2>
      {!doc ? <p className="panel-empty">No document open.</p> : !note ? <p className="panel-empty">{notes.length ? 'Select a note with the Note tool or the arrows.' : 'Click with the Note tool to add a note.'}</p> : <>
        <p className="notes-author">{note.author || 'No author'}</p>
        <textarea key={`${doc.key}:${note.id}`} className="notes-text" aria-label="Note text" defaultValue={note.text} maxLength={65536} rows={6}
          onBlur={e => {
            const text = e.currentTarget.value;
            if (a && text !== note.text) commit({ ...a, notes: a.notes.map(n => (n.id === note.id ? { ...n, text } : n)) }, 'Edit Note');
          }} />
      </>}
      {doc && notes.length > 0 && <div className="inspection-controls">
        <button type="button" aria-label="Previous note" onClick={() => select(notes[(Math.max(i, 0) - 1 + notes.length) % notes.length].id)}>‹</button>
        <span>{i >= 0 ? i + 1 : '–'} of {notes.length}</span>
        <button type="button" aria-label="Next note" onClick={() => select(notes[(i + 1) % notes.length].id)}>›</button>
        <button type="button" disabled={!note} onClick={() => { if (a && note) { select(null); commit({ ...a, notes: a.notes.filter(n => n.id !== note.id) }, 'Delete Note'); } }}>Delete</button>
      </div>}
    </section>
  );
}

interface LogProps {
  rows: MeasureRow[]; setRows: (f: (rows: MeasureRow[]) => MeasureRow[]) => void; record: () => void; canRecord: boolean;
  download: (blob: Blob, name: string) => void; points: (keyof MeasureRow)[];
}

export function MeasurementLogPanel({ rows, setRows, record, canRecord, download, points }: LogProps) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const cols = pickColumns(points), fixed = new Set(pickColumns([]).map(([k]) => k));
  const used = cols.filter(([k]) => fixed.has(k) || rows.some(r => r[k] !== undefined));
  const toggle = (i: number) => setPicked(p => { const n = new Set(p); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  return (
    <section className="inspection-panel" aria-label="Measurement Log">
      <h2>Measurement Log</h2>
      <div className="inspection-controls">
        <button type="button" disabled={!canRecord} onClick={record}>Record Measurements</button>
        <button type="button" disabled={!rows.length} onClick={() => setPicked(new Set(rows.map((_, i) => i)))}>Select All</button>
        <button type="button" disabled={!picked.size} onClick={() => { setRows(r => r.filter((_, i) => !picked.has(i))); setPicked(new Set()); }}>Delete</button>
        <button type="button" disabled={!rows.length} onClick={() => download(new Blob([toCsv(picked.size ? rows.filter((_, i) => picked.has(i)) : rows, cols)], { type: 'text/csv' }), 'measurements.csv')}>Export…</button>
      </div>
      {rows.length ? <div className="measure-log-scroll"><table className="measure-log">
        <thead><tr>{used.map(([, h]) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className={picked.has(i) ? 'picked' : undefined} onClick={() => toggle(i)}>
          {used.map(([k]) => <td key={k}>{formatValue(r[k])}</td>)}
        </tr>)}</tbody>
      </table></div> : <p className="panel-empty">No measurements recorded.</p>}
    </section>
  );
}
