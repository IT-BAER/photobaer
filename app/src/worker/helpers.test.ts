import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { initSync, Engine } from '../engine-pkg/photobaer_engine.js';
import { renderRgba } from './helpers.ts';

initSync({ module: readFileSync(new URL('../engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });

test('renderRgba with several layers keeps only them, reveals hidden ones and trims to their union', () => {
  const e = new Engine(64, 32, 8);
  const square = (x: number, y: number, rgb: number[]) => {
    const id = e.add_layer('L', 0);
    e.put_rgba8(id, x, y, 4, 4, Uint8Array.from({ length: 64 }, (_, i) => (i % 4 === 3 ? 255 : rgb[i % 4])));
    return id;
  };
  const a = square(2, 2, [255, 0, 0]), b = square(20, 10, [0, 0, 255]), c = square(40, 20, [0, 255, 0]);
  e.set_props(b, JSON.stringify({ visible: false }));
  const r = renderRgba(e, { layers: [a, b], trim: true, reveal: true })!;
  assert.deepEqual([r.w, r.h], [22, 12], 'from (2,2) to (24,14)');
  assert.deepEqual([...r.data.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...r.data.subarray(((8 * 22) + 18) * 4, ((8 * 22) + 19) * 4)], [0, 0, 255, 255], 'the hidden layer is revealed');
  assert.equal(r.data[(11 * 22 + 21) * 4 + 3], 255);
  assert.equal(renderRgba(e, { layers: [c] })!.w, 64, 'untrimmed keeps the canvas');
  assert.equal(JSON.parse(e.layers_json()).find((n: { id: number }) => n.id === b).visible, false, 'the document is unchanged');
});
