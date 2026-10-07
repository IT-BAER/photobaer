// Image > Analysis: Set Measurement Scale, Select Data Points and Place Scale Marker.
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { i18n } from './i18n/index.ts';
import { DATA_POINTS, DEFAULT_SCALE, markerRect, type MeasureScale } from './app/analysis.ts';
import { columnTitle, LOG_COLUMNS, type Annotations, type MeasureRow } from './app/measure.ts';
import { newText } from './shell/typesession.ts';
import type { TextJson } from './psd/text.ts';

export type AnalysisKind = 'scale' | 'points' | 'marker';
export interface AnalysisDialogHandle { open(kind: AnalysisKind): void }

interface Props {
  ref: Ref<AnalysisDialogHandle>; annotations: Annotations | null; size: [number, number] | null; rulerLength: number | null;
  points: (keyof MeasureRow)[]; setPoints: (p: (keyof MeasureRow)[]) => void;
  commit: (a: Annotations, label: string) => void;
  placeMarker: (rect: { x: number; y: number; w: number; h: number }, color: [number, number, number], text: TextJson | null) => void;
}

const TITLES: Record<AnalysisKind, MessageDescriptor> = { scale: msg`Measurement Scale`, points: msg`Select Data Points`, marker: msg`Measurement Scale Marker` };
const num = (s: string) => Number(s.replace(',', '.'));

export function AnalysisDialogs({ ref, annotations, size, rulerLength, points, setPoints, commit, placeMarker }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<AnalysisKind | null>(null);
  const [pixels, setPixels] = useState('1');
  const [logical, setLogical] = useState('1');
  const [units, setUnits] = useState('px');
  const [chosen, setChosen] = useState<Set<keyof MeasureRow>>(new Set());
  const [length, setLength] = useState('1');
  const [thickness, setThickness] = useState('4');
  const [fontSize, setFontSize] = useState('12');
  const [showText, setShowText] = useState(true);
  const [color, setColor] = useState<'black' | 'white'>('black');
  const scale = annotations?.scale ?? DEFAULT_SCALE;

  useImperativeHandle(ref, () => ({
    open(next) {
      setKind(next);
      if (next === 'scale') {
        setPixels(String(rulerLength !== null ? Math.round(rulerLength * 1000) / 1000 : scale.pixels));
        setLogical(String(scale.logical));
        setUnits(scale.units);
      } else if (next === 'points') setChosen(new Set(points));
      else setLength(String(scale.logical));
      dialog.current?.showModal();
    },
  }));

  const close = () => dialog.current?.close();
  const scaleOk = num(pixels) > 0 && num(logical) > 0 && Number.isFinite(num(pixels) + num(logical)) && units.trim() !== ''
    && new TextEncoder().encode(units.trim()).length <= 64;
  // The bar must be at least 1 px and fit the canvas unclipped, so its label stays true.
  const wantPx = Math.round(num(length) * scale.pixels / scale.logical);
  const rect = size && Number.isFinite(wantPx) ? markerRect(size[0], size[1], wantPx, Math.max(1, Math.round(num(thickness)))) : null;
  const fits = !!rect && rect.w >= 1 && rect.w === wantPx;
  const markerOk = num(length) > 0 && num(thickness) >= 1 && num(fontSize) > 0 && Number.isFinite(num(length) + num(thickness) + num(fontSize)) && fits;

  const scalePx = scale.pixels, scaleLogical = scale.logical, scaleUnits = scale.units;
  const maxBar = size ? size[0] - 2 * Math.round(size[0] * 0.05) : 0;
  const scaleNote = num(length) > 0 && !fits
    ? t`Scale: ${scalePx} px = ${scaleLogical} ${scaleUnits} (the bar must be 1 to ${maxBar} px wide)`
    : t`Scale: ${scalePx} px = ${scaleLogical} ${scaleUnits}`;

  const submit = () => {
    if (kind === 'scale' && scaleOk && annotations) {
      const s: MeasureScale = { pixels: num(pixels), logical: num(logical), units: units.trim() };
      commit({ ...annotations, scale: s }, 'Set Measurement Scale');
    } else if (kind === 'points') setPoints(DATA_POINTS.filter(k => chosen.has(k)));
    else if (kind === 'marker' && markerOk && rect) {
      const r = rect;
      const rgb: [number, number, number] = color === 'black' ? [0, 0, 0] : [255, 255, 255];
      const label = `${num(length)} ${scale.units}`;
      const t0 = newText({ family: 'Noto Sans', style: 'Regular', size: num(fontSize), color: rgb, alignment: 'left', orientation: 'horizontal' }, { type: 'point' }, [r.x, r.y - 4]);
      const text = showText ? { ...t0, text: label, runs: [{ ...t0.runs[0], length: label.length }], paragraphs: [{ ...t0.paragraphs[0], length: label.length }] } : null;
      placeMarker(r, rgb, text);
    } else return;
    close();
  };

  const field = (label: string, value: string, set: (v: string) => void, extra?: string) =>
    <label>{label} <input type="text" inputMode="decimal" value={value} onChange={e => set(e.currentTarget.value)} />{extra && ` ${extra}`}</label>;

  return (
    <dialog ref={dialog} className="mode-dialog" aria-label={kind ? i18n._(TITLES[kind]) : t`Analysis`} onClose={() => setKind(null)}>
      <form onSubmit={e => { e.preventDefault(); submit(); }}>
        <h2>{kind && i18n._(TITLES[kind])}</h2>
        {kind === 'scale' && <>
          {field(t`Pixel Length:`, pixels, setPixels, 'px')}
          {field(t`Logical Length:`, logical, setLogical)}
          <label><Trans>Logical Units:</Trans> <input type="text" maxLength={64} value={units} onChange={e => setUnits(e.currentTarget.value)} /></label>
          <p className="panel-empty">{rulerLength !== null ? t`Pixel length comes from the ruler line.` : t`Draw a ruler line first to measure a known length.`}</p>
        </>}
        {kind === 'points' && <fieldset><legend><Trans>Data points</Trans></legend>
          {LOG_COLUMNS.filter(([k]) => DATA_POINTS.includes(k)).map(([k, label]) => <label key={k}><input type="checkbox" checked={chosen.has(k)} onChange={e => {
            const on = e.currentTarget.checked;
            setChosen(c => { const n = new Set(c); if (on) n.add(k); else n.delete(k); return n; });
          }} /> {columnTitle(k, label)}</label>)}
        </fieldset>}
        {kind === 'marker' && <>
          {field(t`Length:`, length, setLength, scale.units)}
          {field(t`Height:`, thickness, setThickness, 'px')}
          {field(t`Font Size:`, fontSize, setFontSize, 'pt')}
          <label><input type="checkbox" checked={showText} onChange={e => setShowText(e.currentTarget.checked)} /> <Trans>Display Text</Trans></label>
          <label><Trans>Color</Trans> <select value={color} onChange={e => setColor(e.currentTarget.value as 'black' | 'white')}>
            <option value="black">{t`Black`}</option><option value="white">{t`White`}</option>
          </select></label>
          <p className="panel-empty">{scaleNote}</p>
        </>}
        <div className="actions">
          {kind === 'scale' && <button type="button" disabled={!annotations?.scale} onClick={() => {
            if (annotations) { const { scale: _, ...rest } = annotations; commit(rest, 'Set Measurement Scale'); }
            close();
          }}><Trans>Default</Trans></button>}
          <button type="button" onClick={close}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary" disabled={kind === 'scale' ? !scaleOk : kind === 'marker' ? !markerOk : false}><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}
