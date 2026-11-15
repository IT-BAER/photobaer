import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writePsd, readPsd, type Psd, type PixelData } from 'ag-psd';
import { initSync } from '../engine-pkg/photobaer_engine.js';
import { importPsd, exportPsd } from '../psd.ts';

initSync({ module: readFileSync(new URL('../engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });

const W = 40, H = 30;
const solid = (w: number, h: number): PixelData => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(200) });
const mask = (unlinked: boolean) => ({ top: 0, left: 0, right: 10, bottom: 10, defaultColor: 0, positionRelativeToLayer: unlinked, imageData: solid(10, 10) });

test('layer colors, link groups and an unlinked layer mask survive open -> save -> open', () => {
  const psd: Psd = {
    width: W, height: H,
    children: [
      { name: 'A', imageData: solid(W, H), layerColor: 'violet', linkGroup: 3, mask: mask(true) },
      { name: 'B', imageData: solid(W, H), layerColor: 'gray', linkGroup: 3 },
      { name: 'C', imageData: solid(W, H), mask: mask(false) },
    ],
  };
  const { engine } = importPsd(new Uint8Array(writePsd(psd, { generateThumbnail: false })));
  let out: Uint8Array;
  try {
    const [a, b, c] = JSON.parse(engine.manifest()).layers;
    assert.deepEqual([a.color, a.link, a.mask.linked], ['violet', 3, false]);
    assert.deepEqual([b.color, b.link], ['gray', 3]);
    assert.deepEqual([c.color, c.link, c.mask.linked], [undefined, undefined, undefined], 'defaults stay unwritten');
    out = exportPsd(engine).bytes;
  } finally {
    engine.free();
  }
  const back = readPsd(out, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true }).children!;
  assert.deepEqual(back.map(l => [l.layerColor ?? 'none', l.linkGroup ?? 0, !!l.mask?.positionRelativeToLayer]),
    [['violet', 3, true], ['gray', 3, false], ['none', 0, false]]);
});
