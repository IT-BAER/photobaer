// Blur Gallery handles drawn over the stage while the dialog is open: drag a handle, click empty
// canvas to add a pin or path point (Alt starts a new path), Delete removes the selected one, and a
// pin's ring turns its blur. The wheel still zooms the view underneath.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Viewer } from '../viewer.ts';
import { addAt, drag, handles, outline, removeHandle, ringBlur, type Box, type Pt } from './gallery.ts';
import type { ParamValue, Pin } from './lastFilter.ts';

type Params = Record<string, ParamValue>;
const HIT = 8;
const RING = 26;

export function BlurGalleryOverlay({ kind, params, box, viewer, onChange, onCancel }: {
  kind: string; params: Params; box: Box; viewer: RefObject<Viewer | null>; onChange: (patch: Params) => void; onCancel: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const held = useRef<{ id: string; off: Pt; angle: number } | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const stage = document.querySelector('.stage');
  const screen = (p: Pt): Pt => viewer.current?.docToScreen(p[0], p[1]) ?? p;
  const pins = (params.pins as Pin[] | undefined) ?? [];

  // Repainted every frame: the view can pan or zoom under the open dialog.
  useEffect(() => {
    let raf = 0;
    const paint = () => {
      raf = requestAnimationFrame(paint);
      const c = canvas.current, g = c?.getContext('2d'), v = viewer.current;
      if (!c || !g || !v) return;
      const dpr = v.dpr, w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, c.clientWidth, c.clientHeight);
      const o = outline(kind, params, box);
      const stroke = (lines: Pt[][], dash: number[]) => {
        g.setLineDash(dash);
        for (const [color, width] of [['#000a', 3], ['#fff', 1]] as const) {
          g.strokeStyle = color;
          g.lineWidth = width;
          for (const line of lines) {
            g.beginPath();
            line.map(screen).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
            g.stroke();
          }
        }
      };
      stroke(o.solid, []);
      stroke(o.dashed, [5, 4]);
      g.setLineDash([]);
      for (const hd of handles(kind, params, box)) {
        const [x, y] = screen(hd.at);
        if (hd.id.startsWith('pin:')) {
          const blur = pins[Number(hd.id.slice(4))]?.blur ?? 0;
          g.strokeStyle = '#000a';
          g.lineWidth = 5;
          g.beginPath();
          g.arc(x, y, RING, 0, Math.PI * 2);
          g.stroke();
          g.strokeStyle = '#fff';
          g.lineWidth = 3;
          g.beginPath();
          g.arc(x, y, RING, -Math.PI / 2, -Math.PI / 2 + Math.min(1, blur / 100) * Math.PI * 2);
          g.stroke();
        }
        g.fillStyle = hd.id === sel ? '#4af' : '#fff';
        g.strokeStyle = '#000';
        g.lineWidth = 1;
        g.beginPath();
        g.arc(x, y, hd.id === 'center' || hd.id.startsWith('pin:') ? 6 : 4.5, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
    };
    paint();
    return () => cancelAnimationFrame(raf);
  });

  if (!stage) return null;
  const local = (e: React.PointerEvent): Pt => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const doc = (s: Pt): Pt => viewer.current?.screenToDoc(s[0], s[1]) ?? s;
  const angleAt = (s: Pt, id: string) => {
    const [x, y] = screen(handles(kind, params, box).find(h => h.id === id)!.at);
    return Math.atan2(s[1] - y, s[0] - x);
  };

  return createPortal(
    <canvas ref={canvas} className="overlay gallery-overlay" tabIndex={0} aria-label="Blur Gallery handles"
      onPointerDown={e => {
        if (e.button !== 0) return;
        e.currentTarget.focus();
        const s = local(e), list = handles(kind, params, box);
        let hit = [...list].reverse().find(h => { const [x, y] = screen(h.at); return Math.hypot(s[0] - x, s[1] - y) <= HIT; });
        let ring = false;
        if (!hit) {
          hit = [...list].reverse().find(h => { const [x, y] = screen(h.at); return h.id.startsWith('pin:') && Math.abs(Math.hypot(s[0] - x, s[1] - y) - RING) <= 5; });
          ring = !!hit;
        }
        let id = hit?.id;
        if (!id) {
          const blur = pins[Number(sel?.slice(4))]?.blur ?? pins[pins.length - 1]?.blur ?? 15;
          const added = addAt(kind, params, doc(s), box, e.altKey, blur);
          if (!added) return;
          onChange(added.params);
          id = added.id;
        }
        const at = hit ? hit.at : doc(s), d = doc(s);
        held.current = { id: ring ? `ring:${id.slice(4)}` : id, off: [d[0] - at[0], d[1] - at[1]], angle: ring ? angleAt(s, id) : 0 };
        setSel(id);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        const h = held.current;
        if (!h) return;
        const s = local(e);
        if (h.id.startsWith('ring:')) {
          const i = Number(h.id.slice(5)), a = angleAt(s, `pin:${i}`), turn = Math.atan2(Math.sin(a - h.angle), Math.cos(a - h.angle));
          h.angle = a;
          onChange({ pins: pins.map((q, n) => (n === i ? { ...q, blur: ringBlur(q.blur, turn) } : q)) });
          return;
        }
        const d = doc(s);
        onChange(drag(kind, params, h.id, [d[0] - h.off[0], d[1] - h.off[1]], box));
      }}
      onPointerUp={() => { held.current = null; }} onPointerCancel={() => { held.current = null; }}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Escape') onCancel();
        if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
          const next = removeHandle(kind, params, sel);
          if (next) { onChange(next); setSel(null); }
        }
      }}
      onWheel={e => stage.querySelector('canvas')?.dispatchEvent(new WheelEvent('wheel', e.nativeEvent))} />,
    stage,
  );
}
