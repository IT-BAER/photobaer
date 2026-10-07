// Missing-font dialogs (docs/M4.md section 8): the per-layer prompt when editing starts, Resolve
// Missing Fonts (one replacement per missing face) and Replace All Missing Fonts (one for all).
import { useEffect, useRef, useState } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { client } from './client.ts';
import type { TextJson } from './psd/text.ts';
import { substituteFonts, type FontSub, type MissingRow } from './shell/typecommands.ts';
import type { FaceInfo } from './worker/types.ts';

export type FontDialog =
  | { kind: 'layer'; id: number; rows: MissingRow[]; resume: () => void }
  | { kind: 'resolve'; rows: MissingRow[]; layerIds?: number[] }
  | { kind: 'replace'; rows: MissingRow[] };

export interface FontDialogCtx {
  faces: FaceInfo[]; docName: string;
  texts: () => [number, TextJson][];
  // One history step over every changed layer; resolves false when the worker refused it.
  commit: (edits: [number, TextJson][], label: string) => Promise<boolean>;
  upload: () => Promise<void>; manage: () => void; close: () => void;
  ensure: (families: string[]) => Promise<void>;
}

// Families tried in order for the per-layer Replace; the first that draws the text wins, in Regular.
const DEFAULT_FAMILIES = ['Myriad Pro', 'Arial', 'Helvetica Neue', 'Segoe UI', 'Noto Sans', 'Liberation Sans', 'DejaVu Sans'];
const key = (r: { family: string; style: string }) => `${r.family}\0${r.style}`;
const faceName = (r: { family: string; style: string }) => (r.style ? `${r.family} — ${r.style}` : r.family);
const families = (faces: FaceInfo[]) => [...new Set(faces.map(f => f.family))].sort((a, b) => a.localeCompare(b));
const stylesOf = (faces: FaceInfo[], family: string) => faces.filter(f => f.family === family).map(f => f.style);

async function apply(c: FontDialogCtx, subs: FontSub[], label: string, layerIds?: number[]) {
  await c.ensure(subs.map(s => s.target.family));
  const edits = c.texts().filter(([id]) => !layerIds || layerIds.includes(id))
    .map(([id, t]) => [id, substituteFonts(t, subs), t] as const).filter(([, n, t]) => n !== t).map(([id, n]) => [id, n] as [number, TextJson]);
  return !edits.length || c.commit(edits, label);
}

