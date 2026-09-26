// Built-in brush presets and procedurally generated gray patterns (never stored until edited).
import { computedTip, defaultDynamics, dyn, type BrushPreset, type Dynamics, type PatternRecord } from './preset.ts';

export const BUILTIN_REVISION = 1;

const withDyn = (edit: (d: Dynamics) => void) => { const d = defaultDynamics(); edit(d); return d; };
const pat = (name: string) => `builtin.pattern.${name}`;

export function builtinPresets(): BrushPreset[] {
  return [
    { id: 'builtin.hard-round', name: 'Hard Round', tip: computedTip({ diameter: 20, hardness: 1 }), dynamics: defaultDynamics() },
    { id: 'builtin.soft-round', name: 'Soft Round', tip: computedTip({ diameter: 40, hardness: 0 }), dynamics: defaultDynamics() },
    {
      id: 'builtin.soft-round-pressure-size', name: 'Soft Round Pressure Size', tip: computedTip({ diameter: 40, hardness: 0, spacing: 0.05 }),
      dynamics: withDyn(d => { d.shape.enabled = true; d.shape.size = dyn({ control: 'penPressure', minimum: 0.05 }); }),
    },
    {
      id: 'builtin.hard-round-pressure-opacity', name: 'Hard Round Pressure Opacity', tip: computedTip({ diameter: 24, hardness: 0.9, spacing: 0.05 }),
      dynamics: withDyn(d => { d.transfer.enabled = true; d.transfer.opacity = dyn({ control: 'penPressure', minimum: 0 }); }),
    },
    {
      id: 'builtin.airbrush-soft', name: 'Airbrush Soft Round', tip: computedTip({ diameter: 60, hardness: 0, spacing: 0.05 }),
      dynamics: withDyn(d => { d.buildUp = true; }), captured: { flow: 0.15, opacity: 1, mode: 'normal' },
    },
    {
      id: 'builtin.flat-calligraphic', name: 'Flat Calligraphic', tip: computedTip({ diameter: 36, hardness: 0.85, roundness: 0.12, angle: 35, spacing: 0.05 }),
      dynamics: defaultDynamics(),
    },
    {
      id: 'builtin.chalk', name: 'Chalk', tip: computedTip({ diameter: 45, hardness: 0.5, roundness: 0.8, spacing: 0.09 }),
      dynamics: withDyn(d => {
        Object.assign(d.texture, { enabled: true, patternRef: pat('canvas'), contrast: 0.35, depth: 0.8, minimumDepth: 0.1 });
        Object.assign(d.shape, { enabled: true, size: dyn({ control: 'penPressure', minimum: 0.4 }), angle: dyn({ jitter: 0.08 }) });
      }),
    },
    {
      id: 'builtin.dry-brush', name: 'Dry Brush', tip: computedTip({ diameter: 50, hardness: 0.35, roundness: 0.7, spacing: 0.07 }),
      dynamics: withDyn(d => {
        Object.assign(d.texture, { enabled: true, patternRef: pat('hatch'), contrast: 0.5, depth: 1, minimumDepth: 0 });
        Object.assign(d.dualBrush, {
          enabled: true, tip: computedTip({ diameter: 12, hardness: 0.6, spacing: 0.6 }), mode: 'multiply', size: 14, spacing: 0.55, scatter: 0.4, bothAxes: true, count: 1,
        });
      }),
    },
    {
      id: 'builtin.stipple', name: 'Stipple', tip: computedTip({ diameter: 8, hardness: 0.7, spacing: 0.6 }),
      dynamics: withDyn(d => {
        Object.assign(d.scattering, { enabled: true, amount: 2.5, bothAxes: true, count: 4, countJitter: dyn({ jitter: 0.5, minimum: 0.25 }) });
        Object.assign(d.shape, {
          enabled: true, size: dyn({ jitter: 0.6, minimum: 0.3 }), roundness: dyn({ jitter: 0.4, minimum: 0.4 }), angle: dyn({ jitter: 1 }),
        });
        Object.assign(d.texture, { enabled: true, patternRef: pat('speckle'), depth: 0.6, minimumDepth: 0 });
      }),
    },
    {
      id: 'builtin.wet-edge-round', name: 'Wet Edge Round', tip: computedTip({ diameter: 55, hardness: 0.15, spacing: 0.1 }),
      dynamics: withDyn(d => {
        d.wetEdges = true;
        Object.assign(d.color, { enabled: true, hueJitter: 0.02, satJitter: 0.1, briJitter: 0.08, perTip: false });
      }),
      captured: { flow: 0.5, opacity: 0.85, mode: 'multiply' },
    },
  ];
}

