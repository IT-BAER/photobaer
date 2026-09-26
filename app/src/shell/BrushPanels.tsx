import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Grid2x2, Spline } from 'lucide-react';
import { BLEND_MODES, CONTROLS, defaultDynamics, type BrushPreset, type Dyn, type Dynamics, type Tip, type TipRecord } from '../brushes/preset.ts';
import { groupPresets, smoothingSettings, type PaintTool } from '../brushes/brushParams.ts';
import type { AbrReport } from '../brushes/abr.ts';

type Opts = Record<string, number | string | boolean>;
export type Preview = (params: Record<string, unknown>, w: number, h: number) => Promise<{ w: number; h: number; data: ArrayBuffer }>;

// One brushPreview request per animation frame across all previews; the newest params per key win.
const queue = new Map<string, { params: Record<string, unknown>; w: number; h: number; done: (img: ImageData | null) => void }>();
let frame = 0;
function requestPreview(fn: Preview, key: string, params: Record<string, unknown>, w: number, h: number, done: (img: ImageData | null) => void) {
  queue.set(key, { params, w, h, done });
  if (frame) return;
  const tick = () => {
    const next = queue.entries().next();
    if (next.done) { frame = 0; return; }
    const [k, r] = next.value;
    queue.delete(k);
    fn(r.params, r.w, r.h).then(p => r.done(new ImageData(new Uint8ClampedArray(p.data), p.w, p.h)), () => r.done(null));
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}

export function StrokePreview({ preview, params, id, w = 220, h = 64 }: { preview: Preview; params: Record<string, unknown>; id: string; w?: number; h?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const key = JSON.stringify(params);
  useEffect(() => {
    let alive = true;
    requestPreview(preview, id, JSON.parse(key), w, h, img => { if (alive && img) ref.current?.getContext('2d')?.putImageData(img, 0, 0); });
    return () => { alive = false; };
  }, [preview, key, id, w, h]);
  return <canvas ref={ref} className="stroke-preview" width={w} height={h} data-preview={id} aria-label="Stroke preview" />;
}

export function TipThumb({ tip, tipBitmap, size = 32 }: { tip: Tip; tipBitmap: (ref: string) => TipRecord | undefined; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);
    const bmp = tip.kind === 'sampled' ? tipBitmap(tip.tipRef) : undefined;
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate((-tip.angle * Math.PI) / 180);
    ctx.scale(tip.flipX ? -1 : 1, (tip.flipY ? -1 : 1) * Math.max(0.05, tip.roundness));
    const r = size / 2 - 2;
    if (bmp) {
      const img = new ImageData(bmp.width, bmp.height);
      for (let i = 0; i < bmp.alpha.length; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 222; img.data[i * 4 + 3] = bmp.alpha[i]; }
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      c.getContext('2d')!.putImageData(img, 0, 0);
      const k = (2 * r) / Math.max(bmp.width, bmp.height);
      ctx.drawImage(c, (-bmp.width * k) / 2, (-bmp.height * k) / 2, bmp.width * k, bmp.height * k);
    } else {
      const g = ctx.createRadialGradient(0, 0, r * Math.min(0.99, tip.hardness), 0, 0, r);
      g.addColorStop(0, '#dee0e3');
      g.addColorStop(1, 'rgba(222,224,227,0)');
      ctx.fillStyle = g;
      if (tip.kind === 'computed' && tip.profile === 'square') ctx.fillRect(-r, -r, 2 * r, 2 * r);
      else { ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore();
  }, [tip, tipBitmap, size]);
  return <canvas ref={ref} className="tip-thumb" width={size} height={size} aria-hidden="true" />;
}

// Controls: a slider row (range + number), a number row and a checkbox row.
function Slider({ label, value, min = 0, max = 100, unit = '%', disabled, onChange }: { label: string; value: number; min?: number; max?: number; unit?: string; disabled?: boolean; onChange: (v: number) => void }) {
  const v = Math.min(max, Math.max(min, value));
  const set = (n: number) => { if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n))); };
  return (
    <label className="param-row">
      <span className="param-label">{label}</span>
      <input type="range" min={min} max={max} step={1} value={v} disabled={disabled} aria-label={label} onChange={e => set(e.currentTarget.valueAsNumber)} />
      <input type="number" min={min} max={max} value={Math.round(value)} disabled={disabled} aria-label={`${label} value`} onChange={e => set(e.currentTarget.valueAsNumber)} />
      <span className="param-unit">{unit}</span>
    </label>
  );
}
function NumberRow({ label, value, min, max, unit = '', disabled, onChange }: { label: string; value: number; min: number; max: number; unit?: string; disabled?: boolean; onChange: (v: number) => void }) {
  return (
    <label className="param-row">
      <span className="param-label">{label}</span>
      <input type="number" min={min} max={max} value={Math.round(value * 100) / 100} disabled={disabled} aria-label={label}
        onChange={e => { const n = e.currentTarget.valueAsNumber; if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n))); }} />
      <span className="param-unit">{unit}</span>
    </label>
  );
}
function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return <label className="param-toggle"><input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.currentTarget.checked)} />{label}</label>;
}
function ModeRow({ value, disabled, onChange }: { value: string; disabled?: boolean; onChange: (v: Dynamics['texture']['mode']) => void }) {
  return (
    <label className="param-row">
      <span className="param-label">Mode</span>
      <select value={value} disabled={disabled} onChange={e => onChange(e.currentTarget.value as Dynamics['texture']['mode'])}>
        {BLEND_MODES.map(m => <option key={m} value={m}>{m}</option>)}
      </select>
    </label>
  );
}
const CONTROL_LABELS: Record<string, string> = {
  off: 'Off', fade: 'Fade', penPressure: 'Pen Pressure', penTilt: 'Pen Tilt', stylusWheel: 'Stylus Wheel',
  rotation: 'Rotation', initialDirection: 'Initial Direction', direction: 'Direction',
};
const pct = (x: number) => Math.round(x * 1000) / 10;
function DynRow({ label, d, disabled, minimum = true, onChange }: { label: string; d: Dyn; disabled?: boolean; minimum?: boolean; onChange: (p: Partial<Dyn>) => void }) {
  return (
    <div className="param-dyn">
      <label className="param-row">
        <span className="param-label">{label}</span>
        <select value={d.control} disabled={disabled} aria-label={`${label} control`} onChange={e => onChange({ control: e.currentTarget.value as Dyn['control'] })}>
          {CONTROLS.map(c => <option key={c} value={c}>{CONTROL_LABELS[c]}</option>)}
        </select>
      </label>
      {d.control === 'fade' && <NumberRow label="Fade Steps" min={1} max={9999} value={d.fadeSteps} disabled={disabled} onChange={v => onChange({ fadeSteps: Math.round(v) })} />}
      <Slider label={`${label} Jitter`} value={pct(d.jitter)} disabled={disabled} onChange={v => onChange({ jitter: v / 100 })} />
      {minimum && <Slider label={`${label} Minimum`} value={pct(d.minimum)} disabled={disabled} onChange={v => onChange({ minimum: v / 100 })} />}
    </div>
  );
}

