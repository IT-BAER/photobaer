// Brush presets: tip + dynamics, and their mapping onto the engine's stroke params (StrokeIn, camelCase).
// Sampled tip bitmaps and patterns live in separate records, referenced by id.

export const CONTROLS = ['off', 'fade', 'penPressure', 'penTilt', 'stylusWheel', 'rotation', 'initialDirection', 'direction'] as const;
export type Control = typeof CONTROLS[number];
export interface Dyn { control: Control; fadeSteps: number; jitter: number; minimum: number }

// Engine blend mode names (engine/src/blend.rs BLEND_NAMES without pass through).
export const BLEND_MODES = ['normal', 'dissolve', 'darken', 'multiply', 'color burn', 'linear burn', 'darker color', 'lighten', 'screen',
  'color dodge', 'linear dodge', 'lighter color', 'overlay', 'soft light', 'hard light', 'vivid light', 'linear light', 'pin light',
  'hard mix', 'difference', 'exclusion', 'subtract', 'divide', 'hue', 'saturation', 'color', 'luminosity'] as const;
export type BlendMode = typeof BLEND_MODES[number];

export interface TipGeometry { diameter: number; hardness: number; angle: number; roundness: number; spacing: number; flipX: boolean; flipY: boolean }
export type Tip = ({ kind: 'computed'; profile: 'round' | 'square' } | { kind: 'sampled'; tipRef: string }) & TipGeometry;

export interface Dynamics {
  shape: { enabled: boolean; size: Dyn; angle: Dyn; roundness: Dyn; flipXJitter: boolean; flipYJitter: boolean; brushProjection: boolean };
  scattering: { enabled: boolean; amount: number; scatter: Dyn; bothAxes: boolean; count: number; countJitter: Dyn };
  texture: {
    enabled: boolean; patternRef: string | null; invert: boolean; scale: number; brightness: number; contrast: number;
    eachTip: boolean; mode: BlendMode; depth: number; minimumDepth: number; depthJitter: Dyn;
  };
  dualBrush: {
    enabled: boolean; tip: Tip | null; mode: BlendMode; size: number; spacing: number; scatter: number;
    bothAxes: boolean; count: number; flipX: boolean; flipY: boolean;
  };
  color: { enabled: boolean; fgBg: number; hueJitter: number; satJitter: number; briJitter: number; purity: number; perTip: boolean };
  transfer: { enabled: boolean; opacity: Dyn; flow: Dyn };
  pose: {
    enabled: boolean; overrideTilt: boolean; tiltX: number; tiltY: number; overrideRotation: boolean; rotation: number;
    overridePressure: boolean; pressure: number;
  };
  angleFollowsPath: boolean;
  noise: number;
  wetEdges: boolean;
  buildUp: boolean;
  smoothing: { amount: number; pulledString: boolean; catchUp: boolean; catchUpOnEnd: boolean; adjustForZoom: boolean };
  protectTexture: boolean;
}

export interface Captured { opacity?: number; flow?: number; mode?: BlendMode; color?: [number, number, number] }
// tipMeta: inert imported tip data (bristle/erodible settings) kept for round trips, never painted.
export interface BrushPreset { id: string; name: string; group?: string; tip: Tip; dynamics: Dynamics; captured?: Captured; tipMeta?: Record<string, unknown> }

// Alpha tip bitmap (tip_add) and pattern (pattern_add: channels 1 = gray, 4 = RGBA), stored by id.
export interface TipRecord { id: string; name: string; width: number; height: number; alpha: Uint8Array }
export interface PatternRecord { id: string; name: string; width: number; height: number; channels: 1 | 4; data: Uint8Array }

export const dyn = (d: Partial<Dyn> = {}): Dyn => ({ control: 'off', fadeSteps: 25, jitter: 0, minimum: 0, ...d });

export function computedTip(t: Partial<TipGeometry> & { profile?: 'round' | 'square' } = {}): Tip {
  return { kind: 'computed', profile: 'round', diameter: 30, hardness: 1, angle: 0, roundness: 1, spacing: 0.25, flipX: false, flipY: false, ...t };
}

export function defaultDynamics(): Dynamics {
  return {
    shape: { enabled: false, size: dyn(), angle: dyn(), roundness: dyn(), flipXJitter: false, flipYJitter: false, brushProjection: false },
    scattering: { enabled: false, amount: 0, scatter: dyn(), bothAxes: false, count: 1, countJitter: dyn() },
    texture: {
      enabled: false, patternRef: null, invert: false, scale: 1, brightness: 0, contrast: 0, eachTip: false, mode: 'multiply',
      depth: 1, minimumDepth: 0, depthJitter: dyn({ minimum: 1 }),
    },
    dualBrush: { enabled: false, tip: null, mode: 'multiply', size: 25, spacing: 0.25, scatter: 0, bothAxes: false, count: 1, flipX: false, flipY: false },
    color: { enabled: false, fgBg: 0, hueJitter: 0, satJitter: 0, briJitter: 0, purity: 0, perTip: false },
    transfer: { enabled: false, opacity: dyn({ minimum: 1 }), flow: dyn({ minimum: 1 }) },
    pose: { enabled: false, overrideTilt: false, tiltX: 0, tiltY: 0, overrideRotation: false, rotation: 0, overridePressure: false, pressure: 1 },
    angleFollowsPath: false, noise: 0, wetEdges: false, buildUp: false,
    smoothing: { amount: 0.1, pulledString: false, catchUp: true, catchUpOnEnd: false, adjustForZoom: true },
    protectTexture: false,
  };
}

