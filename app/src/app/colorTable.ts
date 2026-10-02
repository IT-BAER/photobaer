// Image > Mode > Color Table presets, sampled to the current table length.
type Rgb3 = [number, number, number];

export const TABLE_PRESETS: [string, string][] = [['black_body', 'Black Body'], ['grayscale', 'Grayscale'], ['spectrum', 'Spectrum']];

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
