import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writePsd, readPsd, type Layer, type Psd, type PixelData } from 'ag-psd';
import { initSync, Engine } from './engine-pkg/photobaer_engine.js';
import { importPsd, exportPsd, filterIn } from './psd.ts';
import { tileIds } from './project.ts';

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

test('a PSD of another bit depth than 8, 16 or 32 is rejected', () => {
  const bytes = bytesOf({ width: 4, height: 4, colorMode: 3, bitsPerChannel: 8, children: [] });
  bytes[22] = 0; bytes[23] = 1;
  assert.throws(() => importPsd(bytes));
});

test('an effect with a missing pattern is dropped alone; a disabled one without a warning', () => {
  const overlay = (enabled: boolean) => ({ present: enabled, enabled, pattern: { name: 'gone', id: 'gone' } });
  const stroke = [{ enabled: true, size: { units: 'Pixels' as const, value: 2 }, fillType: 'color' as const, color: { r: 1, g: 2, b: 3 } }];
  const psd: Psd = {
    width: 4, height: 4, colorMode: 3, bitsPerChannel: 8,
    children: [
      { name: 'off', top: 0, left: 0, imageData: solid(4, 4, [5, 6, 7, 255]), effects: { stroke, patternOverlay: overlay(false) } },
      { name: 'on', top: 0, left: 0, imageData: solid(4, 4, [5, 6, 7, 255]), effects: { stroke, patternOverlay: overlay(true) } },
    ],
  };
  const { engine, warnings } = importPsd(bytesOf(psd));
  assert.deepEqual(warnings, ['pattern effects that use a missing pattern were not imported']);
  for (const n of JSON.parse(engine.manifest()).layers) {
    assert.equal(n.style.strokes.length, 1, n.name);
    assert.equal(n.style.pattern_overlays.length, 0, n.name);
  }
  engine.free();
});

