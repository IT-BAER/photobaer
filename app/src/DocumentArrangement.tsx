import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { client } from './client.ts';
import { createRenderer, type Renderer } from './render/renderer.ts';
import { Viewer } from './viewer.ts';
import type { View } from './view.ts';
import { arrangeGrid, clampFloatRect, displayedDocumentKeys, reconcileFloatRects, type ArrangeMode, type FloatRect } from './app/arrange.ts';

interface ArrangementDocument { key: string; name: string }

interface Props {
  mode: ArrangeMode;
  documents: ArrangementDocument[];
  activeKey: string | null;
  primary: ReactNode;
  views: Map<string, { view: View }>;
  revision: string;
  activate: (key: string) => void;
  saveView: (key: string, view: View) => void;
  onError: (message: string) => void;
}

interface TileMeta { key: string; version: number; width: number; height: number; maxLevel: number; data: ArrayBuffer | null }

function sameView(a: View, b: View) {
  return a.zoom === b.zoom && a.rot === b.rot && a.cx === b.cx && a.cy === b.cy;
}

function BackgroundPane({ docKey, view, revision, saveView, onError }: {
  docKey: string; view?: View; revision: string; saveView: (key: string, view: View) => void; onError: (message: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const renderer = useRef<Renderer | null>(null);
  const alive = useRef(false);
  const requestedView = useRef(view);
  const saveViewRef = useRef(saveView);
  const onErrorRef = useRef(onError);
  requestedView.current = view;
  saveViewRef.current = saveView;
  onErrorRef.current = onError;

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    alive.current = true;
    void createRenderer(element, 'webgl2').then(r => {
      if (!alive.current) {
        element.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
        return;
      }
      renderer.current = r;
      const source = async (level: number, tx: number, ty: number) => {
        const tile = await client.call('documentDisplayTile', docKey, level, tx, ty);
        return {
          docId: 1,
          version: tile.version,
          fill: tile.data ? (slot: number) => r.upload(slot, new Uint8Array(tile.data!)) : null,
        };
      };
      const next = new Viewer(element, r, source);
      next.setTool('hand');
      next.onView = current => saveViewRef.current(docKey, { ...current });
      viewer.current = next;
      return client.call('documentDisplayTile', docKey, 0, 0, 0).then(meta => {
        if (!alive.current || viewer.current !== next) return;
        next.setDoc({ docId: 1, version: meta.version, width: meta.width, height: meta.height, maxLevel: meta.maxLevel }, requestedView.current);
      });
    }).catch(e => { if (alive.current) onErrorRef.current((e as Error).message); });
    return () => {
      alive.current = false;
      viewer.current?.destroy();
      viewer.current = null;
      renderer.current = null;
      element.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [docKey]);

  useEffect(() => {
    const current = viewer.current;
    if (!current) return;
    void client.call('documentDisplayTile', docKey, 0, 0, 0).then((meta: TileMeta) => {
      if (!alive.current || viewer.current !== current) return;
      current.setDoc({ docId: 1, version: meta.version, width: meta.width, height: meta.height, maxLevel: meta.maxLevel }, requestedView.current);
    }).catch(e => { if (alive.current) onErrorRef.current((e as Error).message); });
  }, [docKey, revision]);

  useEffect(() => {
    const current = viewer.current;
    if (view && current && !sameView(current.view, view)) current.setView(view);
  }, [view]);

  return <canvas ref={canvas} aria-label="Inactive document preview" />;
}

export function DocumentArrangement({ mode, documents, activeKey, primary, views, revision, activate, saveView, onError }: Props) {
  const area = useRef<HTMLDivElement>(null);
  const keys = useMemo(() => displayedDocumentKeys(mode, documents.map(d => d.key), activeKey), [mode, documents, activeKey]);
  const grid = useMemo(() => arrangeGrid(mode, keys), [mode, keys]);
  const [rects, setRects] = useState<Record<string, FloatRect>>({});
  const documentKeys = useRef(documents.map(d => d.key));
  documentKeys.current = documents.map(d => d.key);
  const drag = useRef<{ key: string; resize: boolean; x: number; y: number; rect: FloatRect } | null>(null);
  const name = (key: string) => documents.find(d => d.key === key)?.name ?? key;
  const defaultRect = (key: string) => {
    const index = Math.max(0, documents.findIndex(d => d.key === key));
    const bounds = area.current?.getBoundingClientRect();
    return clampFloatRect({ x: 24 + index * 28, y: 20 + index * 24, width: 420, height: 300 }, bounds?.width ?? 800, bounds?.height ?? 600);
  };
  const floatRect = (key: string) => rects[key] ?? defaultRect(key);
  const styleFor = (key: string): CSSProperties => {
    if (mode === 'float') {
      const rect = floatRect(key);
      return { left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: key === activeKey ? 2 : 1 };
    }
    const cell = grid.cells.find(c => c.key === key);
    return cell ? { gridRow: cell.row, gridColumn: cell.column } : {};
  };

  useEffect(() => {
    const bounds = area.current?.getBoundingClientRect();
    setRects(current => reconcileFloatRects(documentKeys.current, current, bounds?.width ?? 800, bounds?.height ?? 600));
  }, [documents]);

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setRects(current => reconcileFloatRects(documentKeys.current, current, width, height));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const startDrag = (e: PointerEvent, key: string, resize: boolean) => {
    if (mode !== 'float') return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { key, resize, x: e.clientX, y: e.clientY, rect: floatRect(key) };
  };
  const moveDrag = (e: PointerEvent) => {
    const current = drag.current, bounds = area.current?.getBoundingClientRect();
    if (!current || !bounds) return;
    const dx = e.clientX - current.x, dy = e.clientY - current.y;
    const candidate = current.resize
      ? { ...current.rect, width: current.rect.width + dx, height: current.rect.height + dy }
      : { ...current.rect, x: current.rect.x + dx, y: current.rect.y + dy };
    setRects(value => ({ ...value, [current.key]: clampFloatRect(candidate, bounds.width, bounds.height) }));
  };
  const stopDrag = () => { drag.current = null; };
  const arranged = mode !== 'tabs';

  return (
    <div ref={area} className={`document-arrangement mode-${mode}`} style={mode === 'float' ? undefined : {
      gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))`,
      gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`,
    }} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
      <section className="arrange-pane arrange-primary" style={activeKey ? styleFor(activeKey) : undefined}>
        {arranged && activeKey && <button type="button" className="arrange-title" onPointerDown={e => startDrag(e, activeKey, false)}>{name(activeKey)}</button>}
        <div className="arrange-primary-content">{primary}</div>
        {mode === 'float' && activeKey && <span className="arrange-resize" onPointerDown={e => startDrag(e, activeKey, true)} />}
      </section>
      {keys.filter(key => key !== activeKey).map(key => (
        <section key={key} className="arrange-pane arrange-secondary" style={styleFor(key)}>
          <button type="button" className="arrange-title" onClick={() => activate(key)} onPointerDown={e => startDrag(e, key, false)}>{name(key)}</button>
          <BackgroundPane docKey={key} view={views.get(key)?.view} revision={revision} saveView={saveView} onError={onError} />
          {mode === 'float' && <span className="arrange-resize" onPointerDown={e => startDrag(e, key, true)} />}
        </section>
      ))}
    </div>
  );
}
