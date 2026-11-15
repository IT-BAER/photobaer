// Select > Focus Area: the in-focus area of the active layer from a sharpness map (no model). In-Focus Range and
// Image Noise Level each have Auto; the Add and Remove brushes paint on the preview; Soften Edge and Output To
// decide what OK makes of it.
import { useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent, type Ref } from 'react';
import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { client } from './client.ts';
import { i18n } from './i18n/index.ts';
import { formatNumber } from './i18n/numbers.ts';
import { errorText } from './i18n/errors.ts';
import { focusView, strokeEdit, type FocusView } from './focusArea.ts';
import { selectCreated, type Run } from './app/helpers.ts';
import type { DocInfo } from './worker/types.ts';

export interface FocusAreaHandle {
  // Opens the dialog for pixel layer `layer`; `hasMask` disables the outputs that add a layer mask.
  open(layer: number, hasMask: boolean): void;
}

const VIEWS: [FocusView, MessageDescriptor][] = [['overlay', msg`Overlay`], ['black', msg`On Black`], ['white', msg`On White`], ['bw', msg`Black & White`]];
const OUTPUTS = ['selection', 'layerMask', 'newLayer', 'newLayerMask', 'newDocument', 'newDocumentMask'] as const;
type Output = typeof OUTPUTS[number];
const OUTPUT_LABEL: Record<Output, MessageDescriptor> = {
  selection: msg`Selection`, layerMask: msg`Layer Mask`, newLayer: msg`New Layer`, newLayerMask: msg`New Layer with Layer Mask`,
  newDocument: msg`New Document`, newDocumentMask: msg`New Document with Layer Mask`,
};
const MASK_OUTPUTS = new Set<Output>(['layerMask', 'newLayerMask']);
const RANGE_MAX = 7.5, NOISE_MAX = 1;

type Image = { w: number; h: number; data: Uint8Array };

