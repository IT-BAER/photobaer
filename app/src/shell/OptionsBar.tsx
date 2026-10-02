import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignHorizontalDistributeEnd,
  AlignHorizontalDistributeStart, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, AlignVerticalDistributeEnd, AlignVerticalDistributeStart,
  ChevronDown, CircleSlash2, Droplet, Droplets, Scaling, SprayCan, type LucideIcon,
} from 'lucide-react';
import type { AlignMode } from '../worker/types.ts';
import { ALIGN_ITEMS } from '../app/helpers.ts';
import { rgbToHex, type Rgb } from './color.ts';
import { ICONS } from './ToolBar.tsx';
import { saveToolOptions, type Tool } from './tools.ts';

export type ToolOptions = Record<string, number | string | boolean>;

const OPTION_ICONS: Record<string, LucideIcon> = { CircleSlash2, Droplet, Droplets, Scaling, SprayCan };

const ALIGN_ICONS: LucideIcon[] = [
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal, AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignVerticalDistributeStart, AlignVerticalDistributeCenter, AlignVerticalDistributeEnd, AlignHorizontalDistributeStart, AlignHorizontalDistributeCenter, AlignHorizontalDistributeEnd,
];

// Move tool align and distribute buttons for the selected layers (`count`); same order as ALIGN_ITEMS.
export function AlignButtons({ count, onAlign }: { count: number; onAlign: (mode: AlignMode) => void }) {
  return (
    <span className="options-item" role="group" aria-label="Align and distribute">
      {ALIGN_ITEMS.map(([mode, text], i) => {
        const Icon = ALIGN_ICONS[i], label = `${mode.startsWith('align') ? 'Align' : 'Distribute'} ${text}`;
        return <button key={mode} type="button" className="opt-icon" aria-label={label} title={label} disabled={count < (i < 6 ? 1 : 3)} onClick={() => onAlign(mode)}><Icon size={16} /></button>;
      })}
    </span>
  );
}

// Rounds to the step's precision and clamps into [min, max].
function fit(v: number, min = -Infinity, max = Infinity, step = 1): number {
  const d = step < 1 ? Math.min(4, Math.ceil(-Math.log10(step))) : 0;
  return Math.min(max, Math.max(min, Number((Math.round(v / step) * step).toFixed(d))));
}

// Anchored under `anchor` and portalled, so the bar's horizontal scroll does not clip it.
function Popover({ anchor, onClose, children }: { anchor: HTMLElement; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', down); window.removeEventListener('keydown', key, true); };
  }, [anchor, onClose]);
  const r = anchor.getBoundingClientRect();
  return createPortal(
    <div ref={ref} className="options-popover" role="dialog" style={{ left: Math.max(8, Math.min(r.left, window.innerWidth - 248)), top: r.bottom + 6 }}>{children}</div>,
    document.body,
  );
}

function usePopover() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return { open, toggle: () => setOpen(o => !o), close };
}

interface FieldProps {
  label: string; value: number; min?: number; max?: number; step?: number; unit?: string;
  slider?: boolean; onChange: (v: number) => void;
}

// "Label:" scrubs by dragging (one step per px), the input takes typed values and the chevron opens a slider.
function NumberField({ label, value, min, max, step = 1, unit, slider, onChange }: FieldProps) {
  const wrap = useRef<HTMLSpanElement>(null);
  const pop = usePopover();
  const set = (v: number) => { if (Number.isFinite(v)) onChange(fit(v, min, max, step)); };
  const scrub = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget, x0 = e.clientX, v0 = value;
    el.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => set(v0 + (m.clientX - x0) * step);
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return (
    <span className="opt-number" ref={wrap}>
      <span className="opt-scrub" onPointerDown={scrub}>{label}:</span>
      <input type="number" aria-label={label} min={min} max={max} step={step} value={value} onChange={e => set(e.currentTarget.valueAsNumber)} />
      {unit && <span className="opt-unit">{unit}</span>}
      {slider && (
        <button type="button" className="opt-drop" aria-label={`${label} slider`} aria-expanded={pop.open} onClick={pop.toggle}><ChevronDown size={12} /></button>
      )}
      {pop.open && wrap.current && (
        <Popover anchor={wrap.current} onClose={pop.close}>
          <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={e => set(e.currentTarget.valueAsNumber)} />
        </Popover>
      )}
    </span>
  );
}

// Size slider positions 0..1000 map to 1..5000 px on a square curve, so small sizes get most of the travel.
const sizeToPos = (s: number) => Math.round(Math.sqrt((s - 1) / 4999) * 1000);
const posToSize = (p: number) => Math.round(1 + 4999 * (p / 1000) ** 2);