export type Rgba = [number, number, number, number];
export interface ToolOptions {
  rgba: Rgba; mode: string; opacity?: number; flow?: number;
  bg?: Rgba; seed?: number; stride?: 3 | 6; aliased?: boolean;
  // Engine ids for registered tips/patterns; unresolved sampled tips fall back to a round tip, unresolved textures are dropped.
  resolve?: (kind: 'tip' | 'pattern', ref: string) => number | undefined;
}

const engineDyn = (d: Dyn) => ({ control: d.control, fadeSteps: Math.max(1, Math.round(d.fadeSteps)), jitter: d.jitter, minimum: d.minimum });

function tipParams(tip: Tip, resolve: ToolOptions['resolve']) {
  if (tip.kind === 'sampled') {
    const id = resolve?.('tip', tip.tipRef);
    if (id !== undefined) return { tip: 'sampled', tipId: id };
    return { tip: 'round' };
  }
  return { tip: tip.profile };
}

// Disabled sections are omitted so the engine sees its own defaults (and B4 output).
export function toStrokeParams(preset: BrushPreset, o: ToolOptions): Record<string, unknown> {
  const { tip, dynamics: d } = preset;
  const p: Record<string, unknown> = {
    rgba: o.rgba, mode: o.mode, size: tip.diameter, opacity: o.opacity ?? 1, flow: o.flow ?? 1,
    hardness: tip.hardness, spacing: tip.spacing, angle: tip.angle, roundness: tip.roundness,
    ...tipParams(tip, o.resolve),
    stride: o.stride ?? 3, seed: o.seed ?? 0,
  };
  if (tip.flipX) p.flipX = true;
  if (tip.flipY) p.flipY = true;
  if (o.aliased) p.aliased = true;
  if (d.wetEdges) p.wetEdges = true;
  if (d.buildUp) p.airbrush = true;
  if (d.noise > 0) p.noise = d.noise;
  if (d.shape.enabled || d.angleFollowsPath) {
    const s = d.shape;
    const shapeDyn: Record<string, unknown> = { enabled: s.enabled, angleFollowsPath: d.angleFollowsPath };
    if (s.enabled) {
      Object.assign(shapeDyn, {
        size: engineDyn(s.size), roundness: engineDyn(s.roundness), flipXJitter: s.flipXJitter, flipYJitter: s.flipYJitter,
        angleControl: s.angle.control, angleFadeSteps: Math.max(1, Math.round(s.angle.fadeSteps)), angleJitter: s.angle.jitter,
      });
      if (s.brushProjection) shapeDyn.brushProjection = true;
    }
    p.shapeDyn = shapeDyn;
  }
  if (d.scattering.enabled) {
    const s = d.scattering;
    p.scatter = { enabled: true, count: s.count, countDyn: engineDyn(s.countJitter), amount: s.amount, scatterDyn: engineDyn(s.scatter), bothAxes: s.bothAxes };
  }
  if (d.transfer.enabled) p.transfer = { enabled: true, opacityDyn: engineDyn(d.transfer.opacity), flowDyn: engineDyn(d.transfer.flow) };
  if (d.color.enabled) {
    const c = d.color;
    p.color = { enabled: true, bg: o.bg ?? [255, 255, 255, 255], fgBg: c.fgBg, hueJitter: c.hueJitter, satJitter: c.satJitter, briJitter: c.briJitter, purity: c.purity, perTip: c.perTip };
  }
  if (d.pose.enabled) {
    const s = d.pose;
    const pose: Record<string, unknown> = { enabled: true };
    if (s.overrideTilt) { pose.tiltX = s.tiltX; pose.tiltY = s.tiltY; }
    if (s.overrideRotation) pose.rotation = s.rotation;
    if (s.overridePressure) pose.pressure = s.pressure;
    p.pose = pose;
  }
  const t = d.texture;
  const patternId = t.enabled && t.patternRef !== null ? o.resolve?.('pattern', t.patternRef) : undefined;
  if (patternId !== undefined) {
    p.texture = {
      enabled: true, patternId, invert: t.invert, scale: t.scale, brightness: t.brightness, contrast: t.contrast, eachTip: t.eachTip,
      mode: t.mode, depth: t.depth, minimumDepth: t.minimumDepth, depthJitter: engineDyn(t.depthJitter),
    };
  }
  const db = d.dualBrush;
  if (db.enabled && db.tip) {
    const dt = tipParams(db.tip, o.resolve);
    p.dualBrush = {
      enabled: true, tip: dt.tip === 'square' ? 'round' : dt.tip, ...(dt.tipId !== undefined ? { tipId: dt.tipId } : {}),
      hardness: db.tip.hardness, roundness: db.tip.roundness, angle: db.tip.angle, mode: db.mode, size: db.size,
      spacing: db.spacing, scatter: db.scatter, bothAxes: db.bothAxes, count: db.count, flipX: db.flipX, flipY: db.flipY,
    };
  }
  return p;
}
