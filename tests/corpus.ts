// PSD composite oracle (PLAN.md section 5): render each PSD's layers with the engine and compare with
// the merged composite Photoshop stored in the file. Usage: node tests/corpus.ts [dir] (default tests/corpus).
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initializeCanvas, readPsd, type Layer, type Psd } from 'ag-psd';
import init from '../app/src/engine-pkg/photobaer_engine.js';
import { importPsd } from '../app/src/psd.ts';
import { deltaE2000, srgbToLab } from './deltaE.ts';

export const LIMITS = { mean: 1, max: 5 };
export interface Result { file: string; status: 'pass' | 'fail' | 'skip'; reason?: string; mean?: number; max?: number }

// Node has no canvas; ag-psd only needs plain RGBA buffers when reading with useImageData.
initializeCanvas(() => { throw new Error('canvas not available in node'); }, (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData);

let ready: Promise<unknown> | null = null;
export const initEngine = () => ready ??= init({ module_or_path: readFileSync(new URL('../app/src/engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });

// First feature the engine cannot render yet, or null. Blocklist: unknown data shows up as a FAIL, never a silent pass.
export function unsupported(psd: Psd): string | null {
  if (psd.colorMode !== 3) return `color mode ${psd.colorMode}`;
  if ((psd.bitsPerChannel ?? 8) !== 8) return `${psd.bitsPerChannel}-bit`;
  if (!psd.imageData) return 'no composite image';
  const walk = (layers: Layer[]): string | null => {
    for (const l of layers) {
      const name = `layer "${l.name}"`;
      for (const k of ['effects', 'adjustment', 'filterMask', 'realMask', 'knockout'] as const) {
        if (l[k] !== undefined && l[k] !== false) return `${name}: ${k}`;
      }
      // A shape layer's stored raster already has its vector mask applied; a pixel layer's does not.
      if (l.vectorMask && !l.vectorFill) return `${name}: vectorMask`;
      // Photoshop stores full 0..255 Blend If ranges on every layer; those change nothing.
      const br = l.blendingRanges;
      if (br && ![br.compositeGrayBlendSource, br.compositeGraphBlendDestinationRange, ...br.ranges.flatMap(r => [r.sourceRange, r.destRange])]
        .every(r => r.join() === '0,0,255,255')) return `${name}: blendingRanges`;
      if (l.children) { const r = walk(l.children); if (r) return r; }
    }
    return null;
  };
  return walk(psd.children ?? []);
}

// Both images are compared over white, because transparent pixels have no defined color.
export async function checkPsd(file: string, bytes: Uint8Array): Promise<Result> {
  await initEngine();
  if (bytes[4] === 0 && bytes[5] === 2) return { file, status: 'skip', reason: 'PSB' };
  const psd = readPsd(bytes, { useImageData: true, skipThumbnail: true });
  const why = unsupported(psd);
  if (why) return { file, status: 'skip', reason: why };
  const { width: w, height: h } = psd;
  const { engine: e } = importPsd(bytes);
  try {
    const ref = psd.imageData!.data;
    const white = (c: number, a: number) => Math.round(c * a / 255 + 255 * (1 - a / 255));
    let sum = 0, max = 0;
    for (let ty = 0; ty < Math.ceil(h / 256); ty++) {
      for (let tx = 0; tx < Math.ceil(w / 256); tx++) {
        const px = e.flatten_tile_rgba8(tx, ty);
        for (let y = 0; y < Math.min(256, h - ty * 256); y++) {
          for (let x = 0; x < Math.min(256, w - tx * 256); x++) {
            const o = (y * 256 + x) * 4, r = ((ty * 256 + y) * w + tx * 256 + x) * 4;
            const a = srgbToLab(white(px[o], px[o + 3]), white(px[o + 1], px[o + 3]), white(px[o + 2], px[o + 3]));
            const b = srgbToLab(white(ref[r], ref[r + 3]), white(ref[r + 1], ref[r + 3]), white(ref[r + 2], ref[r + 3]));
            const d = deltaE2000(a[0], a[1], a[2], b[0], b[1], b[2]);
            sum += d;
            if (d > max) max = d;
          }
        }
      }
    }
    const mean = sum / (w * h);
    return { file, status: mean < LIMITS.mean && max < LIMITS.max ? 'pass' : 'fail', mean, max };
  } finally {
    e.free();
  }
}

async function main(dir: string) {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter(f => /\.ps[db]$/i.test(f)).sort();
  } catch { /* reported below */ }
  if (!files.length) {
    console.error(`No .psd/.psb files in ${dir}. Put your own PSD files there (the folder is git-ignored).`);
    process.exit(1);
  }
  let failed = 0;
  for (const f of files) {
    let r: Result;
    try {
      r = await checkPsd(f, readFileSync(join(dir, f)));
    } catch (err) {
      r = { file: f, status: 'fail', reason: `error: ${(err as Error).message}` };
    }
    if (r.status === 'fail') failed++;
    const nums = r.mean === undefined ? '' : `mean dE ${r.mean.toFixed(3)}  max dE ${r.max!.toFixed(3)}`;
    console.log(`${r.status.toUpperCase().padEnd(4)}  ${f}  ${nums}${r.reason ? `  (${r.reason})` : ''}`);
  }
  console.log(`\n${files.length} files, ${failed} failed. Limits: mean dE2000 < ${LIMITS.mean}, max < ${LIMITS.max}.`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  await main(process.argv[2] ?? join(import.meta.dirname, 'corpus'));
}
