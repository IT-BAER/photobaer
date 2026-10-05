// Color numbers per mode for the Color Picker and the Color panel: CMYK percent and Gray K through
// the worker's profiles (`Convert`), RGB as is, Lab from sRGB. Grayscale documents store the gray in R.
import { labToRgb, rgbToLab, type Rgb } from './color.ts';

export type Sliders = 'gray' | 'rgb' | 'cmyk' | 'lab';
export type Convert = (values: number[], from: 'rgb' | 'cmyk' | 'gray', to: 'rgb' | 'cmyk' | 'gray') => Promise<number[]>;

export const SLIDERS: Record<Sliders, { label: string; min: number; max: number }[]> = {
  gray: [{ label: 'K', min: 0, max: 100 }],
  rgb: ['R', 'G', 'B'].map(label => ({ label, min: 0, max: 255 })),
  cmyk: ['C', 'M', 'Y', 'K'].map(label => ({ label, min: 0, max: 100 })),
  lab: [{ label: 'L', min: 0, max: 100 }, { label: 'a', min: -128, max: 127 }, { label: 'b', min: -128, max: 127 }],
};

export function defaultSliders(doc: { gray: boolean; mode: { kind: string } | null } | null): Sliders {
  if (!doc) return 'rgb';
  if (doc.mode) return doc.mode.kind === 'cmyk' ? 'cmyk' : doc.mode.kind === 'lab' ? 'lab' : 'rgb';
  return doc.gray ? 'gray' : 'rgb';
}

const neutral = (c: Rgb) => c[0] === c[1] && c[1] === c[2];
const to255 = (v: number[]) => v.map(x => Math.round(Math.min(1, Math.max(0, x)) * 255)) as Rgb;

/** The values of `rgb` on `kind`'s sliders; `grayDoc` reads a neutral color as the document's gray. */
export async function slidersOf(rgb: Rgb, kind: Sliders, grayDoc: boolean, convert: Convert): Promise<number[]> {
  if (kind === 'rgb') return [...rgb];
  if (kind === 'lab') return rgbToLab(rgb);
  if (kind === 'gray') {
    const [g] = grayDoc && neutral(rgb) ? [rgb[0] / 255] : await convert(rgb.map(v => v / 255), 'rgb', 'gray');
    return [100 - g * 100];
  }
  return (await convert(rgb.map(v => v / 255), 'rgb', 'cmyk')).map(v => v * 100);
}

/** The color of slider `values` on `kind`. */
export async function rgbOfSliders(values: number[], kind: Sliders, grayDoc: boolean, convert: Convert): Promise<Rgb> {
  if (kind === 'rgb') return values.map(v => Math.round(v)) as Rgb;
  if (kind === 'lab') return labToRgb(values as [number, number, number]);
  if (kind === 'gray') {
    const g = 1 - values[0] / 100;
    return grayDoc ? to255([g, g, g]) : to255(await convert([g], 'gray', 'rgb'));
  }
  return to255(await convert(values.map(v => v / 100), 'cmyk', 'rgb'));
}

/** The gray `rgb` paints in a Grayscale document, through its Gray profile. */
export async function grayOf(rgb: Rgb, convert: Convert): Promise<Rgb> {
  const [g] = await convert(rgb.map(v => v / 255), 'rgb', 'gray');
  return to255([g, g, g]);
}

/** A paint color in a Grayscale document: neutral colors are the gray already, others convert. */
export async function inGray(rgb: Rgb, convert: Convert): Promise<Rgb> {
  return neutral(rgb) ? rgb : grayOf(rgb, convert);
}

/** A Grayscale paint color as RGB through the Gray profile: `grayOf` it after a profile change keeps its look. */
export async function rgbOfGray(gray: Rgb, convert: Convert): Promise<Rgb> {
  return to255(await convert([gray[0] / 255], 'gray', 'rgb'));
}
