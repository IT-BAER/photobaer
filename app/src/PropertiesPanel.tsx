// Properties panel for the selected adjustment layer (docs/M3.md section 3, B5-1): header with the
// title and "Reset <kind>", the kind's body, then the visibility/clipping checkboxes. The Image >
// Adjustments dialogs reuse `AdjustmentBody`.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { RotateCcw } from 'lucide-react';
import { client } from './client.ts';
import type { Adjustment, DestructiveAdjustment, DocInfo, LayerNode, SmartFilterInfo, SmartFilterKind } from './engine.worker.ts';
import type { ArtboardBackground, BoolOp, FillContent, VectorMaskInfo } from './worker/types.ts';
import { hexToRgb, rgbToHex } from './shell/color.ts';
import { BOOL_LABEL, dashFor, newStroke, radiusMax, setRadius, strokeStyleOf, type Live, type ShapeStroke, type StrokeStyle } from './shell/shapetools.ts';
import { locate } from './layers.ts';
import { selectCreated, type SelectAfter } from './app/helpers.ts';
import {
  EDIT_LABEL, FIELD_SPECS, MENU_LABEL, defaultAdjustment, getPath, gradientDefToUi, setPath, uiToGradientDef, type FieldSpec,
} from './adjustments.ts';
import { rampCss, type Gradient } from './gradients/gradient.ts';
import { LevelsCurvesBody, type SampleCanvas } from './LevelsCurvesBody.tsx';

type Run = (label: string | null, p: () => Promise<DocInfo | null>, selectAfter?: SelectAfter) => Promise<void>;
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
      <div className="professional-toggle-grid shape-appearance">
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

// A native color input that commits on the picker's `change` (React's onChange fires on every drag step).
export function ColorInput({ value, label, onCommit }: { value: [number, number, number]; label: string; onCommit: (c: [number, number, number]) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    const el = ref.current!;
    const on = () => { const c = hexToRgb(el.value); if (c) commit.current(c); };
    el.addEventListener('change', on);
    return () => el.removeEventListener('change', on);
  }, []);
  return <input ref={ref} type="color" aria-label={label} defaultValue={rgbToHex(value)} />;
}

// A number field that commits once on blur or Enter.
export function Num({ label, value, min, max, step, onCommit }: { label: string; value: number; min: number; max: number; step?: number; onCommit: (v: number) => void }) {
  return (
    <label>{label} <input
      key={`${label}-${value}`} type="number" min={min} max={max} step={step} defaultValue={value} aria-label={label}
      onBlur={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v) && v !== value) onCommit(Math.min(max, Math.max(min, v))); }}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    /></label>
  );
}

type ShapeInfo = NonNullable<LayerNode['shape']>;
const colorOf = (c: FillContent | null | undefined, fallback: [number, number, number]) => (c?.type === 'solid' ? c.color : fallback);
const solid = (c: [number, number, number]): FillContent => ({ type: 'solid', color: c });

// Properties Appearance for a shape layer (docs/M4.md section 5): fill, stroke and its options, corner
// radii with a link toggle, polygon sides and star ratio. Each edit is one step labelled by its field.
export function ShapePanel({ node, run, fg, selected }: { node: LayerNode; run: Run; fg: [number, number, number]; selected: LayerNode[] }) {
  const s = node.shape!;
  const [linked, setLinked] = useState(true);
  const live = s.live;
  const stroke = s.stroke?.enabled ? s.stroke : null;
  const edit = (label: string, next: Partial<ShapeInfo>) => {
    const { live: l, fill, stroke: st } = { ...s, ...next };
    void run(null, () => client.call('setShapes', [{ id: node.id, shape: { live: l, fill, stroke: st } }], label));
  };
  const editStroke = (label: string, patch: Partial<ShapeStroke>) => { if (stroke) edit(label, { stroke: { ...stroke, ...patch } }); };
  const radii = live && (live.type === 'rectangle' || live.type === 'roundedRectangle') ? live.radii : null;
  const bounds = live && 'bounds' in live ? live.bounds : null;
  const select = <T extends string>(label: string, value: T, options: T[], apply: (v: T) => void) => (
    <label>{label} <select aria-label={label} value={value} onChange={e => apply(e.currentTarget.value as T)}>
      {options.map(o => <option key={o} value={o}>{o[0].toUpperCase() + o.slice(1)}</option>)}
    </select></label>
  );
  const strokeOn = (on: boolean) => edit('Shape Stroke', {
    stroke: on ? (s.stroke ? { ...s.stroke, enabled: true } : newStroke(fg, 1, 4)) : s.stroke && { ...s.stroke, enabled: false },
  });
  return (
    <div className="properties-panel">
      <div className="panel-tabs"><span className="panel-tab">Properties</span></div>
      <div className="adjustment-header"><h3>Appearance</h3></div>
      <div className="professional-toggle-grid shape-appearance">
        {live?.type !== 'line' && (
          <label className="adjustment-check">
            <input type="checkbox" checked={!!s.fill} onChange={e => edit('Shape Fill', { fill: e.currentTarget.checked ? solid(fg) : null })} /> Fill
            <ColorInput key={rgbToHex(colorOf(s.fill, fg))} label="Fill color" value={colorOf(s.fill, fg)} onCommit={c => edit('Shape Fill', { fill: solid(c) })} />
          </label>
        )}
        <label className="adjustment-check">
          <input type="checkbox" checked={!!stroke} onChange={e => strokeOn(e.currentTarget.checked)} /> Stroke
          <ColorInput key={rgbToHex(colorOf(s.stroke?.content, fg))} label="Stroke color" value={colorOf(s.stroke?.content, fg)}
            onCommit={c => edit('Shape Stroke', { stroke: s.stroke ? { ...s.stroke, enabled: true, content: solid(c) } : newStroke(c, 1, 4) })} />
        </label>
        {stroke && (
          <>
            <Num label="Width" value={stroke.width} min={0} max={1000} onCommit={v => editStroke('Stroke Width', { width: v })} />
            {select<StrokeStyle>('Stroke style', strokeStyleOf(stroke.dash, stroke.width), ['solid', 'dashed', 'dotted'], v => editStroke('Stroke Style', dashFor(v, stroke.width)))}
            {select('Stroke placement', stroke.align, ['inside', 'center', 'outside'], v => editStroke('Stroke Placement', { align: v }))}
            {select('Stroke cap', stroke.cap, ['butt', 'round', 'square'], v => editStroke('Stroke Cap', { cap: v }))}
            {select('Stroke join', stroke.join, ['miter', 'round', 'bevel'], v => editStroke('Stroke Join', { join: v }))}
          </>
        )}
        {radii && bounds && (
          <>
            <button type="button" aria-pressed={linked} onClick={() => setLinked(x => !x)}>{linked ? 'Unlink corner radii' : 'Link corner radii'}</button>
            {(['Top left', 'Top right', 'Bottom left', 'Bottom right'] as const).map((label, i) => (
              <Num key={label} label={label} value={radii[i]} min={0} max={radiusMax(bounds)}
                onCommit={v => edit('Corner Radius', { live: { ...live!, radii: setRadius(radii, i, v, linked, bounds) } as Live })} />
            ))}
          </>
        )}
        {live && bounds && (live.type === 'triangle' || live.type === 'polygon') && (
          <Num label="Corner radius" value={live.radius} min={0} max={radiusMax(bounds)} onCommit={v => edit('Corner Radius', { live: { ...live, radius: v } })} />
        )}
        {live?.type === 'polygon' && (
          <>
            <Num label="Sides" value={live.sides} min={3} max={100} onCommit={v => edit('Polygon Sides', { live: { ...live, sides: Math.round(v) } })} />
            <Num label="Star ratio" value={Math.round(live.star_inset * 100)} min={0} max={99} onCommit={v => edit('Polygon Star Ratio', { live: { ...live, star_inset: v / 100 } })} />
          </>
        )}
      </div>
      <Pathfinder node={node} selected={selected} run={run} />
    </div>
  );
}

