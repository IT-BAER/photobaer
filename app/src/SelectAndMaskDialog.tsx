// Select > Select and Mask: refines the selection against the active layer (or all layers). View modes with Show
// Edge and Show Original, the Brush (add, subtract) and the Refine Edge Brush (expand the detection area, restore the
// original edge), Edge Detection, Global Refinements and Output Settings with Remember Settings.
import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from 'react';
import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { client } from './client.ts';
import { i18n } from './i18n/index.ts';
import { errorText } from './i18n/errors.ts';
import { strokeEdit } from './focusArea.ts';
import { DEFAULTS, EDIT, OUTPUTS, RANGES, VIEWS, invertEdits, parseRemembered, refineView, type Remembered, type RefineOutput, type RefineView } from './selectMask.ts';
import { selectCreated, type Run } from './app/helpers.ts';
import type { DocInfo, RefineBase, RefineSettings } from './worker/types.ts';

export interface SelectAndMaskHandle {
  // Opens the workspace for pixel layer `layer`; `hasMask` disables the Layer Mask output.
  open(layer: number, hasMask: boolean): void;
}

const VIEW_LABEL: Record<RefineView, MessageDescriptor> = {
  onion: msg`Onion Skin (O)`, overlay: msg`Overlay (V)`, black: msg`On Black (A)`, white: msg`On White (T)`,
  bw: msg`Black & White (K)`, layers: msg`On Layers (Y)`,
};
const VIEW_KEY: Record<string, RefineView> = { o: 'onion', v: 'overlay', a: 'black', t: 'white', k: 'bw', y: 'layers' };
const OUTPUT_LABEL: Record<RefineOutput, MessageDescriptor> = {
  selection: msg`Selection`, layerMask: msg`Layer Mask`, newLayer: msg`New Layer`, newLayerMask: msg`New Layer with Layer Mask`,
  newDocument: msg`New Document`, newDocumentMask: msg`New Document with Layer Mask`,
};
// Outputs Decontaminate Colors cannot use.
const PLAIN_OUTPUTS = new Set<RefineOutput>(['selection', 'layerMask']);
const STORE = 'photobaer.selectAndMask';

type Image = { w: number; h: number; data: Uint8Array; sel: Uint8Array };
type Tool = 'brush' | 'refine';

function stored(): string | null {
  try { return localStorage.getItem(STORE); } catch { return null; }
}

function Slider({ label, value, range, step = 1, unit, set }: { label: ReactNode; value: number; range: [number, number]; step?: number; unit: string; set: (v: number) => void }) {
  const clamp = (v: number) => Math.min(range[1], Math.max(range[0], v));
  return (
    <label className="select-mask-field">
      <span>{label}</span>
      <input type="range" min={range[0]} max={range[1]} step={step} value={value} onChange={e => set(clamp(Number(e.target.value)))} />
      <input type="number" min={range[0]} max={range[1]} step={step} value={value} onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) set(clamp(v)); }} />
      <span>{unit}</span>
    </label>
  );
}

