// Image > Apply Image (live preview on the active layer) and Image > Calculations (into a new
// channel or the selection).
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { client } from './client.ts';
import { BLEND_MODES } from './layers.ts';
import type { DocInfo, ImageSource } from './engine.worker.ts';
import type { LayerNode } from './worker/types.ts';

export type ImageCalcRequest = { kind: 'apply'; id: number } | { kind: 'calc' };
export interface ImageCalcHandle { open(r: ImageCalcRequest): void }

type Form = {
  src1: ImageSource; src2: ImageSource; mode: string; opacity: number; preserve: boolean; result: 'channel' | 'selection'; preview: boolean;
};

const title = (s: string) => s.replace(/(^| )\w/g, c => c.toUpperCase());
const pixelLayers = (nodes: LayerNode[]): LayerNode[] =>
  nodes.flatMap(n => [...(n.kind === 'group' ? pixelLayers(n.children ?? []) : []), ...(n.kind === 'group' || n.kind === 'adjustment' || n.kind === 'fill' ? [] : [n])]);

function SourceFields({ label, doc, value, set, calc }: { label: string; doc: DocInfo; value: ImageSource; set: (s: ImageSource) => void; calc: boolean }) {
  const channels: [string, string][] = [
    ...(calc ? [] : [['rgb', 'RGB']] as [string, string][]),
    ['red', 'Red'], ['green', 'Green'], ['blue', 'Blue'],
    ...(calc ? [['gray', 'Gray']] as [string, string][] : []),
    ...(value.layer !== null ? [['alpha', 'Transparency']] as [string, string][] : []),
    ...doc.channels.map(c => [`channel:${c.id}`, c.name] as [string, string]),
  ];
  return (
    <fieldset>
      <legend>{label}</legend>
      <label>Layer <select aria-label={`${label} layer`} value={value.layer ?? 'merged'}
        onChange={e => {
          const layer = e.currentTarget.value === 'merged' ? null : Number(e.currentTarget.value);
          set({ ...value, layer, channel: layer === null && value.channel === 'alpha' ? (calc ? 'gray' : 'rgb') : value.channel });
        }}>
        <option value="merged">Merged</option>
        {pixelLayers(doc.layers).map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
      </select></label>
      <label>Channel <select aria-label={`${label} channel`} value={value.channel} onChange={e => set({ ...value, channel: e.currentTarget.value })}>
        {channels.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select></label>
      <label><input type="checkbox" checked={value.invert} onChange={e => set({ ...value, invert: e.currentTarget.checked })} /> Invert</label>
    </fieldset>
  );
}

export function ImageCalcDialog({ ref, doc, show, setError }: {
  ref: Ref<ImageCalcHandle>; doc: DocInfo | null; show: (d: DocInfo | null) => void; setError: (msg: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [req, setReq] = useState<ImageCalcRequest | null>(null);
  const [form, setForm] = useState<Form>({
    src1: { layer: null, channel: 'rgb', invert: false }, src2: { layer: null, channel: 'gray', invert: false },
    mode: 'multiply', opacity: 100, preserve: true, result: 'channel', preview: true,
  });
  // One worker call at a time; `session`: an Apply Image preview is open in the worker.
  const st = useRef({ chain: Promise.resolve() as Promise<unknown>, session: false, closing: false });
  const enqueue = (fn: () => Promise<unknown>) => { st.current.chain = st.current.chain.then(fn).catch(e => setError((e as Error).message)); };
  const endSession = async (commit: boolean) => {
    if (!st.current.session) return;
    st.current.session = false;
    show(await client.call('previewEnd', commit));
  };
  const apply = (id: number, f: Form) => client.call('applyImage', id, f.src1, f.mode, f.opacity / 100, f.preserve, true);

  useImperativeHandle(ref, () => ({
    open(r) {
      st.current.closing = false;
      setReq(r);
      setForm(f => ({
        ...f, mode: 'multiply', opacity: 100,
        src1: { layer: null, channel: r.kind === 'apply' ? 'rgb' : 'gray', invert: false },
        src2: { layer: null, channel: 'gray', invert: false },
      }));
      dialog.current?.showModal();
    },
  }), []);

  useEffect(() => {
    if (req?.kind !== 'apply' || st.current.closing) return;
    const id = req.id, f = form;
    const t = setTimeout(() => enqueue(async () => {
      if (st.current.closing) return;
      if (!f.preview) { await endSession(false); return; }
      st.current.session = true;
      show(await apply(id, f));
    }), 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, form]);

  function ok() {
    if (!req) return;
    st.current.closing = true;
    dialog.current?.close();
    const r = req, f = form;
    enqueue(async () => {
      try {
        if (r.kind === 'calc') { show(await client.call('calculations', f.src1, f.src2, f.mode, f.opacity / 100, f.result)); return; }
        st.current.session = true;
        show(await apply(r.id, f));
        await endSession(true);
      } catch (e) {
        await endSession(false);
        throw e;
      } finally {
        setReq(q => (q === r ? null : q));
      }
    });
  }

  function cancel() {
    if (st.current.closing) return;
    st.current.closing = true;
    const r = req;
    enqueue(() => endSession(false).finally(() => setReq(q => (q === r ? null : q))));
  }

  const calc = req?.kind === 'calc';
  const name = calc ? 'Calculations' : 'Apply Image';
  return (
    <dialog ref={dialog} className="live-preview image-calc" aria-label={name} onClose={cancel}>
      {doc && req && (
        <form onSubmit={e => { e.preventDefault(); ok(); }}>
          <h2>{name}</h2>
          <SourceFields label={calc ? 'Source 1' : 'Source'} doc={doc} value={form.src1} set={src1 => setForm({ ...form, src1 })} calc={calc} />
          {calc && <SourceFields label="Source 2" doc={doc} value={form.src2} set={src2 => setForm({ ...form, src2 })} calc />}
          <label>Blending <select aria-label="Blending" value={form.mode} onChange={e => setForm({ ...form, mode: e.currentTarget.value })}>
            {BLEND_MODES.filter(m => m !== 'dissolve').map(m => <option key={m} value={m}>{title(m)}</option>)}
          </select></label>
          <label>Opacity <input type="number" min={0} max={100} value={form.opacity}
            onChange={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) setForm({ ...form, opacity: Math.min(100, Math.max(0, v)) }); }} /> %</label>
          {!calc && <label><input type="checkbox" checked={form.preserve} onChange={e => setForm({ ...form, preserve: e.currentTarget.checked })} /> Preserve Transparency</label>}
          {calc && (
            <label>Result <select aria-label="Result" value={form.result} onChange={e => setForm({ ...form, result: e.currentTarget.value as Form['result'] })}>
              <option value="channel">New Channel</option>
              <option value="selection">Selection</option>
            </select></label>
          )}
          {!calc && <label className="adjustment-check"><input type="checkbox" checked={form.preview} onChange={e => setForm({ ...form, preview: e.currentTarget.checked })} /> Preview</label>}
          <div className="actions">
            <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
            <button type="submit" className="primary">OK</button>
          </div>
        </form>
      )}
    </dialog>
  );
}
