import { useImperativeHandle, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type Ref } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { rgbToHex, type Rgb } from './color.ts';
import { clamp01, defaultNoise, evaluate, largestGapMid, normalize, rampCss, resolveStops, type Gradient, type Method, type NoiseParams } from '../gradients/gradient.ts';
import { resolvePreset, type GradientPreset } from '../gradients/presets.ts';
import { NumberInput } from './NumberInput.tsx';

export interface GradientEditorHandle { open(g: Gradient, onOk: (g: Gradient) => void): void }
type Rail = 'stops' | 'opacityStops';
interface Sel { rail: Rail; i: number; midpoint?: boolean }
interface Props {
  ref: Ref<GradientEditorHandle>; presets: GradientPreset[]; fg: Rgb; bg: Rgb;
  pickColor: (rgb: Rgb, title: string, commit: (rgb: Rgb) => void) => void;
}

const CHANNELS: Record<NoiseParams['colorModel'], string[]> = { rgb: ['R', 'G', 'B'], hsb: ['H', 'S', 'B'], lab: ['L', 'a', 'b'] };
const pct = (v: number) => Math.round(v * 100);
const sortedIdx = (r: { position: number }[]) => r.map((_, i) => i).sort((a, b) => r[a].position - r[b].position);

function Percent({ label, value, min = 0, max = 100, set }: { label: string; value: number; min?: number; max?: number; set: (v: number) => void }) {
  return (
    <label>{label}
      <NumberInput min={min} max={max} value={pct(value)}
        onValue={v => set(Math.min(max, Math.max(min, v)) / 100)} />%
    </label>
  );
}

