// Properties panel for the selected adjustment layer (docs/M3.md section 3, B5-1): header with the
// title and "Reset <kind>", the kind's body, then the visibility/clipping checkboxes. The Image >
// Adjustments dialogs reuse `AdjustmentBody`.
import { useRef, useState, type KeyboardEvent } from 'react';
import { RotateCcw } from 'lucide-react';
import { client } from './client.ts';
import type { Adjustment, DestructiveAdjustment, DocInfo, LayerNode, SmartFilterInfo, SmartFilterKind } from './engine.worker.ts';
import type { ArtboardBackground } from './worker/types.ts';
import { locate } from './layers.ts';
import {
  EDIT_LABEL, FIELD_SPECS, MENU_LABEL, defaultAdjustment, getPath, gradientDefToUi, setPath, uiToGradientDef, type FieldSpec,
} from './adjustments.ts';
import { rampCss, type Gradient } from './gradients/gradient.ts';
import { LevelsCurvesBody, type SampleCanvas } from './LevelsCurvesBody.tsx';

type Run = (label: string | null, p: () => Promise<DocInfo | null>) => Promise<void>;
export type OpenGradientEditor = (g: Gradient, onOk: (g: Gradient) => void) => void;
export type PickLookupFile = (onLoaded: (name: string, table: number, format: 'cube' | '3dl') => void) => void;
// `live` marks a slider drag in progress; the drag ends with one more call with `live` false.
type OnChange = (a: Adjustment | DestructiveAdjustment, live: boolean) => void;

// Slider plus a number field that commits on Enter or blur, so typing makes one edit.
function NumberField({ spec, value, set }: { spec: Extract<FieldSpec, { type: 'number' }>; value: number; set: (v: number, live: boolean) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [dragged, setDragged] = useState<number | null>(null);
  const clamp = (v: number) => Math.min(spec.max, Math.max(spec.min, v));
  const done = () => {
    const v = Number(draft);
    setDraft(null);
    if (draft !== null && draft.trim() !== '' && Number.isFinite(v) && clamp(v) !== value) set(clamp(v), false);
  };
  const release = () => {
    setDragged(null);
    if (dragged !== null) set(dragged, false);
  };
  return (
    <div className="adjustment-field">
      <span>{spec.label}</span>
      <input
        type="range" aria-label={spec.label} min={spec.min} max={spec.max} step={spec.step} value={dragged ?? value}
        onChange={e => { const v = e.currentTarget.valueAsNumber; setDragged(v); set(v, true); }}
        onPointerUp={release} onKeyUp={release} onBlur={release}
      />
      <input
        type="number" aria-label={`${spec.label} value`} min={spec.min} max={spec.max} step={spec.step} value={draft ?? value}
        onChange={e => setDraft(e.currentTarget.value)}
        onBlur={done}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
          else if (e.key === 'Escape') setDraft(null);
        }}
      />
    </div>
  );
}

