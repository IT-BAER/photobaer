import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { client } from './client.ts';
import { flatNodes } from './layers.ts';
import { formatNumber } from './i18n/numbers.ts';
import { rgbToHex } from './shell/color.ts';
import type { Viewer } from './viewer.ts';
import type { DocInfo } from './worker/types.ts';
import { histogramStats, selectHistogramChannel, type HistogramChannel } from './app/inspection.ts';

export function HistogramPanel({ doc }: { doc: DocInfo | null }) {
  const [channel, setChannel] = useState<HistogramChannel>('composite');
  const [source, setSource] = useState<string>('composite');
  const [raw, setRaw] = useState<Uint32Array | null>(null);
  const [selectedBin, setSelectedBin] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const graph = useRef<SVGSVGElement>(null);
  const layers = useMemo(() => doc ? flatNodes(doc.layers).filter(layer => layer.kind === 'pixel') : [], [doc]);
  const layerId = source === 'composite' ? null : Number(source);

  useEffect(() => {
    if (layerId !== null && !layers.some(layer => layer.id === layerId)) setSource('composite');
  }, [layerId, layers]);
  useEffect(() => {
    const id = ++request.current;
    if (!doc) { setRaw(null); setError(null); return; }
    setError(null);
    client.call('documentHistogram', doc.key, layerId).then(result => {
      if (request.current !== id || result.key !== doc.key) return;
      const bins = result.histogram as Uint32Array;
      const count = histogramStats(selectHistogramChannel(bins, channel)).count;
      if (count > doc.width * doc.height) throw new Error(t`Histogram pixel count exceeds the source document area.`);
      setRaw(bins);
    }).catch(reason => { if (request.current === id) { setRaw(null); setError((reason as Error).message); } });
    return () => { if (request.current === id) request.current++; };
  }, [doc?.key, doc?.version, layerId, refresh]);

  const bins = raw ? selectHistogramChannel(raw, channel) : new Uint32Array(256);
  const stats = histogramStats(bins), peak = Math.max(1, ...bins);
  const points = Array.from(bins, (count, value) => `${value},${100 - count / peak * 100}`).join(' ');
  const selectAt = (clientX: number) => {
    const rect = graph.current?.getBoundingClientRect();
    if (rect) setSelectedBin(Math.max(0, Math.min(255, Math.round((clientX - rect.left) / rect.width * 255))));
  };

  return (
    <section className="inspection-panel" aria-label={t`Histogram`}>
      <h2><Trans>Histogram</Trans></h2>
      <div className="inspection-controls">
        <label><Trans>Channel</Trans> <select value={channel} onChange={event => setChannel(event.currentTarget.value as HistogramChannel)}>
          <option value="composite">{t`Composite`}</option><option value="red">{t`Red`}</option><option value="green">{t`Green`}</option><option value="blue">{t`Blue`}</option>
        </select></label>
        <label><Trans>Source</Trans> <select value={source} onChange={event => setSource(event.currentTarget.value)} disabled={!doc}>
          <option value="composite">{t`Composite`}</option>
          {layers.map(layer => <option key={layer.id} value={layer.id}>{layer.name}</option>)}
        </select></label>
        <button type="button" onClick={() => setRefresh(value => value + 1)} disabled={!doc}><Trans>Refresh</Trans></button>
      </div>
      {doc ? <>
        <svg ref={graph} className="histogram-graph" viewBox="0 0 255 100" preserveAspectRatio="none" onPointerMove={event => selectAt(event.clientX)} onPointerDown={event => selectAt(event.clientX)}>
          <polyline points={points} fill="none" stroke="currentColor" vectorEffect="non-scaling-stroke" />
          <line x1={selectedBin} x2={selectedBin} y1="0" y2="100" vectorEffect="non-scaling-stroke" />
        </svg>
        <input className="histogram-bin" type="range" min="0" max="255" value={selectedBin} aria-label={t`Histogram bin`} onChange={event => setSelectedBin(event.currentTarget.valueAsNumber)} />
        <dl className="inspection-values">
          <dt><Trans>Pixels</Trans></dt><dd>{stats.count}</dd><dt><Trans>Mean</Trans></dt><dd>{formatNumber(stats.mean, 2)}</dd>
          <dt><Trans>Median</Trans></dt><dd>{stats.median}</dd><dt><Trans>Std Dev</Trans></dt><dd>{formatNumber(stats.standardDeviation, 2)}</dd>
          <dt><Trans>Bin {selectedBin}</Trans></dt><dd>{bins[selectedBin]}</dd>
        </dl>
      </> : <p className="panel-empty"><Trans>No document open.</Trans></p>}
      {error && <p className="panel-error" role="alert">{error}</p>}
    </section>
  );
}

interface CursorSample { x: number; y: number; color: [number, number, number, number] }

