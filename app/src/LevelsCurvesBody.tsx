// Levels and Curves bodies (docs/M3.md section 3 kinds 2 and 3) for the Properties panel and the
// Image > Adjustments dialogs: histogram, channel select, handles/graph, Auto, eyedroppers, presets.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Crosshair, Pencil, Pipette, Spline } from 'lucide-react';
import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { client } from './client.ts';
import { i18n } from './i18n/index.ts';
import { NumberInput } from './shell/NumberInput.tsx';
import type { Adjustment, LevelsRecord } from './engine.worker.ts';
import {
  AUTO_METHODS, CHANNELS, CURVES_PRESETS, LEVELS_PRESETS, addPoint, autoLevels, channelBins, channelValue, curveSamples,
  draggedOut, levelsEyedropper, levelsRecord, movePoint, nameLabel, neutralRecord, pencilDraw, pencilToPoints, pointsToPencil,
  removePoint, setLevelsInput, type AutoMethod, type Channel, type CurvesParams, type LevelsParams, type Point,
} from './levelsCurves.ts';

type Rgb = [number, number, number];
/** Arms a one-shot canvas sample (the callback gets the clicked composite color); null disarms. */
export type SampleCanvas = (onSample: ((rgb: Rgb) => void) | null) => void;
type OnChange = (a: Adjustment, live: boolean) => void;
interface BodyProps<P> { params: P; onChange: (p: P, live: boolean) => void; histogramId: number; sampleCanvas?: SampleCanvas }

// Display text of the Curves display options; channel and preset names come from nameLabel.
const WORDS: Record<string, MessageDescriptor> = {
  Histogram: msg`Histogram`, Overlays: msg`Overlays`, Baseline: msg`Baseline`, Intersection: msg`Intersection`, Clipping: msg`Clipping`,
};
const word = (text: string) => (Object.hasOwn(WORDS, text) ? i18n._(WORDS[text]) : nameLabel(text));
const AUTO_KEY = 'photobaer.levels-auto-method.v1';
const LINE: Record<Channel, string> = { composite: 'currentColor', red: '#e5484d', green: '#30a46c', blue: '#3e8ef7' };

function useHistogram(id: number) {
  const [h, setH] = useState<Uint32Array | null>(null);
  useEffect(() => {
    let alive = true;
    client.call('histogram', id).then(r => { if (alive) setH(r); }, () => { if (alive) setH(new Uint32Array(1024)); });
    return () => { alive = false; };
  }, [id]);
  return h;
}

// A filled SVG path of 256 bins scaled to `height`, tallest bin at the top.
function histogramPath(bins: Uint32Array, height: number): string {
  const max = Math.max(1, ...bins);
  let d = `M0 ${height}`;
  bins.forEach((n, i) => { const y = height - (n / max) * height; d += `L${i} ${y}L${i + 1} ${y}`; });
  return `${d}L256 ${height}Z`;
}

// A one-shot canvas sample armed by a tool button; disarms on a second click or unmount.
function useSampler(sampleCanvas: SampleCanvas | undefined) {
  const [armed, setArmed] = useState<string | null>(null);
  const latest = useRef(sampleCanvas);
  latest.current = sampleCanvas;
  useEffect(() => () => latest.current?.(null), []);
  const arm = (name: string, onSample: (rgb: Rgb) => void) => {
    if (!sampleCanvas) return;
    if (armed === name) { setArmed(null); sampleCanvas(null); return; }
    setArmed(name);
    sampleCanvas(rgb => { setArmed(null); onSample(rgb); });
  };
  return { armed, arm };
}

// Number field committing on Enter or blur.
export function ValueInput({ label, value, step = 1, min, max, disabled, set }: { label: string; value: number; step?: number; min?: number; max?: number; disabled?: boolean; set: (v: number) => void }) {
  const [draft, setDraft] = useState<number | null>(null);
  const done = () => {
    const v = draft;
    setDraft(null);
    if (v !== null && Number.isFinite(v) && v !== value) set(v);
  };
  return (
    <NumberInput aria-label={label} title={label} step={step} min={min} max={max} disabled={disabled} value={draft ?? value}
      onValue={setDraft} onBlur={done}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } else if (e.key === 'Escape') setDraft(null);
      }} />
  );
}

