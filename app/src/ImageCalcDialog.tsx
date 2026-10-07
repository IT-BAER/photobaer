// Image > Apply Image (live preview on the active layer) and Image > Calculations (into a new
// channel, the selection or a new document). Sources and the mask may come from any open
// document of the same pixel size.
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { choiceLabel } from './i18n/choices.ts';
import { client } from './client.ts';
import { BLEND_MODES } from './layers.ts';
import type { CalcOpts, DocInfo, ImageSource } from './engine.worker.ts';
import type { LayerNode } from './worker/types.ts';
import { NumberInput } from './shell/NumberInput.tsx';

export type ImageCalcRequest = { kind: 'apply'; id: number } | { kind: 'calc' };
export interface ImageCalcHandle { open(r: ImageCalcRequest): void }

type Form = {
  src1: ImageSource; src2: ImageSource; mode: string; opacity: number; scale: number; offset: number; useMask: boolean; mask: ImageSource;
  preserve: boolean; result: 'channel' | 'selection' | 'document'; preview: boolean;
};

const SCALED = new Set(['add', 'subtract']);
const opts = (f: Form): CalcOpts => ({ mode: f.mode, opacity: f.opacity / 100, scale: f.scale, offset: f.offset, mask: f.useMask ? f.mask : null });
const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const modeLabel = (m: string) => (m === 'linear dodge' ? t`Linear Dodge` : choiceLabel(m));
const pixelLayers = (nodes: LayerNode[]): LayerNode[] =>
  nodes.flatMap(n => [...(n.kind === 'group' ? pixelLayers(n.children ?? []) : []), ...(n.kind === 'group' || n.kind === 'adjustment' || n.kind === 'fill' ? [] : [n])]);

