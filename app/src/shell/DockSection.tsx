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
  /** Position in the sidebar (CSS order). */
  order: number;
  /** Moves `id` before or after `target`: header drag and drop, or Alt+Arrow keys on the header button. */
  onMove: (id: DockKey, target: DockKey, after: boolean) => void;
  children: ReactNode;
}

const clamp = (h: number) => Math.round(Math.min(DOCK_MAX_HEIGHT, Math.max(DOCK_MIN_HEIGHT, h)));

const DRAG_TYPE = 'application/x-photobaer-dock';

export function DockSection({ id, title, entry, locked, edge = 'bottom', header, onResize, onToggle, order, onMove, children }: Props) {
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ y: number; h: number; last: number } | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const [drop, setDrop] = useState<'before' | 'after' | null>(null);
  // The visible neighbor in the given direction, by CSS order.
  const neighbor = (dir: number) => {
    const all = [...(ref.current?.parentElement?.querySelectorAll<HTMLElement>(':scope > .dock-section') ?? [])]
      .sort((a, b) => Number(a.style.order) - Number(b.style.order));
    return all[all.indexOf(ref.current!) + dir]?.dataset.dock as DockKey | undefined;
  };
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
      ref={ref} data-dock={id}
      className={`dock-section ds-${id}${collapsed ? ' collapsed' : ''}${height !== undefined && !collapsed ? ' sized' : ''}${drop ? ` drop-${drop}` : ''}`}
      style={{ order, ...(height !== undefined && !collapsed ? { height } : {}) }} aria-label={title}
      onDragOver={e => {
        if (locked || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        setDrop(e.clientY > r.top + r.height / 2 ? 'after' : 'before');
      }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null); }}
      onDrop={e => {
        const from = e.dataTransfer.getData(DRAG_TYPE) as DockKey;
        const side = drop;
        setDrop(null);
        if (locked || !from || !side) return;
        e.preventDefault();
        onMove(from, id, side === 'after');
      }}
    >
      {edge === 'top' && splitter}
      <div
        className="dock-header" draggable={!locked} title={locked ? undefined : 'Drag to move this panel'}
        onDragStart={e => {
          if ((e.target as HTMLElement).closest('.dock-tabs button')) { e.preventDefault(); return; }
          e.dataTransfer.setData(DRAG_TYPE, id);
          e.dataTransfer.effectAllowed = 'move';
        }}
      >
        <button
          type="button" className="dock-toggle" disabled={locked} aria-expanded={!collapsed}
          aria-label={header ? `${collapsed ? 'Expand' : 'Collapse'} ${title}` : undefined} onClick={() => onToggle(id)}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          onKeyDown={e => {
            const dir = e.altKey ? (e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0) : 0;
            if (!dir) return;
            e.preventDefault();
            const target = neighbor(dir);
            if (target) onMove(id, target, dir > 0);
          }}
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