// Pathfinder (docs/M4.md section 5): several selected shape layers combine into the bottom one;
// one layer folds its own subpaths, so it needs at least two.
function Pathfinder({ node, selected, run }: { node: LayerNode; selected: LayerNode[]; run: Run }) {
  const shapes = selected.filter(n => n.kind === 'shape');
  const many = shapes.length > 1;
  const on = many || node.shape!.path.subpaths.length > 1;
  const apply = (op: BoolOp) => void (many
    ? run(null, () => client.call('combineShapes', shapes.map(n => n.id), op), selectCreated)
    : run(null, () => client.call('pathfinder', node.id, op)));
  return (
    <>
      <div className="adjustment-header"><h3>Pathfinder</h3></div>
      <div className="pathfinder" role="group" aria-label="Pathfinder">
        {(Object.keys(BOOL_LABEL) as BoolOp[]).map(op => (
          <button key={op} type="button" className={`pathfinder-${op}`} aria-label={BOOL_LABEL[op]} title={BOOL_LABEL[op]} disabled={!on} onClick={() => apply(op)}>
            <i /><i />
          </button>
        ))}
      </div>
    </>
  );
}

// Properties Vector Mask (docs/M4.md section 6): density, feather, flags, counts, Make Selection and Delete.
export function VectorMaskPanel({ node, run }: { node: LayerNode; run: Run }) {
  const m = node.vector_mask!;
  const edit = (label: string, patch: Partial<VectorMaskInfo> | null) =>
    void run(null, () => client.call('vectorMaskEdit', [{ id: node.id, mask: patch && { ...m, ...patch } }], label));
  const flag = (label: string, key: 'enabled' | 'linked' | 'inverted', undo: string) => (
    <label className="adjustment-check"><input type="checkbox" checked={m[key]} onChange={e => edit(undo, { [key]: e.currentTarget.checked })} /> {label}</label>
  );
  const anchors = m.path.subpaths.reduce((n, s) => n + s.points.length, 0);
  return (
    <div className="properties-panel">
      <div className="panel-tabs"><span className="panel-tab">Properties</span></div>
      <div className="adjustment-header">
        <h3>Vector Mask</h3>
        <button type="button" aria-label="Reset Vector Mask Properties" title="Reset Vector Mask Properties"
          onClick={() => edit('Reset Vector Mask Properties', { enabled: true, linked: true, inverted: false, density: 1, feather: 0 })}>
          <RotateCcw size={14} strokeWidth={1.75} />
        </button>
      </div>
      <div className="professional-toggle-grid shape-appearance">
        <Num label="Density" value={Math.round(m.density * 100)} min={0} max={100} onCommit={v => edit('Vector Mask Density', { density: v / 100 })} />
        <Num label="Feather" value={m.feather} min={0} max={1000} step={0.1} onCommit={v => edit('Vector Mask Feather', { feather: v })} />
        {flag('Enabled', 'enabled', 'Enable Vector Mask')}
        {flag('Linked', 'linked', 'Link Vector Mask')}
        {flag('Invert', 'inverted', 'Invert Vector Mask')}
        <span>Components {m.path.subpaths.length}</span>
        <span>Anchor points {anchors}</span>
        <button type="button" onClick={() => void run(null, () => client.call('makeSelectionFromPath', 'vectorMask', node.id, 'new', 'Make Selection from Vector Mask'))}>Make Selection</button>
        <button type="button" onClick={() => edit('Delete Vector Mask', null)}>Delete Mask</button>
      </div>
    </div>
  );
}
