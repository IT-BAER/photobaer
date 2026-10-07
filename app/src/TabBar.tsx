import { t } from '@lingui/core/macro';
import { X } from 'lucide-react';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { DocInfo } from './worker/types.ts';

// A tab drag: the tab follows the pointer by `dx`; the tabs it passes slide aside; `rects` are measured at the start.
interface Drag { key: string; from: number; to: number; x0: number; dx: number; rects: { left: number; width: number }[]; moved: boolean; dropped: boolean }

// The index the dragged tab lands at: the number of other tabs whose center lies left of its center.
export function dropIndex(rects: { left: number; width: number }[], from: number, dx: number) {
  const c = rects[from].left + rects[from].width / 2 + dx;
  return rects.filter((r, i) => i !== from && r.left + r.width / 2 < c).length;
}

// One tab per open document; the active document's size and depth show in its tooltip. Tabs reorder by drag.
export function TabBar({ doc, switchTo, close, move }: { doc: DocInfo; switchTo: (key: string) => void; close: (key: string) => void; move: (key: string, to: number) => Promise<void> }) {
  const bar = useRef<HTMLDivElement>(null);
  const [drag, setState] = useState<Drag | null>(null);
  // Pointer events can outrun renders; the handlers read the latest drag from the ref.
  const { width, height, depth } = doc;
  const live = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => { live.current = d; setState(d); };

  const down = (e: ReactPointerEvent<HTMLDivElement>, i: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button') || doc.docs.length < 2) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rects = [...bar.current!.children].map(c => { const r = c.getBoundingClientRect(); return { left: r.left, width: r.width }; });
    setDrag({ key: doc.docs[i].key, from: i, to: i, x0: e.clientX, dx: 0, rects, moved: false, dropped: false });
  };
  const pointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = live.current;
    if (!d || d.dropped) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 5) return;
    setDrag({ ...d, dx, moved: true, to: dropIndex(d.rects, d.from, dx) });
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointerMove(e);
    const drag = live.current;
    if (!drag || drag.dropped) return;
    if (!drag.moved || drag.to === drag.from) { setDrag(drag.moved ? { ...drag, dx: 0, dropped: true } : null); if (drag.moved) setTimeout(() => setDrag(null), 150); return; }
    // The tab glides into its slot; once the new order renders, the offsets go at once, without transitions.
    const r = drag.rects, slot = drag.to > drag.from ? r[drag.to].left + r[drag.to].width - r[drag.from].width - r[drag.from].left : r[drag.to].left - r[drag.from].left;
    setDrag({ ...drag, dx: slot, dropped: true });
    move(drag.key, drag.to).finally(() => setDrag(null));
  };
  const activeTitle = (name: string) => t`${name}
${width} x ${height} px, ${depth}-bit`;
  const closeLabel = (name: string) => t`Close ${name}`;
  const offset = (i: number) => {
    if (!drag?.moved) return 0;
    if (i === drag.from) return drag.dx;
    const w = drag.rects[drag.from].width;
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -w;
    if (drag.to < drag.from && i >= drag.to && i < drag.from) return w;
    return 0;
  };

  return (
    <div ref={bar} className={`tab-bar${drag?.moved ? ' dragging' : ''}`} role="tablist" aria-label={t`Open documents`}>
      {doc.docs.map((tab, i) => {
        const dragged = drag?.moved && i === drag.from;
        return (
          <div key={tab.key} className={`doc-tab${tab.active ? ' active' : ''}${dragged ? ' drag' : ''}`} role="tab" aria-selected={tab.active} tabIndex={tab.active ? 0 : -1}
            title={tab.active ? activeTitle(tab.name) : tab.name}
            style={drag?.moved ? { transform: `translateX(${offset(i)}px)`, transition: dragged && !drag.dropped ? 'none' : 'transform 150ms ease' } : undefined}
            onPointerDown={e => down(e, i)} onPointerMove={pointerMove} onPointerUp={up} onPointerCancel={() => setDrag(null)}
            onClick={() => { if (!live.current?.moved && !tab.active) switchTo(tab.key); }}
            onAuxClick={e => { if (e.button === 1) { e.preventDefault(); close(tab.key); } }}
            onMouseDown={e => { if (e.button === 1) e.preventDefault(); }}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!tab.active) switchTo(tab.key); } }}>
            <span className="doc-tab-name">{tab.name}{tab.dirty ? '*' : ''}<span className="doc-tab-mode"> ({tab.mode}/{tab.depth}{tab.proof ? `/${tab.proof}` : ''})</span></span>
            <button type="button" className="doc-tab-close" aria-label={closeLabel(tab.name)} tabIndex={-1}
              onClick={e => { e.stopPropagation(); close(tab.key); }}><X size={12} aria-hidden /></button>
          </div>
        );
      })}
    </div>
  );
}