test('a text layer imports as a type layer that shows its raster', () => {
  const psd: Psd = {
    width: 4, height: 4, colorMode: 3, bitsPerChannel: 8,
    children: [{
      name: 'Text', top: 0, left: 0, imageData: solid(4, 4, [5, 6, 7, 255]),
      text: { text: 'Hi', transform: [1, 0, 0, 1, 0, 0], style: { font: { name: 'ArialMT' }, fontSize: 12, fillColor: { r: 255, g: 0, b: 0 } } },
    } as Layer],
  };
  const { engine, warnings } = importPsd(bytesOf(psd));
  assert.deepEqual(warnings, []);
  assert.equal(JSON.parse(engine.manifest()).layers[0].kind, 'text');
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

test('a saved selection is stored in the PSD as an alpha channel', () => {
  const psd: Psd = { width: 4, height: 4, colorMode: 3, bitsPerChannel: 8, children: [{ name: 'L', top: 0, left: 0, imageData: solid(4, 4, [1, 2, 3, 255]) }] };
  const { engine } = importPsd(bytesOf(psd));
  engine.select_rect(0, 0, 2, 2, 'new');
  engine.save_selection('Alpha 1');
  const { bytes, warnings } = exportPsd(engine);
  assert.deepEqual(warnings, []);
  const back = importPsd(bytes).engine;
  assert.deepEqual((JSON.parse(back.manifest()) as { channels: { name: string }[] }).channels.map(c => c.name), ['Alpha 1']);
  engine.free();
  back.free();
});

const cmyk = (c: number, m: number, y: number, k: number) => ({ c, m, y, k });
const hueCh = (a: number) => ({ a, b: a + 30, c: a + 60, d: a + 90, hue: 10, saturation: -5, lightness: 0 });
const levelsCh = (g: number) => ({ shadowInput: 20, highlightInput: 235, shadowOutput: 0, highlightOutput: 255, midtoneInput: g });

function adjustmentLayers(): Layer[] {
  const adj: NonNullable<Layer['adjustment']>[] = [
    { type: 'brightness/contrast', brightness: 150, contrast: -50, useLegacy: true },
    { type: 'levels', rgb: levelsCh(1.5), red: levelsCh(2) },
    { type: 'curves', rgb: [{ input: 0, output: 0 }, { input: 128, output: 160 }, { input: 255, output: 255 }], green: [{ input: 0, output: 10 }, { input: 255, output: 245 }] },
    { type: 'exposure', exposure: 1, offset: -0.25, gamma: 1.5 },
    { type: 'vibrance', vibrance: 30, saturation: -10 },
    { type: 'hue/saturation', master: { a: 0, b: 0, c: 0, d: 0, hue: 180, saturation: 0, lightness: 0 },
      reds: hueCh(315), yellows: hueCh(15), greens: hueCh(75), cyans: hueCh(135), blues: hueCh(195), magentas: hueCh(255) },
    { type: 'color balance', shadows: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 }, midtones: { cyanRed: 50, magentaGreen: 0, yellowBlue: -20 },
      highlights: { cyanRed: 0, magentaGreen: 10, yellowBlue: 0 }, preserveLuminosity: false },
    { type: 'black & white', reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, useTint: true, tintColor: { r: 206, g: 185, b: 155 } },
    { type: 'photo filter', color: { r: 236, g: 138, b: 0 }, density: 25, preserveLuminosity: true },
    { type: 'channel mixer', monochrome: true, red: { red: 100, green: 0, blue: 0, constant: 0 }, green: { red: 0, green: 100, blue: 0, constant: 0 },
      blue: { red: 0, green: 0, blue: 100, constant: 0 }, gray: { red: 40, green: 40, blue: 20, constant: 0 } },
    { type: 'color lookup', lookupType: '3dlut', name: 'warm.cube', dither: true, lutFormat: 'cube', dataOrder: 'rgb', tableOrder: 'rgb',
      lut3DFileData: new TextEncoder().encode('LUT_3D_SIZE 2\n'), lut3DFileName: 'warm.cube' },
    { type: 'invert' },
    { type: 'posterize', levels: 4 },
    { type: 'threshold', level: 128 },
    { type: 'gradient map', gradientType: 'solid', name: 'Custom', reverse: true, dither: true, smoothness: 1,
      colorStops: [{ color: { r: 0, g: 0, b: 0 }, location: 0, midpoint: 0.5 }, { color: { r: 255, g: 128, b: 0 }, location: 1, midpoint: 0.25 }],
      opacityStops: [{ opacity: 1, location: 0, midpoint: 0.5 }, { opacity: 0.2, location: 1, midpoint: 0.5 }] },
    { type: 'selective color', mode: 'absolute', reds: cmyk(10, 0, 0, 0), yellows: cmyk(0, 0, 0, 0), greens: cmyk(0, 0, 0, 0), cyans: cmyk(0, 0, 0, 0),
      blues: cmyk(0, 0, 0, 0), magentas: cmyk(0, 0, 0, 0), whites: cmyk(0, 0, 0, 0), neutrals: cmyk(0, 0, 0, -5), blacks: cmyk(0, 0, 0, 0) },
  ];
  return adj.map((a, i) => ({ name: `A${i}`, adjustment: a, opacity: 0.6, blendMode: 'multiply' }));
}

type Node = { kind: string; name: string; opacity: number; blend: string; adjustment?: unknown };
const layersOf = (e: { manifest(): string }) => (JSON.parse(e.manifest()) as { layers: Node[] }).layers;

test('adjustment layers import as adjustment nodes and survive open, save, open', () => {
  const psd = { width: 16, height: 16, colorMode: 3, bitsPerChannel: 8, children: adjustmentLayers() } as Psd;
  const { engine, warnings } = importPsd(bytesOf(psd));
  const first = layersOf(engine);
  assert.equal(first.length, 16);
  assert.ok(first.every(n => n.kind === 'adjustment' && n.opacity === 0.6 && n.blend === 'multiply'), JSON.stringify(first[0]));
  assert.deepEqual(first[0].adjustment, { kind: 'brightness_contrast', params: { brightness: 150, contrast: -50, legacy: true } });
  assert.deepEqual(first[9].adjustment, { kind: 'channel_mixer', params: {
    red: [100, 0, 0, 0], green: [0, 100, 0, 0], blue: [0, 0, 100, 0], gray: [40, 40, 20, 0], monochrome: true } });
  assert.deepEqual((first[14].adjustment as { params: { gradient: unknown } }).params.gradient, {
    method: 'classic',
    color_stops: [{ position: 0, color: [0, 0, 0], midpoint: 0.5 }, { position: 1, color: [255, 128, 0], midpoint: 0.25 }],
    opacity_stops: [{ position: 0, opacity: 1, midpoint: 0.5 }, { position: 1, opacity: 0.2, midpoint: 0.5 }],
  });
  assert.ok(!warnings.some(w => w.includes('adjustment')), warnings.join());
  const again = importPsd(exportPsd(engine).bytes).engine;
  const second = layersOf(again);
  assert.deepEqual(second.map(n => n.adjustment), first.map(n => n.adjustment));
  const lut = (n: Node) => (n.adjustment as { params: { table: number } }).params.table;
  assert.deepEqual([...again.tile_bytes(BigInt(lut(second[10])))], [...engine.tile_bytes(BigInt(lut(first[10])))]);
  engine.free(); again.free();
});

// PSD-representable M3 fixtures (docs/M3.md sections 4 to 6).
const linear = { name: 'Linear', points: [[0, 0], [255, 255]], mode: 'point', anti_alias: false };
const gradDef = {
  method: 'perceptual',
  color_stops: [{ position: 0, color: [0, 0, 0], midpoint: 0.5 }, { position: 1, color: [255, 128, 0], midpoint: 0.25 }],
  opacity_stops: [{ position: 0, opacity: 1, midpoint: 0.5 }, { position: 1, opacity: 0.5, midpoint: 0.5 }],
};
const gradFill = { gradient: gradDef, style: 'radial', angle: 30, scale: 1.5, reverse: true, dither: true, align_with_layer: false, offset: [0.1, -0.2] };
const patFill = { pattern_id: 'pat-1', scale: 1, angle: 0, linked: true, offset: [3, 4] };
const shadow = (knocks_out: boolean) => ({
  present: true, enabled: true, blend: 'multiply', opacity: 0.75, color: [0, 0, 0], use_global_light: true, angle: 120,
  distance: 5, spread: 0.25, size: 5, contour: { ...linear, anti_alias: true }, noise: 0.5, knocks_out,
});
const glow = (source: string, fill: unknown) => ({
  present: true, enabled: false, blend: 'screen', opacity: 0.75, fill, technique: 'precise', spread: 0.1, size: 5, range: 0.5,
  jitter: 0.25, noise: 0, contour: linear, source,
});
const psdStyle = {
  enabled: true, scale: 2,
  drop_shadows: [shadow(true), { ...shadow(false), enabled: false }],
  inner_shadows: [shadow(false)],
  color_overlays: [{ present: true, enabled: true, blend: 'normal', opacity: 1, color: [128, 128, 128] }],
  gradient_overlays: [{ present: true, enabled: true, blend: 'overlay', opacity: 0.5, gradient: gradFill }],
  pattern_overlays: [{ present: true, enabled: true, blend: 'normal', opacity: 1, pattern: { ...patFill, scale: 2, angle: 15, linked: false } }],
  strokes: [
    { present: true, enabled: true, size: 3, position: 'outside', blend: 'normal', opacity: 1, overprint: true, fill: { type: 'solid', color: [9, 8, 7] } },
    { present: true, enabled: true, size: 2, position: 'center', blend: 'normal', opacity: 1, overprint: false, fill: { type: 'gradient', ...gradFill } },
    { present: true, enabled: false, size: 1, position: 'inside', blend: 'normal', opacity: 1, overprint: false, fill: { type: 'pattern', ...patFill } },
  ],
  outer_glow: glow('edge', { type: 'color', color: [255, 255, 190] }),
  inner_glow: glow('center', { type: 'gradient', gradient: gradDef }),
  bevel: {
    present: true, enabled: true, style: 'stroke_emboss', technique: 'chisel_soft', depth: 2, direction: 'down', size: 5, soften: 2,
    use_global_light: false, angle: 60, altitude: 30, gloss_contour: linear, highlight_blend: 'screen', highlight_color: [255, 255, 255],
    highlight_opacity: 0.75, shadow_blend: 'multiply', shadow_color: [0, 0, 0], shadow_opacity: 0.75,
  },
  contour: { present: true, enabled: true, contour: { ...linear, anti_alias: true }, range: 0.5 },
  texture: { present: true, enabled: false, pattern_id: 'pat-1', scale: 2, depth: 1, invert: true, linked: true, offset: [1, 2] },
  satin: { present: true, enabled: true, blend: 'multiply', opacity: 0.5, color: [0, 0, 0], angle: 19, distance: 11, size: 14, contour: linear, invert: true },
};
const blending = {
  blend_if: {
    gray: { source: [10, 20, 200, 230], destination: [0, 0, 255, 255] },
    red: { source: [1, 2, 3, 4], destination: [0, 0, 255, 255] },
    green: { source: [0, 0, 255, 255], destination: [5, 6, 7, 8] },
    blue: { source: [0, 0, 255, 255], destination: [0, 0, 255, 255] },
  },
  channels: [true, true, true], knockout: 'shallow', blend_interior: true, blend_clipped: false, transparency_shapes: false,
  layer_mask_hides_effects: false, vector_mask_hides_effects: false,
};
const SO_ID = '20953ddb-9391-11ec-b4f1-c15674f50bc4';

function m3Doc(): Engine {
  const e = new Engine(16, 16, 8);
  const pat = e.blob_add(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]));
  e.set_document_m3(JSON.stringify({ global_light: { angle: 90, altitude: 45 }, patterns: [{ id: 'pat-1', name: 'P', width: 2, height: 2, blob: Number(pat) }] }));
  e.add_special(0, JSON.stringify({ name: 'Solid', content: { type: 'solid', color: [1, 2, 3] } }));
  e.add_special(0, JSON.stringify({ name: 'Gradient', content: { type: 'gradient', ...gradFill } }));
  e.add_special(0, JSON.stringify({ name: 'Pattern', content: { type: 'pattern', ...patFill } }));
  const styled = e.add_layer('Styled', 0);
  e.set_tile_rgba8(styled, 0, 0, new Uint8Array(256 * 256 * 4).fill(200));
  e.set_style(styled, JSON.stringify(psdStyle));
  e.set_blending(styled, JSON.stringify(blending));
  const src = e.blob_add(new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
  const smart = e.add_special(0, JSON.stringify({ name: 'Smart', smart: {
    link: { type: 'embedded', id: SO_ID }, source_blob: Number(src), source_size: [4, 4], transform: [2, 0, 3, 0, 2, 4, 0, 0, 1],
  } }));
  e.set_tile_rgba8(smart, 0, 0, new Uint8Array(256 * 256 * 4).fill(90));
  e.delete_node(1);
  return e;
}

