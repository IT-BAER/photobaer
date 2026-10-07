// Lighting Effects lights and the Flame path, edited on a small box that stands for the document:
// drag a light (circle) or its target (square), click empty space to add a path point, drag a point
// off the box to remove it.
import { useEffect, useRef, useState } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { ValueInput } from '../LevelsCurvesBody.tsx';
import type { Light, PathPoint } from './lastFilter.ts';

const W = 200;
const H = 150;
const HIT = 7;
const MAX_LIGHTS = 16;
const MAX_POINTS = 256;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const NEW_LIGHT: Light = { type: 'spot', intensity: 100, hotspot: 0.6, x: 0.3, y: 0.3, z: 0.6, targetX: 0.6, targetY: 0.6, color: '#ffffff', enabled: true };

// A canvas in fractions: `draw` paints, `hit` picks a handle at a point (or -1), `drag` moves it.
function Box({ label, draw, hit, drag, add, remove }: {
  label: string; draw: (g: CanvasRenderingContext2D) => void; hit: (x: number, y: number) => number;
  drag: (h: number, x: number, y: number) => void; add?: (x: number, y: number) => number; remove?: (h: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const held = useRef(-1);
  useEffect(() => {
    const g = canvas.current?.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, W, H);
    draw(g);
  });
  const at = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  return (
    <canvas ref={canvas} className="shear-curve" width={W} height={H} aria-label={label}
      onPointerDown={e => {
        const [x, y] = at(e);
        held.current = hit(x, y);
        if (held.current < 0 && add) held.current = add(clamp01(x), clamp01(y));
        if (held.current >= 0) e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        if (held.current < 0) return;
        const [x, y] = at(e);
        if (remove && (x < 0 || x > 1 || y < 0 || y > 1)) { remove(held.current); held.current = -1; return; }
        drag(held.current, clamp01(x), clamp01(y));
      }}
      onPointerUp={() => { held.current = -1; }} onPointerCancel={() => { held.current = -1; }} />
  );
}

const near = (x: number, y: number, px: number, py: number) => Math.hypot((x - px) * W, (y - py) * H) <= HIT;

export function FlamePath({ value, onChange }: { value: PathPoint[]; onChange: (v: PathPoint[]) => void }) {
  return (
    <Box label={t`Flame path`} hit={(x, y) => value.findIndex(p => near(x, y, p.x, p.y))}
      add={(x, y) => { if (value.length >= MAX_POINTS) return -1; onChange([...value, { x, y }]); return value.length; }}
      drag={(i, x, y) => onChange(value.map((p, k) => (k === i ? { x, y } : p)))}
      remove={i => { if (value.length > 2) onChange(value.filter((_, k) => k !== i)); }}
      draw={g => {
        g.strokeStyle = '#f84';
        g.beginPath();
        value.forEach((p, i) => (i ? g.lineTo(p.x * W, p.y * H) : g.moveTo(p.x * W, p.y * H)));
        g.stroke();
        g.fillStyle = '#fff';
        value.forEach(p => g.fillRect(p.x * W - 3, p.y * H - 3, 6, 6));
      }} />
  );
}

// Handles: light i is 2i, its target 2i + 1.
export function LightsEditor({ value, onChange }: { value: Light[]; onChange: (v: Light[]) => void }) {
  const [sel, setSel] = useState(0);
  const cur = value[Math.min(sel, value.length - 1)];
  const set = (patch: Partial<Light>) => onChange(value.map((l, k) => (l === cur ? { ...l, ...patch } : l)));
  const aimed = (l: Light) => l.type !== 'point';
  return (
    <div className="lights-editor">
      <Box label={t`Lights`}
        hit={(x, y) => {
          for (let i = value.length - 1; i >= 0; i--) {
            const l = value[i];
            if (near(x, y, l.x, l.y)) return 2 * i;
            if (aimed(l) && near(x, y, l.targetX, l.targetY)) return 2 * i + 1;
          }
          return -1;
        }}
        drag={(h, x, y) => {
          setSel(h >> 1);
          onChange(value.map((l, k) => (k !== h >> 1 ? l : h & 1 ? { ...l, targetX: x, targetY: y } : { ...l, x, y })));
        }}
        draw={g => value.forEach(l => {
          g.globalAlpha = l.enabled ? 1 : 0.4;
          if (aimed(l)) {
            g.strokeStyle = '#888';
            g.beginPath();
            g.moveTo(l.x * W, l.y * H);
            g.lineTo(l.targetX * W, l.targetY * H);
            g.stroke();
            g.strokeRect(l.targetX * W - 3, l.targetY * H - 3, 6, 6);
          }
          g.fillStyle = l.color;
          g.strokeStyle = l === cur ? '#4af' : '#000';
          g.beginPath();
          g.arc(l.x * W, l.y * H, 5, 0, Math.PI * 2);
          g.fill();
          g.stroke();
          g.globalAlpha = 1;
        })} />
      <div className="lights-row">
        <select aria-label={t`Light`} value={value.indexOf(cur)} onChange={e => setSel(Number(e.currentTarget.value))} disabled={!cur}>
          {value.map((l, i) => <option key={i} value={i}>{t`Light ${i + 1}`}</option>)}
        </select>
        <button type="button" disabled={value.length >= MAX_LIGHTS} onClick={() => { onChange([...value, { ...NEW_LIGHT }]); setSel(value.length); }}><Trans>Add</Trans></button>
        <button type="button" disabled={!cur} onClick={() => { onChange(value.filter(l => l !== cur)); setSel(0); }}><Trans>Delete</Trans></button>
      </div>
      {cur && (
        <div className="lights-row">
          <select aria-label={t`Light type`} value={cur.type} onChange={e => set({ type: e.currentTarget.value as Light['type'] })}>
            <option value="spot">{t`Spot`}</option><option value="point">{t`Point`}</option><option value="infinite">{t`Infinite`}</option>
          </select>
          <label><input type="checkbox" checked={cur.enabled} onChange={e => set({ enabled: e.currentTarget.checked })} /> <Trans>On</Trans></label>
          <input type="color" aria-label={t`Light color`} value={cur.color} onChange={e => set({ color: e.currentTarget.value })} />
          <label><Trans>Intensity</Trans> <ValueInput label={t`Intensity`} min={-100} max={100} value={cur.intensity} set={v => set({ intensity: Math.min(100, Math.max(-100, v)) })} /></label>
          {cur.type === 'spot' && <label><Trans>Hotspot</Trans> <ValueInput label={t`Hotspot`} min={0} max={100} value={Math.round(cur.hotspot * 100)} set={v => set({ hotspot: clamp01(v / 100) })} /></label>}
          <label><Trans>Height</Trans> <ValueInput label={t`Height`} min={1} max={100} value={Math.round(cur.z * 100)} set={v => set({ z: Math.min(1, Math.max(0.01, v / 100)) })} /></label>
        </div>
      )}
    </div>
  );
}
