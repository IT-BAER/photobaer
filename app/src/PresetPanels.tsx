// Pattern picker (document patterns merged with the preset library) and the Window > Styles, Patterns and
// Gradients panels. A preset pattern is copied into the document (`addDocumentPattern`) before anything uses it.
import { useEffect, useRef, useState } from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Plus, Trash2 } from 'lucide-react';
import { client } from './client.ts';
import type { DocInfo, LayerNode } from './engine.worker.ts';
import type { BrushLibrary } from './brushes/store.ts';
import { parsePat } from './brushes/abr.ts';
import { emptyStyle, patternChoices, patternRefs, type SavedStyle, type StyleLibrary } from './layerStyle.ts';
import { rampCss } from './gradients/gradient.ts';
import { resolvePreset, type GradientPreset } from './gradients/presets.ts';
import type { Rgb } from './shell/color.ts';

const THUMB = 56;
const ICON = { size: 14, strokeWidth: 1.75 };

/** Copies every preset pattern `value` names and the document lacks; the last resulting document, or null. */
export async function adoptPatterns(doc: DocInfo, library: BrushLibrary | null, value: unknown): Promise<DocInfo | null> {
  const have = new Set(doc.patterns.map(p => p.id));
  let d: DocInfo | null = null;
  for (const id of new Set(patternRefs(value))) {
    const r = have.has(id) ? undefined : library?.pattern(id);
    if (r) d = await client.call('addDocumentPattern', r);
  }
  return d;
}

// Tiles a pattern smaller than the thumbnail and scales a larger one down to fit.
function drawThumb(c: HTMLCanvasElement, w: number, h: number, rgba: Uint8ClampedArray<ArrayBuffer>) {
  if (rgba.length !== w * h * 4) return;
  const tile = document.createElement('canvas');
  tile.width = w;
  tile.height = h;
  tile.getContext('2d')!.putImageData(new ImageData(rgba, w, h), 0, 0);
  const ctx = c.getContext('2d')!;
  const s = Math.min(1, THUMB / Math.max(w, h));
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.fillStyle = ctx.createPattern(tile, 'repeat')!;
  ctx.fillRect(0, 0, THUMB / s, THUMB / s);
}

function PatternThumb({ id, preset, library }: { id: string; preset: boolean; library: BrushLibrary | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    const r = preset ? library?.pattern(id) : undefined;
    let got: Promise<{ width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> }>;
    if (r) {
      const rgba = new Uint8ClampedArray(r.width * r.height * 4);
      if (r.channels === 4) rgba.set(r.data);
      else for (let i = 0; i < r.width * r.height; i++) rgba.set([r.data[i], r.data[i], r.data[i], 255], i * 4);
      got = Promise.resolve({ width: r.width, height: r.height, rgba });
    } else {
      got = client.call('patternPixels', id).then(p => ({ width: p.width, height: p.height, rgba: new Uint8ClampedArray(p.data) }));
    }
    got.then(p => { if (alive && ref.current) drawThumb(ref.current, p.width, p.height, p.rgba); }, () => {});
    return () => { alive = false; };
  }, [id, preset, library]);
  return <canvas ref={ref} width={THUMB} height={THUMB} aria-hidden />;
}