type M3Node = Node & { content?: any; style?: any; blending?: any; smart?: any };
const m3Of = (e: Engine) => JSON.parse(e.manifest()) as { layers: M3Node[]; global_light: unknown; patterns: { id: string; blob: number }[] };

test('fill layers, layer styles, blending options, global light, patterns and smart objects survive save, open', () => {
  const e = m3Doc();
  const { bytes, warnings: saveWarnings } = exportPsd(e);
  assert.deepEqual(saveWarnings, []);
  const { engine: again, warnings } = importPsd(bytes);
  assert.deepEqual(warnings, []);
  const [a, b] = [m3Of(e), m3Of(again)];
  assert.deepEqual(b.layers.map(n => [n.kind, n.name]), a.layers.map(n => [n.kind, n.name]));
  assert.deepEqual(b.global_light, { angle: 90, altitude: 45 });
  assert.deepEqual(b.patterns.map(p => ({ ...p, blob: [...again.tile_bytes(BigInt(p.blob))] })),
    a.patterns.map(p => ({ ...p, blob: [...e.tile_bytes(BigInt(p.blob))] })));
  for (let i = 0; i < a.layers.length; i++) {
    assert.deepEqual(b.layers[i].content, a.layers[i].content, a.layers[i].name);
    assert.deepEqual(b.layers[i].style, a.layers[i].style, a.layers[i].name);
    assert.deepEqual(b.layers[i].blending, a.layers[i].blending, a.layers[i].name);
  }
  const [sa, sb] = [a.layers[4].smart, b.layers[4].smart];
  assert.deepEqual(sb.link, sa.link);
  assert.deepEqual(sb.source_size, sa.source_size);
  assert.deepEqual(sb.transform, sa.transform);
  assert.deepEqual([...again.tile_bytes(BigInt(sb.source.blob))], [...e.tile_bytes(BigInt(sa.source.blob))]);
  // Export crops layers to the 16x16 canvas.
  const tile = (en: Engine, n: any) => { const t = en.tile_bytes(BigInt(n.tiles[0][2])); return Array.from({ length: 16 }, (_, y) => [...t.subarray(y * 1024, y * 1024 + 64)]); };
  assert.deepEqual(tile(again, b.layers[4]), tile(e, a.layers[4]), 'smart object cache pixels');
  e.free(); again.free();
});