function Shell({ title, children, onCancel }: { title: string; children: React.ReactNode; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} className="missing-fonts-dialog" aria-label={title} onCancel={e => { e.preventDefault(); onCancel(); }}>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

const UploadButton = ({ c, busy }: { c: FontDialogCtx; busy: boolean }) => (
  <button type="button" disabled={busy} onClick={() => void c.upload()}><Trans>Upload font…</Trans></button>
);

// Editing a layer whose fonts are missing: Replace swaps them for the first default family that draws
// the layer's text ("Replace Missing Fonts", this layer only) and resumes editing.
function LayerDialog({ d, c }: { d: Extract<FontDialog, { kind: 'layer' }>; c: FontDialogCtx }) {
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const replace = async () => {
    setBusy(true); setErr(null);
    const all = families(c.faces), order = [...new Set([...DEFAULT_FAMILIES.filter(f => all.includes(f)), ...all])];
    const subs: FontSub[] = [];
    for (const r of d.rows) {
      for (const family of order) {
        if (DEFAULT_FAMILIES.includes(family)) await c.ensure([family]);
        if (await client.call('fontCovers', family, 'Regular', r.text)) { subs.push({ source: r, target: { family, style: 'Regular' } }); break; }
      }
    }
    if (subs.length !== d.rows.length) { setErr(t`No available default font can display this text. Choose Manage to select a replacement.`); setBusy(false); return; }
    if (await apply(c, subs, 'Replace Missing Fonts', [d.id])) { c.close(); d.resume(); } else setBusy(false);
  };
  return (
    <Shell title={t`Missing Fonts`} onCancel={c.close}>
      <p><Trans>These fonts are missing in this text layer:</Trans></p>
      <ul>{d.rows.map(r => <li key={key(r)}>{faceName(r)}</li>)}</ul>
      <p><Trans>To edit the text now, replace the missing font with the default. You can also manage missing fonts for your entire document.</Trans></p>
      {err && <p role="alert">{err}</p>}
      <div className="actions">
        <UploadButton c={c} busy={busy} />
        <button type="button" disabled={busy} onClick={c.manage}><Trans>Manage</Trans></button>
        <button type="button" onClick={c.close}><Trans>Cancel</Trans></button>
        <button type="button" className="primary" disabled={busy} onClick={() => void replace()}><Trans>Replace</Trans></button>
      </div>
    </Shell>
  );
}

// Type > Resolve Missing Fonts (also opened when a document with missing fonts opens): each missing
// face gets a replacement or stays; the chosen face must draw the text set in the missing one.
function ResolveDialog({ d, c }: { d: Extract<FontDialog, { kind: 'resolve' }>; c: FontDialogCtx }) {
  const [pick, setPick] = useState<Record<string, { family: string; style: string }>>({});
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const all = families(c.faces);
  const docName = c.docName;
  const ok = async () => {
    setBusy(true); setErr(null);
    const subs: FontSub[] = [];
    for (const r of d.rows) {
      const sub = pick[key(r)];
      if (!sub) continue;
      await c.ensure([sub.family]);
      if (!await client.call('fontCovers', sub.family, sub.style, r.text)) {
        { const family = sub.family, source = `${r.family} ${r.style}`; setErr(t`${family} does not contain every character used by ${source}. Choose another font.`); };
        setBusy(false);
        return;
      }
      subs.push({ source: r, target: sub });
    }
    if (await apply(c, subs, 'Resolve Missing Fonts', d.layerIds)) c.close(); else setBusy(false);
  };
  return (
    <Shell title={t`Resolve Missing Fonts`} onCancel={c.close}>
      <p>{d.layerIds ? t`“${docName}” uses fonts that could not be loaded. Choose replacements for the selected text. Text layout may change.` : t`“${docName}” uses fonts that could not be loaded. Choose replacements for the whole document. Text layout may change.`}</p>
      <p><Trans>Unresolved fonts keep their current rendering until the text is edited. Original font names are kept; choose permanent replacements now or later from the Type menu.</Trans></p>
      {!all.length && <p role="status"><Trans>No installed fonts are available for replacement.</Trans></p>}
      <div className="missing-fonts-list">
        {d.rows.map(r => {
          const k = key(r), sub = pick[k], name = faceName(r), layerCount = r.layerIds.length;
          return (
            <div key={k} className="missing-font-row">
              <div><strong>{name}</strong> <span><Trans>Text layers: {layerCount}</Trans></span></div>
              <select aria-label={t`Replacement for ${name}`} value={sub?.family ?? ''} disabled={busy} onChange={e => {
                const family = e.currentTarget.value, styles = stylesOf(c.faces, family);
                setPick(p => {
                  const n = { ...p };
                  if (!family) delete n[k]; else n[k] = { family, style: styles.includes(r.style) ? r.style : styles[0] ?? 'Regular' };
                  return n;
                });
              }}>
                <option value="">{t`Leave unchanged`}</option>
                {all.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
              {sub && (
                <select aria-label={t`Replacement style for ${name}`} value={sub.style} disabled={busy} onChange={e => { const style = e.currentTarget.value; setPick(p => ({ ...p, [k]: { ...sub, style } })); }}>
                  {stylesOf(c.faces, sub.family).map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
            </div>
          );
        })}
      </div>
      {err && <p role="alert">{err}</p>}
      <div className="actions">
        <UploadButton c={c} busy={busy} />
        <button type="button" onClick={c.close}><Trans>Skip for Now</Trans></button>
        <button type="button" className="primary" disabled={busy || !Object.keys(pick).length} onClick={() => void ok()}>{busy ? t`Replacing…` : t`Replace Fonts`}</button>
      </div>
    </Shell>
  );
}

// Type > Replace All Missing Fonts: every run set in any missing face takes one family and style.
function ReplaceDialog({ d, c }: { d: Extract<FontDialog, { kind: 'replace' }>; c: FontDialogCtx }) {
  const all = families(c.faces), fams = [...new Set(d.rows.map(r => r.family))], familyCount = fams.length;
  const [family, setFamily] = useState(all[0] ?? ''), styles = stylesOf(c.faces, family);
  const [style, setStyle] = useState(styles[0] ?? 'Regular');
  const [busy, setBusy] = useState(false);
  const ok = async () => {
    setBusy(true);
    if (await apply(c, d.rows.map(r => ({ source: r, target: { family, style } })), 'Replace All Missing Fonts')) c.close(); else setBusy(false);
  };
  return (
    <Shell title={t`Replace All Missing Fonts`} onCancel={c.close}>
      <p>{fams.length === 1 ? t`Replacing ${fams[0]}.` : t`Replacing ${familyCount} missing families.`}</p>
      <label className="adjustment-field"><span><Trans>Replace With</Trans></span>
        <select value={family} onChange={e => { const f = e.currentTarget.value, s = stylesOf(c.faces, f); setFamily(f); setStyle(s.includes(style) ? style : s[0] ?? 'Regular'); }}>
          {all.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
      </label>
      <label className="adjustment-field"><span><Trans>Style</Trans></span>
        <select value={style} onChange={e => setStyle(e.currentTarget.value)}>{styles.map(s => <option key={s} value={s}>{s}</option>)}</select>
      </label>
      <div className="actions">
        <UploadButton c={c} busy={busy} />
        <button type="button" onClick={c.close}><Trans>Cancel</Trans></button>
        <button type="button" className="primary" disabled={busy || !family} onClick={() => void ok()}><Trans>OK</Trans></button>
      </div>
    </Shell>
  );
}

export function MissingFontsDialog({ d, c }: { d: FontDialog; c: FontDialogCtx }) {
  if (d.kind === 'layer') return <LayerDialog d={d} c={c} />;
  if (d.kind === 'resolve') return <ResolveDialog d={d} c={c} />;
  return <ReplaceDialog d={d} c={c} />;
}