export function Field({ spec, params, onChange }: { spec: FieldSpec; params: object; onChange: (path: string, v: unknown, live: boolean) => void }) {
  const value = getPath(params, spec.path);
  if (spec.type === 'checkbox') {
    return <label className="adjustment-check"><input type="checkbox" checked={!!value} onChange={e => onChange(spec.path, e.currentTarget.checked, false)} /> {spec.label}</label>;
  }
  if (spec.type === 'select') {
    return (
      <label className="adjustment-field"><span>{spec.label}</span>
        <select value={String(value)} onChange={e => onChange(spec.path, e.currentTarget.value, false)}>
          {spec.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
    );
  }
  // `scale` shows a stored fraction as a whole percent (value x scale).
  const k = spec.scale ?? 1;
  const shown = k === 1 ? Number(value) : Math.round(Number(value) * k);
  return <NumberField spec={spec} value={shown} set={(v, live) => onChange(spec.path, v / k, live)} />;
}

// `histogramId` names the layer whose histogram Levels/Curves show (0: the composite);
// `sampleCanvas` is absent where canvas clicks cannot reach the body (the modal dialogs).
export function AdjustmentBody({ adjustment, onChange, openGradientEditor, pickLookupFile, histogramId, sampleCanvas }: {
  adjustment: Adjustment | DestructiveAdjustment; onChange: OnChange; openGradientEditor: OpenGradientEditor; pickLookupFile: PickLookupFile;
  histogramId: number; sampleCanvas?: SampleCanvas;
}) {
  const { kind } = adjustment;
  if (adjustment.kind === 'levels' || adjustment.kind === 'curves') {
    return <LevelsCurvesBody adjustment={adjustment} onChange={onChange} histogramId={histogramId} sampleCanvas={sampleCanvas} />;
  }
  if (kind === 'invert') return <p className="adjustment-note">Invert has no parameters. Use opacity or blend mode to moderate the result.</p>;
  if (kind === 'gradient_map') {
    const { params } = adjustment;
    const g = gradientDefToUi(params.gradient);
    const edit = () => openGradientEditor(g, next => onChange({ kind, params: { ...params, gradient: uiToGradientDef(next) } }, false));
    const flag = (key: 'reverse' | 'dither', v: boolean) => onChange({ kind, params: { ...params, [key]: v } }, false);
    return (
      <div className="adjustment-body">
        <button type="button" className="gradient-ramp-button" aria-label="Edit gradient" title="Click to edit the gradient"
          style={{ backgroundImage: `${rampCss(g, params.gradient.method)}, var(--checker)` }} onClick={edit} />
        <span className="adjustment-note">{g.stops.length} color stops · {g.opacityStops.length} opacity stops</span>
        <button type="button" onClick={edit}>Edit gradient…</button>
        <label className="adjustment-check"><input type="checkbox" checked={params.reverse} onChange={e => flag('reverse', e.currentTarget.checked)} /> Reverse</label>
        <label className="adjustment-check"><input type="checkbox" checked={params.dither} onChange={e => flag('dither', e.currentTarget.checked)} /> Dither</label>
      </div>
    );
  }
  if (kind === 'color_lookup') {
    const { params } = adjustment;
    return (
      <div className="adjustment-body">
        <button type="button" onClick={() => pickLookupFile((name, table, format) => onChange({ kind, params: { ...params, name, table, format } }, false))}>Load 3D LUT…</button>
        <span className="adjustment-note">{params.table === null ? 'No lookup table loaded' : params.name}</span>
        <label className="adjustment-field"><span>Interpolation</span>
          <select value={params.interpolation} onChange={e => onChange({ kind, params: { ...params, interpolation: e.currentTarget.value as 'tetrahedral' | 'trilinear' } }, false)}>
            <option value="tetrahedral">Tetrahedral</option>
            <option value="trilinear">Trilinear</option>
          </select>
        </label>
        <label className="adjustment-check"><input type="checkbox" checked={params.dither} onChange={e => onChange({ kind, params: { ...params, dither: e.currentTarget.checked } }, false)} /> Dither</label>
      </div>
    );
  }
  return (
    <div className="adjustment-body">
      {(FIELD_SPECS[kind] ?? []).map(f => (
        <Field key={f.path} spec={f} params={adjustment.params} onChange={(path, v, live) => onChange(setPath(adjustment, path, v), live)} />
      ))}
    </div>
  );
}

export function PropertiesPanel({ doc, node, run, openGradientEditor, pickLookupFile, sampleCanvas }: {
  doc: DocInfo; node: LayerNode; run: Run; openGradientEditor: OpenGradientEditor; pickLookupFile: PickLookupFile; sampleCanvas: SampleCanvas;
}) {
  const adjustment = node.adjustment!;
  const title = EDIT_LABEL[adjustment.kind];
  // A slider drag previews through the worker's preview session and commits once on release.
  const dragging = useRef(false);
  // Properties only ever holds a layer kind, so the body hands back one.
  const change: OnChange = (edited, live) => {
    const next = edited as Adjustment;
    if (live) { dragging.current = true; void run(null, () => client.call('setAdjustment', node.id, next, title, true)); return; }
    if (dragging.current) { dragging.current = false; void run(null, () => client.call('previewEnd', true)); return; }
    void run(null, () => client.call('setAdjustment', node.id, next, title));
  };
  const setFlag = (props: { visible: boolean } | { clipping: boolean }, label: string) => void run(null, () => client.call('setProps', node.id, props, label));
  const isBottom = locate(doc.layers, node.id)?.index === 0;
  return (
    <div className="properties-panel">
      <div className="panel-tabs"><span className="panel-tab">Properties</span></div>
      <div className="adjustment-header">
        <h3>{title}</h3>
        <button type="button" aria-label={`Reset ${title}`} title={`Reset ${title}`} onClick={() => change(defaultAdjustment(adjustment.kind), false)}>
          <RotateCcw size={14} strokeWidth={1.75} />
        </button>
      </div>
      <AdjustmentBody key={node.id} adjustment={adjustment} onChange={change} openGradientEditor={openGradientEditor} pickLookupFile={pickLookupFile} histogramId={0} sampleCanvas={sampleCanvas} />
      <div className="professional-toggle-grid">
        <label className="adjustment-check"><input type="checkbox" checked={node.visible} onChange={() => setFlag({ visible: !node.visible }, 'Adjustment Visibility')} /> Adjustment visible</label>
        <label className="adjustment-check"><input type="checkbox" checked={node.clipping} disabled={isBottom} onChange={() => setFlag({ clipping: !node.clipping }, 'Adjustment Clipping')} /> Clip to layer below</label>
      </div>
    </div>
  );
}

const BLUR_RADIUS: FieldSpec = { type: 'number', label: 'Radius', path: 'radius', min: 0.1, max: 250, step: 0.1 };
const OPACITY: FieldSpec = { type: 'number', label: 'Opacity', path: 'opacity', min: 0, max: 100, step: 1, scale: 100 };

export function filterLabel(f: SmartFilterKind): string {
  return f.kind === 'gaussian_blur' ? 'Gaussian Blur' : MENU_LABEL[f.kind];
}

// Properties for a smart object (B11-4): each filter's enable checkbox and opacity slider, and the params of
// the selected filter (top one by default) through the adjustment bodies. Every edit is a "Smart Filter" step.
export function SmartFiltersPanel({ node, run, openGradientEditor, pickLookupFile, sampleCanvas }: {
  node: LayerNode; run: Run; openGradientEditor: OpenGradientEditor; pickLookupFile: PickLookupFile; sampleCanvas: SampleCanvas;
}) {
  const filters = node.smart!.filters;
  const [picked, setPicked] = useState<number | null>(null);
  const dragging = useRef(false);
  const current = filters.find(f => f.id === picked) ?? filters.at(-1);
  const set = (fid: number, patch: Partial<Omit<SmartFilterInfo, 'id' | 'mask'>>, live: boolean) => {
    if (live) { dragging.current = true; void run(null, () => client.call('setSmartFilter', node.id, fid, patch, 'Smart Filter', true)); return; }
    if (dragging.current) { dragging.current = false; void run(null, () => client.call('previewEnd', true)); return; }
    void run(null, () => client.call('setSmartFilter', node.id, fid, patch, 'Smart Filter'));
  };
  return (
    <div className="properties-panel">
      <div className="panel-tabs"><span className="panel-tab">Properties</span></div>
      <h3>Smart Filters</h3>
      {filters.length === 0 ? <p className="adjustment-note">No smart filters.</p> : filters.map(f => (
        <div key={f.id} className="smart-filter-row" aria-current={f === current}>
          <label className="adjustment-check">
            <input type="checkbox" checked={f.enabled} onChange={e => set(f.id, { enabled: e.currentTarget.checked }, false)} />
            <button type="button" className="link-button" onClick={() => setPicked(f.id)}>{filterLabel(f.filter)}</button>
          </label>
          <Field spec={OPACITY} params={f} onChange={(_, v, live) => set(f.id, { opacity: v as number }, live)} />
        </div>
      ))}
      {current && (
        <>
          <h3>{filterLabel(current.filter)}</h3>
          {current.filter.kind === 'gaussian_blur'
            ? <Field spec={BLUR_RADIUS} params={current.filter.params} onChange={(_, v, live) => set(current.id, { filter: { kind: 'gaussian_blur', params: { radius: v as number } } }, live)} />
            : <AdjustmentBody key={current.id} adjustment={current.filter} onChange={(a, live) => set(current.id, { filter: a as Adjustment }, live)}
                openGradientEditor={openGradientEditor} pickLookupFile={pickLookupFile} histogramId={node.id} sampleCanvas={sampleCanvas} />}
        </>
      )}
    </div>
  );
}

// Properties for an artboard (docs/M4.md section 11): X/Y move it with its layers and guides,
// W/H resize it, background. Each edit is one step labelled by its field.
export function ArtboardPanel({ node, run }: { node: LayerNode; run: Run }) {
  const a = node.artboard!;
  const [l, t, r, b] = a.rect;
  const commit = (rect: [number, number, number, number], background: ArtboardBackground, label: string) =>
    void run(null, () => client.call('editArtboard', node.id, rect, background, label));
  const field = (label: string, value: number, apply: (v: number) => [number, number, number, number], min: number) => (
    <label>{label} <input
      key={`${node.id}-${label}-${value}`} type="number" step={1} min={min} defaultValue={value} aria-label={`Artboard ${label}`}
      onBlur={e => { const v = Math.round(Number(e.currentTarget.value)); if (Number.isFinite(v) && v >= min && v !== value) commit(apply(v), a.background, `Artboard ${label}`); }}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    /></label>
  );
  return (
    <div className="properties-panel">
      <div className="panel-tabs"><span className="panel-tab">Properties</span></div>
      <div className="adjustment-header"><h3>Artboard</h3></div>
      <div className="professional-toggle-grid">
        {field('X', l, v => [v, t, v + r - l, b], -1e7)}
        {field('Y', t, v => [l, v, r, v + b - t], -1e7)}
        {field('W', r - l, v => [l, t, l + v, b], 1)}
        {field('H', b - t, v => [l, t, r, t + v], 1)}
        <label>Background <select
          value={a.background.type} aria-label="Artboard background"
          onChange={e => commit(a.rect, { type: e.currentTarget.value as 'none' | 'white' | 'black' | 'transparent' }, 'Artboard Background')}
        >
          <option value="white">White</option><option value="black">Black</option><option value="transparent">Transparent</option>
          <option value="none">None</option>
          {a.background.type === 'color' && <option value="color" disabled>Other color</option>}
        </select></label>
      </div>
    </div>
  );
}
