// PSD composite oracle (PLAN.md section 5): render each PSD's layers with the engine and compare with
// the merged composite Photoshop stored in the file. Usage: node tests/corpus.ts [dir] (default tests/corpus).
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initializeCanvas, readPsd, type Layer, type Psd } from 'ag-psd';
import init from '../app/src/engine-pkg/photobaer_engine.js';
import { importPsd } from '../app/src/psd.ts';
import { deltaE2000, srgbToLab } from './deltaE.ts';

export const LIMITS = { mean: 1, max: 5 };
export interface Result { file: string; status: 'pass' | 'fail' | 'skip'; reason?: string; mean?: number; max?: number; over?: number; excluded?: number }

// Files whose Photoshop composite no float formula reproduces. `over` bounds the count of pixels at dE >= LIMITS.max,
// `mean` replaces LIMITS.mean for that file.
export interface Allow { over?: number; mean?: number }
export const EXCEPTIONS: Record<string, Allow & { why: string }> = {
  // Measured 52: color burn/dodge, vivid light and divide with a source of 1-2/255, hard mix at sum 255/256,
  // darker/lighter color ties within one 8-bit Lum level. Photoshop's integer precision, not a formula error.
  'blend-modes__rgb-blend-modes.psd': { over: 60, why: '8-bit precision edge cases' },
  // Measured mean 1.375, max 4.271: pass-through group fill < 1 over a lighter color child below the Lum tie
  // mixes partially toward the source (docs/M1.md section 3, open). One fill value in the corpus fits no model.
  'passthrough_fill_blendmode.psd': { mean: 1.5, why: 'pass-through fill with lighter color, rule unknown' },
  // Measured mean 0.274, over 2130: the 1-px outside stroke ring of the styled clip base, which the file keeps with
  // blend interior on; styles.rs keeps the reference clamp of strokes to the shape (owner, 27 Sep 2026; clamping
  // before strokes measured over 62).
  'advanced-blending.psd': { over: 2130, why: 'blend interior clamp erases the outside stroke the file keeps' },
};

// Pixels where a visible dissolve layer has partial coverage: Photoshop draws a random pattern there.
function dissolveMask(psd: Psd): Uint8Array {
  const { width: w, height: h } = psd;
  const out = new Uint8Array(w * h);
  const walk = (layers: Layer[]) => {
    for (const l of layers) {
      if (l.hidden) continue;
      if (l.children) { walk(l.children); continue; }
      if (l.blendMode !== 'dissolve' || !l.imageData) continue;
      const k = (l.opacity ?? 1) * (l.fillOpacity ?? 1);
      const m = l.mask && !l.mask.disabled ? l.mask : undefined;
      const { width: lw, height: lh, data } = l.imageData;
      for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
        const X = x + (l.left ?? 0), Y = y + (l.top ?? 0);
        const a = data[(y * lw + x) * 4 + 3];
        if (X < 0 || Y < 0 || X >= w || Y >= h || a === 0) continue;
        let mv = 255;
        if (m) {
          const mx = X - (m.left ?? 0), my = Y - (m.top ?? 0), md = m.imageData;
          mv = md && mx >= 0 && my >= 0 && mx < md.width && my < md.height ? md.data[(my * md.width + mx) * 4] : m.defaultColor ?? 0;
        }
        if (mv > 0 && (a < 255 || mv < 255 || k < 1)) out[Y * w + X] = 1;
      }
    }
  };
  walk(psd.children ?? []);
  return out;
}

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
      for (const k of ['filterMask', 'realMask'] as const) {
        if (l[k] !== undefined) return `${name}: ${k}`;
      }
      // A shape layer's stored raster already has its vector mask applied; a pixel layer's does not.
      if (l.vectorMask && !l.vectorFill) return `${name}: vectorMask`;
      if (l.children && l.blendMode === 'dissolve') return `${name}: dissolve group`;
      if (l.children) { const r = walk(l.children); if (r) return r; }
    }
    return null;
  };
  return walk(psd.children ?? []);
}

// Both images are compared over white, because transparent pixels have no defined color.
export async function checkPsd(file: string, bytes: Uint8Array, allow: Allow = {}): Promise<Result> {
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
    const skip = dissolveMask(psd);
    let sum = 0, max = 0, over = 0, excluded = 0;
    for (let ty = 0; ty < Math.ceil(h / 256); ty++) {
      for (let tx = 0; tx < Math.ceil(w / 256); tx++) {
        const px = e.flatten_tile_rgba8(tx, ty);
        for (let y = 0; y < Math.min(256, h - ty * 256); y++) {
          for (let x = 0; x < Math.min(256, w - tx * 256); x++) {
            const i = (ty * 256 + y) * w + tx * 256 + x;
            if (skip[i]) { excluded++; continue; }
            const o = (y * 256 + x) * 4, r = i * 4;
            const a = srgbToLab(white(px[o], px[o + 3]), white(px[o + 1], px[o + 3]), white(px[o + 2], px[o + 3]));
            const b = srgbToLab(white(ref[r], ref[r + 3]), white(ref[r + 1], ref[r + 3]), white(ref[r + 2], ref[r + 3]));
            const d = deltaE2000(a[0], a[1], a[2], b[0], b[1], b[2]);
            sum += d;
            if (d > max) max = d;
            if (d >= LIMITS.max) over++;
          }
        }
      }
    }
    const mean = excluded < w * h ? sum / (w * h - excluded) : 0;
    return { file, status: mean < (allow.mean ?? LIMITS.mean) && over <= (allow.over ?? 0) ? 'pass' : 'fail', mean, max, over, excluded };
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
      r = await checkPsd(f, readFileSync(join(dir, f)), EXCEPTIONS[f]);
    } catch (err) {
      r = { file: f, status: 'fail', reason: `error: ${(err as Error).message}` };
    }
    if (r.status === 'fail') failed++;
    const nums = r.mean === undefined ? '' : `mean dE ${r.mean.toFixed(3)}  max dE ${r.max!.toFixed(3)}  over ${r.over}${EXCEPTIONS[f]?.over ? ` (allowed ${EXCEPTIONS[f].over})` : ''}${EXCEPTIONS[f]?.mean ? ` (mean allowed ${EXCEPTIONS[f].mean})` : ''}${r.excluded ? `  dissolve-excluded ${r.excluded}` : ''}`;
    console.log(`${r.status.toUpperCase().padEnd(4)}  ${f}  ${nums}${r.reason ? `  (${r.reason})` : ''}`);
  }
  console.log(`\n${files.length} files, ${failed} failed. Limits: mean dE2000 < ${LIMITS.mean}, max < ${LIMITS.max}.`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  await main(process.argv[2] ?? join(import.meta.dirname, 'corpus'));
}