export function InfoPanel({ doc, canvas, viewer }: { doc: DocInfo | null; canvas: RefObject<HTMLCanvasElement | null>; viewer: RefObject<Viewer | null> }) {
  const [size, setSize] = useState<1 | 3 | 5>(1);
  const [sample, setSample] = useState<CursorSample | null>(null);
  const [error, setError] = useState<string | null>(null);
  const newest = useRef(0);
  const position = useRef<[number, number] | null>(null);
  const latestDoc = useRef(doc);
  const latestSize = useRef(size);
  const requestCurrent = useRef<(point: [number, number]) => void>(() => {});
  const cancelCurrent = useRef<() => void>(() => {});
  const previousKey = useRef<string | null>(null);
  latestDoc.current = doc;
  latestSize.current = size;

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let frame = 0, alive = true, inFlight = false, pending: [number, number] | null = null;
    const pump = () => {
      frame = 0;
      const currentDoc = latestDoc.current, point = pending;
      if (!alive || inFlight || !currentDoc || !point) return;
      pending = null;
      inFlight = true;
      const [x, y] = point, id = newest.current;
      client.call('documentSample', currentDoc.key, x, y, latestSize.current, null).then(result => {
        const now = latestDoc.current;
        if (alive && newest.current === id && now?.key === result.key && now.version === result.version) {
          setSample({ x: Math.floor(x), y: Math.floor(y), color: result.color }); setError(null);
        }
      }, reason => {
        if (alive && newest.current === id && latestDoc.current?.key === currentDoc.key) { setSample(null); setError((reason as Error).message); }
      }).finally(() => {
        inFlight = false;
        if (alive && pending) pump();
      });
    };
    const queue = (point: [number, number]) => {
      pending = point;
      newest.current++;
      if (!frame && !inFlight) frame = requestAnimationFrame(pump);
    };
    requestCurrent.current = queue;
    cancelCurrent.current = () => { pending = null; newest.current++; if (frame) { cancelAnimationFrame(frame); frame = 0; } };
    const move = (event: PointerEvent) => {
      const current = viewer.current, currentDoc = latestDoc.current, rect = element.getBoundingClientRect();
      if (!current || !currentDoc) return;
      const point = current.screenToDoc(event.clientX - rect.left, event.clientY - rect.top);
      if (point[0] < 0 || point[1] < 0 || point[0] >= currentDoc.width || point[1] >= currentDoc.height) {
        position.current = null; cancelCurrent.current(); setSample(null); setError(null); return;
      }
      position.current = point;
      queue(point);
    };
    const leave = () => { position.current = null; cancelCurrent.current(); setSample(null); setError(null); };
    element.addEventListener('pointermove', move, { passive: true });
    element.addEventListener('pointerleave', leave, { passive: true });
    return () => {
      alive = false; newest.current++; position.current = null; setSample(null);
      if (frame) cancelAnimationFrame(frame);
      requestCurrent.current = () => {};
      cancelCurrent.current = () => {};
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerleave', leave);
    };
  }, [canvas, viewer]);

  useEffect(() => {
    if (!doc || previousKey.current !== doc.key) {
      previousKey.current = doc?.key ?? null;
      position.current = null; cancelCurrent.current(); setSample(null); setError(null);
      return;
    }
    const point = position.current;
    if (!point || point[0] < 0 || point[1] < 0 || point[0] >= doc.width || point[1] >= doc.height) {
      position.current = null; cancelCurrent.current(); setSample(null);
      return;
    }
    requestCurrent.current(point);
  }, [doc?.key, doc?.version, doc?.width, doc?.height, size]);

  // Color sampler readouts, re-read when the document or a sampler changes.
  const [samples, setSamples] = useState<{ at: [number, number]; color: number[] }[]>([]);
  const samplerKey = JSON.stringify(doc?.annotations.samplers ?? []);
  useEffect(() => {
    const points = doc?.annotations.samplers ?? [];
    if (!doc || !points.length) { setSamples([]); return; }
    let alive = true;
    // A sampler left outside the canvas (after a crop) reads as no color.
    Promise.all(points.map(([x, y]) => client.call('documentSample', doc.key, x, y, size, null).catch(() => null))).then(rs => {
      if (alive) setSamples(rs.map((r, i) => ({ at: points[i], color: r?.color ?? [] })));
    });
    return () => { alive = false; };
  }, [doc?.key, doc?.version, samplerKey, size]);

  const mode = doc?.mode?.kind ?? (doc?.gray ? 'gray' : 'rgb');
  const bounds = doc?.selection?.bounds;
  const depth = doc?.depth;
  return (
    <section className="inspection-panel" aria-label={t`Info`}>
      <h2><Trans>Info</Trans></h2>
      <label><Trans>Sample</Trans> <select value={size} onChange={event => setSize(Number(event.currentTarget.value) as 1 | 3 | 5)}>
        <option value="1">{t({ message: 'Point', context: 'sample size' })}</option><option value="3">3 × 3</option><option value="5">5 × 5</option>
      </select></label>
      {doc ? <dl className="inspection-values">
        <dt><Trans>Cursor</Trans></dt><dd>{sample ? `${sample.x}, ${sample.y}` : '–'}</dd>
        <dt>RGBA</dt><dd>{sample ? sample.color.map(v => formatNumber(v)).join(', ') : '–'}</dd>
        <dt>Hex</dt><dd>{sample ? `${rgbToHex([sample.color[0], sample.color[1], sample.color[2]])} / ${formatNumber(sample.color[3])}` : '–'}</dd>
        <dt><Trans>Document</Trans></dt><dd>{doc.width} × {doc.height}</dd>
        <dt><Trans context="color mode">Mode</Trans></dt><dd><Trans>{mode}, {depth}-bit</Trans></dd>
        <dt><Trans>Profile</Trans></dt><dd>{doc.profile?.name ?? t`None`}</dd>
        <dt><Trans>Selection</Trans></dt><dd>{bounds ? `${bounds[2]} × ${bounds[3]}` : t`None`}</dd>
        {samples.map((s, i) => [
          <dt key={`t${i}`}>#{i + 1} {s.at[0]}, {s.at[1]}</dt>,
          <dd key={`d${i}`}>{s.color.length ? s.color.map(v => formatNumber(v)).join(', ') : '–'}</dd>,
        ])}
      </dl> : <p className="panel-empty"><Trans>No document open.</Trans></p>}
      {error && <p className="panel-error" role="alert">{error}</p>}
    </section>
  );
}
