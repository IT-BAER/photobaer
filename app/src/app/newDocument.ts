// File > New: Photoshop's New Document presets by category, search, recent documents and the size estimate.
// Preset sizes stay in their own unit (print in inches or millimeters, screens in pixels).
import type { MessageDescriptor } from '@lingui/core';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { pxToUnit, unitToPx, type RulerUnit } from '../shell/units.ts';
import { documentSizes, fmtBytes } from './statusInfo.ts';
import type { ColorMode } from '../worker/types.ts';

export type SizeUnit = Exclude<RulerUnit, 'percent'>;
export const SIZE_UNITS: SizeUnit[] = ['px', 'in', 'cm', 'mm', 'pt', 'pica'];
export type NewMode = 'bitmap' | 'gray' | 'rgb' | 'cmyk' | 'lab';
export const NEW_MODES: [NewMode, MessageDescriptor][] = [
  ['bitmap', msg`Bitmap`], ['gray', msg`Grayscale`], ['rgb', msg`RGB Color`], ['cmyk', msg`CMYK Color`], ['lab', msg`Lab Color`],
];
export type NewBackground = 'white' | 'black' | 'background' | 'transparent' | 'custom';
export const MAX_PX = 65536;

// `tag` follows the name in the title ("Landscape, 6 x 4"); device and product names stay untranslated.
export interface Preset { name: MessageDescriptor | string; tag?: string; w: number; h: number; unit: SizeUnit; ppi: number }
export interface Category { id: string; label: MessageDescriptor; presets: Preset[] }

const inch = (name: MessageDescriptor | string, w: number, h: number, tag?: string): Preset => ({ name, tag, w, h, unit: 'in', ppi: 300 });
const mm = (name: MessageDescriptor | string, w: number, h: number): Preset => ({ name, w, h, unit: 'mm', ppi: 300 });
const px = (name: MessageDescriptor | string, w: number, h: number, ppi = 72): Preset => ({ name, w, h, unit: 'px', ppi });

export const CATEGORIES: Category[] = [
  {
    id: 'photo', label: msg`Photo`, presets: [
      inch(msg`Landscape`, 6, 4, '6 x 4'), inch(msg`Landscape`, 7, 5, '7 x 5'), inch(msg`Landscape`, 10, 8, '10 x 8'),
      inch(msg`Portrait`, 4, 6, '4 x 6'), inch(msg`Portrait`, 5, 7, '5 x 7'), inch(msg`Square`, 5, 5, '5 x 5'),
    ],
  },
  {
    id: 'print', label: msg({ message: 'Print', context: 'New Document category' }), presets: [
      inch(msg`Letter`, 8.5, 11), inch(msg`Legal`, 8.5, 14), inch(msg`Tabloid`, 11, 17), mm('A3', 297, 420), mm('A4', 210, 297), mm('A5', 148, 210),
    ],
  },
  {
    id: 'art', label: msg`Art & Illustration`, presets: [
      inch(msg`Poster`, 18, 24), inch(msg`Postcard`, 6, 4), inch(msg`Comic Book`, 6.625, 10.25), inch(msg`Square`, 12, 12, '12 x 12'),
    ],
  },
  {
    id: 'web', label: msg`Web`, presets: [
      px(msg`Web Most Common`, 1366, 768), px(msg`Web Minimum`, 1024, 768), px(msg`Web Large`, 1920, 1080), px('WQHD', 2560, 1440), px('MacBook Pro 16"', 3456, 2234),
    ],
  },
  {
    id: 'mobile', label: msg`Mobile`, presets: [
      px('iPhone 16', 1179, 2556), px('iPhone 16 Pro Max', 1320, 2868), px('iPad Pro 13"', 2064, 2752), px('Android 1080p', 1080, 1920), px('Apple Watch 45mm', 396, 484),
    ],
  },
  {
    id: 'film', label: msg`Film & Video`, presets: [
      px('HDTV 1080p', 1920, 1080), px('HDTV 720p', 1280, 720), px('UHD 4K', 3840, 2160), px('DCI 4K', 4096, 2160), px('Cinema 2K', 2048, 1080), px('UHD 8K', 7680, 4320),
    ],
  },
  {
    id: 'social', label: msg`Social`, presets: [
      px('Instagram Post', 1080, 1080), px('Instagram Portrait', 1080, 1350), px('Instagram Story', 1080, 1920), px('Facebook Post', 1200, 630),
      px('X Post', 1600, 900), px('YouTube Thumbnail', 1280, 720), px('LinkedIn Post', 1200, 627), px('Pinterest Pin', 1000, 1500),
    ],
  },
];

