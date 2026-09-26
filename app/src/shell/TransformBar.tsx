import { useState, useSyncExternalStore } from 'react';
import { Link, Unlink } from 'lucide-react';
import { NUMERIC_FIELDS, type Mode, type NumericField } from '../transform/session.ts';

export const MODES: [Mode, string][] = [['free', 'Free Transform'], ['scale', 'Scale'], ['rotate', 'Rotate'], ['skew', 'Skew'], ['distort', 'Distort'], ['perspective', 'Perspective'], ['warp', 'Warp']];
export interface TransformBarState { mode: Mode; values: number[]; linked: boolean; snap: boolean }
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
}

const LABELS: Record<NumericField, [string, string]> = {
  x: ['X', 'px'], y: ['Y', 'px'], w: ['W', '%'], h: ['H', '%'], angle: ['Angle', '°'], skewX: ['H skew', '°'], skewY: ['V skew', '°'],
};

// Shows the session value unless the field is being edited; every valid keystroke applies live.
function NumField({ f, value, p }: { f: NumericField; value: number; p: Props }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [label, unit] = LABELS[f];
  return (
    <label>
      {label}
      <input
        type="number" step={0.1} aria-label={label} value={draft ?? value.toFixed(2)}
        onFocus={e => setDraft(e.currentTarget.value)} onBlur={() => setDraft(null)}
        onChange={e => { setDraft(e.currentTarget.value); const v = e.currentTarget.valueAsNumber; if (Number.isFinite(v)) p.setNumeric(f, v); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); p.apply(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur(); p.cancel(); }
        }}
      />
      {unit}
    </label>
  );
}

export function TransformBar(p: Props) {
  const s = useSyncExternalStore(p.store.subscribe, p.store.get);
  const field = (f: NumericField) => <NumField key={f} f={f} value={s.values[NUMERIC_FIELDS.indexOf(f)]} p={p} />;
  return (
    <div className="options-bar transform-bar" role="toolbar" aria-label="Transform options">
      <label>
        <select aria-label="Transform mode" value={s.mode} onChange={e => p.setMode(e.currentTarget.value as Mode)}>
          {MODES.map(([m, l]) => <option key={m} value={m} disabled={m === 'warp'}>{l}</option>)}
        </select>
      </label>
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
      <button type="button" onClick={p.cancel}>Cancel</button>
      <button type="button" className="primary" onClick={p.apply}>Apply</button>
    </div>
  );
}
