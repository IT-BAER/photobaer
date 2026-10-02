// Filter Gallery effect layers (docs/M5.md section 4): the effects by group, the selected layer's params,
// and the stack top first with an enable checkbox per layer. Layer 0 applies first.
import { useState } from 'react';
import { setIn } from '../layerStyle.ts';
import { Field } from '../PropertiesPanel.tsx';
import type { GalleryLayer, ParamValue } from './lastFilter.ts';
import { defaults, fieldSpecs, schema, specOf, visibleParams } from './schema.ts';

const GROUPS: [string, string][] = [
  ['gallery.artistic', 'Artistic'], ['gallery.brushStrokes', 'Brush Strokes'], ['gallery.distort', 'Distort'],
  ['gallery.sketch', 'Sketch'], ['gallery.stylize', 'Stylize'], ['gallery.texture', 'Texture'],
];

// An effect's visible params at their defaults; the gallery filter supplies its seed and colors.
function fresh(kind: string): GalleryLayer {
  const s = specOf(kind)!, d = defaults(s);
  return { kind, enabled: true, params: Object.fromEntries(visibleParams(s).map(p => [p.key, d[p.key]])) };
}

const label = (kind: string) => specOf(kind)?.label ?? kind;

export function GalleryStack({ value, onChange }: { value: GalleryLayer[]; onChange: (v: GalleryLayer[]) => void }) {
  const [sel, setSel] = useState(value.length - 1);
  const cur = value[sel] as GalleryLayer | undefined;
  const spec = cur && specOf(cur.kind);
  const put = (v: GalleryLayer[], i: number) => { onChange(v); setSel(i); };
  const pick = (kind: string) => (cur
    ? put(value.map((l, i) => (i === sel ? { ...fresh(kind), enabled: l.enabled } : l)), sel)
    : put([...value, fresh(kind)], value.length));
  const move = (d: number) => {
    const v = [...value];
    [v[sel], v[sel + d]] = [v[sel + d], v[sel]];
    put(v, sel + d);
  };
  return (
    <div className="gallery-stack">
      <div className="gallery-effects">
        {GROUPS.map(([g, name], i) => (
          <details key={g} open={i === 0}>
            <summary>{name}</summary>
            {schema().filter(s => s.group === g).map(s => (
              <button key={s.id} type="button" aria-pressed={cur?.kind === s.id} onClick={() => pick(s.id)}>{s.label}</button>
            ))}
          </details>
        ))}
      </div>
      <div className="gallery-params">
        <h3>{cur ? label(cur.kind) : 'No effect selected'}</h3>
        {!cur || !spec ? <p className="adjustment-note">Pick a filter to start a stack.</p>
          : fieldSpecs(spec).length === 0 ? <p className="adjustment-note">This filter has no options.</p>
            : fieldSpecs(spec).map(f => <Field key={f.path} spec={f} params={cur.params}
                onChange={(path, v) => onChange(value.map((l, i) => (i === sel ? { ...l, params: setIn(l.params, path, v as ParamValue) } : l)))} />)}
      </div>
      <div className="gallery-layers">
        <ol aria-label="Effect layers">
          {value.map((l, i) => ({ l, i })).reverse().map(({ l, i }) => (
            <li key={i}>
              <input type="checkbox" aria-label={`${label(l.kind)} enabled`} checked={l.enabled}
                onChange={() => onChange(value.map((q, k) => (k === i ? { ...q, enabled: !q.enabled } : q)))} />
              <button type="button" aria-pressed={i === sel} onClick={() => setSel(i)}>{`${i + 1}. ${label(l.kind)}`}</button>
            </li>
          ))}
        </ol>
        <div className="gallery-buttons">
          <button type="button" onClick={() => put([...value, cur ? { ...cur, params: { ...cur.params } } : fresh(schema().find(s => s.group === GROUPS[0][0])!.id)], value.length)}>New Effect Layer</button>
          <button type="button" disabled={!cur} onClick={() => put(value.filter((_, i) => i !== sel), value.length - 2)}>Delete</button>
          <button type="button" disabled={!cur || sel <= 0} onClick={() => move(-1)}>Move Down</button>
          <button type="button" disabled={!cur || sel >= value.length - 1} onClick={() => move(1)}>Move Up</button>
        </div>
      </div>
    </div>
  );
}
