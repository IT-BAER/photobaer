import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, Engine } from '../engine-pkg/photobaer_engine.js';
import { inkCurve } from './inkCurve.ts';
import type { InkCurve } from '../worker/types.ts';

initSync({ module: readFileSync(new URL('../engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });

test('inkCurve matches the engine Duotone display of one black ink', () => {
  const curves: InkCurve[] = [
    [0, null, null, null, null, null, 40, null, null, null, null, null, 100],
    [0, null, 12.5, null, null, null, 40, null, null, 70.3, null, null, 100],
    [null, 30, null, null, null, 10, null, 80, null, null, null, 20, null],
    [5, null, null, null, null, null, null, null, null, null, null, null, 60],
  ];
  for (const c of curves) {
    const e = new Engine(256, 1, 8);
    const row = new Uint8Array(256 * 4);
    for (let x = 0; x < 256; x++) row.set([x, x, x, 255], x * 4);
    e.put_rgba8(1, 0, 0, 256, 1, row);
    e.convert_mode(true);
    e.set_color_mode(JSON.stringify({ mode: 'duotone', inks: [[0, 0, 0]], curves: [c] }));
    const shown = e.flatten_tile_f32(0, 0);
    // One black ink shows white minus its density at ink 1 - gray.
    for (let x = 0; x < 256; x += 5) assert.ok(Math.abs(1 - shown[x * 4] - inkCurve(c, 1 - x / 255)) < 1e-4, `${c} at ${x}`);
    e.free();
  }
});
