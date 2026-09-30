// The generic filter dialog built from the schema, also used for Edit > Fade (docs/M5.md section 2).
import { useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from 'react';
import { client } from '../client.ts';
import type { FieldSpec } from '../adjustments.ts';
import { BLEND_MODES } from '../layers.ts';
import { setIn } from '../layerStyle.ts';
import { ValueInput } from '../LevelsCurvesBody.tsx';
import { Field } from '../PropertiesPanel.tsx';
import type { Viewer } from '../viewer.ts';
import type { DocInfo } from '../worker/types.ts';
import { applyFilter, type CurvePoint, type ParamValue } from './lastFilter.ts';
import { ShearCurve } from './ShearCurve.tsx';
import { defaults, fieldSpecs, previewScale, type FilterSpec } from './schema.ts';

type Target = 'pixels' | 'mask' | 'selection';
type Show = (d: DocInfo | null) => void;
type Params = Record<string, ParamValue>;
type FadeParams = { opacity: number; mode: string };
export type FilterRequest = { type: 'filter'; spec: FilterSpec; id: number; target: Target } | { type: 'fade'; id: number; step: string };
export interface FilterDialogHandle { open(r: FilterRequest): void }

const FADE_DEFAULTS: Params = { opacity: 100, mode: 'normal' };
const FADE_FIELDS: FieldSpec[] = [
  { type: 'number', label: 'Opacity (%)', path: 'opacity', min: 0, max: 100, step: 1 },
  { type: 'select', label: 'Mode', path: 'mode', options: BLEND_MODES.map(m => [m, m.replace(/(^| )\w/g, c => c.toUpperCase())]) },
];

export function FilterDialog({ ref, viewer, show, setError }: {
  ref: Ref<FilterDialogHandle>; viewer: RefObject<Viewer | null>; show: Show; setError: (msg: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [req, setReq] = useState<FilterRequest | null>(null);
  const [params, setParams] = useState<Params>({});
  const [previewOn, setPreviewOn] = useState(true);
  const [alt, setAlt] = useState(false);
  // `gen` drops scheduled renders once params change or the dialog closes; `session`: a worker preview is open.
  const st = useRef({ gen: 0, session: false, closing: false, chain: Promise.resolve() as Promise<unknown>, timers: [] as ReturnType<typeof setTimeout>[] });

  const enqueue = (fn: () => Promise<unknown>) => {
    st.current.chain = st.current.chain.then(fn).catch(e => setError((e as Error).message));
  };
  const stop = () => { st.current.gen++; st.current.timers.forEach(clearTimeout); st.current.timers = []; };
  const preview = (r: FilterRequest, p: Params, view: number[], scale: number) => {
    st.current.session = true;
    return r.type === 'filter'
      ? client.call('applyFilter', r.id, r.target, { kind: r.spec.id, params: p }, r.spec.label, true, view, scale)
      : client.call('fade', r.id, p as FadeParams, true);
  };
  const endSession = async (commit: boolean) => {
    if (!st.current.session) return;
    st.current.session = false;
    show(await client.call('previewEnd', commit));
  };
  const reset = (r: FilterRequest) => setParams(r.type === 'filter' ? defaults(r.spec) : FADE_DEFAULTS);

  useImperativeHandle(ref, () => ({
    open(r) {
      stop();
      st.current.closing = false;
      setReq(r);
      reset(r);
      setAlt(false);
      dialog.current?.showModal();
    },
  }), []);

  // Each change restarts the render 16 ms later: a proxy render first when the view is large, then full resolution.
  useEffect(() => {
    if (!req || st.current.closing) return;
    stop();
    const g = st.current.gen, r = req, p = params;
    if (!previewOn || (r.type === 'filter' && !r.spec.preview)) { enqueue(() => endSession(false)); return; }
    st.current.timers.push(setTimeout(() => {
      const rect = r.type === 'filter' ? viewer.current?.visibleRect() ?? null : null;
      const view = rect ? [...rect] : [], scale = rect ? previewScale(rect[2], rect[3]) : 1;
      enqueue(async () => {
        if (g !== st.current.gen) return;
        show(await preview(r, p, view, scale));
        if (scale < 1 && g === st.current.gen) {
          st.current.timers.push(setTimeout(() => enqueue(async () => { if (g === st.current.gen) show(await preview(r, p, view, 1)); }), 350));
        }
      });
    }, 16));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, params, previewOn]);

  // OK renders the whole target at full resolution: inside the open preview session, or as a plain step.
  function ok() {
    if (!req) return;
    stop();
    st.current.closing = true;
    dialog.current?.close();
    const r = req, p = params;
    enqueue(async () => {
      try {
        if (r.type === 'fade') {
          if (st.current.session) { await preview(r, p, [], 1); await endSession(true); } else show(await client.call('fade', r.id, p as FadeParams));
          return;
        }
        await applyFilter(async f => {
          if (st.current.session) { await preview(r, f.params, [], 1); await endSession(true); }
          else show(await client.call('applyFilter', r.id, r.target, { kind: f.kind, params: f.params }, f.label));
        }, { kind: r.spec.id, params: p, label: r.spec.label });
      } catch (e) {
        await endSession(false);
        throw e;
      } finally {
        setReq(null);
      }
    });
  }

  function cancel() {
    stop();
    if (st.current.closing) return;
    st.current.closing = true;
    enqueue(() => endSession(false).finally(() => setReq(null)));
  }

  const title = req ? (req.type === 'fade' ? `Fade ${req.step}` : req.spec.label) : 'Filter';
  const fields = req?.type === 'filter' ? fieldSpecs(req.spec) : FADE_FIELDS;
  return (
    <dialog ref={dialog} className="filter-dialog" aria-label={title} onClose={cancel} onKeyDown={e => setAlt(e.altKey)} onKeyUp={e => setAlt(e.altKey)}>
      <form onSubmit={e => { e.preventDefault(); ok(); }}>
        <h2>{title}</h2>
        {req?.type === 'filter' && req.spec.params.filter(p => p.kind === 'curve').map(p => (
          <ShearCurve key={p.key} value={params[p.key] as CurvePoint[]} onChange={v => setParams(q => ({ ...q, [p.key]: v }))} />
        ))}
        {req && fields.filter(f => !f.path.startsWith('kernel.')).map(f => <Field key={f.path} spec={f} params={params} onChange={(path, v) => setParams(q => setIn(q, path, v as ParamValue))} />)}
        {req?.type === 'filter' && req.spec.params.some(p => p.kind === 'kernel') && (
          <div className="kernel-grid">
            {fields.filter(f => f.path.startsWith('kernel.')).map(f => f.type === 'number' && (
              <ValueInput key={f.path} label={f.label} min={f.min} max={f.max} step={f.step} value={Number((params.kernel as number[])[Number(f.path.slice(7))])}
                set={v => setParams(q => setIn(q, f.path, Math.min(f.max, Math.max(f.min, v)) as ParamValue))} />
            ))}
          </div>
        )}
        {(req?.type === 'fade' || req?.spec.preview) && (
          <label className="adjustment-check"><input type="checkbox" checked={previewOn} onChange={e => setPreviewOn(e.currentTarget.checked)} /> Preview</label>
        )}
        <div className="actions">
          {alt
            ? <button type="button" onClick={() => req && reset(req)}>Reset</button>
            : <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>}
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </dialog>
  );
}

// A filter command: runs at once without visible params, else opens the dialog.
export function runFilter(spec: FilterSpec, id: number, target: Target, dialog: FilterDialogHandle | null, show: Show) {
  if (fieldSpecs(spec).length) { dialog?.open({ type: 'filter', spec, id, target }); return Promise.resolve(); }
  return applyFilter(async f => show(await client.call('applyFilter', id, target, { kind: f.kind, params: f.params }, f.label)),
    { kind: spec.id, params: defaults(spec), label: spec.label });
}
