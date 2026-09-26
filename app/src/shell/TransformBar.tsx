import { useState, useSyncExternalStore } from 'react';
import { Link, Unlink } from 'lucide-react';
import { NUMERIC_FIELDS, type Mode, type NumericField } from '../transform/session.ts';
import { STYLES, type Preset, type SplitMode, type Style } from '../transform/warp.ts';

export const MODES: [Mode, string][] = [['free', 'Free Transform'], ['scale', 'Scale'], ['rotate', 'Rotate'], ['skew', 'Skew'], ['distort', 'Distort'], ['perspective', 'Perspective'], ['warp', 'Warp']];
// Warp controls: the preset, the grid value ('1', '3', '4', '5' or 'custom') and the armed split mode.
export type WarpSplit = SplitMode | 'remove';
export interface WarpBarState { preset: Preset; grid: string; split: WarpSplit | null }
export interface TransformBarState { mode: Mode; values: number[]; linked: boolean; snap: boolean; warp: WarpBarState | null }
// The session pushes every change here, so only the bar re-renders during a drag.
export class TransformBarStore {
  #state: TransformBarState;
  #subs = new Set<() => void>();
  constructor(s: TransformBarState) { this.#state = s; }
  get = () => this.#state;
  set(s: Partial<TransformBarState>) { this.#state = { ...this.#state, ...s }; for (const f of this.#subs) f(); }
  subscribe = (f: () => void) => { this.#subs.add(f); return () => { this.#subs.delete(f); }; };
}

interface Props {
  store: TransformBarStore;
  setMode(m: Mode): void; setSnap(b: boolean): void; setLinked(b: boolean): void;
  setReference(u: number, v: number): void; setNumeric(f: NumericField, v: number): void;
  apply(): void; cancel(): void;
  warpStyle(s: Style): void; warpPreset(p: Partial<Preset>): void; warpGrid(n: number): void; warpSplit(m: WarpSplit): void;
}

const STYLE_LABELS: Record<Style, string> = {
  none: 'None', custom: 'Custom', arc: 'Arc', arcLower: 'Lower Arc', arcUpper: 'Upper Arc', arch: 'Arch', bulge: 'Bulge',
  shellLower: 'Lower Shell', shellUpper: 'Upper Shell', flag: 'Flag', wave: 'Wave', fish: 'Fish', rise: 'Rise',
  fisheye: 'Fisheye', inflate: 'Inflate', squeeze: 'Squeeze', twist: 'Twist',
};
const PERCENTS: ['bend' | 'horizontalDistortion' | 'verticalDistortion', string][] = [['bend', 'Bend'], ['horizontalDistortion', 'H distortion'], ['verticalDistortion', 'V distortion']];
const SPLITS: [WarpSplit, string][] = [['vertical', 'Split vertically'], ['horizontal', 'Split horizontally'], ['both', 'Split crosswise'], ['remove', 'Remove split']];

const LABELS: Record<NumericField, [string, string]> = {
  x: ['X', 'px'], y: ['Y', 'px'], w: ['W', '%'], h: ['H', '%'], angle: ['Angle', '°'], skewX: ['H skew', '°'], skewY: ['V skew', '°'],
};

// Shows the session value unless the field is being edited; every valid keystroke applies live.
function NumField({ label, unit, value, digits = 2, min, max, set, p }: {
  label: string; unit: string; value: number; digits?: number; min?: number; max?: number; set(v: number): void; p: Props;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label>
      {label}
      <input
        type="number" step={digits ? 0.1 : 1} min={min} max={max} aria-label={label} value={draft ?? value.toFixed(digits)}
        onFocus={e => setDraft(e.currentTarget.value)} onBlur={() => setDraft(null)}
        onChange={e => { setDraft(e.currentTarget.value); const v = e.currentTarget.valueAsNumber; if (Number.isFinite(v)) set(v); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); p.apply(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur(); p.cancel(); }
        }}
      />
      {unit}
    </label>
  );
}

// Style, orientation and the bend/distortion percentages for a preset style; grid and split mode for none/custom.
function WarpControls({ w, p }: { w: WarpBarState; p: Props }) {
  const { preset } = w, shaped = preset.style !== 'none' && preset.style !== 'custom';
  return (
    <>
      <label>
        Style
        <select aria-label="Warp style" value={preset.style} onChange={e => p.warpStyle(e.currentTarget.value as Style)}>
          {STYLES.map(st => <option key={st} value={st}>{STYLE_LABELS[st]}</option>)}
        </select>
      </label>
      <label>
        <select aria-label="Warp orientation" disabled={!shaped} value={preset.orientation}
          onChange={e => p.warpPreset({ orientation: e.currentTarget.value as Preset['orientation'] })}>
          <option value="horizontal">Horizontal</option>
          <option value="vertical">Vertical</option>
        </select>
      </label>
      {shaped ? PERCENTS.map(([k, label]) => (
        <NumField key={k} label={label} unit="%" digits={0} min={-100} max={100} value={preset[k] * 100}
          set={v => p.warpPreset({ [k]: Math.max(-1, Math.min(1, v / 100)) })} p={p} />
      )) : (
        <>
          <label>
            Grid
            <select aria-label="Warp grid" value={w.grid} onChange={e => p.warpGrid(Number(e.currentTarget.value))}>
              <option value="1">Default</option>
              {[3, 4, 5].map(n => <option key={n} value={String(n)}>{`${n} × ${n}`}</option>)}
              <option value="custom" disabled>Custom</option>
            </select>
          </label>
          {SPLITS.map(([m, label]) => (
            <button key={m} type="button" aria-pressed={w.split === m} onClick={() => p.warpSplit(m)}>{label}</button>
          ))}
        </>
      )}
    </>
  );
}

export function TransformBar(p: Props) {
  const s = useSyncExternalStore(p.store.subscribe, p.store.get);
  const field = (f: NumericField) => {
    const [label, unit] = LABELS[f];
    return <NumField key={f} label={label} unit={unit} value={s.values[NUMERIC_FIELDS.indexOf(f)]} set={v => p.setNumeric(f, v)} p={p} />;
  };
  const mode = (
    <label>
      <select aria-label="Transform mode" value={s.mode} onChange={e => p.setMode(e.currentTarget.value as Mode)}>
        {MODES.map(([m, l]) => <option key={m} value={m} disabled={!!s.warp && m !== 'warp'}>{l}</option>)}
      </select>
    </label>
  );
  const end = (
    <>
      <button type="button" onClick={p.cancel}>Cancel</button>
      <button type="button" className="primary" onClick={p.apply}>Apply</button>
    </>
  );
  if (s.warp) return (
    <div className="options-bar transform-bar" role="toolbar" aria-label="Transform options">
      {mode}
      <WarpControls w={s.warp} p={p} />
      {end}
    </div>
  );
  return (
    <div className="options-bar transform-bar" role="toolbar" aria-label="Transform options">
      {mode}
      <label className="opt-bool"><input type="checkbox" checked={s.snap} onChange={e => p.setSnap(e.currentTarget.checked)} />Snap</label>
      <div className="ref-grid" role="group" aria-label="Reference point">
        {[0, 0.5, 1].flatMap(v => [0, 0.5, 1].map(u => (
          <button key={`${u},${v}`} type="button" aria-label={`Reference ${u},${v}`} onClick={() => p.setReference(u, v)} />
        )))}
      </div>
      {field('x')}
      {field('y')}
      {field('w')}
      <button type="button" className="link-toggle" aria-pressed={s.linked} title="Keep width and height proportional" onClick={() => p.setLinked(!s.linked)}>
        {s.linked ? <Link size={14} /> : <Unlink size={14} />}
      </button>
      {field('h')}
      {field('angle')}
      {field('skewX')}
      {field('skewY')}
      {end}
    </div>
  );
}