// Angle / roundness gizmo: drag the arrow to turn the tip, drag the dot to squash it.
export function TipGizmo({ angle, roundness, disabled, onChange }: { angle: number; roundness: number; disabled?: boolean; onChange: (k: 'angle' | 'roundness', v: number) => void }) {
  const drag = useRef<'angle' | 'roundness' | null>(null);
  const rad = (angle * Math.PI) / 180, R = 34;
  const ax = 44 + R * Math.cos(rad), ay = 44 - R * Math.sin(rad);
  const rx = 44 - R * roundness * Math.sin(rad), ry = 44 - R * roundness * Math.cos(rad);
  const move = (e: PointerEvent<SVGSVGElement>) => {
    if (!drag.current || disabled) return;
    const b = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - b.left) * 88) / b.width - 44, y = 44 - ((e.clientY - b.top) * 88) / b.height;
    if (drag.current === 'angle') onChange('angle', Math.round((Math.atan2(y, x) * 180) / Math.PI));
    else onChange('roundness', Math.min(100, Math.max(1, Math.round((Math.hypot(x, y) / R) * 100))));
  };
  const grab = (k: 'angle' | 'roundness') => (e: PointerEvent<SVGCircleElement>) => { if (disabled) return; drag.current = k; e.currentTarget.ownerSVGElement?.setPointerCapture(e.pointerId); };
  return (
    <svg className="tip-gizmo" viewBox="0 0 88 88" width={88} height={88} aria-label="Angle and roundness" aria-disabled={disabled || undefined}
      onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <circle cx={44} cy={44} r={R} className="gizmo-ring" />
      <ellipse cx={44} cy={44} rx={R} ry={R * roundness} transform={`rotate(${-angle} 44 44)`} className="gizmo-tip" />
      <line x1={44} y1={44} x2={ax} y2={ay} className="gizmo-axis" />
      <circle cx={ax} cy={ay} r={5} className="gizmo-handle" data-handle="angle" onPointerDown={grab('angle')} />
      <circle cx={rx} cy={ry} r={5} className="gizmo-handle" data-handle="roundness" onPointerDown={grab('roundness')} />
    </svg>
  );
}

