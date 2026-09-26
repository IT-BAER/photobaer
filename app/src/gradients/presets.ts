import type { Rgb } from '../shell/color.ts';
import { defaultNoise, type Gradient, type Method } from './gradient.ts';

export interface GradientPreset {
  id: string; name: string; group: string; gradient: Gradient;
  // Stops taken live from the current foreground/background colors.
  swatches?: 'fgToBg' | 'fgToTransparent';
}

const solid = (interpolation: Method, stops: [number, Rgb][], opacity: [number, number, number][] = [[0, 1, 0.5], [1, 1, 0.5]]): Gradient => ({
  kind: 'solid', interpolation,
  stops: stops.map(([position, color]) => ({ position, color, midpoint: 0.5 })),
  opacityStops: opacity.map(([position, o, midpoint]) => ({ position, opacity: o, midpoint })),
});
const preset = (id: string, name: string, group: string, gradient: Gradient, swatches?: GradientPreset['swatches']): GradientPreset =>
  ({ id: `builtin.${id}`, name, group, gradient, ...(swatches ? { swatches } : {}) });

export const BUILTIN_GRADIENTS: GradientPreset[] = [
  preset('fgToBg', 'Foreground to Background', 'Basic', solid('classic', [[0, [0, 0, 0]], [1, [255, 255, 255]]]), 'fgToBg'),
  preset('fgToTransparent', 'Foreground to Transparent', 'Basic', solid('classic', [[0, [0, 0, 0]], [1, [0, 0, 0]]], [[0, 1, 0.5], [1, 0, 0.5]]), 'fgToTransparent'),
  preset('blackWhite', 'Black, White', 'Basic', solid('classic', [[0, [0, 0, 0]], [1, [255, 255, 255]]])),
  preset('duskFire', 'Dusk Fire', 'Color', solid('perceptual', [[0, [24, 12, 38]], [0.45, [196, 52, 66]], [0.78, [240, 142, 58]], [1, [252, 226, 156]]])),
  preset('lagoon', 'Lagoon', 'Color', solid('perceptual', [[0, [6, 32, 54]], [0.5, [18, 122, 138]], [1, [148, 226, 198]]])),
  preset('brushedSteel', 'Brushed Steel', 'Color', solid('linear', [[0, [34, 34, 38]], [0.35, [122, 126, 134]], [0.5, [214, 216, 222]], [0.65, [122, 126, 134]], [1, [34, 34, 38]]])),
  preset('desertDusk', 'Desert Dusk', 'Color', solid('perceptual', [[0, [58, 42, 92]], [0.4, [214, 108, 122]], [1, [250, 214, 148]]])),
  preset('rainbow', 'Rainbow', 'Color', solid('classic', ([[228, 46, 46], [232, 158, 34], [214, 214, 46], [52, 186, 86], [44, 130, 210], [92, 62, 186], [196, 62, 158]] as Rgb[]).map((c, k) => [k / 6, c]))),
  preset('fogFade', 'Fog Fade', 'Color', solid('classic', [[0, [236, 242, 248]], [1, [236, 242, 248]]], [[0, 0.92, 0.34], [1, 0, 0.5]])),
  preset('noiseGrain', 'Noise Grain', 'Color', {
    ...solid('classic', [[0, [0, 0, 0]], [1, [255, 255, 255]]]), kind: 'noise',
    noise: { ...defaultNoise(), seed: 20240824, roughness: 0.85, minimum: [0.05, 0.05, 0.08], maximum: [0.95, 0.9, 1] },
  }),
];

export function resolvePreset(p: GradientPreset, fg: Rgb, bg: Rgb): Gradient {
  if (!p.swatches) return p.gradient;
  const [a, b] = p.gradient.stops;
  return { ...p.gradient, stops: [{ ...a, color: fg }, { ...b, color: p.swatches === 'fgToBg' ? bg : fg }] };
}

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const KEY = 'photobaer:gradients';

// User gradients (group Custom) in localStorage; a storage that throws keeps them in memory for the session.
export class GradientLibrary {
  #store: Store | undefined;
  #user: GradientPreset[] = [];

  constructor(store: Store | undefined = globalThis.localStorage) {
    this.#store = store;
    try {
      const raw = store?.getItem(KEY);
      if (raw) this.#user = JSON.parse(raw) as GradientPreset[];
    } catch { /* unavailable or corrupt: start empty */ }
  }

  list(): GradientPreset[] { return [...BUILTIN_GRADIENTS, ...this.#user]; }
  get(id: string) { return this.list().find(p => p.id === id); }

  add(gradient: Gradient, name = 'Custom gradient'): GradientPreset {
    const p: GradientPreset = { id: `user.${crypto.randomUUID()}`, name, group: 'Custom', gradient: structuredClone(gradient) };
    this.#user.push(p);
    try { this.#store?.setItem(KEY, JSON.stringify(this.#user)); } catch { /* session-only */ }
    return p;
  }
}