// Integer spatial hash -> [0, 1).
function hash(x: number, y: number, s: number) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(s, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const wrap = (v: number, n: number) => ((v % n) + n) % n;

type Gen = (x: number, y: number) => number;

// Distance to the nearest and second nearest of periodic lattice points (hex mesh edges).
function nearest2(x: number, y: number, pts: [number, number][], w: number, h: number) {
  let d1 = Infinity, d2 = Infinity;
  for (const [px, py] of pts) for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    const d = Math.hypot(x + 0.5 - (px + ox * w), y + 0.5 - (py + oy * h));
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return [d1, d2];
}

// Paper fibre: short random strokes of darker fibre on a light ground, drawn once into a 128 x 128 tile.
function paperFibre(): Uint8Array {
  const n = 128, a = new Float32Array(n * n).fill(228);
  for (let f = 0; f < 90; f++) {
    const x0 = hash(f, 1, 7) * n, y0 = hash(f, 2, 7) * n, ang = hash(f, 3, 7) * Math.PI, len = 10 + hash(f, 4, 7) * 30;
    for (let t = 0; t < len; t += 0.5) {
      const i = wrap(Math.round(y0 + Math.sin(ang) * t), n) * n + wrap(Math.round(x0 + Math.cos(ang) * t), n);
      a[i] -= 22;
    }
  }
  return Uint8Array.from(a, (v, i) => Math.max(0, Math.min(255, Math.round(v - 12 * hash(i % n, (i / n) | 0, 8)))));
}

const GENERATORS: [string, string, number, number, Gen | (() => Uint8Array)][] = [
  ['fine-grain', 'Fine Grain', 64, 64, (x, y) => 128 + (hash(x, y, 1) - 0.5) * 110],
  ['dot-grid', 'Dot Grid', 32, 32, (x, y) => (Math.hypot(wrap(x, 8) - 3.5, wrap(y, 8) - 3.5) < 2.2 ? 40 : 235)],
  ['linen', 'Linen', 64, 64, (x, y) => 175 + 30 * Math.sin((x * Math.PI) / 2) * (0.6 + 0.4 * hash(x, 0, 2)) + 25 * Math.sin((y * Math.PI) / 2) * (0.6 + 0.4 * hash(0, y, 3))],
  ['blueprint-grid', 'Blueprint Grid', 64, 64, (x, y) => (x % 16 === 0 || y % 16 === 0 ? 30 : x % 4 === 0 || y % 4 === 0 ? 150 : 230)],
  ['hex-mesh', 'Hex Mesh', 32, 28, (x, y) => { const [d1, d2] = nearest2(x, y, [[0, 0], [16, 0], [8, 14], [24, 14]], 32, 28); return d2 - d1 < 1.6 ? 40 : 225; }],
  ['paper-fibre', 'Paper Fibre', 128, 128, paperFibre],
  ['canvas', 'Canvas', 64, 64, (x, y) => (((x >> 2) + (y >> 2)) & 1 ? 150 + 60 * Math.sin((wrap(y, 4) + 0.5) * Math.PI / 4) : 150 + 60 * Math.sin((wrap(x, 4) + 0.5) * Math.PI / 4)) - 20 * hash(x, y, 4)],
  ['hatch', 'Hatch', 32, 32, (x, y) => (wrap(x + y, 8) < 2 ? 55 : 225)],
  ['speckle', 'Speckle', 64, 64, (x, y) => (hash(x, y, 5) < 0.08 ? 30 + 90 * hash(x, y, 6) : 240)],
  ['static-noise', 'Static Noise', 64, 64, (x, y) => hash(x, y, 9) * 256],
];

export function builtinPatterns(): PatternRecord[] {
  return GENERATORS.map(([key, name, w, h, gen]) => {
    let data: Uint8Array;
    if (gen.length === 0) data = (gen as () => Uint8Array)();
    else {
      data = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = Math.max(0, Math.min(255, Math.round((gen as Gen)(x, y))));
    }
    return { id: pat(key), name, width: w, height: h, channels: 1, data };
  });
}
