import { useState } from 'react';
import { RotateCcw, ArrowLeftRight } from 'lucide-react';
import { hsbToRgb, rgbToHex, rgbToHsb, type Rgb } from './color.ts';
import { HueStrip, SbField } from './ColorField.tsx';

interface Props { fg: Rgb; bg: Rgb; setFg: (rgb: Rgb) => void; setBg: (rgb: Rgb) => void; swap: () => void; reset: () => void }

export function ColorPanel({ fg, bg, setFg, setBg, swap, reset }: Props) {
  const [editing, setEditing] = useState<'fg' | 'bg'>('fg');
  const current = editing === 'fg' ? fg : bg;
  const setCurrent = editing === 'fg' ? setFg : setBg;
  const [h, s, b] = rgbToHsb(current);

  return (
    <div className="color-panel">
      <div className="color-wells">
        <button
          className={`well fg${editing === 'fg' ? ' active' : ''}`} aria-label="Foreground color" aria-pressed={editing === 'fg'}
          style={{ background: rgbToHex(fg) }} onClick={() => setEditing('fg')}
        />
        <button
          className={`well bg${editing === 'bg' ? ' active' : ''}`} aria-label="Background color" aria-pressed={editing === 'bg'}
          style={{ background: rgbToHex(bg) }} onClick={() => setEditing('bg')}
        />
        <button aria-label="Swap colors" title="Swap colors (X)" onClick={swap}><ArrowLeftRight size={14} strokeWidth={1.75} /></button>
        <button aria-label="Reset to black and white" title="Reset to default (D)" onClick={reset}><RotateCcw size={14} strokeWidth={1.75} /></button>
      </div>
      <div className="color-body">
        <SbField h={h} s={s} b={b} onChange={(ns, nb) => setCurrent(hsbToRgb([h, ns, nb]))} />
        <HueStrip h={h} onChange={nh => setCurrent(hsbToRgb([nh, s, b]))} />
      </div>
    </div>
  );
}
