// Window > Navigator: a thumbnail of the flattened document with the visible area outlined in red.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { client } from './client.ts';
import { formatNumber, parseNumber } from './i18n/numbers.ts';
import type { DocInfo } from './engine.worker.ts';
import type { Viewer } from './viewer.ts';
import type { View } from './view.ts';
import { SLIDER_MAX, clampZoom, sliderToZoom, thumbSize, thumbToDoc, viewQuad, zoomToSlider } from './app/navigator.ts';

const SIZE = 200;
const ICON = { size: 16, strokeWidth: 1.75 };

export function NavigatorPanel({ doc, viewer, view }: { doc: DocInfo; viewer: Viewer | null; view: View }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [thumb, setThumb] = useState<ImageData | null>(null);
  const [pct, setPct] = useState<string | null>(null);
  const [w, h] = thumbSize(doc.width, doc.height, SIZE);

  // Debounced: a stroke or drag bumps the version many times a second.
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      client.call('navigatorThumb', SIZE).then(r => {
        if (alive && r.docId === doc.docId) setThumb(new ImageData(new Uint8ClampedArray(r.data), r.w, r.h));
      }).catch(err => console.warn('navigator thumbnail unavailable', err));
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [doc.docId, doc.version]);

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (thumb && thumb.width === w && thumb.height === h) ctx.putImageData(thumb, 0, 0);
    if (!viewer) return;
    const [vw, vh] = viewer.size;
    ctx.beginPath();
    viewQuad(view, vw, vh, doc.width, doc.height, w, h).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.strokeStyle = '#ff2a2a';
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [thumb, view, viewer, w, h, doc.width, doc.height]);

  const centerAt = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (!viewer) return;
    const r = e.currentTarget.getBoundingClientRect();
    const [cx, cy] = thumbToDoc((e.clientX - r.left) / r.width * w, (e.clientY - r.top) / r.height * h, doc.width, doc.height, w, h);
    viewer.setView({ ...viewer.view, cx, cy });
  };
  const dpr = viewer?.dpr ?? 1;
  const setZoom = (z: number) => viewer?.setView({ ...viewer.view, zoom: clampZoom(z) });
  const shown = formatNumber(view.zoom * dpr * 100, 1);
  const applyPct = () => {
    const v = parseNumber((pct ?? '').replace('%', '')) ?? NaN;
    if (Number.isFinite(v) && v > 0) setZoom(v / 100 / dpr);
    setPct(null);
  };

  return (
    <div className="adjustments-panel navigator-panel">
      <div className="panel-tabs"><span className="panel-tab"><Trans>Navigator</Trans></span></div>
      <canvas ref={canvas} role="img" aria-label={t`Navigator`} width={w} height={h} className="navigator-canvas" style={{ aspectRatio: `${w} / ${h}` }}
        onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); centerAt(e); }}
        onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) centerAt(e); }}
        onPointerUp={e => e.currentTarget.releasePointerCapture(e.pointerId)} />
      <div className="navigator-zoom">
        <button type="button" aria-label={t`Zoom Out`} title={t`Zoom Out`} onClick={() => viewer?.zoomBy(0.5)}><ZoomOut {...ICON} /></button>
        <input type="range" aria-label={t`Zoom`} min={0} max={SLIDER_MAX} value={zoomToSlider(clampZoom(view.zoom))} onChange={e => setZoom(sliderToZoom(Number(e.currentTarget.value)))} />
        <button type="button" aria-label={t`Zoom In`} title={t`Zoom In`} onClick={() => viewer?.zoomBy(2)}><ZoomIn {...ICON} /></button>
        <input type="text" inputMode="decimal" aria-label={t`Zoom percent`} className="navigator-pct" value={pct ?? shown}
          onChange={e => setPct(e.currentTarget.value)} onBlur={() => setPct(null)}
          onKeyDown={e => { if (e.key === 'Enter') applyPct(); else if (e.key === 'Escape') setPct(null); }} />
        <span>%</span>
      </div>
    </div>
  );
}