test('PSD save warns about M3 settings it cannot store', () => {
  const e = m3Doc();
  const top = (JSON.parse(e.manifest()) as { layers: { id: number }[] }).layers[4].id;
  e.set_blending(top, JSON.stringify({ ...blending, knockout: 'deep' }));
  e.add_special(0, JSON.stringify({ name: 'Scaled', content: { type: 'pattern', ...patFill, scale: 2 } }));
  const { warnings } = exportPsd(e);
  assert.deepEqual(new Set(warnings), new Set(['pattern scale, angle and link of fill layers and strokes are not stored in PSD', 'deep knockout is saved as shallow in PSD']));
  e.free();
});

test('layer comps survive save, open with names, flags, visibility and position', () => {
  const e = new Engine(300, 200, 8);
  e.fill(1, 'pixels', 255, 255, 255, 255);
  const box = e.add_layer('box', 1);
  const t = new Uint8Array(256 * 256 * 4);
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) t.set([255, 0, 0, 255], (y * 256 + x) * 4);
  e.set_tile_rgba8(box, 0, 0, t);
  e.capture_layer_comp('Start');
  e.offset_layer(box, 30, 5);
  e.set_props(box, JSON.stringify({ visible: false }));
  const moved = e.capture_layer_comp('Moved');
  e.update_layer_comp(moved, JSON.stringify({ apply_appearance: false }));
  const { bytes, warnings } = exportPsd(e);
  e.free();
  assert.ok(warnings.includes('layer comp appearance is not stored in PSD'), JSON.stringify(warnings));
  const back = importPsd(bytes).engine;
  type Comp = { name: string; apply_visibility: boolean; apply_position: boolean; apply_appearance: boolean; layers: { id: number; visible: boolean; position: number[] | null }[] };
  const m = JSON.parse(back.manifest()) as { layers: { id: number; name: string }[]; layer_comps: Comp[] };
  const id = m.layers.find(l => l.name === 'box')!.id;
  const state = (c: Comp) => { const l = c.layers.find(x => x.id === id)!; return [l.visible, l.position]; };
  assert.deepEqual(m.layer_comps.map(c => [c.name, c.apply_visibility, c.apply_position, c.apply_appearance]),
    [['Start', true, true, true], ['Moved', true, true, false]]);
  assert.deepEqual(state(m.layer_comps[0]), [true, [10, 10]]);
  assert.deepEqual(state(m.layer_comps[1]), [false, [40, 15]]);
  back.free();
});

