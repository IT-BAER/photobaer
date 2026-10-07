// Window > Shapes (docs/M4.md section 5): the custom shape library as a searchable grid of 34 px
// thumbnails; a click arms the Custom Shape tool with that shape, Load adds the shapes of a .csh.
import { useEffect, useRef, useState } from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { pathData } from './app/svgcss.ts';
import { parseCsh, shapeLibrary, type CustomShape } from './shell/customShapes.ts';

const THUMB = 34, INSET = 3;

function Thumb({ shape }: { shape: CustomShape }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, THUMB, THUMB);
    ctx.setTransform(THUMB - 2 * INSET, 0, 0, THUMB - 2 * INSET, INSET, INSET);
    ctx.fillStyle = '#e8e8e8';
    ctx.fill(new Path2D(pathData(shape.path)), shape.path.fill_rule);
  }, [shape]);
  return <canvas ref={ref} width={THUMB} height={THUMB} aria-hidden />;
}

export function ShapesPanel({ selected, arm }: { selected: string; arm: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [, setVersion] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const lib = shapeLibrary();
  const all = lib.list();
  const current = selected || all[0]?.id;
  const shown = all.filter(s => s.name.toLowerCase().includes(q.trim().toLowerCase()));
  const armed = (name: string) => t`${name} armed. Drag on the canvas to draw it.`;
  const load = async (f: File) => {
    const r = parseCsh(new Uint8Array(await f.arrayBuffer()));
    if (!r.shapes.length) { setMessage(r.warnings[0] ?? t`No shapes found in that file.`); return; }
    lib.append(r.shapes);
    setVersion(v => v + 1);
    const n = r.shapes.length;
    const fileName = f.name, first = r.warnings[0], w = r.warnings.length;
    const count = plural(n, { one: '# shape', other: '# shapes' });
    const warns = plural(w, { one: '# warning', other: '# warnings' });
    setMessage(w ? t`Loaded ${count} from ${fileName}; ${warns}: ${first}` : t`Loaded ${count} from ${fileName}.`);
  };
  return (
    <div className="adjustments-panel shapes-panel">
      <div className="panel-tabs"><span className="panel-tab"><Trans>Shapes</Trans></span></div>
      <input type="search" placeholder={t`Search shapes`} aria-label={t`Search shapes`} value={q} onChange={e => setQ(e.currentTarget.value)} />
      {!shown.length && <p className="panel-empty"><Trans>No shapes match “{q}”.</Trans></p>}
      <div className="shape-grid">
        {shown.map(s => (
          <button key={s.id} type="button" title={s.name} aria-label={s.name} aria-pressed={s.id === current}
            onClick={() => { arm(s.id); setMessage(armed(s.name)); }}>
            <Thumb shape={s} />
          </button>
        ))}
      </div>
      {message && <p className="panel-empty" role="status">{message}</p>}
      <div className="shapes-footer">
        <button type="button" title={t`Load a .csh custom shape library`} onClick={() => file.current?.click()}><Trans>Load…</Trans></button>
        <span className="panel-empty"><Trans>Clicking a shape arms the Custom Shape tool.</Trans></span>
      </div>
      <input ref={file} type="file" accept=".csh" hidden aria-label={t`Custom shape file`}
        onChange={e => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) void load(f); }} />
    </div>
  );
}
