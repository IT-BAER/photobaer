import { useEffect, useState } from 'react';
import { RotateCcw, ArrowLeftRight } from 'lucide-react';
import { msg, t } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { i18n } from '../i18n/index.ts';
import { hsbToRgb, rgbToHex, rgbToHsb, type Rgb } from './color.ts';
import { HueStrip, SbField } from './ColorField.tsx';
import { SLIDERS, defaultSliders, rgbOfSliders, slidersOf, type Convert, type Sliders } from './colorModes.ts';

interface Props {
  fg: Rgb; bg: Rgb; setFg: (rgb: Rgb) => void; setBg: (rgb: Rgb) => void; swap: () => void; reset: () => void;
  doc: { gray: boolean; mode: { kind: string } | null } | null; convert: Convert;
}

const SLIDER_NAMES: [Sliders, MessageDescriptor][] = [
  ['gray', msg`Grayscale Sliders`], ['rgb', msg`RGB Sliders`], ['cmyk', msg`CMYK Sliders`], ['lab', msg`Lab Sliders`],
];

export function ColorPanel({ fg, bg, setFg, setBg, swap, reset, doc, convert }: Props) {
  const [editing, setEditing] = useState<'fg' | 'bg'>('fg');
  const current = editing === 'fg' ? fg : bg;
  const setCurrent = editing === 'fg' ? setFg : setBg;
  const [h, s, b] = rgbToHsb(current);
  // The slider set follows the document's mode until the user picks one.
  const docKind = defaultSliders(doc);
  const [picked, setPicked] = useState<Sliders | null>(null);
  const kind = picked ?? docKind;
  const grayDoc = !!doc?.gray && !doc.mode;
  const [values, setValues] = useState<number[] | null>(null);
  useEffect(() => {
    let live = true;
    slidersOf(current, kind, grayDoc, convert).then(v => { if (live) setValues(v); }, () => { if (live) setValues(null); });
    return () => { live = false; };
  }, [current, kind, grayDoc, convert]);
  const setSlider = (i: number, v: number) => {
    if (!values) return;
    const next = values.map((x, k) => (k === i ? v : x));
    setValues(next);
    rgbOfSliders(next, kind, grayDoc, convert).then(setCurrent, () => {});
  };

  return (
    <div className="color-panel">
      <div className="color-wells">
        <button
          className={`well fg${editing === 'fg' ? ' active' : ''}`} aria-label={t`Foreground color`} aria-pressed={editing === 'fg'}
          style={{ background: rgbToHex(fg) }} onClick={() => setEditing('fg')}
        />
        <button
          className={`well bg${editing === 'bg' ? ' active' : ''}`} aria-label={t`Background color`} aria-pressed={editing === 'bg'}
          style={{ background: rgbToHex(bg) }} onClick={() => setEditing('bg')}
        />
        <button aria-label={t`Swap colors`} title={t`Swap colors (X)`} onClick={swap}><ArrowLeftRight size={14} strokeWidth={1.75} /></button>
        <button aria-label={t`Reset to black and white`} title={t`Reset to default (D)`} onClick={reset}><RotateCcw size={14} strokeWidth={1.75} /></button>
        <select className="color-sliders-kind" aria-label={t`Color sliders`} value={kind} onChange={e => setPicked(e.currentTarget.value as Sliders)}>
          {SLIDER_NAMES.map(([k, name]) => <option key={k} value={k}>{i18n._(name)}</option>)}
        </select>
      </div>
      <div className="color-body">
        <SbField h={h} s={s} b={b} onChange={(ns, nb) => setCurrent(hsbToRgb([h, ns, nb]))} />
        <HueStrip h={h} onChange={nh => setCurrent(hsbToRgb([nh, s, b]))} />
      </div>
      {values && (
        <div className="color-sliders">
          {SLIDERS[kind].map((d, i) => (
            <label key={d.label}>
              <span>{d.label}</span>
              <input type="range" min={d.min} max={d.max} step={1} value={Math.round(values[i])} aria-label={d.label} onChange={e => setSlider(i, Number(e.currentTarget.value))} />
              <output>{Math.round(values[i])}{kind === 'cmyk' || kind === 'gray' ? '%' : ''}</output>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