test('a PSD layer comp captured in place applies without moving a layer off the tile grid', () => {
  const psd: Psd = {
    width: 300, height: 200, colorMode: 3, bitsPerChannel: 8,
    children: [{ id: 5, name: 'box', left: 100, top: 20, imageData: solid(20, 20, [255, 0, 0, 255]), comps: { settings: [{ compList: [1], enabled: true, offset: { x: 0, y: 0 } }] } }],
    imageResources: { layerComps: { list: [{ id: 1, name: 'C', capturedInfo: 7 as number }] } },
  };
  const e = importPsd(bytesOf(psd)).engine;
  const id = (JSON.parse(e.manifest()) as { layers: { id: number; name: string }[] }).layers.find(l => l.name === 'box')!.id;
  assert.deepEqual([...e.layer_bounds(id)], [100, 20, 20, 20]);
  e.apply_layer_comp(1);
  assert.deepEqual([...e.layer_bounds(id)], [100, 20, 20, 20]);
  e.free();
});

// A smart object whose source is a 3 x 2 PSB (as Convert to Smart Object writes it) placed at 2x.
function psbSmartDoc() {
  const src = new Engine(3, 2, 8);
  src.set_tile_rgba8(1, 0, 0, new Uint8Array(256 * 256 * 4).map((_, i) => (i % 4 === 3 ? 255 : i % 4 === 0 ? 200 : 10)));
  const psb = exportPsd(src, { psb: true }).bytes;
  src.free();
  assert.deepEqual([psb[4], psb[5]], [0, 2], 'a PSB header');
  const e = new Engine(16, 16, 8);
  const blob = e.blob_add(psb);
  const id = e.place_smart(0, JSON.stringify({
    name: 'Smart', link: { type: 'embedded', id: SO_ID }, source_blob: Number(blob), source_size: [3, 2], transform: [2, 0, 4, 0, 2, 4, 0, 0, 1],
  }), new Uint8Array(3 * 2 * 4).map((_, i) => (i % 4 === 3 ? 255 : i % 4 === 0 ? 200 : 10)));
  e.delete_node(1);
  return { e, id, psb };
}

