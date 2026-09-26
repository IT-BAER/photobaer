import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writePsd, readPsd, type Layer, type Psd, type PixelData } from 'ag-psd';
import { initSync } from './engine-pkg/photobaer_engine.js';
import { importPsd, exportPsd } from './psd.ts';

initSync({ module: readFileSync(new URL('./engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });

function solid(w: number, h: number, [r, g, b, a]: [number, number, number, number]): PixelData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a; }
  return { width: w, height: h, data };
}

function bytesOf(psd: Psd): Uint8Array {
  return new Uint8Array(writePsd(psd, { generateThumbnail: false }));
}

function richPsd(): Psd {
  return {
    width: 16, height: 16, colorMode: 3, bitsPerChannel: 8,
    children: [
      { name: 'Base', top: 0, left: 0, imageData: solid(16, 16, [10, 20, 30, 255]) },
      { name: 'Clip', top: 0, left: 0, clipping: true, imageData: solid(16, 16, [40, 50, 60, 200]) },
      {
        name: 'Group1', opened: true, fillOpacity: 0.5,
        children: [
          {
            name: 'Masked', top: 0, left: 0, imageData: solid(16, 16, [1, 2, 3, 255]),
            mask: { top: 4, left: 4, defaultColor: 0, imageData: solid(8, 8, [255, 255, 255, 255]) },
          },
        ],
      },
      {
        name: 'Multiply', top: 0, left: 0, blendMode: 'multiply', opacity: 0.5, fillOpacity: 0.25, hidden: true,
        protected: { transparency: true, composite: false, position: false },
        imageData: solid(16, 16, [9, 9, 9, 255]),
      },
    ],
  };
}

test('import maps groups, masks, clipping, blend, opacity, fill, visibility and locks', () => {
  const { engine } = importPsd(bytesOf(richPsd()));
  const tree = JSON.parse(engine.layers_json());
  assert.equal(tree.length, 4);
  const [base, clip, group, multiply] = tree;
  assert.equal(base.name, 'Base');
  assert.equal(base.kind, 'pixel');
  assert.deepEqual(base.locks, { transparency: false, pixels: false, position: false });
  assert.equal(clip.name, 'Clip');
  assert.equal(clip.clipping, true);
  assert.equal(group.name, 'Group1');
  assert.equal(group.kind, 'group');
  assert.equal(group.children.length, 1);
  assert.ok(Math.abs(group.fill - 0.5) < 0.01, `group fill ${group.fill}`);
  const masked = group.children[0];
  assert.equal(masked.name, 'Masked');
  assert.deepEqual(masked.mask, { enabled: true, default: 0 });
  assert.equal(multiply.name, 'Multiply');
  assert.equal(multiply.blend, 'multiply');
  // PSD opacity/fill round-trip through an 8-bit byte, so 0.5 and 0.25 land a fraction off.
  assert.ok(Math.abs(multiply.opacity - 0.5) < 0.01, `opacity ${multiply.opacity}`);
  assert.ok(Math.abs(multiply.fill - 0.25) < 0.01, `fill ${multiply.fill}`);
  assert.equal(multiply.visible, false);
  assert.deepEqual(multiply.locks, { transparency: true, pixels: false, position: false });
  engine.free();
});

test('a layer partly outside the canvas is cropped on import', () => {
  const psd: Psd = {
    width: 8, height: 8, colorMode: 3, bitsPerChannel: 8,
    children: [{ name: 'L', top: -4, left: -4, imageData: solid(8, 8, [200, 100, 50, 255]) }],
  };
  const { engine } = importPsd(bytesOf(psd));
  const px = engine.flatten_tile_rgba8(0, 0);
  const at = (x: number, y: number) => px.slice((y * 256 + x) * 4, (y * 256 + x) * 4 + 4);
  assert.deepEqual([...at(0, 0)], [200, 100, 50, 255]);
  assert.deepEqual([...at(3, 3)], [200, 100, 50, 255]);
  assert.deepEqual([...at(5, 5)], [0, 0, 0, 0]);
  engine.free();
});

// Opacity/fill quantize through an 8-bit PSD byte and an f32 engine field; round to compare structurally.
function roundOpacity(json: string): string {
  return JSON.stringify(JSON.parse(json), (k, v) => (k === 'opacity' || k === 'fill') && typeof v === 'number' ? Math.round(v * 20) / 20 : v);
}

test('import, export, re-import round trips the tree and every tile', () => {
  const a = importPsd(bytesOf(richPsd()));
  const { bytes: bytes2 } = exportPsd(a.engine);
  const b = importPsd(bytes2);
  assert.equal(roundOpacity(a.engine.layers_json()), roundOpacity(b.engine.layers_json()));
  for (let ty = 0; ty < Math.ceil(a.engine.height() / 256); ty++) {
    for (let tx = 0; tx < Math.ceil(a.engine.width() / 256); tx++) {
      assert.deepEqual([...a.engine.flatten_tile_rgba8(tx, ty)], [...b.engine.flatten_tile_rgba8(tx, ty)]);
    }
  }
  a.engine.free();
  b.engine.free();
});

test('a PSB header is rejected before parsing', () => {
  const bytes = bytesOf({ width: 4, height: 4, colorMode: 3, bitsPerChannel: 8, children: [] });
  bytes[5] = 2;
  assert.throws(() => importPsd(bytes), /PSB files are not supported yet/);
});

test('a 16-bit PSD header is rejected', () => {
  const bytes = bytesOf({ width: 4, height: 4, colorMode: 3, bitsPerChannel: 8, children: [] });
  bytes[22] = 0; bytes[23] = 16;
  assert.throws(() => importPsd(bytes));
});

test('a text layer imports its raster and warns once', () => {
  const psd: Psd = {
    width: 4, height: 4, colorMode: 3, bitsPerChannel: 8,
    children: [{
      name: 'Text', top: 0, left: 0, imageData: solid(4, 4, [5, 6, 7, 255]),
      text: { text: 'Hi', transform: [1, 0, 0, 1, 0, 0], style: { font: { name: 'ArialMT' }, fontSize: 12, fillColor: { r: 255, g: 0, b: 0 } } },
    } as Layer],
  };
  const { engine, warnings } = importPsd(bytesOf(psd));
  assert.deepEqual(warnings, ['text layers were imported as pixels']);
  assert.deepEqual([...engine.flatten_tile_rgba8(0, 0).slice(0, 4)], [5, 6, 7, 255]);
  engine.free();
});

test('a flat PSD with no layer records places the composite into the Background layer', () => {
  const img = solid(6, 6, [12, 34, 56, 255]);
  const psd: Psd = { width: 6, height: 6, colorMode: 3, bitsPerChannel: 8, imageData: img };
  const { engine } = importPsd(bytesOf(psd));
  const px = engine.flatten_tile_rgba8(0, 0);
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 6; x++) {
      const o = (y * 256 + x) * 4, r = (y * 6 + x) * 4;
      assert.deepEqual([...px.slice(o, o + 4)], [...img.data.slice(r, r + 4)]);
    }
  }
  engine.free();
});

