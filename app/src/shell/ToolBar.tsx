import { useEffect, useRef, useState } from 'react';
import {
  Blend, Brush, Circle, Crop, Eraser, Frame, Hand, Hexagon, Lasso, Magnet, Minus, Move, MousePointerClick,
  DiamondMinus, DiamondPlus, MousePointer2, Navigation, PaintBucket, PenTool, Pencil, Signature, Spline, SplinePointer, Pipette, RectangleHorizontal, RotateCw, Rows3, Shapes, Slash, Square, SquareDashedText, TextCursor, Triangle, Type, TypeOutline, Wand2, ZoomIn, Bandage, Syringe, SquareDashed, Move3d, Eye, Stamp, Grid3x3,
  History, PaintbrushVertical, Droplet, Focus, Pointer, Sun, Moon, Contrast, Replace, Palette, BrushCleaning, WandSparkles,
  Crosshair, Ruler, StickyNote, Hash, Slice, SquareMousePointer, LayoutTemplate, Scan,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { RotateCcw, ArrowLeftRight } from 'lucide-react';
import { SLOTS, TOOLS, cycleTool, type Slot } from './tools.ts';
import { rgbToHex, type Rgb } from './color.ts';
import { loadOrder, moveItem, saveOrder } from '../app/panelOrder.ts';

export const ICONS: Record<string, ComponentType<{ size?: number; strokeWidth?: number }>> = {
  Move, Square, Circle, Minus, Rows3, Lasso, PenTool, Magnet, MousePointerClick, Wand2, Crop, Frame,
  Pipette, Brush, Pencil, Eraser, Blend, PaintBucket, Hand, RotateCw, ZoomIn, RectangleHorizontal, Triangle, Hexagon, Slash,
  Signature, Spline, DiamondPlus, DiamondMinus, SplinePointer, MousePointer2, Navigation, Shapes,
  Bandage, Syringe, SquareDashed, Move3d, Eye, Stamp, Grid3x3,
  History, PaintbrushVertical, Droplet, Focus, Pointer, Sun, Moon, Contrast, Replace, Palette, BrushCleaning, WandSparkles,
  Type, TextCursor, SquareDashedText, TypeOutline,
  Crosshair, Ruler, StickyNote, Hash, Slice, SquareMousePointer, LayoutTemplate, Scan,
};

const LONG_PRESS_MS = 350;
const ORDER_KEY = 'photobaer.toolOrder';
const DRAG_TYPE = 'application/x-photobaer-tool';

interface Props {
  active: string; setActive: (id: string) => void;
  lastUsed: Record<string, string>; setLastUsed: (u: Record<string, string>) => void;
  fg: Rgb; bg: Rgb; openPicker: (which: 'fg' | 'bg') => void; swap: () => void; reset: () => void;
  quickMask: boolean; setQuickMask: (v: boolean) => void;
}

export function ToolBar({ active, setActive, lastUsed, setLastUsed, fg, bg, openPicker, swap, reset, quickMask, setQuickMask }: Props) {
  const [flyout, setFlyoutState] = useState<{ id: string; top: number; left: number } | null>(null);
  // The flyout is fixed so the scrolling tool list does not clip it.
  const setFlyout = (id: string | null, el?: HTMLElement) => {
    const r = el?.getBoundingClientRect();
    setFlyoutState(id && r ? { id, top: r.top, left: r.right + 4 } : null);
  };
  const keepInView = (ul: HTMLUListElement | null) => {
    if (ul && ul.getBoundingClientRect().bottom > innerHeight - 8) ul.style.top = `${Math.max(8, innerHeight - 8 - ul.offsetHeight)}px`;
  };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [order, setOrder] = useState(() => loadOrder(ORDER_KEY, SLOTS.map(s => s.id)));
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const move = (id: string, target: string, after: boolean) => setOrder(o => { const next = moveItem(o, id, target, after); saveOrder(ORDER_KEY, next); return next; });
  const slots = order.map(id => SLOTS.find(s => s.id === id)!);
  // The menubar sits above the scrim, so a press there must close the flyout too.
  useEffect(() => {
    if (!flyout) return;
    const close = (e: PointerEvent) => { if (!(e.target as Element).closest?.('.flyout')) setFlyoutState(null); };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [flyout]);

  const currentOf = (slot: Slot) => (SLOTS.find(s => s.id === slot.id)!.tools.includes(active) ? active : lastUsed[slot.id]);

  function choose(slot: Slot, toolId: string) {
    setLastUsed({ ...lastUsed, [slot.id]: toolId });
    setActive(toolId);
    setFlyout(null);
  }

  function pressSlot(slot: Slot) {
    if (active !== currentOf(slot)) choose(slot, currentOf(slot));
    else choose(slot, cycleTool(slot, currentOf(slot)));
  }

  return (
    <div className="toolbar" role="toolbar" aria-label="Tools" aria-orientation="vertical" data-active-tool={active}
      onKeyDown={e => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button.slot'));
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (i < 0) return;
        e.preventDefault();
        // Alt+Arrow moves the focused tool slot.
        if (e.altKey) {
          const j = i + (e.key === 'ArrowDown' ? 1 : -1);
          if (j >= 0 && j < buttons.length) move(buttons[i].dataset.slot!, buttons[j].dataset.slot!, j > i);
          return;
        }
        buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
      }}
    >
      <div className="toolbar-main">
        {slots.map(slot => {
          const toolId = currentOf(slot);
          const tool = TOOLS[toolId];
          const Icon = ICONS[tool.icon];
          return (
            <div key={slot.id} className={`tool-slot${drop?.id === slot.id ? (drop.after ? ' drop-after' : ' drop-before') : ''}`}
              onDragOver={e => {
                if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setDrop({ id: slot.id, after: e.clientY > r.top + r.height / 2 });
              }}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null); }}
              onDrop={e => {
                const from = e.dataTransfer.getData(DRAG_TYPE);
                const d = drop;
                setDrop(null);
                if (!from || !d) return;
                e.preventDefault();
                move(from, slot.id, d.after);
              }}
            >
              <button
                className="slot" data-slot={slot.id} aria-label={tool.label} aria-pressed={active === toolId}
                title={slot.key ? `${tool.label} (${slot.key.toUpperCase()})` : tool.label}
                onClick={() => pressSlot(slot)}
                onContextMenu={e => { e.preventDefault(); setFlyout(slot.id, e.currentTarget); }}
                onPointerDown={e => { const el = e.currentTarget; timer.current = setTimeout(() => setFlyout(slot.id, el), LONG_PRESS_MS); }}
                onPointerUp={() => { if (timer.current) clearTimeout(timer.current); }}
                onPointerLeave={() => { if (timer.current) clearTimeout(timer.current); }}
                draggable aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                onDragStart={e => {
                  if (timer.current) clearTimeout(timer.current);
                  e.dataTransfer.setData(DRAG_TYPE, slot.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => setDrop(null)}
              >
                <Icon size={18} strokeWidth={1.75} />
                {slot.tools.length > 1 && <span className="corner-mark" />}
              </button>
              {flyout?.id === slot.id && (
                <>
                  {/* A right-click on another slot opens its flyout instead of the browser menu. */}
                  <div className="scrim" onClick={() => setFlyout(null)} onContextMenu={e => {
                    e.preventDefault();
                    const hit = document.elementsFromPoint(e.clientX, e.clientY).find(el => el instanceof HTMLElement && el.dataset.slot) as HTMLElement | undefined;
                    setFlyout(hit?.dataset.slot ?? null, hit);
                  }} />
                  <ul className="flyout" role="menu" ref={keepInView} style={{ top: flyout.top, left: flyout.left }}>
                    {slot.tools.map(id => {
                      const t = TOOLS[id];
                      const TIcon = ICONS[t.icon];
                      return (
                        <li key={id}>
                          <button role="menuitem" aria-label={t.label} aria-pressed={active === id} onClick={() => choose(slot, id)}>
                            <TIcon size={16} strokeWidth={1.75} /><span>{t.label}</span><kbd>{t.key.toUpperCase()}</kbd>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="toolbar-footer">
        <button aria-label="Foreground color" title="Foreground color" className="chip fg" style={{ background: rgbToHex(fg) }} onClick={() => openPicker('fg')} />
        <button aria-label="Background color" title="Background color" className="chip bg" style={{ background: rgbToHex(bg) }} onClick={() => openPicker('bg')} />
        <button aria-label="Swap foreground and background" title="Swap (X)" onClick={swap}><ArrowLeftRight size={14} strokeWidth={1.75} /></button>
        <button aria-label="Reset to default colors" title="Reset (D)" onClick={reset}><RotateCcw size={14} strokeWidth={1.75} /></button>
        <button aria-label="Toggle quick mask" title="Quick mask (Q)" aria-pressed={quickMask} onClick={() => setQuickMask(!quickMask)}>QM</button>
      </div>
    </div>
  );
}
