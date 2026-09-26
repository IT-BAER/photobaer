// Stroke params, smoothing and options for the paint tools. Every set tool option wins over the selected preset
// (size, tip geometry, opacity, flow, mode, airbrush, wet edges, smoothing); no preset means the default round tip.
import type { SmoothingOpts } from '../shell/smoothing.ts';
import { computedTip, defaultDynamics, toStrokeParams, type BrushPreset, type Rgba, type ToolOptions } from './preset.ts';

type Options = Record<string, unknown>;
export type PaintTool = 'brush' | 'pencil' | 'eraser';
export interface StrokeContext {
  tool: PaintTool; rgba: Rgba; mode: string; bg: Rgba; seed: number; stride: 3 | 6;
  resolve?: ToolOptions['resolve'];
}

const DEFAULT_PRESET: BrushPreset = { id: '', name: 'Default', tip: computedTip(), dynamics: defaultDynamics() };
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
// Pencil and the eraser's pencil mode: hard aliased tip, full flow, no build-up.
const pencilLike = (tool: PaintTool, o: Options) => tool === 'pencil' || (tool === 'eraser' && o.mode === 'pencil');

export function presetStrokeParams(preset: BrushPreset | null, o: Options, c: StrokeContext): Record<string, unknown> {
  const p = structuredClone(preset ?? DEFAULT_PRESET);
  const d = p.dynamics, t = p.tip;
  const pencil = pencilLike(c.tool, o);
  t.diameter = num(o.size, t.diameter);
  t.hardness = pencil ? 1 : num(o.hardness, t.hardness * 100) / 100;
  t.spacing = Math.max(0.01, num(o.spacing, t.spacing * 100) / 100);
  t.roundness = Math.min(1, Math.max(0.01, num(o.roundness, t.roundness * 100) / 100));
  t.angle = num(o.angle, t.angle);
  t.flipX = bool(o.flipX, t.flipX);
  t.flipY = bool(o.flipY, t.flipY);
  d.wetEdges = bool(o.wetEdges, d.wetEdges);
  d.buildUp = buildUpFor(preset, o, c.tool);
  if (o.pressureSize) d.shape = { ...d.shape, enabled: true, size: { ...d.shape.size, control: 'penPressure', minimum: Math.max(0.02, d.shape.size.minimum) } };
  if (o.pressureOpacity) d.transfer = { ...d.transfer, enabled: true, opacity: { ...d.transfer.opacity, control: 'penPressure' } };
  if (c.tool === 'eraser') { d.color.enabled = false; d.wetEdges = false; }
  const out = toStrokeParams(p, {
    rgba: c.rgba, mode: c.mode, bg: c.bg, seed: c.seed, stride: c.stride, resolve: c.resolve, aliased: pencil,
    opacity: num(o.opacity, 100) / 100, flow: pencil ? 1 : num(o.flow, 100) / 100,
  });
  if (c.tool === 'eraser' && o.eraseToHistory) out.eraseToHistory = true;
  return out;
}

// Without a preset the classic model: pulled string, catch up on stroke end.
const CLASSIC = { amount: 0, pulledString: true, catchUp: false, catchUpOnEnd: true, adjustForZoom: true };
export type SmoothingSettings = typeof CLASSIC;

export function smoothingSettings(preset: BrushPreset | null, o: Options): SmoothingSettings {
  const s = preset ? { ...preset.dynamics.smoothing, amount: preset.dynamics.smoothing.amount * 100 } : CLASSIC;
  return {
    amount: num(o.smoothing, s.amount), pulledString: bool(o.pulledString, s.pulledString), catchUp: bool(o.strokeCatchUp, s.catchUp),
    catchUpOnEnd: bool(o.catchUpOnStrokeEnd, s.catchUpOnEnd), adjustForZoom: bool(o.adjustForZoom, s.adjustForZoom),
  };
}

// Stroke catch-up only applies without pulled string.
export function smoothingFor(preset: BrushPreset | null, o: Options): SmoothingOpts {
  const s = smoothingSettings(preset, o);
  return { smoothing: s.amount, pulledString: s.pulledString, catchUp: s.catchUp && !s.pulledString, catchUpOnEnd: s.catchUpOnEnd, adjustForZoom: s.adjustForZoom };
}

export const buildUpFor = (preset: BrushPreset | null, o: Options, tool: PaintTool) =>
  !pencilLike(tool, o) && bool(o.airbrush, preset?.dynamics.buildUp ?? false);

// Tool options written when a preset is selected (the options then win over the preset).
export function presetOptions(p: BrushPreset, tool?: PaintTool): Record<string, number | string | boolean> {
  const t = p.tip, c = p.captured;
  const out: Record<string, number | string | boolean> = {
    size: t.diameter, hardness: t.hardness * 100, spacing: t.spacing * 100, roundness: t.roundness * 100, angle: t.angle,
    flipX: t.flipX, flipY: t.flipY, airbrush: p.dynamics.buildUp, wetEdges: p.dynamics.wetEdges, smoothing: p.dynamics.smoothing.amount * 100,
  };
  if (c?.opacity !== undefined) out.opacity = c.opacity * 100;
  if (c?.flow !== undefined) out.flow = c.flow * 100;
  // The eraser's mode option is brush/pencil/block, so a captured blend mode never applies to it.
  if (c?.mode !== undefined && tool !== 'eraser') out.mode = c.mode;
  return out;
}

export const GROUPS = ['General', 'Dry Media', 'Wet Media', 'Special Effects'] as const;

function keywordGroup(p: BrushPreset) {
  const s = `${p.id} ${p.name}`.toLowerCase();
  if (/water|wet|mixer|wash/.test(s)) return 'Wet Media';
  if (/chalk|charcoal|pencil|pastel|dry/.test(s)) return 'Dry Media';
  if (/scatter|splatter|spatter|texture|effect/.test(s)) return 'Special Effects';
  return 'General';
}

export function groupPresets(list: BrushPreset[]): [string, BrushPreset[]][] {
  const groups = new Map<string, BrushPreset[]>(GROUPS.map(g => [g, []]));
  for (const p of list) {
    const g = p.group?.trim() || keywordGroup(p);
    const arr = groups.get(g);
    if (arr) arr.push(p); else groups.set(g, [p]);
  }
  return [...groups].filter(([, ps]) => ps.length > 0);
}

export const pushRecent = (ids: string[], id: string) => [id, ...ids.filter(x => x !== id)].slice(0, 8);
