import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { TriangleAlert } from 'lucide-react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { hexToRgb, hsbToRgb, intensityOf, isWebSafe, labToRgb, rgbToHex, rgbToHsb, rgbToLab, snapWebSafe, withIntensity, type Rgb } from './color.ts';
import { HueStrip, SbField } from './ColorField.tsx';
import { rgbOfSliders, slidersOf, type Convert } from './colorModes.ts';
import { NumberInput } from './NumberInput.tsx';

// `hdr` (a 32-bit document) adds the Intensity slider in stops; the committed color carries it (`intensityOf`).
export interface ColorPickerHandle { open(rgb: Rgb, title: string, commit: (rgb: Rgb) => void, opts?: { hdr?: boolean }): void }

// A numeric field bound to one channel of an [a, b, c] tuple, committed on blur/Enter.
function Field({ label, value, min, max, onCommit }: { label: string; value: number; min: number; max: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="color-field">
      {label}
      <input
        type="number" min={min} max={max} value={draft ?? Math.round(value)}
        onChange={e => setDraft(e.currentTarget.value)}
        onBlur={() => { const v = Number(draft); setDraft(null); if (draft !== null && Number.isFinite(v)) onCommit(Math.min(max, Math.max(min, v))); }}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
    </label>
  );
}

// `convert` gives the C, M, Y, K fields (working or document CMYK); without it they are not shown.
export function ColorPicker({ ref, convert }: { ref: Ref<ColorPickerHandle>; convert?: Convert }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(t`Color Picker`);
  const [rgb, setRgb] = useState<Rgb>([0, 0, 0]);
  const original = useRef<Rgb>([0, 0, 0]);
  const commit = useRef<(rgb: Rgb) => void>(() => {});
  const [hdr, setHdr] = useState(false);
  const [stops, setStops] = useState(0);

  useImperativeHandle(ref, () => ({
    open(initial, heading, onCommit, opts) {
      original.current = initial;
      commit.current = onCommit;
      setTitle(heading);
      setRgb(initial);
      setHdr(!!opts?.hdr);
      setStops(opts?.hdr ? intensityOf(initial) : 0);
      dialog.current?.showModal();
    },
  }));

  const [cmyk, setCmyk] = useState<number[] | null>(null);
  useEffect(() => {
    let live = true;
    if (convert) slidersOf(rgb, 'cmyk', false, convert).then(v => { if (live) setCmyk(v); }, () => { if (live) setCmyk(null); });
    return () => { live = false; };
  }, [rgb, convert]);

  const apply = (next: Rgb, s = stops) => { setRgb(next); setStops(s); commit.current(hdr ? withIntensity(next, s) : next); };
  const applyCmyk = (i: number, v: number) => {
    if (!cmyk || !convert) return;
    rgbOfSliders(cmyk.map((x, k) => (k === i ? v : x)), 'cmyk', false, convert).then(apply, () => {});
  };
  const [h, s, b] = rgbToHsb(rgb);
  const [l, a, bb] = rgbToLab(rgb);
  const websafe = isWebSafe(rgb);
  const revert = () => apply(original.current, hdr ? intensityOf(original.current) : 0);

  return (
    <dialog ref={dialog} className="color-picker" onCancel={revert}>
      <h2>{title}</h2>
      <div className="picker-body">
        <SbField h={h} s={s} b={b} onChange={(ns, nb) => apply(hsbToRgb([h, ns, nb]))} />
        <HueStrip h={h} onChange={nh => apply(hsbToRgb([nh, s, b]))} />
        <div className="picker-preview">
          <div className="swatch-preview" style={{ background: rgbToHex(rgb) }} title={t`New`} />
          <div className="swatch-preview" style={{ background: rgbToHex(original.current) }} title={t`Original`} />
          {!websafe && (
            <button type="button" className="websafe-warning" title={t`Not web-safe: click to snap`} onClick={() => apply(snapWebSafe(rgb))}>
              <TriangleAlert size={16} strokeWidth={1.75} />
            </button>
          )}
        </div>
      </div>
      <div className="picker-fields">
        <Field label={t({ message: 'H', context: 'color picker hue field' })} value={h} min={0} max={360} onCommit={v => apply(hsbToRgb([v, s, b]))} />
        <Field label={t({ message: 'S', context: 'color picker saturation field' })} value={s} min={0} max={100} onCommit={v => apply(hsbToRgb([h, v, b]))} />
        <Field label={t({ message: 'B', context: 'color picker brightness field' })} value={b} min={0} max={100} onCommit={v => apply(hsbToRgb([h, s, v]))} />
        <label className="color-field hex">
          #
          <input
            defaultValue={rgbToHex(rgb).slice(1)} key={rgbToHex(rgb)}
            onBlur={e => { const v = hexToRgb(e.currentTarget.value); if (v) apply(v); }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          />
        </label>
        <Field label={t({ message: 'R', context: 'color picker red field' })} value={rgb[0]} min={0} max={255} onCommit={v => apply([v, rgb[1], rgb[2]])} />
        <Field label={t({ message: 'G', context: 'color picker green field' })} value={rgb[1]} min={0} max={255} onCommit={v => apply([rgb[0], v, rgb[2]])} />
        <Field label={t({ message: 'B', context: 'color picker blue field' })} value={rgb[2]} min={0} max={255} onCommit={v => apply([rgb[0], rgb[1], v])} />
        <span />
        <Field label="L" value={l} min={0} max={100} onCommit={v => apply(labToRgb([v, a, bb]))} />
        <Field label="a" value={a} min={-128} max={127} onCommit={v => apply(labToRgb([l, v, bb]))} />
        <Field label="b" value={bb} min={-128} max={127} onCommit={v => apply(labToRgb([l, a, v]))} />
        <span />
        {cmyk && ['C', 'M', 'Y', 'K'].map((label, i) => (
          <Field key={label} label={label} value={cmyk[i]} min={0} max={100} onCommit={v => applyCmyk(i, v)} />
        ))}
      </div>
      {hdr && (
        <label className="color-intensity">
          <Trans>Intensity</Trans>
          <input type="range" min={-20} max={20} step={0.01} value={stops} onChange={e => apply(rgb, Number(e.currentTarget.value))} />
          <NumberInput min={-20} max={20} step={0.01} value={stops} aria-label={t`Intensity stops`}
            onValue={v => apply(rgb, Math.min(20, Math.max(-20, v)))} />
        </label>
      )}
      <div className="actions">
        <button type="button" onClick={() => { revert(); dialog.current?.close(); }}><Trans>Cancel</Trans></button>
        <button type="button" className="primary" onClick={() => dialog.current?.close()}><Trans>OK</Trans></button>
      </div>
    </dialog>
  );
}