test('an imported smart object with a PSB source is live: its source pixels come from the embedded bytes', () => {
  const { e, id, psb } = psbSmartDoc();
  const { engine: again, warnings, sources } = importPsd(exportPsd(e).bytes);
  assert.deepEqual(warnings, []);
  assert.deepEqual(sources, [], 'a PSD/PSB source is parsed on import');
  const n = (JSON.parse(again.manifest()) as { layers: M3Node[] }).layers[0];
  assert.deepEqual([...again.tile_bytes(BigInt(n.smart.source.blob))], [...psb], 'the embedded bytes round-trip');
  assert.equal(n.smart.source.tiles.length, 1, 'source tiles');
  again.render_smart((n as M3Node & { id: number }).id);
  assert.deepEqual([...again.flatten_tile_rgba8(0, 0)], [...e.flatten_tile_rgba8(0, 0)], 'a re-render from the imported source matches');
  const back = importPsd(exportPsd(again).bytes).engine;
  const m = (JSON.parse(back.manifest()) as { layers: M3Node[] }).layers[0];
  assert.deepEqual([...back.tile_bytes(BigInt(m.smart.source.blob))], [...psb]);
  e.free(); again.free(); back.free();
  void id;
});

test('a smart object with a smart filter PSD has no default object for refuses export naming the filter', () => {
  const { e, id } = psbSmartDoc();
  const m = JSON.parse(e.manifest());
  m.layers[0].smart.filters = [{ id: 1, filter: { kind: 'render.tree', params: {} }, enabled: true, opacity: 1, blend: 'normal', mask: null }];
  const f = Engine.from_manifest(JSON.stringify(m));
  for (const t of tileIds(JSON.stringify(m))) f.put_tile(BigInt(t), e.tile_bytes(BigInt(t)));
  f.finish_load();
  assert.throws(() => exportPsd(f), /Cannot export Tree as an editable Photoshop filter/);
  e.free(); f.free();
  void id;
});

