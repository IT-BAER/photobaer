// Edit > Find and Replace Text: searches the type layers' text and changes one match or all of them.
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { client } from './client.ts';
import { findMatches, nextMatch, type Cursor, type FindOptions } from './app/findReplace.ts';
import type { Run } from './app/helpers.ts';

export interface FindReplaceHandle { open(): void }
type Options = FindOptions & { allLayers: boolean; forward: boolean };
type Layer = { id: number; name: string; text: string };

// `activeId`: the selected layer, the only one searched without Search All Layers; `select` makes a found layer active.
export function FindReplaceDialog({ ref, activeId, select, run }: { ref: Ref<FindReplaceHandle>; activeId: number | null; select: (id: number) => void; run: Run }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [find, setFind] = useState('');
  const [change, setChange] = useState('');
  const [o, setO] = useState<Options>({ allLayers: true, forward: true, caseSensitive: false, wholeWord: false, ignoreAccents: false });
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [status, setStatus] = useState('');
  useImperativeHandle(ref, () => ({ open() { setCursor(null); setStatus(''); dialog.current?.showModal(); } }));

  const layers = async () => {
    const all = await client.call('typeTexts');
    return o.allLayers ? all : all.filter(l => l.id === activeId);
  };
  const report = (list: Layer[], c: Cursor | null) => {
    setCursor(c);
    if (!c) { setStatus(t`No match found.`); return; }
    select(c.id);
    const name = list.find(l => l.id === c.id)?.name ?? '';
    setStatus(t`Found in ${name}.`);
  };
  const findNext = async (from: Cursor | null = cursor) => {
    const list = await layers();
    report(list, nextMatch(list, find, o, from, o.forward));
  };
  // The current match, when it is still one in its layer's text.
  const current = async () => {
    const c = cursor;
    if (!c || c.start === c.end) return null;
    const l = (await layers()).find(x => x.id === c.id);
    return l && findMatches(l.text, find, o).some(([a, b]) => a === c.start && b === c.end) ? c : null;
  };
  const changeOne = async (thenFind: boolean) => {
    const c = await current();
    if (!c) { await findNext(); return; }
    await run(null, () => client.call('typeReplace', [{ id: c.id, ranges: [[c.start, c.end]] }], change, 'Replace Text'));
    const at = { id: c.id, start: c.start + change.length, end: c.start + change.length };
    if (thenFind) await findNext(at);
    else { setCursor(at); setStatus(''); }
  };
  const changeAll = async () => {
    const edits = (await layers()).map(l => ({ id: l.id, ranges: findMatches(l.text, find, o) })).filter(e => e.ranges.length);
    const count = edits.reduce((s, e) => s + e.ranges.length, 0);
    setCursor(null);
    if (!count) { setStatus(t`No match found.`); return; }
    await run(null, () => client.call('typeReplace', edits, change, 'Replace All Text'));
    setStatus(plural(count, { one: '# replacement made.', other: '# replacements made.' }));
  };
  const box = (k: keyof Options, label: string) => (
    <label><input type="checkbox" checked={o[k]} onChange={e => { const v = e.currentTarget.checked; setO(p => ({ ...p, [k]: v })); }} /> {label}</label>
  );
  const hasMatch = !!cursor && cursor.start < cursor.end;
  return (
    <dialog ref={dialog} className="find-replace-dialog" aria-labelledby="find-replace-title">
      <form onSubmit={e => { e.preventDefault(); if (find) void findNext(); }}>
        <h2 id="find-replace-title"><Trans>Find and Replace Text</Trans></h2>
        <div className="find-replace">
          <div className="fields">
            <label><Trans>Find What:</Trans> <input value={find} onChange={e => { setFind(e.currentTarget.value); setStatus(''); }} autoFocus /></label>
            <label><Trans>Change To:</Trans> <input value={change} onChange={e => setChange(e.currentTarget.value)} /></label>
            <div className="options">
              {box('allLayers', t`Search All Layers`)}
              {box('forward', t`Forward`)}
              {box('caseSensitive', t`Case Sensitive`)}
              {box('wholeWord', t`Whole Word Only`)}
              {box('ignoreAccents', t`Ignore Accents`)}
            </div>
            <p className="hint" role="status">{status}</p>
          </div>
          <div className="buttons">
            <button type="button" onClick={() => dialog.current?.close()}><Trans>Done</Trans></button>
            <button type="submit" className="primary" disabled={!find}><Trans>Find Next</Trans></button>
            <button type="button" disabled={!find || !hasMatch} onClick={() => void changeOne(false)}><Trans>Change</Trans></button>
            <button type="button" disabled={!find} onClick={() => void changeAll()}><Trans>Change All</Trans></button>
            <button type="button" disabled={!find || !hasMatch} onClick={() => void changeOne(true)}><Trans>Change/Find</Trans></button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