export function FocusAreaDialog({ ref, doc, run, setError, selectAndMask }: {
  ref: Ref<FocusAreaHandle>; doc: DocInfo | null; run: Run; setError: (e: string | null) => void;
  // Opens Select and Mask for the layer after the Select and Mask… button made the selection.
  selectAndMask: (layer: number, hasMask: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [layer, setLayer] = useState<{ id: number; hasMask: boolean } | null>(null);
  const [img, setImg] = useState<Image | null>(null);
  const [mask, setMask] = useState<Uint8Array | null>(null);
  const [auto, setAuto] = useState<[number, number]>([0, 0]);
  const [range, setRange] = useState(0), [rangeAuto, setRangeAuto] = useState(true);
  const [noise, setNoise] = useState(0), [noiseAuto, setNoiseAuto] = useState(true);
  const [view, setView] = useState<FocusView>('overlay'), [preview, setPreview] = useState(true);
  const [soften, setSoften] = useState(false), [output, setOutput] = useState<Output>('selection');
  const [brush, setBrush] = useState<'add' | 'remove' | null>(null), [size, setSize] = useState(50);
  // Brush edits at the working size; `painted` once a stroke changed them.
  const edits = useRef<Uint8Array | null>(null), painted = useRef(false);
  const stroke = useRef<[number, number] | null>(null);
  // Bumped per open and per preview request, so late answers for an older state are dropped.
  const opened = useRef(0), seq = useRef(0);

  useImperativeHandle(ref, () => ({
    open(id, hasMask) {
      const mine = ++opened.current;
      setLayer({ id, hasMask }); setImg(null); setMask(null); setBrush(null);
      setRangeAuto(true); setNoiseAuto(true); setPreview(true);
      setOutput(o => (hasMask && MASK_OUTPUTS.has(o) ? 'selection' : o));
      edits.current = null; painted.current = false;
      dialog.current?.showModal();
      Promise.all([client.call('focusImage', id), client.call('focusAuto', id)]).then(([im, a]) => {
        if (opened.current !== mine) return;
        setImg({ w: im.w, h: im.h, data: new Uint8Array(im.data) });
        edits.current = new Uint8Array(im.w * im.h).fill(128);
        setAuto(a); setRange(a[0]); setNoise(a[1]);
      }, e => { dialog.current?.close(); setError(errorText(e)); });
    },
  }));

  // The engine's mask for the slider values, a short pause after the last change.
  useEffect(() => {
    if (!layer || !img) return;
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      client.call('focusPreview', layer.id, range, noise, null).then(r => { if (seq.current === mine) setMask(new Uint8Array(r.data)); }, () => {});
    }, 120);
    return () => clearTimeout(timer);
  }, [layer, img, range, noise]);

  function draw() {
    const c = canvas.current;
    if (!c || !img) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const m = mask ?? new Uint8Array(img.w * img.h);
    ctx.putImageData(new ImageData(focusView(img.data, m, edits.current, view, preview && !!mask), img.w, img.h), 0, 0);
  }
  useEffect(draw, [img, mask, view, preview]);

  function paint(e: ReactPointerEvent<HTMLCanvasElement>, first: boolean) {
    if (!brush || !img || !edits.current || !doc) return;
    const r = e.currentTarget.getBoundingClientRect();
    const at: [number, number] = [(e.clientX - r.left) * img.w / r.width, (e.clientY - r.top) * img.h / r.height];
    strokeEdit(edits.current, img.w, img.h, first ? null : stroke.current, at, Math.max(0.5, size / 2 * img.w / doc.width), brush === 'add' ? 255 : 0);
    stroke.current = at;
    painted.current = true;
    draw();
  }

  // Select and Mask…: the in-focus area as the selection, then the Select and Mask workspace.
  async function refine() {
    if (!layer) return;
    const { id, hasMask } = layer, r0 = range, n0 = noise, ed = painted.current ? edits.current : null, before = JSON.stringify(doc?.history);
    dialog.current?.close();
    let found = false;
    await run(t`Selecting focus area…`, async () => {
      const r = await client.call('focusArea', id, r0, n0, ed, soften);
      found = JSON.stringify(r.history) !== before;
      if (!found) setError(t`No in-focus area found`);
      return r;
    });
    if (found) selectAndMask(id, hasMask);
  }

  async function ok() {
    if (!layer) return;
    const id = layer.id, r0 = range, n0 = noise, ed = painted.current ? edits.current : null, out = output, before = JSON.stringify(doc?.history);
    dialog.current?.close();
    const newLayer = out === 'newLayer' || out === 'newLayerMask';
    await run(t`Selecting focus area…`, async () => {
      const r = await client.call('focusArea', id, r0, n0, ed, soften);
      if (JSON.stringify(r.history) === before) { setError(t`No in-focus area found`); return r; }
      if (out === 'layerMask') return client.call('addMaskFromSelection', id, false);
      if (out === 'newLayer') return client.call('layerViaCopy', id);
      if (out === 'newLayerMask') {
        const d = await client.call('duplicateNode', id);
        return { ...(await client.call('addMaskFromSelection', d.created, false)), created: d.created };
      }
      if (out === 'newDocument' || out === 'newDocumentMask') return client.call('focusToDocument', id, out === 'newDocumentMask');
      return r;
    }, newLayer ? selectCreated : undefined);
  }

  const num = (v: number) => formatNumber(v, 2);
  return (
    <dialog ref={dialog} className="focus-area-dialog" aria-label={t`Focus Area`} onClose={() => { opened.current++; seq.current++; setLayer(null); }}>
      <form method="dialog" onSubmit={e => { e.preventDefault(); void ok(); }}>
        <h2><Trans>Focus Area</Trans></h2>
        <div className="focus-area-body">
          <div className="focus-area-stage">
            {img ? (
              <canvas ref={canvas} width={img.w} height={img.h} className="focus-area-canvas" data-brush={brush ?? undefined}
                onPointerDown={e => { if (!brush) return; e.currentTarget.setPointerCapture(e.pointerId); paint(e, true); }}
                onPointerMove={e => { if (e.buttons & 1 && stroke.current) paint(e, false); }}
                onPointerUp={() => { stroke.current = null; }} onPointerCancel={() => { stroke.current = null; }} />
            ) : <p className="hint"><Trans>Analyzing…</Trans></p>}
          </div>
          <div className="focus-area-controls">
            <div className="opt-segmented" role="group" aria-label={t`Brush`}>
              <button type="button" aria-pressed={brush === 'add'} onClick={() => setBrush(b => (b === 'add' ? null : 'add'))}><Trans>Add Brush</Trans></button>
              <button type="button" aria-pressed={brush === 'remove'} onClick={() => setBrush(b => (b === 'remove' ? null : 'remove'))}><Trans>Remove Brush</Trans></button>
            </div>
            <label><Trans>Size</Trans> <input type="number" min={1} max={2500} value={size} onChange={e => setSize(Math.min(2500, Math.max(1, Number(e.target.value) || 1)))} /> px</label>
            <label><Trans>View</Trans> <select value={view} onChange={e => setView(e.target.value as FocusView)}>
              {VIEWS.map(([v, l]) => <option key={v} value={v}>{i18n._(l)}</option>)}
            </select></label>
            <label><input type="checkbox" checked={preview} onChange={e => setPreview(e.target.checked)} /> <Trans>Preview</Trans></label>
            <h3><Trans>Parameters</Trans></h3>
            <label><Trans>In-Focus Range</Trans>
              <input type="range" min={0} max={RANGE_MAX} step={0.01} value={range} onChange={e => { setRange(Number(e.target.value)); setRangeAuto(false); }} /> {num(range)}</label>
            <label><input type="checkbox" checked={rangeAuto} onChange={e => { setRangeAuto(e.target.checked); if (e.target.checked) setRange(auto[0]); }} /> <Trans>Auto</Trans></label>
            <h3><Trans>Advanced</Trans></h3>
            <label><Trans>Image Noise Level</Trans>
              <input type="range" min={0} max={NOISE_MAX} step={0.01} value={noise} onChange={e => { setNoise(Number(e.target.value)); setNoiseAuto(false); }} /> {num(noise)}</label>
            <label><input type="checkbox" checked={noiseAuto} onChange={e => { setNoiseAuto(e.target.checked); if (e.target.checked) setNoise(auto[1]); }} /> <Trans>Auto</Trans></label>
            <h3><Trans>Output</Trans></h3>
            <label><input type="checkbox" checked={soften} onChange={e => setSoften(e.target.checked)} /> <Trans>Soften Edge</Trans></label>
            <label><Trans>Output To</Trans> <select value={output} onChange={e => setOutput(e.target.value as Output)}>
              {OUTPUTS.map(o => <option key={o} value={o} disabled={!!layer?.hasMask && MASK_OUTPUTS.has(o)}>{i18n._(OUTPUT_LABEL[o])}</option>)}
            </select></label>
          </div>
        </div>
        <div className="actions">
          <button type="button" className="focus-area-refine" disabled={!img} onClick={() => void refine()}><Trans>Select and Mask…</Trans></button>
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary" disabled={!img}><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}
