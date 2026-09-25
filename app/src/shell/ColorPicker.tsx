import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { TriangleAlert } from 'lucide-react';
import { hexToRgb, hsbToRgb, isWebSafe, labToRgb, rgbToHex, rgbToHsb, rgbToLab, snapWebSafe, type Rgb } from './color.ts';
import { HueStrip, SbField } from './ColorField.tsx';

export interface ColorPickerHandle { open(rgb: Rgb, title: string, commit: (rgb: Rgb) => void): void }

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

export function ColorPicker({ ref }: { ref: Ref<ColorPickerHandle> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState('Color Picker');
  const [rgb, setRgb] = useState<Rgb>([0, 0, 0]);
  const original = useRef<Rgb>([0, 0, 0]);
  const commit = useRef<(rgb: Rgb) => void>(() => {});

  useImperativeHandle(ref, () => ({
    open(initial, t, onCommit) {
      original.current = initial;
      commit.current = onCommit;
      setTitle(t);
      setRgb(initial);
      dialog.current?.showModal();
    },
  }));

  const apply = (next: Rgb) => { setRgb(next); commit.current(next); };
  const [h, s, b] = rgbToHsb(rgb);
  const [l, a, bb] = rgbToLab(rgb);
  const websafe = isWebSafe(rgb);
  const revert = () => apply(original.current);

  return (
    <dialog ref={dialog} className="color-picker" onCancel={revert}>
      <h2>{title}</h2>
      <div className="picker-body">
        <SbField h={h} s={s} b={b} onChange={(ns, nb) => apply(hsbToRgb([h, ns, nb]))} />
        <HueStrip h={h} onChange={nh => apply(hsbToRgb([nh, s, b]))} />
        <div className="picker-preview">
          <div className="swatch-preview" style={{ background: rgbToHex(rgb) }} title="New" />
          <div className="swatch-preview" style={{ background: rgbToHex(original.current) }} title="Original" />
          {!websafe && (
            <button type="button" className="websafe-warning" title="Not web-safe: click to snap" onClick={() => apply(snapWebSafe(rgb))}>
              <TriangleAlert size={16} strokeWidth={1.75} />
            </button>
          )}
        </div>
      </div>
      <div className="picker-fields">
        <Field label="H" value={h} min={0} max={360} onCommit={v => apply(hsbToRgb([v, s, b]))} />
        <Field label="S" value={s} min={0} max={100} onCommit={v => apply(hsbToRgb([h, v, b]))} />
        <Field label="B" value={b} min={0} max={100} onCommit={v => apply(hsbToRgb([h, s, v]))} />
        <Field label="R" value={rgb[0]} min={0} max={255} onCommit={v => apply([v, rgb[1], rgb[2]])} />
        <Field label="G" value={rgb[1]} min={0} max={255} onCommit={v => apply([rgb[0], v, rgb[2]])} />
        <Field label="B" value={rgb[2]} min={0} max={255} onCommit={v => apply([rgb[0], rgb[1], v])} />
        <Field label="L" value={l} min={0} max={100} onCommit={v => apply(labToRgb([v, a, bb]))} />
        <Field label="a" value={a} min={-128} max={127} onCommit={v => apply(labToRgb([l, v, bb]))} />
        <Field label="b" value={bb} min={-128} max={127} onCommit={v => apply(labToRgb([l, a, v]))} />
        <label className="color-field hex">
          #
          <input
            defaultValue={rgbToHex(rgb).slice(1)} key={rgbToHex(rgb)}
            onBlur={e => { const v = hexToRgb(e.currentTarget.value); if (v) apply(v); }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          />
        </label>
      </div>
      <div className="actions">
        <button type="button" onClick={() => { revert(); dialog.current?.close(); }}>Cancel</button>
        <button type="button" className="primary" onClick={() => dialog.current?.close()}>OK</button>
      </div>
    </dialog>
  );
}
