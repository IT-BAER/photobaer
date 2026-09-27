// Properties panel for the selected adjustment layer (docs/M3.md section 3, B5-1): header with the
// title and "Reset <kind>", the kind's body, then the visibility/clipping checkboxes. The Image >
// Adjustments dialogs reuse `AdjustmentBody`.
import { useRef, useState, type KeyboardEvent } from 'react';
import { RotateCcw } from 'lucide-react';
import { client } from './client.ts';
import type { Adjustment, DocInfo, LayerNode } from './engine.worker.ts';
import { locate } from './layers.ts';
import {
  EDIT_LABEL, FIELD_SPECS, defaultAdjustment, getPath, gradientDefToUi, setPath, uiToGradientDef, type FieldSpec,
} from './adjustments.ts';
import { rampCss, type Gradient } from './gradients/gradient.ts';
import { LevelsCurvesBody, type SampleCanvas } from './LevelsCurvesBody.tsx';

type Run = (label: string | null, p: () => Promise<DocInfo | null>) => Promise<void>;
export type OpenGradientEditor = (g: Gradient, onOk: (g: Gradient) => void) => void;
export type PickLookupFile = (onLoaded: (name: string, table: number, format: 'cube' | '3dl') => void) => void;
// `live` marks a slider drag in progress; the drag ends with one more call with `live` false.
type OnChange = (a: Adjustment, live: boolean) => void;

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
  adjustment: Adjustment; onChange: OnChange; openGradientEditor: OpenGradientEditor; pickLookupFile: PickLookupFile;
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
  const change: OnChange = (next, live) => {
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