// Brush tip button: a preview of size and hardness; its popover holds both fields.
function BrushTip({ size, hardness, setSize, setHardness }: { size: number; hardness?: number; setSize: (v: number) => void; setHardness: (v: number) => void }) {
  const btn = useRef<HTMLButtonElement>(null);
  const pop = usePopover();
  const soft = hardness ?? 100;
  return (
    <>
      <button ref={btn} type="button" className="brush-tip" aria-label="Brush size and hardness" aria-expanded={pop.open} onClick={pop.toggle}>
        <span className="brush-tip-preview" style={{ background: `radial-gradient(circle closest-side, currentColor ${soft}%, transparent 100%)` }} />
        <span>{size}</span>
        <ChevronDown size={12} />
      </button>
      {pop.open && btn.current && (
        <Popover anchor={btn.current} onClose={pop.close}>
          <NumberField label="Size" value={size} min={1} max={5000} unit="px" onChange={setSize} />
          <input type="range" aria-label="Size" min={0} max={1000} value={sizeToPos(size)} onChange={e => setSize(posToSize(e.currentTarget.valueAsNumber))} />
          {hardness !== undefined && (
            <>
              <NumberField label="Hardness" value={hardness} min={0} max={100} unit="%" onChange={setHardness} />
              <input type="range" aria-label="Hardness" min={0} max={100} value={hardness} onChange={e => setHardness(e.currentTarget.valueAsNumber)} />
            </>
          )}
        </Popover>
      )}
    </>
  );
}

interface ControlProps { option: Tool['options'][number]; value: number | string | boolean; commit: (id: string, v: number | string | boolean) => void; fg: Rgb }

// Generic control for one option, keyed off its schema kind.
function Control({ option: { id, kind, label, min, max, step, unit, choices, icon }, value, commit, fg }: ControlProps) {
  if (kind === 'boolean' && icon) {
    const Icon = OPTION_ICONS[icon];
    return (
      <button type="button" className="opt-icon" aria-label={label} title={label} aria-pressed={value as boolean} onClick={() => commit(id, !value)}>
        <Icon size={16} />
      </button>
    );
  }
  if (kind === 'boolean') {
    return (
      <label className="opt-bool">
        <input type="checkbox" checked={value as boolean} onChange={e => commit(id, e.currentTarget.checked)} />
        {label}
      </label>
    );
  }
  if (kind === 'color') {
    return (
      <label className="opt-color">
        {label}
        <input type="color" value={(value as string) || rgbToHex(fg)} onChange={e => commit(id, e.currentTarget.value)} />
      </label>
    );
  }
  if (kind === 'segmented') {
    return (
      <div className="opt-segmented" role="group" aria-label={label}>
        {choices?.map(c => (
          <button key={c} type="button" aria-pressed={value === c} onClick={() => commit(id, c)}>{c}</button>
        ))}
      </div>
    );
  }
  if (kind === 'select') {
    return (
      <label className="opt-select">
        {label}
        <select value={value as string} onChange={e => commit(id, e.currentTarget.value)}>
          {choices?.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
    );
  }
  const percent = kind === 'percent';
  return (
    <NumberField
      label={label} value={value as number} min={min} max={percent ? 100 : max} step={step}
      unit={percent ? '%' : unit} slider={percent} onChange={v => commit(id, v)}
    />
  );
}

interface Props { tool: Tool; values: ToolOptions; setValues: (v: ToolOptions) => void; custom?: Record<string, ReactNode>; fg?: Rgb }

export function OptionsBar({ tool, values, setValues, custom = {}, fg = [0, 0, 0] }: Props) {
  // Persists to the tool's localStorage slot on every commit, so options survive a reload.
  const latest = useRef(values);
  latest.current = values;
  const commit = (id: string, v: number | string | boolean) => {
    const next = { ...latest.current, [id]: v };
    latest.current = next;
    setValues(next);
    saveToolOptions(tool, next);
  };
  const ToolIcon = ICONS[tool.icon];
  // Painting tools fold Size and Hardness into the brush tip button.
  const tip = tool.cursor === 'none' && tool.options.some(o => o.id === 'size');
  return (
    <div className="options-bar" role="toolbar" aria-label={`${tool.label} options`}>
      <span className="options-tool" title={tool.label}>{ToolIcon && <ToolIcon size={16} />}</span>
      {tool.options.map(o => {
        if (tip && o.id === 'hardness') return null;
        // The Healing Brush shows its pattern picker only with Source: Pattern.
        if (o.id === 'pattern' && values.source === 'sampled') return null;
        const control = tip && o.id === 'size'
          ? <BrushTip size={values.size as number} hardness={values.hardness as number | undefined} setSize={v => commit('size', v)} setHardness={v => commit('hardness', v)} />
          : o.kind === 'custom' ? <span>{custom[o.id]}</span> : <Control option={o} value={values[o.id]} commit={commit} fg={fg} />;
        return (
          <span key={o.id} className="options-item">
            {o.sep && <span className="options-divider" aria-hidden="true" />}
            {control}
          </span>
        );
      })}
    </div>
  );
}