test('curves and brightness/contrast smart filters round-trip through PSD with params, stack mask and render', () => {
  const { e, id } = psbSmartDoc();
  const curves = { kind: 'curves', params: { mode: 'point', composite: [[0, 0], [128, 200], [255, 255]], red: null, green: [[0, 30], [255, 255]], blue: null } };
  const bc = { kind: 'brightness_contrast', params: { brightness: 20, contrast: -10, legacy: false } };
  e.add_smart_filter(id, JSON.stringify(curves));
  e.add_smart_filter(id, JSON.stringify(bc));
  e.set_smart_filter(id, 2, JSON.stringify({ opacity: 0.5, blend: 'multiply' }));
  e.add_filter_mask(id, 0, true);
  e.set_filter_mask_tile8(id, 0, 0, 0, new Uint8Array(256 * 256).map((_, i) => (i % 256 < 7 ? 255 : 0)));
  e.render_smart(id);
  const filtered = [...e.flatten_tile_rgba8(0, 0)];
  const { engine: again, warnings } = importPsd(exportPsd(e).bytes);
  assert.deepEqual(warnings, []);
  const n = m3Of(again).layers[0] as M3Node & { id: number };
  const strip = (fs: any[]) => fs.map(({ filter, enabled, opacity, blend }) => ({ filter, enabled, opacity, blend }));
  assert.deepEqual(strip(n.smart.filters), strip(m3Of(e).layers[0].smart.filters), 'params, enabled, opacity and mode');
  assert.equal(n.smart.stack_mask.default, 255);
  assert.deepEqual([...again.flatten_tile_rgba8(0, 0)], filtered, 'the stored render');
  again.render_smart(n.id);
  assert.deepEqual([...again.flatten_tile_rgba8(0, 0)], filtered, 'a re-render with the imported filters and stack mask matches');
  e.free(); again.free();
});

test('a curves filter channel outside composite/red/green/blue is dropped with a warning', () => {
  const warnings: string[] = [];
  const f = { type: 'curves', filter: { adjustments: [
    { channels: ['composite'], curve: [{ x: 0, y: 10 }, { x: 255, y: 255 }] },
    { channels: ['cyan'], curve: [{ x: 0, y: 0 }, { x: 255, y: 200 }] },
  ] } } as unknown as Parameters<typeof filterIn>[0];
  const a = filterIn(f, m => warnings.push(m))!;
  assert.deepEqual(a.params, { mode: 'point', composite: [[0, 10], [255, 255]], red: null, green: null, blue: null });
  assert.deepEqual(warnings, ['curves smart filter channels other than composite, red, green and blue were not imported']);
});

test('a smart object stack mask with tiles outside the canvas warns on PSD export', () => {
  const { e, id } = psbSmartDoc();
  e.add_smart_filter(id, JSON.stringify({ kind: 'brightness_contrast', params: { brightness: 20, contrast: 0, legacy: false } }));
  e.add_filter_mask(id, 0, true);
  e.set_filter_mask_tile8(id, 0, 0, 0, new Uint8Array(256 * 256).fill(0));
  assert.ok(!exportPsd(e).warnings.includes('smart filter mask areas outside the canvas are not stored in PSD'));
  const m = JSON.parse(e.manifest());
  const sm = m.layers[0].smart.stack_mask;
  sm.tiles.push([-1, 0, sm.tiles[0][2]]);
  const f = Engine.from_manifest(JSON.stringify(m));
  for (const t of tileIds(JSON.stringify(m))) f.put_tile(BigInt(t), e.tile_bytes(BigInt(t)));
  f.finish_load();
  assert.ok(exportPsd(f).warnings.includes('smart filter mask areas outside the canvas are not stored in PSD'));
  e.free(); f.free();
});

test('adjustments without a PSD filter refuse export naming the filter', () => {
  const { e, id } = psbSmartDoc();
  e.add_smart_filter(id, JSON.stringify({ kind: 'posterize', params: { levels: 4 } }));
  assert.throws(() => exportPsd(e), /Cannot export Posterize as an editable Photoshop filter/);
  e.free();
});

test('image-file smart object sources are left to the caller\'s decoder', () => {
  const e = m3Doc();
  const { engine, sources } = importPsd(exportPsd(e).bytes);
  assert.equal(sources.length, 1);
  assert.deepEqual([...sources[0].bytes], [137, 80, 78, 71, 1, 2, 3]);
  e.free(); engine.free();
});
