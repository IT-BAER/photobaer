// Shear curve editor: y runs down the side, the offset across, the center line is 0. Drag a point to
// move it, click empty space to add one, drag it off the box to remove it (two points stay).
import { useEffect, useRef } from 'react';
import { t } from '@lingui/core/macro';
import type { CurvePoint } from './lastFilter.ts';

const SIZE = 160;
const HIT = 7;
const MAX_POINTS = 16;

const toPx = (p: CurvePoint) => [((p.offset + 1) / 2) * SIZE, p.y * SIZE];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function ShearCurve({ value, onChange }: { value: CurvePoint[]; onChange: (v: CurvePoint[]) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef(-1);

  useEffect(() => {
    const g = canvas.current?.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, SIZE, SIZE);
    g.strokeStyle = '#888';
    g.beginPath();
    g.moveTo(SIZE / 2, 0);
    g.lineTo(SIZE / 2, SIZE);
    g.stroke();
    g.strokeStyle = '#4af';
    g.beginPath();
    value.forEach((p, i) => (i ? g.lineTo(...(toPx(p) as [number, number])) : g.moveTo(...(toPx(p) as [number, number]))));
    g.stroke();
    g.fillStyle = '#fff';
    value.forEach(p => { const [x, y] = toPx(p); g.fillRect(x - 3, y - 3, 6, 6); });
  }, [value]);

  const at = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * SIZE, ((e.clientY - r.top) / r.height) * SIZE];
  };
  const point = (x: number, y: number): CurvePoint => ({ y: clamp(y / SIZE, 0, 1), offset: clamp((x / SIZE) * 2 - 1, -1, 1) });

  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    const [x, y] = at(e);
    let i = value.findIndex(p => Math.hypot(toPx(p)[0] - x, toPx(p)[1] - y) <= HIT);
    if (i < 0) {
      if (value.length >= MAX_POINTS) return;
      const n = point(x, y);
      i = value.filter(p => p.y <= n.y).length;
      onChange([...value.slice(0, i), n, ...value.slice(i)]);
    }
    drag.current = i;
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    const i = drag.current;
    if (i < 0) return;
    const [x, y] = at(e);
    if ((x < 0 || x > SIZE || y < 0 || y > SIZE) && value.length > 2) {
      drag.current = -1;
      onChange(value.filter((_, k) => k !== i));
      return;
    }
    const n = point(x, y);
    const lo = i > 0 ? value[i - 1].y : 0;
    const hi = i < value.length - 1 ? value[i + 1].y : 1;
    onChange(value.map((p, k) => (k === i ? { y: clamp(n.y, lo, hi), offset: n.offset } : p)));
  }

  return (
    <canvas ref={canvas} className="shear-curve" width={SIZE} height={SIZE} aria-label={t`Shear curve`}
      onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = -1; }} onPointerCancel={() => { drag.current = -1; }} />
  );
}
