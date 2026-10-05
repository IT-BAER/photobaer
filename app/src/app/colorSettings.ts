// Edit > Color Settings: working spaces, color management policies and conversion options, kept per browser.
import { loadedProfileNames } from './profileStore.ts';

export type Policy = 'off' | 'preserveEmbedded' | 'convertToWorking';
export type Intent = 'perceptual' | 'relativeColorimetric' | 'saturation' | 'absoluteColorimetric';

export interface ColorSettings {
  rgb: string;
  cmyk: string;
  gray: string;
  rgbPolicy: Policy;
  grayPolicy: Policy;
  askWhenOpening: boolean;
  askWhenMissing: boolean;
  intent: Intent;
  bpc: boolean;
  dither: boolean;
  // Advanced Controls: Desaturate Monitor Colors By `desaturateBy` % (display only).
  desaturateOn: boolean;
  desaturateBy: number;
}

// The engine's built-in profiles by space.
export const RGB_SPACES = ['sRGB IEC61966-2.1', 'Adobe RGB (1998)', 'Display P3', 'ProPhoto RGB', 'Rec. 2020'];
export const CMYK_SPACES = ['Coated Offset CMYK (analytic)', 'Uncoated Offset CMYK (analytic)'];
export const GRAY_SPACES = ['Gray Gamma 2.2', 'Gray Gamma 1.8', 'Dot Gain 15%', 'Dot Gain 20%', 'Dot Gain 25%', 'Dot Gain 30%'];
export const POLICIES: [Policy, string][] = [['off', 'Off'], ['preserveEmbedded', 'Preserve Embedded Profiles'], ['convertToWorking', 'Convert to Working RGB']];
export const INTENTS: [Intent, string][] = [
  ['perceptual', 'Perceptual'], ['relativeColorimetric', 'Relative Colorimetric'], ['saturation', 'Saturation'], ['absoluteColorimetric', 'Absolute Colorimetric'],
];

const base: ColorSettings = {
  rgb: RGB_SPACES[0], cmyk: CMYK_SPACES[0], gray: 'Dot Gain 20%', rgbPolicy: 'preserveEmbedded', grayPolicy: 'preserveEmbedded',
  askWhenOpening: false, askWhenMissing: false, intent: 'relativeColorimetric', bpc: true, dither: true,
  desaturateOn: false, desaturateBy: 20,
};

export const COLOR_PRESETS: { name: string; description: string; settings: ColorSettings }[] = [
  {
    name: 'North America General Purpose 2',
    description: 'General-purpose settings for screen and print. sRGB working space; embedded profiles are kept and mismatches are handled without asking.',
    settings: base,
  },
  {
    name: 'North America Prepress 2',
    description: 'Print production. The wider Adobe RGB working space keeps colors a press can print but sRGB cannot, and every mismatch is asked about.',
    settings: { ...base, rgb: 'Adobe RGB (1998)', rgbPolicy: 'convertToWorking', grayPolicy: 'convertToWorking', askWhenOpening: true, askWhenMissing: true },
  },
  {
    name: 'North America Web/Internet',
    description: 'Everything ends up as sRGB, because an untagged image on the web is assumed to be sRGB. Gray is gamma 2.2 for the same reason.',
    settings: { ...base, gray: 'Gray Gamma 2.2', rgbPolicy: 'convertToWorking', grayPolicy: 'convertToWorking' },
  },
  {
    name: 'Monitor Color',
    description: 'Color management off: document numbers go to the display unchanged. For screen work without an ICC workflow.',
    settings: { ...base, gray: 'Gray Gamma 2.2', rgbPolicy: 'off', grayPolicy: 'off' },
  },
];

export const DEFAULT_COLOR_SETTINGS = COLOR_PRESETS[0].settings;

// The preset `s` equals, else 'Custom'.
export function matchPreset(s: ColorSettings): string {
  const keys = Object.keys(base) as (keyof ColorSettings)[];
  return COLOR_PRESETS.find(p => keys.every(k => p.settings[k] === s[k]))?.name ?? 'Custom';
}

// Stored JSON as settings; a field that is missing or invalid takes the default. `loaded` names the
// user's loaded profiles by space, which are working spaces as well.
export function parseColorSettings(json: string | null, loaded: { rgb?: string[]; cmyk?: string[]; gray?: string[] } = {}): ColorSettings {
  let v: Record<string, unknown> = {};
  try { v = JSON.parse(json ?? '{}') ?? {}; } catch { /* default */ }
  const d = DEFAULT_COLOR_SETTINGS;
  const pick = <T>(k: keyof ColorSettings, ok: (x: unknown) => boolean) => (ok(v[k]) ? v[k] : d[k]) as T;
  const policy = (x: unknown) => POLICIES.some(([p]) => p === x);
  const bool = (x: unknown) => typeof x === 'boolean';
  return {
    rgb: pick('rgb', x => [...RGB_SPACES, ...loaded.rgb ?? []].includes(x as string)),
    cmyk: pick('cmyk', x => [...CMYK_SPACES, ...loaded.cmyk ?? []].includes(x as string)),
    gray: pick('gray', x => [...GRAY_SPACES, ...loaded.gray ?? []].includes(x as string)),
    rgbPolicy: pick('rgbPolicy', policy),
    grayPolicy: pick('grayPolicy', policy),
    askWhenOpening: pick('askWhenOpening', bool),
    askWhenMissing: pick('askWhenMissing', bool),
    intent: pick('intent', x => INTENTS.some(([i]) => i === x)),
    bpc: pick('bpc', bool),
    dither: pick('dither', bool),
    desaturateOn: pick('desaturateOn', bool),
    desaturateBy: pick('desaturateBy', x => typeof x === 'number' && x >= 1 && x <= 100),
  };
}

const KEY = 'photobaer.colorSettings';

export function loadColorSettings(): ColorSettings {
  try { return parseColorSettings(localStorage.getItem(KEY), loadedProfileNames()); } catch { return DEFAULT_COLOR_SETTINGS; }
}

export function saveColorSettings(s: ColorSettings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* not stored this time */ }
}

// keep: tag the embedded profile; convert: to the working space; discard: untagged; leave: no profile,
// stays untagged; ask: the Profile Mismatch or Missing Profile dialog decides.
export type OpenAction = 'keep' | 'convert' | 'discard' | 'leave' | 'assign';

// What opening an RGB or Gray (`space`) file with profile `embedded` (null: none) does under `s`;
// `ask` false skips the dialogs (agent opens) and lets the policy decide.
export function openAction(s: ColorSettings, embedded: string | null, ask = true, space: 'rgb' | 'gray' = 'rgb'): OpenAction | 'ask' {
  const policy = space === 'gray' ? s.grayPolicy : s.rgbPolicy;
  if (embedded === null) return ask && s.askWhenMissing && policy !== 'off' ? 'ask' : 'leave';
  if (embedded === s[space]) return 'keep';
  if (policy === 'off') return 'discard';
  if (ask && s.askWhenOpening) return 'ask';
  return policy === 'preserveEmbedded' ? 'keep' : 'convert';
}
