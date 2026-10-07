import { useRef } from 'react';
import { t } from '@lingui/core/macro';
import { hsbToRgb, rgbToHex, type Rgb } from './color.ts';

interface Props { h: number; s: number; b: number; onChange: (s: number, b: number) => void }

// Saturation (x) / brightness (y) field for a fixed hue; pointer and arrow keys both move the marker.
export function SbField({ h, s, b, onChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const fromEvent = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    onChange(x * 100, (1 - y) * 100);
  };
  const drag = (e: React.PointerEvent) => {
    fromEvent(e);
    const move = (ev: PointerEvent) => fromEvent(ev);
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };
  const step = (dx: number, dy: number) => onChange(Math.min(100, Math.max(0, s + dx)), Math.min(100, Math.max(0, b + dy)));
  const sRound = Math.round(s);
  const bRound = Math.round(b);
  const pureHue: Rgb = hsbToRgb([h, 100, 100]);
  return (
    <div
      ref={ref} className="sb-field" role="slider" tabIndex={0} aria-label={t`Saturation and brightness`}
      aria-valuetext={t`S ${sRound} B ${bRound}`}
      style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${rgbToHex(pureHue)})` }}
      onPointerDown={drag}
      onKeyDown={e => {
        if (e.key === 'ArrowLeft') step(-1, 0);
        else if (e.key === 'ArrowRight') step(1, 0);
        else if (e.key === 'ArrowUp') step(0, 1);
        else if (e.key === 'ArrowDown') step(0, -1);
        else return;
        e.preventDefault();
      }}
    >
      <div className="sb-marker" style={{ left: `${s}%`, top: `${100 - b}%` }} />
    </div>
  );
}

// Vertical hue strip, 0-360 degrees top to bottom.
export function HueStrip({ h, onChange }: { h: number; onChange: (h: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const fromEvent = (e: { clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    onChange(y * 360);
  };
  const drag = (e: React.PointerEvent) => {
    fromEvent(e);
    const move = (ev: PointerEvent) => fromEvent(ev);
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };
  return (
    <div
      ref={ref} className="hue-strip" role="slider" tabIndex={0} aria-label={t`Hue`}
      aria-valuenow={Math.round(h)} aria-valuemin={0} aria-valuemax={360}
      onPointerDown={drag}
      onKeyDown={e => {
        if (e.key === 'ArrowUp') onChange(Math.max(0, h - 1));
        else if (e.key === 'ArrowDown') onChange(Math.min(360, h + 1));
        else return;
        e.preventDefault();
      }}
    >
      <div className="hue-marker" style={{ top: `${(h / 360) * 100}%` }} />
    </div>
  );
}
