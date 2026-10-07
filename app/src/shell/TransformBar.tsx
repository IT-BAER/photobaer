import { useSyncExternalStore } from 'react';
import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { i18n } from '../i18n/index.ts';
import { NumberInput } from './NumberInput.tsx';
import { Link, Unlink } from 'lucide-react';
import { NUMERIC_FIELDS, type Mode, type NumericField } from '../transform/session.ts';
import { STYLES, type Preset, type SplitMode, type Style } from '../transform/warp.ts';

export const MODES: [Mode, MessageDescriptor][] = [['free', msg`Free Transform`], ['scale', msg`Scale`], ['rotate', msg`Rotate`], ['skew', msg`Skew`], ['distort', msg`Distort`], ['perspective', msg`Perspective`], ['warp', msg`Warp`]];
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

const STYLE_LABELS: Record<Style, MessageDescriptor> = {
  none: msg`None`, custom: msg`Custom`, arc: msg`Arc`, arcLower: msg`Lower Arc`, arcUpper: msg`Upper Arc`, arch: msg`Arch`, bulge: msg`Bulge`,
  shellLower: msg`Lower Shell`, shellUpper: msg`Upper Shell`, flag: msg`Flag`, wave: msg`Wave`, fish: msg`Fish`, rise: msg`Rise`,
  fisheye: msg`Fisheye`, inflate: msg`Inflate`, squeeze: msg`Squeeze`, twist: msg`Twist`,
};
const PERCENTS: ['bend' | 'horizontalDistortion' | 'verticalDistortion', MessageDescriptor][] = [['bend', msg`Bend`], ['horizontalDistortion', msg`H distortion`], ['verticalDistortion', msg`V distortion`]];
const SPLITS: [WarpSplit, MessageDescriptor][] = [['vertical', msg`Split vertically`], ['horizontal', msg`Split horizontally`], ['both', msg`Split crosswise`], ['remove', msg`Remove split`]];

const LABELS: Record<NumericField, [MessageDescriptor, string]> = {
  x: [msg`X`, 'px'], y: [msg`Y`, 'px'], w: [msg({ message: 'W', context: 'width' }), '%'], h: [msg({ message: 'H', context: 'height' }), '%'],
  angle: [msg`Angle`, '°'], skewX: [msg`H skew`, '°'], skewY: [msg`V skew`, '°'],
};

// Shows the session value unless the field is being edited; every valid keystroke applies live.
function NumField({ label, unit, value, digits = 2, min, max, set, p }: {
  label: string; unit: string; value: number; digits?: number; min?: number; max?: number; set(v: number): void; p: Props;
}) {
  return (
    <label>
      {label}
      <NumberInput
        step={digits ? 0.1 : 1} min={min} max={max} aria-label={label} value={Number(value.toFixed(digits))}
        onValue={set}
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
        <Trans>Style</Trans>
        <select aria-label={t`Warp style`} value={preset.style} onChange={e => p.warpStyle(e.currentTarget.value as Style)}>
          {STYLES.map(st => <option key={st} value={st}>{i18n._(STYLE_LABELS[st])}</option>)}
        </select>
      </label>
      <label>
        <select aria-label={t`Warp orientation`} disabled={!shaped} value={preset.orientation}
          onChange={e => p.warpPreset({ orientation: e.currentTarget.value as Preset['orientation'] })}>
          <option value="horizontal">{t`Horizontal`}</option>
          <option value="vertical">{t`Vertical`}</option>
        </select>
      </label>
      {shaped ? PERCENTS.map(([k, label]) => (
        <NumField key={k} label={i18n._(label)} unit="%" digits={0} min={-100} max={100} value={preset[k] * 100}
          set={v => p.warpPreset({ [k]: Math.max(-1, Math.min(1, v / 100)) })} p={p} />
      )) : (
        <>
          <label>
            <Trans>Grid</Trans>
            <select aria-label={t`Warp grid`} value={w.grid} onChange={e => p.warpGrid(Number(e.currentTarget.value))}>
              <option value="1">{t`Default`}</option>
              {[3, 4, 5].map(n => <option key={n} value={String(n)}>{`${n} × ${n}`}</option>)}
              <option value="custom" disabled>{t`Custom`}</option>
            </select>
          </label>
          {SPLITS.map(([m, label]) => (
            <button key={m} type="button" aria-pressed={w.split === m} onClick={() => p.warpSplit(m)}>{i18n._(label)}</button>
          ))}
        </>
      )}
    </>
  );
}

const referenceLabel = (u: number, v: number) => t`Reference ${u},${v}`;

export function TransformBar(p: Props) {
  const s = useSyncExternalStore(p.store.subscribe, p.store.get);
  const field = (f: NumericField) => {
    const [label, unit] = LABELS[f];
    return <NumField key={f} label={i18n._(label)} unit={unit} value={s.values[NUMERIC_FIELDS.indexOf(f)]} set={v => p.setNumeric(f, v)} p={p} />;
  };
  const mode = (
    <label>
      <select aria-label={t`Transform mode`} value={s.mode} onChange={e => p.setMode(e.currentTarget.value as Mode)}>
        {MODES.map(([m, l]) => <option key={m} value={m} disabled={!!s.warp && m !== 'warp'}>{i18n._(l)}</option>)}
      </select>
    </label>
  );
  const end = (
    <>
      <button type="button" onClick={p.cancel}><Trans>Cancel</Trans></button>
      <button type="button" className="primary" onClick={p.apply}><Trans>Apply</Trans></button>
    </>
  );
  if (s.warp) return (
    <div className="options-bar transform-bar" role="toolbar" aria-label={t`Transform options`}>
      {mode}
      <WarpControls w={s.warp} p={p} />
      {end}
    </div>
  );
  return (
    <div className="options-bar transform-bar" role="toolbar" aria-label={t`Transform options`}>
      {mode}
      <label className="opt-bool"><input type="checkbox" checked={s.snap} onChange={e => p.setSnap(e.currentTarget.checked)} /><Trans>Snap</Trans></label>
      <div className="ref-grid" role="group" aria-label={t`Reference point`}>
        {[0, 0.5, 1].flatMap(v => [0, 0.5, 1].map(u => (
          <button key={`${u},${v}`} type="button" aria-label={referenceLabel(u, v)} onClick={() => p.setReference(u, v)} />
        )))}
      </div>
      {field('x')}
      {field('y')}
      {field('w')}
      <button type="button" className="link-toggle" aria-pressed={s.linked} title={t`Keep width and height proportional`} onClick={() => p.setLinked(!s.linked)}>
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
