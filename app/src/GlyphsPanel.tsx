// Window > Glyphs (docs/M4.md section 10): the glyphs of one face per Unicode block, drawn from the
// outlines by the worker; a click inserts at the caret or appends to the selected type layer.
import { useEffect, useRef, useState } from 'react';
import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { i18n } from './i18n/index.ts';
import { X } from 'lucide-react';
import { client } from './client.ts';
import { typeLayers, type TypeCtx } from './app/typeMenu.ts';
import { appendText } from './shell/typecommands.ts';
import type { FaceInfo } from './worker/types.ts';

export const GLYPH_SUBSETS: [MessageDescriptor, number, number][] = [
  [msg`Basic Latin`, 32, 126],
  [msg`Latin-1 Supplement`, 160, 255],
  [msg`Latin Extended-A`, 256, 383],
  [msg`Latin Extended-B`, 384, 591],
  [msg`IPA Extensions`, 592, 687],
  [msg`Greek`, 880, 1023],
  [msg`Cyrillic`, 1024, 1279],
  [msg`Hebrew`, 1424, 1535],
  [msg`Arabic`, 1536, 1791],
  [msg`Punctuation`, 8192, 8303],
  [msg`Currency`, 8352, 8383],
  [msg`Letterlike Symbols`, 8448, 8527],
  [msg`Arrows`, 8592, 8703],
  [msg`Mathematical Operators`, 8704, 8959],
  [msg`Box Drawing`, 9472, 9599],
  [msg`Geometric Shapes`, 9632, 9727],
  [msg`Dingbats`, 9984, 10175],
];
const RECENT_MAX = 20;

interface Cell { gid: number; cp: number | null; name: string }
interface Cells { missing: boolean; size: number; cells: Cell[]; data: ArrayBuffer }
type Sel = { from: number; to: number } | { gids: number[] };

// The cells of one request; stale answers (face or subset changed meanwhile) are dropped.
function useCells(family: string, style: string, sel: Sel | null): Cells | null {
  const [cells, setCells] = useState<Cells | null>(null);
  const key = JSON.stringify([family, style, sel]);
  useEffect(() => {
    if (!family || !sel) { setCells(null); return; }
    let alive = true;
    client.call('glyphCells', family, style, sel).then(r => { if (alive) setCells(r); }, () => { if (alive) setCells(null); });
    return () => { alive = false; };
  }, [key]);
  return cells;
}

function GlyphCell({ cell, alpha, size, onClick, onContextMenu }: {
  cell: Cell; alpha: Uint8Array; size: number; onClick: () => void; onContextMenu?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const g = ref.current?.getContext('2d');
    if (!g) return;
    const [r, gr, b] = (getComputedStyle(ref.current!).color.match(/\d+/g) ?? ['220', '220', '220']).map(Number);
    const img = g.createImageData(size, size);
    for (let i = 0; i < alpha.length; i++) img.data.set([r, gr, b, alpha[i]], i * 4);
    g.putImageData(img, 0, 0);
  }, [alpha, size]);
  const code = cell.cp === null ? t`unmapped` : `U+${cell.cp.toString(16).toUpperCase().padStart(4, '0')}`;
  return (
    <button type="button" className="glyph-cell" title={`${cell.name} — ${code}`} aria-label={`${cell.name} ${code}`} onClick={onClick}
      onContextMenu={e => { if (onContextMenu) { e.preventDefault(); onContextMenu(); } }}>
      <canvas ref={ref} width={size} height={size} />
    </button>
  );
}

function Grid({ cells, onClick, onContextMenu }: { cells: Cells; onClick: (c: Cell) => void; onContextMenu?: (c: Cell) => void }) {
  const n = cells.size * cells.size, all = new Uint8Array(cells.data);
  return (
    <div className="glyph-grid">
      {cells.cells.map((c, i) => (
        <GlyphCell key={`${c.gid}-${i}`} cell={c} size={cells.size} alpha={all.subarray(i * n, (i + 1) * n)} onClick={() => onClick(c)}
          onContextMenu={onContextMenu && (() => onContextMenu(c))} />
      ))}
    </div>
  );
}