export const presetTitle = (p: Preset) => {
  const name = typeof p.name === 'string' ? p.name : i18n._(p.name);
  return p.tag ? `${name}, ${p.tag}` : name;
};
export const toPx = (v: number, unit: SizeUnit, ppi: number) => Math.min(MAX_PX, Math.max(1, Math.round(unitToPx(v, unit, ppi))));
export const presetPx = (p: Preset): [number, number] => [toPx(p.w, p.unit, p.ppi), toPx(p.h, p.unit, p.ppi)];
// A Width or Height in another unit, same physical size: whole pixels, else 3 decimals.
export function convertSize(v: number, from: SizeUnit, to: SizeUnit, ppi: number): number {
  return to === 'px' ? toPx(v, from, ppi) : Math.round(pxToUnit(unitToPx(v, from, ppi), to, ppi) * 1000) / 1000;
}

export function searchPresets(q: string): Preset[] {
  const s = q.trim().toLowerCase();
  return s ? CATEGORIES.flatMap(c => c.presets).filter(p => presetTitle(p).toLowerCase().includes(s)) : [];
}

const MODE_OF: Record<NewMode, ColorMode | null> = { bitmap: { kind: 'bitmap' }, gray: null, rgb: null, cmyk: { kind: 'cmyk' }, lab: { kind: 'lab' } };
export function estimateSize(wPx: number, hPx: number, mode: NewMode, depth: number): string {
  return fmtBytes(documentSizes({ width: wPx, height: hPx, depth, mode: MODE_OF[mode], gray: mode === 'gray', extraChannels: 0 }, [])[0]);
}
// Bitmap is 1 bit; CMYK and Lab have no 32-bit mode.
export const depthsFor = (mode: NewMode): number[] => (mode === 'bitmap' ? [1] : mode === 'cmyk' || mode === 'lab' ? [8, 16] : [8, 16, 32]);

export interface RecentDoc { w: number; h: number; unit: SizeUnit; ppi: number; mode: NewMode; depth: number }
const RECENT_KEY = 'photobaer:newDocRecent';
const sameDoc = (a: RecentDoc, b: RecentDoc) => a.w === b.w && a.h === b.h && a.unit === b.unit && a.ppi === b.ppi && a.mode === b.mode && a.depth === b.depth;

export function pushRecent(list: RecentDoc[], d: RecentDoc): RecentDoc[] {
  return [d, ...list.filter(x => !sameDoc(x, d))].slice(0, 5);
}
export function parseRecent(raw: string | null): RecentDoc[] {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((d): d is RecentDoc => !!d && typeof d === 'object' && ['w', 'h', 'ppi', 'depth'].every(k => typeof (d as Record<string, unknown>)[k] === 'number')
      && SIZE_UNITS.includes((d as RecentDoc).unit) && NEW_MODES.some(([m]) => m === (d as RecentDoc).mode));
  } catch { return []; }
}
export function loadRecent(): RecentDoc[] {
  try { return parseRecent(globalThis.localStorage?.getItem(RECENT_KEY) ?? null); } catch { return []; }
}
export function saveRecent(list: RecentDoc[]) {
  try { globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* session-only */ }
}
