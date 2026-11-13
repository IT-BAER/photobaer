// Status bar info field and its Show menu (Photoshop order), plus the units selector next to it.
// Scratch Sizes, Efficiency and Timing are left out: the browser gives no honest number for them.
import type { MessageDescriptor } from '@lingui/core';
import { msg, plural, t } from '@lingui/core/macro';
import { formatNumber } from '../i18n/numbers.ts';
import { pxToUnit, RULER_UNITS, type RulerUnit } from '../shell/units.ts';
import type { MeasureScale } from './analysis.ts';
import type { Box, ColorMode } from '../worker/types.ts';

export const STATUS_INFO = ['sizes', 'profile', 'dimensions', 'scale', 'tool', 'layers'] as const;
export type StatusInfo = typeof STATUS_INFO[number];
export const STATUS_INFO_LABEL: Record<StatusInfo, MessageDescriptor> = {
  sizes: msg`Document Sizes`, profile: msg`Document Profile`, dimensions: msg`Document Dimensions`,
  scale: msg`Measurement Scale`, tool: msg`Current Tool`, layers: msg`Layer Count`,
};

// Units & Rulers names, as Photoshop lists them.
export const RULER_UNIT_LABEL: Record<RulerUnit, MessageDescriptor> = {
  px: msg`Pixels`, in: msg`Inches`, cm: msg`Centimeters`, mm: msg`Millimeters`, pt: msg`Points`, pica: msg`Picas`, percent: msg`Percent`,
};
const UNIT_SHORT: Record<RulerUnit, string> = { px: 'px', in: 'in', cm: 'cm', mm: 'mm', pt: 'pt', pica: 'pica', percent: '%' };

const STORE_KEY = 'photobaer:statusInfo';
export function loadStatusInfo(): StatusInfo {
  try {
    const v = globalThis.localStorage?.getItem(STORE_KEY);
    if (v && (STATUS_INFO as readonly string[]).includes(v)) return v as StatusInfo;
  } catch { /* storage unavailable: default */ }
  return 'dimensions';
}
export function saveStatusInfo(v: StatusInfo) {
  try { globalThis.localStorage?.setItem(STORE_KEY, v); } catch { /* session-only */ }
}
export const isRulerUnit = (v: string): v is RulerUnit => (RULER_UNITS as readonly string[]).includes(v);

export interface SizeDoc { width: number; height: number; depth: number; mode: ColorMode | null; gray: boolean; extraChannels: number }

function colorChannels(d: SizeDoc): number {
  switch (d.mode?.kind) {
    case 'cmyk': return 4;
    case 'lab': return 3;
    case 'bitmap': case 'duotone': case 'indexed': return 1;
    case 'multichannel': return Math.max(1, d.extraChannels);
    default: return d.gray ? 1 : 3;
  }
}

// [flattened, with layers] in bytes, Photoshop's "Doc: a/b": the flattened color channels, and each layer's
// content bounds on the canvas with its transparency, plus alpha and spot channels.
export function documentSizes(d: SizeDoc, layerBoxes: Box[]): [number, number] {
  if (d.mode?.kind === 'bitmap') {
    const flat = Math.ceil(d.width / 8) * d.height;
    return [flat, flat];
  }
  const bpc = Math.max(1, d.depth / 8), ch = colorChannels(d);
  const flat = d.width * d.height * ch * bpc;
  let layered = d.mode?.kind === 'multichannel' ? 0 : d.extraChannels * d.width * d.height * bpc;
  for (const [x, y, w, h] of layerBoxes) {
    const cw = Math.max(0, Math.min(d.width, x + w) - Math.max(0, x)), chh = Math.max(0, Math.min(d.height, y + h) - Math.max(0, y));
    layered += cw * chh * (ch + 1) * bpc;
  }
  return [flat, Math.max(flat, layered)];
}

export function fmtBytes(b: number): string {
  const [v, u] = b >= 2 ** 30 ? [b / 2 ** 30, 'G'] : b >= 2 ** 20 ? [b / 2 ** 20, 'M'] : [b / 1024, 'K'];
  return `${formatNumber(v, v < 10 ? 2 : 1)}${u}`;
}

export interface StatusCtx {
  width: number; height: number; depth: number; resolution: number; modeName: string; profile: string | null;
  unit: RulerUnit; sizes: [number, number] | null; scale: MeasureScale; toolName: string; layerCount: number;
}

export function statusInfoText(key: StatusInfo, c: StatusCtx): string {
  switch (key) {
    case 'sizes': {
      const flat = c.sizes ? fmtBytes(c.sizes[0]) : '…', layered = c.sizes ? fmtBytes(c.sizes[1]) : '';
      return c.sizes ? t`Doc: ${flat}/${layered}` : t`Doc: ${flat}`;
    }
    case 'profile': {
      const bits = c.depth, mode = c.modeName, name = c.profile ?? t`Untagged ${mode}`;
      return t`${name} (${bits}bpc)`;
    }
    case 'scale': {
      const px = formatNumber(c.scale.pixels), logical = formatNumber(c.scale.logical), units = c.scale.units;
      return t`${px} px = ${logical} ${units}`;
    }
    case 'tool': return c.toolName;
    case 'layers': return plural(c.layerCount, { one: '# Layer', other: '# Layers' });
    default: {
      const u = UNIT_SHORT[c.unit], ppi = formatNumber(c.resolution, 2);
      const w = formatNumber(pxToUnit(c.width, c.unit, c.resolution, c.width), 2);
      const h = formatNumber(pxToUnit(c.height, c.unit, c.resolution, c.height), 2);
      return t`${w} ${u} x ${h} ${u} (${ppi} ppi)`;
    }
  }
}