export function GlyphsPanel({ c, faces }: { c: TypeCtx; faces: FaceInfo[] }) {
  const families = [...new Set(faces.map(f => f.family))].sort((a, b) => a.localeCompare(b));
  const [family, setFamily] = useState(''), [style, setStyle] = useState('Regular'), [subset, setSubset] = useState(0);
  const [recent, setRecent] = useState<{ family: string; gid: number }[]>([]);
  const [alt, setAlt] = useState<Cell | null>(null), [altGids, setAltGids] = useState<number[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const fam = family || families[0] || '';
  const styles = faces.filter(f => f.family === fam).map(f => f.style);
  const sty = styles.includes(style) ? style : styles[0] ?? 'Regular';
  const [subsetMsg, from, to] = GLYPH_SUBSETS[subset];
  const subsetName = i18n._(subsetMsg), altName = alt?.name;
  const grid = useCells(fam, sty, { from, to });
  const mine = recent.filter(r => r.family === fam).map(r => r.gid);
  const recentCells = useCells(fam, sty, mine.length ? { gids: mine } : null);
  const altCells = useCells(fam, sty, alt && altGids.length ? { gids: altGids } : null);

  useEffect(() => {
    if (!alt) { setAltGids([]); return; }
    let alive = true;
    client.call('glyphAlternates', fam, sty, alt.gid).then(g => { if (alive) setAltGids(g); }, () => { if (alive) setAltGids([]); });
    return () => { alive = false; };
  }, [alt?.gid, fam, sty]);
  useEffect(() => { setAlt(null); }, [fam, sty]);

  const insert = (cell: Cell) => {
    if (cell.cp === null) { setNotice(t`That glyph has no code point — it is an OpenType alternate, reachable only through a feature.`); return; }
    const ch = String.fromCodePoint(cell.cp), tr = c.typeRef.current, n = typeLayers(c.selected)[0];
    if (tr?.editing()) tr.insert(ch);
    else if (n) void c.run(null, () => client.call('typeSetMany', [[n.id, appendText(n.text!, ch)]], 'Insert Glyph'));
    else { setNotice(t`Select a type layer, or click into one with the Type tool, then click a glyph.`); return; }
    setRecent(r => [{ family: fam, gid: cell.gid }, ...r.filter(x => x.family !== fam || x.gid !== cell.gid)].slice(0, RECENT_MAX));
    setNotice(null);
  };

  if (!families.length) return <div className="properties-panel glyphs-panel"><p className="panel-empty"><Trans>No fonts are available.</Trans></p></div>;
  return (
    <div className="properties-panel type-panel glyphs-panel">
      <div className="panel-tabs"><span className="panel-tab"><Trans>Glyphs</Trans></span></div>
      <label><Trans>Font</Trans> <select aria-label={t`Font`} value={fam} onChange={e => { const f = e.currentTarget.value; void c.ensureFamilies([f]).then(() => setFamily(f)); }}>{families.map(f => <option key={f} value={f}>{f}</option>)}</select></label>
      <label><Trans>Style</Trans> <select aria-label={t`Style`} value={sty} onChange={e => setStyle(e.currentTarget.value)}>{styles.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
      <label><Trans>Subset</Trans> <select aria-label={t`Subset`} value={subset} onChange={e => setSubset(Number(e.currentTarget.value))}>
        {GLYPH_SUBSETS.map(([label], i) => <option key={i} value={i}>{i18n._(label)}</option>)}
      </select></label>
      {grid?.missing && <p className="adjustment-note"><Trans>{fam} could not be loaded; the fallback face is shown.</Trans></p>}
      {recentCells && recentCells.cells.length > 0 && (
        <section><h4><Trans>Recently used</Trans></h4><Grid cells={recentCells} onClick={cell => setAlt(cell)} /></section>
      )}
      <div className="glyph-scroll">
        {grid && !grid.cells.length && <p className="panel-empty"><Trans>{fam} has no glyphs in {subsetName}.</Trans></p>}
        {grid ? <Grid cells={grid} onClick={insert} onContextMenu={setAlt} /> : <p className="panel-empty"><Trans>Loading the face…</Trans></p>}
      </div>
      {alt && (
        <section>
          <h4><Trans>Alternates for {altName}</Trans> <button type="button" className="path-action" aria-label={t`Close alternates`} onClick={() => setAlt(null)}><X size={12} /></button></h4>
          {altCells ? <Grid cells={altCells} onClick={insert} /> : <p className="panel-empty"><Trans>No alternates in this font.</Trans></p>}
        </section>
      )}
      {notice && <p className="adjustment-note" role="status">{notice}</p>}
      <p className="panel-empty"><Trans>Right-click a glyph to list its OpenType alternates.</Trans></p>
    </div>
  );
}
