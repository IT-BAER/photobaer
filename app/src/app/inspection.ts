export type HistogramChannel = 'composite' | 'red' | 'green' | 'blue';
export interface HistogramStats { count: number; mean: number; median: number; standardDeviation: number }

const CHANNEL_OFFSET: Record<HistogramChannel, number> = { composite: 0, red: 256, green: 512, blue: 768 };

export function selectHistogramChannel(histogram: Uint32Array, channel: HistogramChannel): Uint32Array {
  if (histogram.length !== 1024) throw new Error('A native histogram must contain 1024 bins.');
  const offset = CHANNEL_OFFSET[channel];
  return histogram.slice(offset, offset + 256);
}

export function histogramStats(bins: Uint32Array): HistogramStats {
  let count = 0, weighted = 0;
  for (let value = 0; value < bins.length; value++) { count += bins[value]; weighted += value * bins[value]; }
  if (!count) return { count: 0, mean: 0, median: 0, standardDeviation: 0 };
  const mean = weighted / count;
  let cumulative = 0, median = 0;
  const middle = (count + 1) / 2;
  for (; median < bins.length; median++) { cumulative += bins[median]; if (cumulative >= middle) break; }
  let variance = 0;
  for (let value = 0; value < bins.length; value++) variance += bins[value] * (value - mean) ** 2;
  return { count, mean, median, standardDeviation: Math.sqrt(variance / count) };
}