test('an exported layer covering one tile is written at that tile\'s bounding rect, not the full canvas', () => {
  const psd: Psd = {
    width: 600, height: 600, colorMode: 3, bitsPerChannel: 8,
    children: [{ name: 'L', top: 10, left: 10, imageData: solid(20, 20, [1, 2, 3, 255]) }],
  };
  const { engine } = importPsd(bytesOf(psd));
  const { bytes } = exportPsd(engine);
  const back = readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  const l = back.children![0];
  assert.ok((l.right! - l.left!) <= 256, `right-left ${l.right! - l.left!}`);
  assert.ok((l.bottom! - l.top!) <= 256, `bottom-top ${l.bottom! - l.top!}`);
  engine.free();
});

test('exportPsd composite equals the engine flatten output', () => {
  const psd: Psd = {
    width: 4, height: 4, colorMode: 3, bitsPerChannel: 8,
    children: [{ name: 'L', top: 0, left: 0, imageData: solid(4, 4, [11, 22, 33, 255]) }],
  };
  const { engine } = importPsd(bytesOf(psd));
  const { bytes } = exportPsd(engine);
  const back = readPsd(bytes, { useImageData: true, skipThumbnail: true });
  const flat = engine.flatten_tile_rgba8(0, 0);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const o = (y * 256 + x) * 4, r = (y * 4 + x) * 4;
      assert.deepEqual([...flat.slice(o, o + 4)], [...back.imageData!.data.slice(r, r + 4)]);
    }
  }
  engine.free();
});

// ag-psd only carries alpha-channel names (imageResources.alphaChannelNames), not pixel data for
// extra channels, so a saved selection warns and is dropped rather than round-tripped.
test('exportPsd warns when the document has a saved selection channel', () => {
  const psd: Psd = { width: 4, height: 4, colorMode: 3, bitsPerChannel: 8, children: [{ name: 'L', top: 0, left: 0, imageData: solid(4, 4, [1, 2, 3, 255]) }] };
  const { engine } = importPsd(bytesOf(psd));
  engine.select_rect(0, 0, 2, 2, 'new');
  engine.save_selection('Alpha 1');
  const { warnings } = exportPsd(engine);
  assert.deepEqual(warnings, ['saved selections are not stored in PSD']);
  engine.free();
});