export function SelectAndMaskDialog({ ref, doc, run, setError }: { ref: Ref<SelectAndMaskHandle>; doc: DocInfo | null; run: Run; setError: (e: string | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [layer, setLayer] = useState<{ id: number; hasMask: boolean } | null>(null);
  const [img, setImg] = useState<Image | null>(null);
  const [prev, setPrev] = useState<{ alpha: Uint8Array; band: Uint8Array } | null>(null);
  const [rem, setRem] = useState<Remembered>(DEFAULTS), [remember, setRemember] = useState(false);
  const [base, setBase] = useState<RefineBase>({ invert: false, clear: false });
  const [sampleAll, setSampleAll] = useState(false);
  const [showEdge, setShowEdge] = useState(false), [showOriginal, setShowOriginal] = useState(false);
  const [tool, setTool] = useState<Tool | null>(null), [add, setAdd] = useState(true), [size, setSize] = useState(25);
  // Brush codes at the working size; `edited` counts finished strokes, so the preview follows them.
  const edits = useRef<Uint8Array | null>(null), [edited, setEdited] = useState(0);
  const stroke = useRef<[number, number] | null>(null);
  // Bumped per open, image load and preview request, so late answers for an older state are dropped.
  const opened = useRef(0), seq = useRef(0);
  const s = rem.settings;
  const setS = (patch: Partial<RefineSettings>) => setRem(r => ({ ...r, settings: { ...r.settings, ...patch } }));

  function load(id: number, all: boolean) {
    const mine = ++opened.current;
    setImg(null); setPrev(null);
    client.call('refineImage', id, all).then(im => {
      if (opened.current !== mine) return;
      setImg({ w: im.w, h: im.h, data: new Uint8Array(im.data), sel: new Uint8Array(im.sel) });
      if (edits.current?.length !== im.w * im.h) edits.current = new Uint8Array(im.w * im.h).fill(EDIT.none);
    }, e => { dialog.current?.close(); setError(errorText(e)); });
  }

  useImperativeHandle(ref, () => ({
    open(id, hasMask) {
      const json = stored(), r = parseRemembered(json);
      setRemember(json !== null);
      setRem(r.output === 'layerMask' && hasMask ? { ...r, output: 'selection' } : r);
      setLayer({ id, hasMask }); setBase({ invert: false, clear: false }); setSampleAll(false);
      setShowEdge(false); setShowOriginal(false); setTool(null); setAdd(true);
      edits.current = null; setEdited(0);
      dialog.current?.showModal();
      load(id, false);
    },
  }));

  // The engine's preview for the current values, a short pause after the last change.
  const painted = edited > 0;
  useEffect(() => {
    if (!layer || !img) return;
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      client.call('refinePreview', layer.id, sampleAll, s, base, painted ? edits.current : null)
        .then(r => { if (seq.current === mine) setPrev({ alpha: new Uint8Array(r.alpha), band: new Uint8Array(r.band) }); }, () => {});
    }, 120);
    return () => clearTimeout(timer);
  }, [layer, img, s, base, edited, sampleAll]);

  function draw() {
    const c = canvas.current;
    if (!c || !img) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const alpha = prev?.alpha ?? img.sel, band = prev?.band ?? new Uint8Array(img.w * img.h);
    const o = { view: rem.view, opacity: rem.opacity[rem.view] / 100, showEdge, showOriginal };
    ctx.putImageData(new ImageData(refineView(img.data, img.w, alpha, band, img.sel, edits.current, o), img.w, img.h), 0, 0);
  }
  useEffect(draw, [img, prev, rem.view, rem.opacity, showEdge, showOriginal]);

  function paint(e: ReactPointerEvent<HTMLCanvasElement>, first: boolean) {
    if (!tool || !img || !edits.current || !doc) return;
    const r = e.currentTarget.getBoundingClientRect();
    const at: [number, number] = [(e.clientX - r.left) * img.w / r.width, (e.clientY - r.top) * img.h / r.height];
    // Alt switches between the tool's two modes while held, as in Photoshop.
    const plus = add !== e.altKey;
    const code = tool === 'brush' ? (plus ? EDIT.add : EDIT.subtract) : (plus ? EDIT.refine : EDIT.keepEdge);
    strokeEdit(edits.current, img.w, img.h, first ? null : stroke.current, at, Math.max(0.5, size / 2 * img.w / doc.width), code);
    stroke.current = at;
    draw();
  }

  function endStroke() {
    if (!stroke.current) return;
    stroke.current = null;
    setEdited(n => n + 1);
  }

  function invert() {
    setBase(b => ({ ...b, invert: !b.invert }));
    if (edits.current) edits.current = invertEdits(edits.current);
    setEdited(n => (n ? n + 1 : n));
  }

  function clearSelection() {
    setBase({ invert: false, clear: true });
    edits.current?.fill(EDIT.none);
    setEdited(0);
  }

  function setDecontaminate(on: boolean) {
    setRem(r => ({ ...r, decontaminate: on, output: on && PLAIN_OUTPUTS.has(r.output) ? 'newLayerMask' : r.output }));
  }

  function keys(e: ReactKeyboardEvent<HTMLDialogElement>) {
    if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'j') setShowEdge(v => !v);
    else if (k === 'p') setShowOriginal(v => !v);
    else if (k === 'b') setTool('brush');
    else if (k === 'r') setTool('refine');
    else if (k === '[') setSize(v => Math.max(1, Math.round(v / 1.2)));
    else if (k === ']') setSize(v => Math.min(2500, Math.round(v * 1.2) + 1));
    else if (VIEW_KEY[k]) setRem(r => ({ ...r, view: VIEW_KEY[k] }));
    else return;
    e.preventDefault();
  }

  async function ok() {
    if (!layer) return;
    const id = layer.id, all = sampleAll, set = s, b = base, ed = painted ? edits.current : null, r = rem;
    try { if (remember) localStorage.setItem(STORE, JSON.stringify(r)); else localStorage.removeItem(STORE); } catch { /* not remembered */ }
    dialog.current?.close();
    const toDoc = r.output === 'newDocument' || r.output === 'newDocumentMask';
    const amount = r.decontaminate ? r.amount : 0;
    await run(t`Refining the selection…`, async () => {
      const res = await client.call('selectAndMask', id, all, set, b, ed, toDoc ? 'selection' : r.output, amount > 0, amount);
      return toDoc ? client.call('focusToDocument', id, r.output === 'newDocumentMask', amount) : res;
    }, r.output.startsWith('newLayer') ? selectCreated : undefined);
  }

  const opacity = rem.opacity[rem.view];
  return (
    <dialog ref={dialog} className="focus-area-dialog select-mask-dialog" aria-label={t`Select and Mask`} onKeyDown={keys}
      onClose={() => { opened.current++; seq.current++; setLayer(null); }}>
      <form method="dialog" onSubmit={e => { e.preventDefault(); void ok(); }}>
        <h2><Trans>Select and Mask</Trans></h2>
        <div className="select-mask-tools">
          <div className="opt-segmented" role="group" aria-label={t`Tools`}>
            <button type="button" aria-pressed={tool === 'brush'} title={t`Brush Tool (B)`} onClick={() => setTool(v => (v === 'brush' ? null : 'brush'))}><Trans>Brush Tool</Trans></button>
            <button type="button" aria-pressed={tool === 'refine'} title={t`Refine Edge Brush Tool (R)`} onClick={() => setTool(v => (v === 'refine' ? null : 'refine'))}><Trans>Refine Edge Brush Tool</Trans></button>
          </div>
          <div className="opt-segmented" role="group" aria-label={t`Brush mode`}>
            <button type="button" aria-pressed={add} disabled={!tool} title={tool === 'refine' ? t`Expand detection area` : t`Add to selection`} onClick={() => setAdd(true)}>+</button>
            <button type="button" aria-pressed={!add} disabled={!tool} title={tool === 'refine' ? t`Restore original edge` : t`Subtract from selection`} onClick={() => setAdd(false)}>−</button>
          </div>
          <label><Trans>Size</Trans> <input type="number" min={1} max={2500} value={size} onChange={e => setSize(Math.min(2500, Math.max(1, Number(e.target.value) || 1)))} /> px</label>
          <label><input type="checkbox" checked={sampleAll} onChange={e => { setSampleAll(e.target.checked); if (layer) load(layer.id, e.target.checked); }} /> <Trans>Sample All Layers</Trans></label>
        </div>
        <div className="focus-area-body select-mask-body">
          <div className="focus-area-stage">
            {img ? (
              <canvas ref={canvas} width={img.w} height={img.h} className="focus-area-canvas" data-brush={tool ?? undefined}
                onPointerDown={e => { if (!tool) return; e.currentTarget.setPointerCapture(e.pointerId); paint(e, true); }}
                onPointerMove={e => { if (e.buttons & 1 && stroke.current) paint(e, false); }}
                onPointerUp={endStroke} onPointerCancel={endStroke} />
            ) : <p className="hint"><Trans>Analyzing…</Trans></p>}
          </div>
          <div className="focus-area-controls select-mask-controls">
            <h3><Trans>View Mode</Trans></h3>
            <label><Trans>View</Trans> <select value={rem.view} onChange={e => setRem(r => ({ ...r, view: e.target.value as RefineView }))}>
              {VIEWS.map(v => <option key={v} value={v}>{i18n._(VIEW_LABEL[v])}</option>)}
            </select></label>
            <label><input type="checkbox" checked={showEdge} onChange={e => setShowEdge(e.target.checked)} /> <Trans>Show Edge (J)</Trans></label>
            <label><input type="checkbox" checked={showOriginal} onChange={e => setShowOriginal(e.target.checked)} /> <Trans>Show Original (P)</Trans></label>
            {rem.view !== 'bw' && rem.view !== 'layers' && (
              <Slider label={<Trans>Opacity</Trans>} value={opacity} range={[0, 100]} unit="%" set={v => setRem(r => ({ ...r, opacity: { ...r.opacity, [r.view]: v } }))} />
            )}
            <h3><Trans>Edge Detection</Trans></h3>
            <Slider label={<Trans>Radius</Trans>} value={s.radius} range={RANGES.radius} unit="px" set={v => setS({ radius: v })} />
            <label><input type="checkbox" checked={s.smart_radius} onChange={e => setS({ smart_radius: e.target.checked })} /> <Trans>Smart Radius</Trans></label>
            <h3><Trans>Global Refinements</Trans></h3>
            <Slider label={<Trans context="select and mask">Smooth</Trans>} value={s.smooth} range={RANGES.smooth} unit="" set={v => setS({ smooth: v })} />
            <Slider label={<Trans>Feather</Trans>} value={s.feather} range={RANGES.feather} step={0.1} unit="px" set={v => setS({ feather: v })} />
            <Slider label={<Trans>Contrast</Trans>} value={s.contrast} range={RANGES.contrast} unit="%" set={v => setS({ contrast: v })} />
            <Slider label={<Trans>Shift Edge</Trans>} value={s.shift_edge} range={RANGES.shift_edge} unit="%" set={v => setS({ shift_edge: v })} />
            <div className="select-mask-buttons">
              <button type="button" onClick={clearSelection}><Trans>Clear Selection</Trans></button>
              <button type="button" aria-pressed={base.invert} onClick={invert}><Trans>Invert</Trans></button>
            </div>
            <h3><Trans>Output Settings</Trans></h3>
            <label><input type="checkbox" checked={rem.decontaminate} onChange={e => setDecontaminate(e.target.checked)} /> <Trans>Decontaminate Colors</Trans></label>
            {rem.decontaminate && (
              <Slider label={<Trans>Amount</Trans>} value={rem.amount} range={[0, 100]} unit="%" set={v => setRem(r => ({ ...r, amount: v }))} />
            )}
            <label><Trans>Output To</Trans> <select value={rem.output} onChange={e => setRem(r => ({ ...r, output: e.target.value as RefineOutput }))}>
              {OUTPUTS.map(o => (
                <option key={o} value={o} disabled={(rem.decontaminate && PLAIN_OUTPUTS.has(o)) || (o === 'layerMask' && !!layer?.hasMask)}>{i18n._(OUTPUT_LABEL[o])}</option>
              ))}
            </select></label>
            <label><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> <Trans>Remember Settings</Trans></label>
          </div>
        </div>
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary" disabled={!img}><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}