// `tool`: the section edits the active tool's options (usable without a preset), else the selected preset.
interface Section { id: string; label: string; enabled?: boolean; onEnabled?: (v: boolean) => void; disabled?: boolean; tool?: boolean; body: ReactNode }

export interface BrushSettingsProps {
  tool: PaintTool; options: Opts; setOption: (k: string, v: number | boolean) => void;
  preset: BrushPreset | null; presets: BrushPreset[]; selectPreset: (p: BrushPreset) => void;
  editDynamics: (fn: (d: Dynamics) => void) => void; patterns: { id: string; name: string }[];
  tipBitmap: (ref: string) => TipRecord | undefined; preview: Preview; previewParams: Record<string, unknown>;
}

export function BrushSettingsPanel(p: BrushSettingsProps) {
  const { tool, options: o, setOption, preset, presets, editDynamics: edit } = p;
  const [open, setOpen] = useState('tip');
  useEffect(() => setOpen('tip'), [tool]);
  const d = preset?.dynamics;
  const none = !d;
  const pencil = tool === 'pencil' || (tool === 'eraser' && o.mode === 'pencil');
  const base = preset?.tip;
  const tip = {
    diameter: Number(o.size ?? base?.diameter ?? 30), hardness: pencil ? 100 : Number(o.hardness ?? (base?.hardness ?? 1) * 100),
    angle: Number(o.angle ?? base?.angle ?? 0), roundness: Number(o.roundness ?? (base?.roundness ?? 1) * 100),
    spacing: Number(o.spacing ?? (base?.spacing ?? 0.25) * 100), flipX: Boolean(o.flipX ?? base?.flipX ?? false), flipY: Boolean(o.flipY ?? base?.flipY ?? false),
  };
  const sm = smoothingSettings(preset, o);
  const wet = Boolean(o.wetEdges ?? d?.wetEdges ?? false);
  const buildUp = !pencil && Boolean(o.airbrush ?? d?.buildUp ?? false);
  const dd = d ?? DEFAULT_DYN;
  const sections: Section[] = [
    {
      id: 'tip', label: 'Brush Tip Shape', tool: true, body: (
        <>
          <ul className="tip-grid" aria-label="Brush tips">
            {presets.map(x => (
              <li key={x.id}>
                <button className="tip-cell" aria-label={x.name} title={x.name} aria-pressed={x.id === preset?.id} onClick={() => p.selectPreset(x)}>
                  <TipThumb tip={x.tip} tipBitmap={p.tipBitmap} size={28} /><small>{Math.round(x.tip.diameter)}</small>
                </button>
              </li>
            ))}
          </ul>
          <Slider label="Size" unit="px" min={1} max={5000} value={tip.diameter} onChange={v => setOption('size', Math.round(v))} />
          <div className="param-pair">
            <Toggle label="Flip X" checked={tip.flipX} onChange={v => setOption('flipX', v)} />
            <Toggle label="Flip Y" checked={tip.flipY} onChange={v => setOption('flipY', v)} />
          </div>
          <div className="tip-shape">
            <TipGizmo angle={tip.angle} roundness={tip.roundness / 100} onChange={(k, v) => setOption(k, v)} />
            <div>
              <NumberRow label="Angle" unit="°" min={-180} max={180} value={tip.angle} onChange={v => setOption('angle', v)} />
              <NumberRow label="Roundness" unit="%" min={1} max={100} value={tip.roundness} onChange={v => setOption('roundness', v)} />
            </div>
          </div>
          <Slider label="Hardness" value={tip.hardness} disabled={base?.kind === 'sampled' || pencil} onChange={v => setOption('hardness', v)} />
          <Slider label="Spacing" min={1} max={1000} value={tip.spacing} onChange={v => setOption('spacing', v)} />
        </>
      ),
    },
    {
      id: 'shape', label: 'Shape Dynamics', enabled: dd.shape.enabled, onEnabled: v => edit(x => { x.shape.enabled = v; }), body: (
        <>
          <DynRow label="Size" d={dd.shape.size} onChange={c => edit(x => { x.shape.size = { ...x.shape.size, ...c }; })} />
          <DynRow label="Angle" d={dd.shape.angle} minimum={false} onChange={c => edit(x => { x.shape.angle = { ...x.shape.angle, ...c }; })} />
          <DynRow label="Roundness" d={dd.shape.roundness} onChange={c => edit(x => { x.shape.roundness = { ...x.shape.roundness, ...c }; })} />
          <Toggle label="Flip X Jitter" checked={dd.shape.flipXJitter} onChange={v => edit(x => { x.shape.flipXJitter = v; })} />
          <Toggle label="Flip Y Jitter" checked={dd.shape.flipYJitter} onChange={v => edit(x => { x.shape.flipYJitter = v; })} />
          <Toggle label="Angle Follows Path" checked={dd.angleFollowsPath} onChange={v => edit(x => { x.angleFollowsPath = v; })} />
          <Toggle label="Brush Projection" checked={dd.shape.brushProjection} onChange={v => edit(x => { x.shape.brushProjection = v; })} />
        </>
      ),
    },
    {
      id: 'scattering', label: 'Scattering', enabled: dd.scattering.enabled, onEnabled: v => edit(x => { x.scattering.enabled = v; }), body: (
        <>
          <Slider label="Scatter" max={1000} value={dd.scattering.amount * 100} onChange={v => edit(x => { x.scattering.amount = v / 100; })} />
          <Toggle label="Both Axes" checked={dd.scattering.bothAxes} onChange={v => edit(x => { x.scattering.bothAxes = v; })} />
          <DynRow label="Scatter" d={dd.scattering.scatter} onChange={c => edit(x => { x.scattering.scatter = { ...x.scattering.scatter, ...c }; })} />
          <NumberRow label="Count" min={1} max={16} value={dd.scattering.count} onChange={v => edit(x => { x.scattering.count = Math.round(v); })} />
          <DynRow label="Count" d={dd.scattering.countJitter} onChange={c => edit(x => { x.scattering.countJitter = { ...x.scattering.countJitter, ...c }; })} />
        </>
      ),
    },
    {
      id: 'texture', label: 'Texture', enabled: dd.texture.enabled, onEnabled: v => edit(x => { x.texture.enabled = v; }), body: (
        <>
          <label className="param-row">
            <span className="param-label">Pattern</span>
            <select value={dd.texture.patternRef ?? ''} onChange={e => { const v = e.currentTarget.value; edit(x => { x.texture.patternRef = v || null; }); }}>
              <option value="">None</option>
              {p.patterns.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <Toggle label="Invert" checked={dd.texture.invert} onChange={v => edit(x => { x.texture.invert = v; })} />
          <Slider label="Scale" max={1000} value={dd.texture.scale * 100} onChange={v => edit(x => { x.texture.scale = Math.max(0.01, v / 100); })} />
          <Slider label="Brightness" min={-100} value={dd.texture.brightness * 100} onChange={v => edit(x => { x.texture.brightness = v / 100; })} />
          <Slider label="Contrast" min={-100} value={dd.texture.contrast * 100} onChange={v => edit(x => { x.texture.contrast = v / 100; })} />
          <Toggle label="Texture Each Tip" checked={dd.texture.eachTip} onChange={v => edit(x => { x.texture.eachTip = v; })} />
          <ModeRow value={dd.texture.mode} onChange={v => edit(x => { x.texture.mode = v; })} />
          <Slider label="Depth" value={pct(dd.texture.depth)} onChange={v => edit(x => { x.texture.depth = v / 100; })} />
          <Slider label="Minimum Depth" value={pct(dd.texture.minimumDepth)} onChange={v => edit(x => { x.texture.minimumDepth = v / 100; })} />
          <DynRow label="Depth" d={dd.texture.depthJitter} onChange={c => edit(x => { x.texture.depthJitter = { ...x.texture.depthJitter, ...c }; })} />
        </>
      ),
    },
    {
      id: 'dual', label: 'Dual Brush', enabled: dd.dualBrush.enabled, onEnabled: v => edit(x => { x.dualBrush.enabled = v; }), body: (
        <>
          <label className="param-row">
            <span className="param-label">Tip</span>
            <select value={presets.find(x => JSON.stringify(x.tip) === JSON.stringify(dd.dualBrush.tip))?.id ?? ''}
              onChange={e => { const t = presets.find(x => x.id === e.currentTarget.value)?.tip; edit(x => { x.dualBrush.tip = t ? { ...t } : null; }); }}>
              <option value="">None</option>
              {presets.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <ModeRow value={dd.dualBrush.mode} onChange={v => edit(x => { x.dualBrush.mode = v; })} />
          <NumberRow label="Size" unit="px" min={1} max={1000} value={dd.dualBrush.size} onChange={v => edit(x => { x.dualBrush.size = v; })} />
          <Slider label="Spacing" max={1000} value={pct(dd.dualBrush.spacing)} onChange={v => edit(x => { x.dualBrush.spacing = Math.max(0.01, v / 100); })} />
          <Slider label="Scatter" max={1000} value={dd.dualBrush.scatter * 100} onChange={v => edit(x => { x.dualBrush.scatter = v / 100; })} />
          <Toggle label="Both Axes" checked={dd.dualBrush.bothAxes} onChange={v => edit(x => { x.dualBrush.bothAxes = v; })} />
          <NumberRow label="Count" min={1} max={16} value={dd.dualBrush.count} onChange={v => edit(x => { x.dualBrush.count = Math.round(v); })} />
          <Toggle label="Flip X" checked={dd.dualBrush.flipX} onChange={v => edit(x => { x.dualBrush.flipX = v; })} />
          <Toggle label="Flip Y" checked={dd.dualBrush.flipY} onChange={v => edit(x => { x.dualBrush.flipY = v; })} />
        </>
      ),
    },
    {
      id: 'color', label: 'Color Dynamics', disabled: tool === 'eraser', enabled: dd.color.enabled, onEnabled: v => edit(x => { x.color.enabled = v; }), body: (
        <>
          <Slider label="Fore/Background" value={pct(dd.color.fgBg)} onChange={v => edit(x => { x.color.fgBg = v / 100; })} />
          <Slider label="Hue" value={pct(dd.color.hueJitter)} onChange={v => edit(x => { x.color.hueJitter = v / 100; })} />
          <Slider label="Saturation" value={pct(dd.color.satJitter)} onChange={v => edit(x => { x.color.satJitter = v / 100; })} />
          <Slider label="Brightness" value={pct(dd.color.briJitter)} onChange={v => edit(x => { x.color.briJitter = v / 100; })} />
          <Slider label="Purity" min={-100} value={dd.color.purity * 100} onChange={v => edit(x => { x.color.purity = v / 100; })} />
          <Toggle label="Apply Per Tip" checked={dd.color.perTip} onChange={v => edit(x => { x.color.perTip = v; })} />
        </>
      ),
    },
    {
      id: 'transfer', label: 'Transfer', enabled: dd.transfer.enabled, onEnabled: v => edit(x => { x.transfer.enabled = v; }), body: (
        <>
          <DynRow label="Opacity" d={dd.transfer.opacity} onChange={c => edit(x => { x.transfer.opacity = { ...x.transfer.opacity, ...c }; })} />
          <DynRow label="Flow" d={dd.transfer.flow} onChange={c => edit(x => { x.transfer.flow = { ...x.transfer.flow, ...c }; })} />
        </>
      ),
    },
    {
      id: 'pose', label: 'Brush Pose', enabled: dd.pose.enabled, onEnabled: v => edit(x => { x.pose.enabled = v; }), body: (
        <>
          <Toggle label="Override Tilt" checked={dd.pose.overrideTilt} onChange={v => edit(x => { x.pose.overrideTilt = v; })} />
          <NumberRow label="Tilt X" unit="°" min={-90} max={90} value={dd.pose.tiltX} onChange={v => edit(x => { x.pose.tiltX = v; })} />
          <NumberRow label="Tilt Y" unit="°" min={-90} max={90} value={dd.pose.tiltY} onChange={v => edit(x => { x.pose.tiltY = v; })} />
          <Toggle label="Override Rotation" checked={dd.pose.overrideRotation} onChange={v => edit(x => { x.pose.overrideRotation = v; })} />
          <NumberRow label="Rotation" unit="°" min={-180} max={180} value={dd.pose.rotation} onChange={v => edit(x => { x.pose.rotation = v; })} />
          <Toggle label="Override Pressure" checked={dd.pose.overridePressure} onChange={v => edit(x => { x.pose.overridePressure = v; })} />
          <Slider label="Pressure" value={pct(dd.pose.pressure)} onChange={v => edit(x => { x.pose.pressure = v / 100; })} />
        </>
      ),
    },
    {
      id: 'noise', label: 'Noise', enabled: dd.noise > 0, onEnabled: v => edit(x => { x.noise = v ? 0.1 : 0; }),
      body: <Slider label="Noise" value={pct(dd.noise)} onChange={v => edit(x => { x.noise = v / 100; })} />,
    },
    { id: 'wetEdges', label: 'Wet Edges', disabled: tool === 'eraser', enabled: wet, onEnabled: v => setOption('wetEdges', v), body: <Toggle label="Wet Edges" checked={wet} onChange={v => setOption('wetEdges', v)} />, tool: true },
    { id: 'buildUp', label: 'Build-up', disabled: pencil, enabled: buildUp, onEnabled: v => setOption('airbrush', v), body: <Toggle label="Build-up" checked={buildUp} onChange={v => setOption('airbrush', v)} />, tool: true },
    {
      id: 'smoothing', label: 'Smoothing', enabled: sm.amount > 0, onEnabled: v => setOption('smoothing', v ? 10 : 0), tool: true, body: (
        <>
          <Slider label="Smoothing" value={sm.amount} onChange={v => setOption('smoothing', v)} />
          <Toggle label="Pulled String" checked={sm.pulledString} onChange={v => setOption('pulledString', v)} />
          <Toggle label="Stroke Catch-up" checked={sm.catchUp} disabled={sm.pulledString} onChange={v => setOption('strokeCatchUp', v)} />
          <Toggle label="Catch-up on Stroke End" checked={sm.catchUpOnEnd} disabled={sm.pulledString} onChange={v => setOption('catchUpOnStrokeEnd', v)} />
          <Toggle label="Adjust for Zoom" checked={sm.adjustForZoom} onChange={v => setOption('adjustForZoom', v)} />
        </>
      ),
    },
    {
      id: 'protectTexture', label: 'Protect Texture', enabled: dd.protectTexture, onEnabled: v => edit(x => { x.protectTexture = v; }),
      body: <Toggle label="Protect Texture" checked={dd.protectTexture} onChange={v => edit(x => { x.protectTexture = v; })} />,
    },
  ];
  const current = sections.find(s => s.id === open) ?? sections[0];
  const off = (s: Section) => !!s.disabled || (none && !s.tool);
  return (
    <div className="brush-settings" aria-label="Brush Settings">
      {none && <p className="panel-note">No brush preset selected: pick one in Brushes to edit dynamics. The tip applies to the active tool.</p>}
      <div className="brush-settings-body">
        <div className="brush-categories" role="tablist" aria-orientation="vertical" aria-label="Brush settings sections">
          {sections.map(s => (
            <div key={s.id} className="brush-category" data-active={s.id === current.id}>
              {s.enabled !== undefined && (
                <input type="checkbox" aria-label={`Enable ${s.label}`} checked={s.enabled} disabled={off(s)} onChange={e => s.onEnabled?.(e.currentTarget.checked)} />
              )}
              <button role="tab" aria-selected={s.id === current.id} disabled={!!s.disabled} onClick={() => setOpen(s.id)}>{s.label}</button>
            </div>
          ))}
        </div>
        <section className="brush-section" role="tabpanel" aria-label={current.label}>
          <h3>{current.label}</h3>
          <fieldset disabled={off(current) || current.enabled === false}>{current.body}</fieldset>
        </section>
      </div>
      <div className="brush-settings-preview">
        <span>Stroke preview</span>
        <StrokePreview preview={p.preview} params={p.previewParams} id="settings" />
      </div>
    </div>
  );
}

const DEFAULT_DYN = defaultDynamics();

export interface BrushesProps {
  presets: BrushPreset[]; selected: BrushPreset | null; recent: string[]; selectPreset: (p: BrushPreset) => void; deletePreset: (id: string) => void;
  options: Opts; setOption: (k: string, v: number | boolean) => void; tipBitmap: (ref: string) => TipRecord | undefined;
  preview: Preview; previewFor: (p: BrushPreset | null) => Record<string, unknown>;
  importAbr: (f: File) => Promise<{ added: number; name: string; report: AbrReport } | { error: string }>; openSettings: () => void;
}

export function BrushesPanel(p: BrushesProps) {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'tips' | 'strokes'>('tips');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [banner, setBanner] = useState<{ text: string; details: string[] } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();
  const shown = q ? p.presets.filter(x => x.name.toLowerCase().includes(q) || x.id.toLowerCase().includes(q)) : p.presets;
  const recent = p.recent.map(id => p.presets.find(x => x.id === id)).filter((x): x is BrushPreset => !!x);
  const sel = p.selected;
  const size = Number(p.options.size ?? sel?.tip.diameter ?? 30), hardness = Number(p.options.hardness ?? (sel?.tip.hardness ?? 1) * 100);
  const liveTip: Tip = { ...(sel?.tip ?? { kind: 'computed', profile: 'round', diameter: 30, hardness: 1, angle: 0, roundness: 1, spacing: 0.25, flipX: false, flipY: false }), diameter: size, hardness: hardness / 100 };
  const context = (id: string) => (e: MouseEvent) => { e.preventDefault(); setMenu({ id, x: e.clientX, y: e.clientY }); };
  async function load(f: File) {
    setBanner(null);
    const r = await p.importAbr(f);
    if ('error' in r) { setBanner({ text: r.error, details: [] }); return; }
    const details = [...r.report.warnings, ...r.report.skipped];
    if (r.added === 0) { setBanner({ text: details[0] ?? `No brushes found in ${r.name}.`, details }); return; }
    setBanner({ text: `Loaded ${r.added} brush${r.added === 1 ? '' : 'es'} from ${r.name}.`, details });
  }
  return (
    <div className="brushes-panel" aria-label="Brushes" onClick={() => setMenu(null)}>
      <div className="brush-mini-editor">
        <TipThumb tip={liveTip} tipBitmap={p.tipBitmap} size={44} />
        <div>
          <Slider label="Size" unit="px" min={1} max={5000} value={size} onChange={v => p.setOption('size', Math.round(v))} />
          <Slider label="Hardness" value={hardness} disabled={sel?.tip.kind === 'sampled'} onChange={v => p.setOption('hardness', v)} />
        </div>
      </div>
      <div className="brush-toolbar">
        <input type="search" placeholder="Search" aria-label="Search brushes" value={query} onChange={e => setQuery(e.currentTarget.value)} />
        <div role="group" aria-label="Brush view">
          <button aria-label="Tip thumbnails" title="Tip thumbnails" aria-pressed={view === 'tips'} onClick={() => setView('tips')}><Grid2x2 size={14} strokeWidth={1.75} /></button>
          <button aria-label="Stroke previews" title="Stroke previews" aria-pressed={view === 'strokes'} onClick={() => setView('strokes')}><Spline size={14} strokeWidth={1.75} /></button>
        </div>
      </div>
      {recent.length > 0 && (
        <div className="brush-recent" aria-label="Recent brushes">
          {recent.map(x => (
            <button key={x.id} aria-label={x.name} title={x.name} aria-pressed={x.id === sel?.id} onClick={() => p.selectPreset(x)} onContextMenu={context(x.id)}>
              <TipThumb tip={x.tip} tipBitmap={p.tipBitmap} size={24} />
            </button>
          ))}
        </div>
      )}
      <div className="brush-list" role="region" aria-label="Brush presets">
        {shown.length === 0 && <p className="panel-note">No brush matches “{query}”.</p>}
        {groupPresets(shown).map(([g, ps]) => {
          const isOpen = !!q || !collapsed.has(g);
          return (
            <section key={g} className="brush-group" data-group={g}>
              <button className="brush-group-head" aria-expanded={isOpen} onClick={() => setCollapsed(c => { const n = new Set(c); if (isOpen) n.add(g); else n.delete(g); return n; })}>
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>{g}</span><small>{ps.length}</small>
              </button>
              {isOpen && (
                <ul>
                  {ps.map(x => (
                    <li key={x.id}>
                      <button className="brush-row" aria-label={x.name} title={`${x.name}, ${Math.round(x.tip.diameter)} px`} aria-pressed={x.id === sel?.id}
                        onClick={() => p.selectPreset(x)} onContextMenu={context(x.id)}>
                        <TipThumb tip={x.tip} tipBitmap={p.tipBitmap} size={28} />
                        <span className="brush-row-name">{x.name}</span><small>{Math.round(x.tip.diameter)} px</small>
                        {view === 'strokes' && <StrokePreview preview={p.preview} params={p.previewFor(x)} id={`row:${x.id}`} w={160} h={36} />}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      {banner && (
        <div className="brush-banner" role="status">
          <p>{banner.text}</p>
          {banner.details.length > 0 && (
            <details open>
              <summary>Import warnings ({banner.details.length})</summary>
              <ul>{banner.details.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </details>
          )}
        </div>
      )}
      <div className="brush-current">
        <span>{sel?.name ?? 'No preset'}</span>
        <StrokePreview preview={p.preview} params={p.previewFor(sel)} id="current" />
      </div>
      <div className="panel-footer">
        <button onClick={() => file.current?.click()}>Load…</button>
        <button onClick={p.openSettings}>Brush Settings</button>
      </div>
      <input ref={file} type="file" hidden accept=".abr" aria-label="Load ABR" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void load(f); }} />
      {menu && (
        <ul className="context-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
          <li><button role="menuitem" onClick={() => { p.deletePreset(menu.id); setMenu(null); setBanner(null); }}>Delete Brush</button></li>
        </ul>
      )}
    </div>
  );
}