/** Searchable pattern grid. A click picks (`activate` absent) or selects (`activate` given); a double click activates. */
export function PatternPicker({ doc, library, value, set, onDoc, onError, activate }: {
  doc: DocInfo; library: BrushLibrary | null; value: string; set: (id: string) => void;
  onDoc: (d: DocInfo) => void; onError: (m: string) => void; activate?: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [, setImported] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const shown = patternChoices(doc.patterns, library?.patterns() ?? [], q);
  const adopt = (id: string, then: (id: string) => void) => {
    adoptPatterns(doc, library, { pattern_id: id }).then(d => { if (d) onDoc(d); then(id); }, e => onError((e as Error).message));
  };
  async function importPat(f: File) {
    if (!library) { onError(t`The pattern library is not available.`); return; }
    const { patterns, warnings } = parsePat(new Uint8Array(await f.arrayBuffer()));
    if (patterns.length) library.import({ presets: [], tips: [], patterns });
    if (!patterns.length || warnings.length) {
      const name = f.name, count = patterns.length, extra = warnings.join('; ');
      const summary = plural(count, { one: '# pattern imported', other: '# patterns imported' });
      onError(warnings.length ? t`${name}: ${summary}; ${extra}` : t`${name}: ${summary}`);
    }
    setImported(n => n + 1);
  }
  return (
    <div className="style-pattern-picker">
      <input type="search" placeholder={t`Search patterns`} aria-label={t`Search patterns`} value={q} onChange={e => setQ(e.currentTarget.value)} />
      {shown.length ? (
        <div className="style-pattern-grid">
          {shown.map(c => (
            <button key={c.id} type="button" title={c.name} aria-label={c.name} aria-pressed={c.id === value} className={c.id === value ? 'active' : ''}
              onClick={() => (activate ? set(c.id) : adopt(c.id, set))} onDoubleClick={() => activate && adopt(c.id, activate)}>
              <PatternThumb id={c.id} preset={c.preset} library={library} />
            </button>
          ))}
        </div>
      ) : <p className="adjustment-note"><Trans>No patterns.</Trans></p>}
      <button type="button" onClick={() => file.current?.click()}><Trans>Import .pat…</Trans></button>
      <input ref={file} type="file" hidden accept=".pat" onChange={e => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) void importPat(f); }} />
    </div>
  );
}

export function PatternsPanel({ doc, library, onDoc, onError, fill }: {
  doc: DocInfo; library: BrushLibrary | null; onDoc: (d: DocInfo) => void; onError: (m: string) => void; fill: (id: string) => void;
}) {
  const [sel, setSel] = useState('');
  return (
    <div className="adjustments-panel">
      <div className="panel-tabs"><span className="panel-tab"><Trans>Patterns</Trans></span></div>
      <PatternPicker doc={doc} library={library} value={sel} set={setSel} onDoc={onDoc} onError={onError} activate={fill} />
    </div>
  );
}

export function GradientsPanel({ presets, fg, bg, fill }: { presets: GradientPreset[]; fg: Rgb; bg: Rgb; fill: (p: GradientPreset) => void }) {
  return (
    <div className="adjustments-panel">
      <div className="panel-tabs"><span className="panel-tab"><Trans>Gradients</Trans></span></div>
      <div className="gradient-preset-grid">
        {presets.map(p => {
          const g = resolvePreset(p, fg, bg);
          return <button key={p.id} type="button" title={p.name} aria-label={p.name} style={{ backgroundImage: `${rampCss(g, g.interpolation)}, var(--checker)` }} onDoubleClick={() => fill(p)} />;
        })}
      </div>
    </div>
  );
}

export function StylesPanel({ styles, node, apply }: { styles: StyleLibrary; node: LayerNode | null; apply: (s: SavedStyle) => void }) {
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [, setVersion] = useState(0);
  const changed = () => setVersion(v => v + 1);
  const list = styles.list(q);
  const deleteLabel = (name: string) => t`Delete ${name}`;
  return (
    <div className="adjustments-panel">
      <div className="panel-tabs"><span className="panel-tab"><Trans>Styles</Trans></span></div>
      <input type="search" placeholder={t`Search styles`} aria-label={t`Search styles`} value={q} onChange={e => setQ(e.currentTarget.value)} />
      <ul className="style-library-list" aria-label={t`Saved styles`}>
        {list.map(s => (
          <li key={s.id}>
            <button type="button" className="style-library-name" disabled={!node} onClick={() => apply(s)}>{s.name}</button>
            <button type="button" aria-label={deleteLabel(s.name)} title={t`Delete style`} onClick={() => { styles.remove(s.id); changed(); }}><Trash2 {...ICON} /></button>
          </li>
        ))}
        {!list.length && <li className="adjustment-note"><Trans>No saved styles.</Trans></li>}
      </ul>
      <div className="panel-footer">
        <input placeholder={t`Style name`} aria-label={t`New style name`} value={name} onChange={e => setName(e.currentTarget.value)} />
        <button type="button" aria-label={t`Save the layer style`} title={t`Save the layer style`} disabled={!node}
          onClick={() => { if (node) { styles.save(name, node.style ?? emptyStyle(), node.blending); setName(''); changed(); } }}><Plus {...ICON} /></button>
        <button type="button" disabled={!styles.list().length} onClick={() => { if (confirm(t`Delete all saved styles?`)) { styles.clear(); changed(); } }}><Trans context="verb">Clear</Trans></button>
      </div>
    </div>
  );
}
