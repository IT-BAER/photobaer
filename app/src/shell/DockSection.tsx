import { useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { DOCK_MAX_HEIGHT, DOCK_MIN_HEIGHT, type DockEntry, type DockKey } from '../app/workspaces.ts';

interface Props {
  id: DockKey;
  title: string;
  entry?: DockEntry;
  locked: boolean;
  /** 'top' for sections below the Layers filler: dragging up grows them. 'none' for the filler itself. */
  edge?: 'bottom' | 'top' | 'none';
  /** Replaces the title text in the header row (the Color/Swatches/Brush tab strip). */
  header?: ReactNode;
  onResize: (id: DockKey, height: number | null) => void;
  onToggle: (id: DockKey) => void;
  children: ReactNode;
}

const clamp = (h: number) => Math.round(Math.min(DOCK_MAX_HEIGHT, Math.max(DOCK_MIN_HEIGHT, h)));

export function DockSection({ id, title, entry, locked, edge = 'bottom', header, onResize, onToggle, children }: Props) {
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ y: number; h: number; last: number } | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const collapsed = !!entry?.collapsed;
  const height = live ?? entry?.height;
  const sign = edge === 'top' ? -1 : 1;
  const currentHeight = () => ref.current?.getBoundingClientRect().height ?? DOCK_MIN_HEIGHT;
  const splitter = !collapsed && !locked && edge !== 'none' && (
    <div
      className={`dock-splitter ${edge}`} role="separator" aria-orientation="horizontal" aria-label={`Resize ${title}`} tabIndex={0}
      aria-valuenow={height === undefined ? undefined : Math.round(height)} aria-valuemin={DOCK_MIN_HEIGHT} aria-valuemax={DOCK_MAX_HEIGHT}
      onPointerDown={e => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const h = currentHeight();
        drag.current = { y: e.clientY, h, last: h };
      }}
      onPointerMove={e => {
        const d = drag.current;
        if (!d) return;
        d.last = clamp(d.h + sign * (e.clientY - d.y));
        setLive(d.last);
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        setLive(null);
        if (d && d.last !== d.h) onResize(id, d.last);
      }}
      onPointerCancel={() => { drag.current = null; setLive(null); }}
      onDoubleClick={() => onResize(id, null)}
      onKeyDown={e => {
        const step = e.key === 'ArrowDown' ? 16 : e.key === 'ArrowUp' ? -16 : 0;
        if (!step) return;
        e.preventDefault();
        onResize(id, clamp(currentHeight() + sign * step));
      }}
    />
  );
  return (
    <section
      ref={ref} className={`dock-section ds-${id}${collapsed ? ' collapsed' : ''}${height !== undefined && !collapsed ? ' sized' : ''}`}
      style={height !== undefined && !collapsed ? { height } : undefined} aria-label={title}
    >
      {edge === 'top' && splitter}
      <div className="dock-header">
        <button
          type="button" className="dock-toggle" disabled={locked} aria-expanded={!collapsed}
          aria-label={header ? `${collapsed ? 'Expand' : 'Collapse'} ${title}` : undefined} onClick={() => onToggle(id)}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          {!header && <span>{title}</span>}
        </button>
        {header}
      </div>
      {!collapsed && <div className="dock-body">{children}</div>}
      {edge === 'bottom' && splitter}
    </section>
  );
}