// Triangular handles along a 0..255 track; a drag reports live positions, then (if it moved) one final one.
function HandleTrack({ label, handles, onDrag, className }: {
  label: string; handles: { key: string; pos: number; tone: string }[]; onDrag: (key: string, pos: number, live: boolean) => void; className?: string;
}) {
  const drag = useRef<{ key: string; pos: number; moved: boolean } | null>(null);
  const end = () => { const d = drag.current; drag.current = null; if (d?.moved) onDrag(d.key, d.pos, false); };
  const at = (e: ReactPointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(255, Math.max(0, ((e.clientX - r.left) / r.width) * 255));
  };
  return (
    <div className={`levels-track ${className ?? ''}`} aria-label={label}
      onPointerMove={e => { if (drag.current) { drag.current.pos = at(e); drag.current.moved = true; onDrag(drag.current.key, drag.current.pos, true); } }}
      onPointerUp={end} onPointerCancel={end}>
      {handles.map(h => { const handleKey = h.key; return (
        <span key={h.key} className={`levels-handle ${h.tone}`} style={{ left: `${(h.pos / 255) * 100}%` }} aria-label={t`${label} ${handleKey}`}
          onPointerDown={e => {
            e.preventDefault();
            (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { key: h.key, pos: h.pos, moved: false };
          }} />
      ); })}
    </div>
  );
}

function ChannelSelect({ value, set }: { value: Channel; set: (c: Channel) => void }) {
  return (
    <label className="adjustment-field"><span><Trans>Channel</Trans></span>
      <select value={value} onChange={e => set(e.currentTarget.value as Channel)}>
        {CHANNELS.map(([c, l]) => <option key={c} value={c}>{word(l)}</option>)}
      </select>
    </label>
  );
}

function PresetSelect({ names, current, apply }: { names: string[]; current: string; apply: (name: string) => void }) {
  return (
    <label className="adjustment-field"><span><Trans>Preset</Trans></span>
      <select value={current} onChange={e => apply(e.currentTarget.value)}>
        <option value="Default">{word('Default')}</option>
        {names.map(n => <option key={n} value={n}>{word(n)}</option>)}
        {current === 'Custom' && <option value="Custom">{word('Custom')}</option>}
      </select>
    </label>
  );
}

const sameRecord = (a: LevelsRecord, b: LevelsRecord) => (Object.keys(a) as (keyof LevelsRecord)[]).every(k => a[k] === b[k]);
const noChannels = (p: { red?: unknown; green?: unknown; blue?: unknown }) => !p.red && !p.green && !p.blue;

function LevelsBody({ params, onChange, histogramId, sampleCanvas }: BodyProps<LevelsParams>) {
  const [ch, setCh] = useState<Channel>('composite');
  const [method, setMethod] = useState<AutoMethod>(() => {
    try { return (localStorage.getItem(AUTO_KEY) as AutoMethod | null) ?? 'contrast'; } catch { return 'contrast'; }
  });
  const [options, setOptions] = useState(false);
  const h = useHistogram(histogramId);
  const { armed, arm } = useSampler(sampleCanvas);
  const rec = levelsRecord(params, ch);
  const set = (r: LevelsRecord, live: boolean) => onChange({ ...params, [ch]: r }, live);
  const drag = (key: string, pos: number, live: boolean) => {
    if (key !== 'gamma') { set(setLevelsInput(rec, key as keyof LevelsRecord, pos), live); return; }
    const v = Math.min(0.99, Math.max(0.01, (pos - rec.input_black) / (rec.input_white - rec.input_black)));
    set(setLevelsInput(rec, 'gamma', Math.log(v) / Math.log(0.5)), live);
  };
  const pickMethod = (m: AutoMethod) => {
    setMethod(m);
    try { localStorage.setItem(AUTO_KEY, m); } catch { /* session-only */ }
  };
  const bins = h && channelBins(h, ch);
  const current = noChannels(params)
    ? sameRecord(params.composite, neutralRecord()) ? 'Default' : LEVELS_PRESETS.find(([, r]) => sameRecord(r, params.composite))?.[0] ?? 'Custom'
    : 'Custom';
  const gammaPos = rec.input_black + (rec.input_white - rec.input_black) * 0.5 ** rec.gamma;
  const field = (label: string, key: keyof LevelsRecord, step = 1) =>
    <ValueInput label={label} value={rec[key]} step={step} set={v => set(setLevelsInput(rec, key, v), false)} />;
  const dropper = (which: 'black' | 'gray' | 'white', label: string) => (
    <button type="button" className={`levels-eyedropper-${which}`} aria-label={label} aria-pressed={armed === which} disabled={!sampleCanvas || !h}
      title={sampleCanvas ? t`${label}: click the image to set it` : t`${label}: available in the Properties panel`}
      onClick={() => arm(which, rgb => onChange(levelsEyedropper(params, which, rgb), false))}>
      <Pipette size={14} strokeWidth={1.75} />
    </button>
  );
  return (
    <div className="adjustment-body">
      <PresetSelect names={LEVELS_PRESETS.map(([n]) => n)} current={current} apply={name => {
        const r = name === 'Default' ? neutralRecord() : LEVELS_PRESETS.find(([n]) => n === name)?.[1];
        if (r) onChange({ composite: r, red: null, green: null, blue: null }, false);
      }} />
      <ChannelSelect value={ch} set={setCh} />
      <div className="levels-tools">
        {dropper('black', t`Black point`)}{dropper('gray', t`Gray point`)}{dropper('white', t`White point`)}
        <button type="button" disabled={!h?.some(n => n > 0)} onClick={() => h && onChange(autoLevels(h, method), false)}><Trans>Auto</Trans></button>
        <button type="button" aria-expanded={options} onClick={() => setOptions(!options)}><Trans>Options…</Trans></button>
      </div>
      {options && (
        <fieldset className="levels-options"><legend><Trans>Auto Color Correction Options</Trans></legend>
          {AUTO_METHODS.map(([m, l]) => (
            <label key={m} className="adjustment-check"><input type="radio" name="levels-auto" checked={method === m} onChange={() => pickMethod(m)} /> {word(l)}</label>
          ))}
        </fieldset>
      )}
      <span className="adjustment-note"><Trans>Input Levels</Trans></span>
      <svg className="levels-histogram" viewBox="0 0 256 100" preserveAspectRatio="none" aria-label={t`Input histogram`}>
        {bins && <path d={histogramPath(bins, 100)} fill={ch === 'composite' ? 'currentColor' : LINE[ch]} />}
      </svg>
      {!h ? <span className="adjustment-note"><Trans>Loading…</Trans></span> : !bins?.some(n => n > 0) && <span className="adjustment-note"><Trans>No pixels</Trans></span>}
      <HandleTrack label={t`Input`} onDrag={drag} handles={[
        { key: 'input_black', pos: rec.input_black, tone: 'black' }, { key: 'gamma', pos: gammaPos, tone: 'gray' },
        { key: 'input_white', pos: rec.input_white, tone: 'white' },
      ]} />
      <div className="levels-values">{field(t`Input black`, 'input_black')}{field(t`Gamma`, 'gamma', 0.01)}{field(t`Input white`, 'input_white')}</div>
      <span className="adjustment-note"><Trans>Output Levels</Trans></span>
      <HandleTrack label={t`Output`} className="levels-output-ramp" onDrag={drag} handles={[
        { key: 'output_black', pos: rec.output_black, tone: 'black' }, { key: 'output_white', pos: rec.output_white, tone: 'white' },
      ]} />
      <div className="levels-values">{field(t`Output black`, 'output_black')}{field(t`Output white`, 'output_white')}</div>
    </div>
  );
}

const DISPLAY: [keyof Display, string][] = [['histogram', 'Histogram'], ['overlays', 'Overlays'], ['baseline', 'Baseline'], ['intersection', 'Intersection'], ['clipping', 'Clipping']];
interface Display { histogram: boolean; overlays: boolean; baseline: boolean; intersection: boolean; clipping: boolean }

function CurvesBody({ params, onChange, histogramId, sampleCanvas }: BodyProps<CurvesParams>) {
  const [ch, setCh] = useState<Channel>('composite');
  const [sel, setSel] = useState(-1);
  const [show, setShow] = useState<Display>({ histogram: true, overlays: true, baseline: true, intersection: true, clipping: false });
  const h = useHistogram(histogramId);
  const { armed, arm } = useSampler(sampleCanvas);
  const pencil = params.mode === 'pencil';
  const identity: Point[] = [[0, 0], [255, 255]];
  const points = params[ch] ?? (pencil ? pointsToPencil(identity, false) : identity);
  const drag = useRef<{ index: number; last: Point; points: Point[]; out: boolean; live: boolean } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const set = (pts: Point[], live: boolean) => { const p = { ...params, [ch]: pts }; onChange(p, live); return p; };
  const samples = curveSamples(points, pencil);

  const locate = (e: ReactPointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const gx = e.clientX - r.left, gy = e.clientY - r.top;
    return { gx, gy, size: r.width, v: [(gx / r.width) * 255, 255 - (gy / r.height) * 255] as Point, tol: (10 * 255) / r.width };
  };
  const down = (e: ReactPointerEvent<SVGSVGElement>) => {
    e.preventDefault();
    const { v, tol } = locate(e);
    if (pencil) {
      const pts = pencilDraw(points, v, v);
      drag.current = { index: -1, last: v, points: pts, out: false, live: true };
      set(pts, true);
    } else {
      const { points: pts, index } = addPoint(points, v[0], v[1], tol);
      if (index < 0) return;
      if (e.altKey && pts === points) {
        const next = removePoint(points, index);
        if (next !== points) { setSel(-1); set(next, false); }
        return;
      }
      setSel(index);
      drag.current = { index, last: v, points: pts, out: false, live: pts !== points };
      if (pts !== points) set(pts, true);
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const { gx, gy, size, v } = locate(e);
    if (pencil) d.points = pencilDraw(d.points, d.last, v);
    else {
      d.out = draggedOut(gx, gy, size) && d.index > 0 && d.index < d.points.length - 1;
      d.points = movePoint(d.points, d.index, v[0], v[1]);
    }
    d.last = v;
    d.live = true;
    set(d.out ? removePoint(d.points, d.index) : d.points, true);
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.live) return;
    if (d.out) setSel(-1);
    set(d.out ? removePoint(d.points, d.index) : d.points, false);
  };
  const setMode = (mode: 'point' | 'pencil') => {
    if (mode === params.mode) return;
    const conv = (pts: Point[]) => (mode === 'pencil' ? pointsToPencil(pts, false) : pencilToPoints(pts));
    const opt = (pts?: Point[] | null) => (pts ? conv(pts) : pts);
    setSel(-1);
    onChange({ mode, composite: conv(params.composite), red: opt(params.red), green: opt(params.green), blue: opt(params.blue) }, false);
  };
  const addSample = (rgb: Rgb) => {
    const x = channelValue(rgb, ch);
    const { points: pts, index } = addPoint(points, x, samples[x], 0);
    if (index < 0) return;
    setSel(index);
    if (pts !== points) set(pts, false);
  };
  const current = pencil || !noChannels(params) ? 'Custom'
    : JSON.stringify(params.composite) === JSON.stringify(identity) ? 'Default'
      : CURVES_PRESETS.find(([, p]) => JSON.stringify(p) === JSON.stringify(params.composite))?.[0] ?? 'Custom';
  const selected = !pencil && sel >= 0 && sel < points.length ? points[sel] : null;
  const line = (s: number[]) => s.map((y, x) => `${x},${255 - y}`).join(' ');
  const bins = h && channelBins(h, ch);
  const others = CHANNELS.map(([c]) => c).filter(c => c !== ch && (c === 'composite' || params[c]));
  return (
    <div className="adjustment-body">
      <PresetSelect names={CURVES_PRESETS.map(([n]) => n)} current={current} apply={name => {
        const pts = name === 'Default' ? identity : CURVES_PRESETS.find(([n]) => n === name)?.[1];
        if (pts) { setSel(-1); onChange({ mode: 'point', composite: pts, red: null, green: null, blue: null }, false); }
      }} />
      <ChannelSelect value={ch} set={c => { setCh(c); setSel(-1); }} />
      <div className="levels-tools" role="group" aria-label={t`Curve drawing mode`}>
        <button type="button" aria-label={t`Edit points`} title={t`Edit points`} aria-pressed={!pencil} onClick={() => setMode('point')}><Spline size={14} strokeWidth={1.75} /></button>
        <button type="button" aria-label={t`Pencil`} title={t`Pencil`} aria-pressed={pencil} onClick={() => setMode('pencil')}><Pencil size={14} strokeWidth={1.75} /></button>
        <button type="button" aria-label={t`Sample curve point`} aria-pressed={armed === 'sample'} disabled={!sampleCanvas || pencil}
          title={sampleCanvas ? t`Sample curve point: click the image to add a point at its value` : t`Sample curve point: available in the Properties panel`}
          onClick={() => arm('sample', addSample)}>
          <Crosshair size={14} strokeWidth={1.75} />
        </button>
      </div>
      <svg ref={svg} className="adjustment-curve" viewBox="0 0 255 255" aria-label={t`Curve`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {show.histogram && bins && <path d={histogramPath(bins, 255)} className="curve-histogram" />}
        {[64, 128, 191].map(g => <g key={g} className="curve-grid"><line x1={g} y1={0} x2={g} y2={255} /><line x1={0} y1={g} x2={255} y2={g} /></g>)}
        {show.baseline && <line className="curve-grid" x1={0} y1={255} x2={255} y2={0} />}
        {show.overlays && others.map(c => <polyline key={c} className="curve-overlay" stroke={LINE[c]} points={line(curveSamples(params[c] ?? identity, pencil))} />)}
        {show.clipping && samples.map((y, x) => (y <= 0.5 || y >= 254.5) && <line key={x} className="curve-clip" x1={x} y1={0} x2={x} y2={255} />)}
        {show.intersection && selected && <g className="curve-grid"><line x1={selected[0]} y1={0} x2={selected[0]} y2={255} /><line x1={0} y1={255 - selected[1]} x2={255} y2={255 - selected[1]} /></g>}
        <polyline className="curve-line" stroke={LINE[ch]} points={line(samples)} />
        {!pencil && points.map(([x, y], i) => <rect key={i} className={i === sel ? 'curve-point selected' : 'curve-point'} x={x - 3} y={255 - y - 3} width={6} height={6} />)}
      </svg>
      <div className="levels-values">
        <ValueInput label={t`Input`} value={selected?.[0] ?? 0} disabled={!selected} set={v => set(movePoint(points, sel, v, points[sel][1]), false)} />
        <ValueInput label={t`Output`} value={selected?.[1] ?? 0} disabled={!selected} set={v => set(movePoint(points, sel, points[sel][0], v), false)} />
      </div>
      <div className="professional-toggle-grid">
        {DISPLAY.map(([k, l]) => <label key={k} className="adjustment-check"><input type="checkbox" checked={show[k]} onChange={e => setShow({ ...show, [k]: e.currentTarget.checked })} /> {word(l)}</label>)}
      </div>
    </div>
  );
}

/** The Levels or Curves body for an adjustment of that kind; `histogramId` 0 reads the composite. */
export function LevelsCurvesBody({ adjustment, onChange, histogramId, sampleCanvas }: {
  adjustment: Extract<Adjustment, { kind: 'levels' | 'curves' }>; onChange: OnChange; histogramId: number; sampleCanvas?: SampleCanvas;
}) {
  if (adjustment.kind === 'levels') {
    return <LevelsBody params={adjustment.params} histogramId={histogramId} sampleCanvas={sampleCanvas} onChange={(params, live) => onChange({ kind: 'levels', params }, live)} />;
  }
  return <CurvesBody params={adjustment.params} histogramId={histogramId} sampleCanvas={sampleCanvas} onChange={(params, live) => onChange({ kind: 'curves', params }, live)} />;
}