// Another document shows only its merged image and color channels (its layers and saved channels
// are not loaded here).
function SourceFields({ label, doc, value, set, calc }: { label: string; doc: DocInfo; value: ImageSource; set: (s: ImageSource) => void; calc: boolean }) {
  const own = value.doc === undefined;
  const channels: [string, string][] = [
    ...(calc ? [] : [['rgb', 'RGB']] as [string, string][]),
    ['red', t`Red`], ['green', t`Green`], ['blue', t`Blue`],
    ...(calc ? [['gray', t`Gray`]] as [string, string][] : []),
    ...(value.layer !== null ? [['alpha', t`Transparency`]] as [string, string][] : []),
    ...(own ? doc.channels.map(c => [`channel:${c.id}`, c.name] as [string, string]) : []),
  ];
  const others = doc.docs.filter(d => !d.active && d.width === doc.width && d.height === doc.height);
  return (
    <fieldset>
      <legend>{label}</legend>
      {others.length > 0 && (
        <label><Trans>Document</Trans> <select aria-label={t`${label} document`} value={value.doc ?? ''}
          onChange={e => {
            const key = e.currentTarget.value || undefined;
            set({ layer: null, channel: calc ? 'gray' : 'rgb', invert: value.invert, ...(key ? { doc: key } : {}) });
          }}>
          <option value="">{doc.name}</option>
          {others.map(d => <option key={d.key} value={d.key}>{d.name}</option>)}
        </select></label>
      )}
      <label><Trans>Layer</Trans> <select aria-label={t`${label} layer`} value={value.layer ?? 'merged'}
        onChange={e => {
          const layer = e.currentTarget.value === 'merged' ? null : Number(e.currentTarget.value);
          set({ ...value, layer, channel: layer === null && value.channel === 'alpha' ? (calc ? 'gray' : 'rgb') : value.channel });
        }}>
        <option value="merged">{t`Merged`}</option>
        {own && pixelLayers(doc.layers).map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
      </select></label>
      <label><Trans>Channel</Trans> <select aria-label={t`${label} channel`} value={value.channel} onChange={e => set({ ...value, channel: e.currentTarget.value })}>
        {channels.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select></label>
      <label><input type="checkbox" checked={value.invert} onChange={e => set({ ...value, invert: e.currentTarget.checked })} /> <Trans>Invert</Trans></label>
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
    mode: 'multiply', opacity: 100, scale: 1, offset: 0, useMask: false, mask: { layer: null, channel: 'gray', invert: false },
    preserve: true, result: 'channel', preview: true,
  });
  // One worker call at a time; `session`: an Apply Image preview is open in the worker.
  const st = useRef({ chain: Promise.resolve() as Promise<unknown>, session: false, closing: false });
  const enqueue = (fn: () => Promise<unknown>) => { st.current.chain = st.current.chain.then(fn).catch(e => setError((e as Error).message)); };
  const endSession = async (commit: boolean) => {
    if (!st.current.session) return;
    st.current.session = false;
    show(await client.call('previewEnd', commit));
  };
  const apply = (id: number, f: Form) => client.call('applyImage', id, f.src1, { ...opts(f), preserve: f.preserve }, true);

  useImperativeHandle(ref, () => ({
    open(r) {
      st.current.closing = false;
      setReq(r);
      setForm(f => ({
        ...f, mode: 'multiply', opacity: 100, scale: 1, offset: 0, useMask: false,
        src1: { layer: null, channel: r.kind === 'apply' ? 'rgb' : 'gray', invert: false },
        src2: { layer: null, channel: 'gray', invert: false },
        mask: { layer: null, channel: 'gray', invert: false },
      }));
      dialog.current?.showModal();
    },
  }), []);

  useEffect(() => {
    if (req?.kind !== 'apply' || st.current.closing) return;
    const id = req.id, f = form;
    const timer = setTimeout(() => enqueue(async () => {
      if (st.current.closing) return;
      if (!f.preview) { await endSession(false); return; }
      st.current.session = true;
      show(await apply(id, f));
    }), 60);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, form]);

  function ok() {
    if (!req) return;
    st.current.closing = true;
    dialog.current?.close();
    const r = req, f = form;
    enqueue(async () => {
      try {
        if (r.kind === 'calc') { show(await client.call('calculations', f.src1, f.src2, opts(f), f.result)); return; }
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
  const name = calc ? t`Calculations` : t`Apply Image`;
  return (
    <dialog ref={dialog} className="live-preview image-calc" aria-label={name} onClose={cancel}>
      {doc && req && (
        <form onSubmit={e => { e.preventDefault(); ok(); }}>
          <h2>{name}</h2>
          <SourceFields label={calc ? t`Source 1` : t`Source`} doc={doc} value={form.src1} set={src1 => setForm({ ...form, src1 })} calc={calc} />
          {calc && <SourceFields label={t`Source 2`} doc={doc} value={form.src2} set={src2 => setForm({ ...form, src2 })} calc />}
          <label><Trans>Blending</Trans> <select aria-label={t`Blending`} value={form.mode} onChange={e => setForm({ ...form, mode: e.currentTarget.value })}>
            {[...BLEND_MODES.filter(m => m !== 'dissolve'), 'add'].map(m => <option key={m} value={m}>{modeLabel(m)}</option>)}
          </select></label>
          <label><Trans>Opacity</Trans> <NumberInput min={0} max={100} value={form.opacity}
            onValue={v => setForm({ ...form, opacity: clampNum(v, 0, 100) })} /> %</label>
          {SCALED.has(form.mode) && <>
            <label><Trans>Scale</Trans> <NumberInput min={1} max={2} step={0.001} value={form.scale}
              onValue={v => setForm({ ...form, scale: clampNum(v, 1, 2) })} /></label>
            <label><Trans>Offset</Trans> <NumberInput min={-255} max={255} value={form.offset}
              onValue={v => setForm({ ...form, offset: clampNum(v, -255, 255) })} /></label>
          </>}
          <label><input type="checkbox" checked={form.useMask} onChange={e => setForm({ ...form, useMask: e.currentTarget.checked })} /> <Trans>Mask</Trans></label>
          {form.useMask && <SourceFields label={t`Mask`} doc={doc} value={form.mask} set={mask => setForm({ ...form, mask })} calc />}
          {!calc && <label><input type="checkbox" checked={form.preserve} onChange={e => setForm({ ...form, preserve: e.currentTarget.checked })} /> <Trans>Preserve Transparency</Trans></label>}
          {calc && (
            <label><Trans>Result</Trans> <select aria-label={t`Result`} value={form.result} onChange={e => setForm({ ...form, result: e.currentTarget.value as Form['result'] })}>
              <option value="channel">{t`New Channel`}</option>
              <option value="selection">{t`Selection`}</option>
              <option value="document">{t`New Document`}</option>
            </select></label>
          )}
          {!calc && <label className="adjustment-check"><input type="checkbox" checked={form.preview} onChange={e => setForm({ ...form, preview: e.currentTarget.checked })} /> <Trans>Preview</Trans></label>}
          <div className="actions">
            <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
            <button type="submit" className="primary"><Trans>OK</Trans></button>
          </div>
        </form>
      )}
    </dialog>
  );
}