export function GradientEditor({ ref, presets, fg, bg, pickColor }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [g, setG] = useState<Gradient>(() => normalize({ stops: [], opacityStops: [], kind: 'solid', interpolation: 'classic' }));
  const [sel, setSel] = useState<Sel | null>(null);
  const onOk = useRef<(g: Gradient) => void>(() => {});
  const rails = { stops: useRef<HTMLDivElement>(null), opacityStops: useRef<HTMLDivElement>(null) };

  useImperativeHandle(ref, () => ({
    open(initial, ok) {
      onOk.current = ok;
      setG(structuredClone(initial));
      setSel({ rail: 'stops', i: 0 });
      dialog.current?.showModal();
    },
  }));

  const noise = g.noise ?? defaultNoise();
  const patchNoise = (p: Partial<NoiseParams>) => setG({ ...g, noise: { ...noise, ...p } });
  const valueAt = (t: number) => evaluate(normalize(g), t);

  function setStop(rail: Rail, i: number, patch: Record<string, unknown>) {
    const r = g[rail].map((s, k) => (k === i ? { ...s, ...patch } : s));
    setG({ ...g, [rail]: r });
  }
  function add(rail: Rail, at = largestGapMid(g[rail].map(s => s.position))) {
    const [r, gg, b, a] = valueAt(at);
    const stop = rail === 'stops'
      ? { position: at, color: [r, gg, b].map(Math.round) as Rgb, midpoint: 0.5 }
      : { position: at, opacity: Math.round(a * 1000) / 1000, midpoint: 0.5 };
    setG({ ...g, [rail]: [...g[rail], stop] });
    setSel({ rail, i: g[rail].length });
  }
  function remove(s: Sel | null) {
    if (!s || g[s.rail].length <= 2) return;
    setG({ ...g, [s.rail]: g[s.rail].filter((_, k) => k !== s.i) });
    setSel({ rail: s.rail, i: 0 });
  }
  const at = (rail: Rail, clientX: number) => {
    const r = rails[rail].current!.getBoundingClientRect();
    return clamp01((clientX - r.left) / r.width);
  };
  function drag(rail: Rail, i: number, e: ReactPointerEvent<HTMLButtonElement>) {
    setSel({ rail, i });
    if (e.detail > 1) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setG(cur => ({ ...cur, [rail]: cur[rail].map((s, k) => (k === i ? { ...s, position: at(rail, ev.clientX) } : s)) }));
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }
  function nudge(s: Sel, e: KeyboardEvent) {
    const stop = g[s.rail][s.i];
    const step = e.shiftKey ? 0.1 : 0.01;
    const cur = s.midpoint ? stop.midpoint : stop.position;
    const lo = s.midpoint ? 0.01 : 0, hi = s.midpoint ? 0.99 : 1;
    let v: number;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = cur - step;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = cur + step;
    else if (e.key === 'Home') v = lo;
    else if (e.key === 'End') v = hi;
    else if (!s.midpoint && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); remove(s); return; }
    else return;
    e.preventDefault();
    setStop(s.rail, s.i, { [s.midpoint ? 'midpoint' : 'position']: Math.min(hi, Math.max(lo, Math.round(v * 1000) / 1000)) });
  }
  function setKind(kind: Gradient['kind']) {
    if (kind === g.kind) return;
    if (kind === 'noise') { setG({ ...g, kind, noise }); return; }
    const r = resolveStops(g);
    const [c0, c1] = [r.stops[0], r.stops.at(-1)!], [o0, o1] = [r.opacityStops[0], r.opacityStops.at(-1)!];
    setG({
      kind, interpolation: 'classic', noise,
      stops: [{ position: 0, color: c0.color, midpoint: 0.5 }, { position: 1, color: c1.color, midpoint: 0.5 }],
      opacityStops: [{ position: 0, opacity: o0.opacity, midpoint: 0.5 }, { position: 1, opacity: o1.opacity, midpoint: 0.5 }],
    });
    setSel({ rail: 'stops', i: 0 });
  }
  function setMinMax(which: 'minimum' | 'maximum', k: number, v: number) {
    const minimum = [...noise.minimum] as NoiseParams['minimum'], maximum = [...noise.maximum] as NoiseParams['maximum'];
    (which === 'minimum' ? minimum : maximum)[k] = v;
    if (which === 'minimum' && v > maximum[k]) maximum[k] = v;
    if (which === 'maximum' && v < minimum[k]) minimum[k] = v;
    patchNoise({ minimum, maximum });
  }

  const rail = (r: Rail) => {
    const order = sortedIdx(g[r]);
    return (
      <div ref={rails[r]} className={`gradient-rail ${r === 'stops' ? 'color-rail' : 'opacity-rail'}`} aria-label={r === 'stops' ? 'Color stops' : 'Opacity stops'}
        onDoubleClick={e => { if (e.target === e.currentTarget) add(r, at(r, e.clientX)); }}>
        {g[r].map((s, i) => (
          <button key={i} type="button" className="gradient-stop" aria-pressed={sel?.rail === r && sel.i === i && !sel.midpoint}
            aria-label={`${r === 'stops' ? 'Color' : 'Opacity'} stop at ${pct(s.position)}%`}
            style={{ left: `${s.position * 100}%`, ...(r === 'stops' ? { background: rgbToHex((s as Gradient['stops'][number]).color) } : { background: `rgb(${Math.round(255 * (1 - (s as Gradient['opacityStops'][number]).opacity))} ${Math.round(255 * (1 - (s as Gradient['opacityStops'][number]).opacity))} ${Math.round(255 * (1 - (s as Gradient['opacityStops'][number]).opacity))})` }) }}
            onPointerDown={e => drag(r, i, e)} onFocus={() => setSel({ rail: r, i })}
            onDoubleClick={() => r === 'stops' && pickColor((s as Gradient['stops'][number]).color, 'Stop Color', c => setStop('stops', i, { color: c }))}
            onKeyDown={e => nudge({ rail: r, i }, e)} />
        ))}
        {sel?.rail === r && order.slice(0, -1).map((i, k) => {
          const a = g[r][i], b = g[r][order[k + 1]];
          return (
            <button key={`m${i}`} type="button" className="gradient-midpoint" aria-pressed={!!sel.midpoint && sel.i === i}
              aria-label={`Midpoint ${pct(a.midpoint)}%`} style={{ left: `${(a.position + (b.position - a.position) * a.midpoint) * 100}%` }}
              onClick={() => setSel({ rail: r, i, midpoint: true })} onKeyDown={e => nudge({ rail: r, i, midpoint: true }, e)} />
          );
        })}
      </div>
    );
  };

  const cur = sel && g[sel.rail][sel.i];
  const ramp = rampCss(g);
  return (
    <dialog ref={dialog} className="gradient-editor" aria-label="Gradient Editor">
      <h2>Gradient Editor</h2>
      <div className="gradient-presets" role="list">
        {presets.map(p => {
          const pg = resolvePreset(p, fg, bg);
          return (
            <button key={p.id} type="button" role="listitem" title={p.name} aria-label={p.name} className="gradient-chip"
              style={{ backgroundImage: `${rampCss(pg)}, var(--checker)` }}
              onClick={() => { setG(structuredClone(pg)); setSel({ rail: 'stops', i: 0 }); }} />
          );
        })}
      </div>
      <div className="gradient-row">
        <label>Type
          <select value={g.kind} onChange={e => setKind(e.currentTarget.value as Gradient['kind'])}>
            <option value="solid">Solid</option><option value="noise">Noise</option>
          </select>
        </label>
        {g.kind === 'solid' && (
          <label>Interpolation
            <select value={g.interpolation} onChange={e => setG({ ...g, interpolation: e.currentTarget.value as Method })}>
              <option value="perceptual">Perceptual</option><option value="linear">Linear</option><option value="classic">Classic</option>
            </select>
          </label>
        )}
      </div>
      {g.kind === 'solid' && rail('opacityStops')}
      <div className="gradient-ramp" data-testid="gradient-ramp" data-ramp={ramp} style={{ backgroundImage: `${ramp}, var(--checker)` }}
        onDoubleClick={e => g.kind === 'solid' && add('stops', at('stops', e.clientX))} />
      {g.kind === 'solid' ? (
        <>
          {rail('stops')}
          <div className="gradient-row">
            <button type="button" onClick={() => add('stops')}><Plus size={14} /> Add color stop</button>
            <button type="button" onClick={() => add('opacityStops')}><Plus size={14} /> Add opacity stop</button>
            <button type="button" aria-label="Remove stop" title="Remove stop" disabled={!sel || g[sel.rail].length <= 2} onClick={() => remove(sel)}><Trash2 size={14} /></button>
          </div>
          {cur && sel && (
            <div className="gradient-row" aria-label="Stop">
              <Percent label="Location" value={cur.position} set={v => setStop(sel.rail, sel.i, { position: v })} />
              {sel.rail === 'stops'
                ? <label>Color <button type="button" className="gradient-swatch" aria-label="Stop color" style={{ background: rgbToHex((cur as Gradient['stops'][number]).color) }}
                    onClick={() => pickColor((cur as Gradient['stops'][number]).color, 'Stop Color', c => setStop('stops', sel.i, { color: c }))} /></label>
                : <Percent label="Opacity" value={(cur as Gradient['opacityStops'][number]).opacity} set={v => setStop('opacityStops', sel.i, { opacity: v })} />}
              <Percent label="Midpoint" value={cur.midpoint} min={1} max={99} set={v => setStop(sel.rail, sel.i, { midpoint: v })} />
            </div>
          )}
        </>
      ) : (
        <div className="gradient-noise">
          <Percent label="Roughness" value={noise.roughness} set={v => patchNoise({ roughness: v })} />
          <label>Color model
            <select value={noise.colorModel} onChange={e => patchNoise({ colorModel: e.currentTarget.value as NoiseParams['colorModel'] })}>
              <option value="rgb">RGB</option><option value="hsb">HSB</option><option value="lab">Lab</option>
            </select>
          </label>
          {CHANNELS[noise.colorModel].map((c, k) => (
            <div key={c} className="gradient-row">
              <Percent label={`${c} min`} value={noise.minimum[k]} set={v => setMinMax('minimum', k, v)} />
              <Percent label={`${c} max`} value={noise.maximum[k]} set={v => setMinMax('maximum', k, v)} />
            </div>
          ))}
          <label><input type="checkbox" checked={noise.restrictColors} onChange={e => patchNoise({ restrictColors: e.currentTarget.checked })} /> Restrict colors</label>
          <label><input type="checkbox" checked={noise.addTransparency} onChange={e => patchNoise({ addTransparency: e.currentTarget.checked })} /> Add transparency</label>
          <button type="button" onClick={() => patchNoise({ seed: noise.seed + 1 })}>Randomize</button>
        </div>
      )}
      <div className="actions">
        <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
        <button type="button" className="primary" onClick={() => { dialog.current?.close(); onOk.current(normalize(g)); }}>OK</button>
      </div>
    </dialog>
  );
}
