// Image > Mode > Color Table presets, sampled to the current table length.
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { parseAco } from '../shell/swatches.ts';
type Rgb3 = [number, number, number];

export const TABLE_PRESETS: [string, MessageDescriptor][] = [['black_body', msg`Black Body`], ['grayscale', msg`Grayscale`], ['spectrum', msg`Spectrum`]];

const lerp = (stops: Rgb3[], t: number): Rgb3 => {
  const f = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), k = f - i;
  return stops[i].map((v, c) => Math.round(v + (stops[i + 1][c] - v) * k)) as Rgb3;
};

const STOPS: Record<string, Rgb3[]> = {
  black_body: [[0, 0, 0], [180, 0, 0], [255, 120, 0], [255, 230, 40], [255, 255, 255]],
  grayscale: [[0, 0, 0], [255, 255, 255]],
  spectrum: [[128, 0, 255], [0, 0, 255], [0, 255, 255], [0, 255, 0], [255, 255, 0], [255, 0, 0]],
};

export function colorTablePreset(name: string, n: number): Rgb3[] {
  const stops = STOPS[name];
  if (!stops) throw new Error(`unknown color table ${name}`);
  return Array.from({ length: n }, (_, i) => lerp(stops, n > 1 ? i / (n - 1) : 0));
}

// Image > Mode > Color Table Save: an .act file, 256 RGB entries then the color count and no
// transparent index (0xffff).
export function writeAct(table: Rgb3[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(772);
  table.slice(0, 256).forEach((c, i) => out.set(c, i * 3));
  new DataView(out.buffer).setUint32(768, (Math.min(256, table.length) << 16) | 0xffff);
  return out;
}

// Color Table Load: an .act table (768 bytes, or 772 with the color count) or an .aco swatch file.
export function readTableFile(name: string, bytes: Uint8Array): Rgb3[] {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'aco') {
    const t = parseAco(bytes).swatches.map(s => s.rgb);
    if (!t.length || t.length > 256) throw new Error(`${name} holds ${t.length} RGB colors; a color table needs 1 to 256`);
    return t;
  }
  if (ext !== 'act') throw new Error(`${name} is not an .act or .aco file`);
  if (bytes.length !== 768 && bytes.length !== 772) throw new Error(`${name} is not a color table (.act files are 768 or 772 bytes)`);
  const n = bytes.length === 772 ? new DataView(bytes.buffer, bytes.byteOffset).getUint16(768) || 256 : 256;
  return Array.from({ length: Math.min(n, 256) }, (_, i) => [...bytes.subarray(i * 3, i * 3 + 3)] as Rgb3);
}

// A table at length `n`: cut, or padded with its last color.
export function fitTable(table: Rgb3[], n: number): Rgb3[] {
  return Array.from({ length: n }, (_, i) => table[Math.min(i, table.length - 1)]);
}
