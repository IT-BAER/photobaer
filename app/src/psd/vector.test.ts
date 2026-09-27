import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writePsd, readPsd, type BezierPath, type Layer, type Psd, type PixelData } from 'ag-psd';
import { initSync } from '../engine-pkg/photobaer_engine.js';
import { importPsd, exportPsd } from '../psd.ts';
import { readSavedPaths, writeSavedPaths } from './vector.ts';

initSync({ module: readFileSync(new URL('../engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });

const W = 100, H = 80;
const px = (value: number) => ({ units: 'Pixels' as const, value });
const solid = (w: number, h: number): PixelData => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(200) });
const bytesOf = (psd: Psd) => new Uint8Array(writePsd(psd, { generateThumbnail: false }));

// Rect 10.5..60 x 20..50 as 4 corner knots; ag-psd points are [inX, inY, x, y, outX, outY].
const corner = (x: number, y: number) => ({ linked: false, points: [x, y, x, y, x, y] });
const rect = (op: 'combine' | 'subtract'): BezierPath => ({
  open: false, operation: op, fillRule: 'non-zero',
  knots: [corner(10.5, 20), corner(60, 20), { linked: true, points: [58, 50, 60, 50, 62, 50] }, corner(10.5, 50)],
});

function layersOf(bytes: Uint8Array) {
  const { engine, warnings } = importPsd(bytes);
  try {
    const m = JSON.parse(engine.manifest());
    return { m, warnings, out: exportPsd(engine).bytes };
  } finally {
    engine.free();
  }
}

test('shape layer: path, ops, fill rule, stroke and live radii survive open -> save -> open', () => {
  const shape: Layer = {
    name: 'Rectangle 1',
    vectorFill: { type: 'color', color: { r: 255, g: 0, b: 0 } },
    vectorMask: { paths: [rect('combine'), rect('subtract')] },
    vectorStroke: {
      strokeEnabled: true, fillEnabled: true, lineWidth: px(3), lineDashOffset: px(0), miterLimit: 4,
      lineCapType: 'round', lineJoinType: 'round', lineAlignment: 'outside', lineDashSet: [px(2), px(1)],
      blendMode: 'normal', opacity: 1, content: { type: 'color', color: { r: 0, g: 0, b: 255 } },
    },
    vectorOrigination: { keyDescriptorList: [{
      keyOriginType: 1,
      keyOriginRRectRadii: { topRight: px(10), topLeft: px(5), bottomLeft: px(15), bottomRight: px(20) },
      keyOriginShapeBoundingBox: { top: px(20), left: px(10.5), bottom: px(50), right: px(60) },
    }] },
  };
  const first = layersOf(bytesOf({ width: W, height: H, children: [shape] }));
  assert.ok(!first.warnings.some(w => w.includes('vector')), first.warnings.join());
  const n = first.m.layers[0];
  assert.equal(n.kind, 'shape');
  const s = n.shape;
  assert.equal(s.path.fill_rule, 'nonzero');
  assert.deepEqual(s.path.subpaths.map((p: any) => p.op), ['combine', 'subtract']);
  assert.equal(s.path.subpaths[0].points.length, 4);
  for (const p of s.path.subpaths[0].points) assert.equal(p.length, 6);
  const knot = s.path.subpaths[0].points[2];
  [60, 50, 58, 50, 62, 50].forEach((v, i) => assert.ok(Math.abs(knot[i] - v) < 1e-5, `${knot}`));
  assert.deepEqual(s.fill, { type: 'solid', color: [255, 0, 0] });
  const st = s.stroke;
  assert.deepEqual([st.enabled, st.width, st.align, st.cap, st.join, st.dash], [true, 3, 'outside', 'round', 'round', [2, 1]]);
  assert.deepEqual(st.content, { type: 'solid', color: [0, 0, 255] });
  assert.deepEqual(s.live, { type: 'rectangle', bounds: [10.5, 20, 60, 50], radii: [5, 10, 15, 20] });

  const second = layersOf(first.out);
  assert.deepEqual(second.m.layers[0].shape, s);
  const back = readPsd(first.out, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true }).children![0];
  assert.deepEqual(back.vectorOrigination!.keyDescriptorList[0].keyOriginRRectRadii, shape.vectorOrigination!.keyDescriptorList[0].keyOriginRRectRadii);
});

test('vector mask on a pixel layer: flags, density, feather and the raster mask survive', () => {
  const layer: Layer = {
    name: 'Masked', top: 0, left: 0, imageData: solid(W, H),
    vectorMask: { invert: true, disable: true, notLink: true, paths: [rect('combine')] },
    mask: { fromVectorData: true, defaultColor: 255, vectorMaskDensity: 0.5, vectorMaskFeather: 4 },
    realMask: { top: 0, left: 0, defaultColor: 0, imageData: solid(8, 8) },
  };
  const first = layersOf(bytesOf({ width: W, height: H, children: [layer] }));
  assert.deepEqual(first.warnings, []);
  const n = first.m.layers[0];
  assert.equal(n.kind, 'pixel');
  const vm = n.vector_mask;
  assert.deepEqual([vm.inverted, vm.enabled, vm.linked, vm.feather], [true, false, false, 4]);
  assert.ok(Math.abs(vm.density - 0.5) <= 0.5 / 255, `${vm.density}`);
  assert.equal(vm.path.subpaths[0].points.length, 4);
  assert.ok(n.mask, 'the real user mask becomes the raster mask');
  const second = layersOf(first.out);
  assert.deepEqual(second.m.layers[0].vector_mask, vm);
  assert.ok(second.m.layers[0].mask);
});

test('layout: guides, grid, resolution, artboard and saved paths survive open -> save -> open', () => {
  const psd: Psd = {
    width: W, height: H,
    imageResources: {
      resolutionInfo: { horizontalResolution: 300, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: 300, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' },
      gridAndGuidesInformation: { grid: { horizontal: 576, vertical: 576 }, guides: [{ location: 100.5, direction: 'vertical' }, { location: 30, direction: 'horizontal' }] },
    },
    children: [{
      name: 'Artboard 1', children: [{ name: 'L', top: 0, left: 0, imageData: solid(4, 4) }],
      artboard: { rect: { top: 0, left: 10, bottom: 70, right: 90 }, guideIndices: [1], presetName: 'Custom', backgroundType: 1, color: { r: 255, g: 255, b: 255 } },
    } as Layer],
  };
  const paths = [
    { name: 'Path 1', work: false, path: { fill_rule: 'nonzero' as const, subpaths: [{ closed: true, op: 'combine' as const, points: [[10, 10, 10, 10, 10, 10], [50, 10, 40, 5, 60, 15], [50, 60, 50, 60, 50, 60]] }] } },
    { name: 'Work Path', work: true, path: { fill_rule: 'evenodd' as const, subpaths: [{ closed: false, op: 'combine' as const, points: [[1, 2, 1, 2, 1, 2], [3, 4, 3, 4, 3, 4]] }] } },
  ];
  const input = writeSavedPaths(bytesOf(psd), paths, W, H);
  assert.equal(readSavedPaths(input, W, H).length, 2);
  const first = layersOf(input);
  const { m } = first;
  assert.equal(m.resolution, 300);
  assert.deepEqual(m.grid, { spacing_x: 18, spacing_y: 18 });
  assert.deepEqual(m.guides.map((g: any) => [g.axis, g.pos]), [['x', 100.5], ['y', 30]]);
  const ab = m.layers[0].artboard;
  assert.deepEqual(ab.rect, [10, 0, 90, 70]);
  assert.deepEqual(ab.guide_ids, [m.guides[1].id]);
  assert.deepEqual(ab.background, { type: 'white' });
  assert.deepEqual(m.paths.map((p: any) => [p.name, p.work]), [['Path 1', false], ['Work Path', true]]);
  // Path records are 8.24 fixed point fractions of the document size.
  m.paths[0].path.subpaths[0].points[1].forEach((v: number, i: number) => assert.ok(Math.abs(v - [50, 10, 40, 5, 60, 15][i]) < 1e-5));
  assert.equal(m.paths[1].path.fill_rule, 'evenodd');
  assert.equal(m.paths[1].path.subpaths[0].closed, false);

  const second = layersOf(first.out).m;
  for (const k of ['resolution', 'grid', 'guides', 'paths']) assert.deepEqual(second[k], m[k], k);
  assert.deepEqual(second.layers[0].artboard, ab);
  const back = readPsd(first.out, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  assert.equal(back.imageResources!.gridAndGuidesInformation!.grid!.horizontal, 576);
  assert.equal(back.imageResources!.gridAndGuidesInformation!.guides![0].location, 100.5);
});

test('import uses engine setters: an out-of-UI-range adjustment beside shapes and paths still opens', () => {
  const evenOdd = (p: BezierPath): BezierPath => ({ ...p, fillRule: 'even-odd' });
  const red = { type: 'color' as const, color: { r: 255, g: 0, b: 0 } };
  const psd: Psd = {
    width: W, height: H,
    imageResources: { resolutionInfo: { horizontalResolution: 300, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: 300, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' } },
    children: [
      { name: 'BC', adjustment: { type: 'brightness/contrast', brightness: 150, contrast: 0, useLegacy: true } },
      { name: 'Shape', vectorFill: red, vectorMask: { paths: [evenOdd(rect('combine')), evenOdd(rect('combine'))] } },
      { name: 'All but', vectorFill: red, vectorMask: { fillStartsWithAllPixels: true, paths: [rect('subtract')] } },
      { name: 'Soft', vectorFill: red, vectorMask: { paths: [rect('combine')] }, mask: { fromVectorData: true, vectorMaskDensity: 0.8 } },
    ],
  };
  const { m, warnings } = layersOf(writeSavedPaths(bytesOf(psd), [{ name: 'Path 1', work: false, path: { fill_rule: 'nonzero', subpaths: [] } }], W, H));
  assert.deepEqual(warnings, []);
  const [bc, shape, allBut, soft] = m.layers;
  assert.equal(bc.adjustment.params.brightness, 150);
  assert.equal(m.resolution, 300);
  assert.equal(m.paths.length, 1);
  // The PSD subpath flag is not a fill rule: two combine subpaths unite.
  assert.equal(shape.shape.path.fill_rule, 'nonzero');
  const all = allBut.shape.path.subpaths;
  assert.deepEqual(all.map((s: any) => s.op), ['combine', 'subtract']);
  assert.deepEqual(all[0].points.map((p: number[]) => p.slice(0, 2)), [[0, 0], [W, 0], [W, H], [0, H]]);
  assert.equal(soft.kind, 'fill');
  assert.ok(Math.abs(soft.vector_mask.density - 0.8) <= 1 / 255);
});

test('a group vector mask and an inverted or disabled fill-layer vector mask survive open -> save -> open', () => {
  const red = { type: 'color' as const, color: { r: 255, g: 0, b: 0 } };
  const psd: Psd = {
    width: W, height: H,
    children: [
      { name: 'Group', vectorMask: { paths: [rect('combine')], invert: true }, children: [{ name: 'px', imageData: solid(W, H) }] },
      { name: 'Inverted', vectorFill: red, vectorMask: { paths: [rect('combine')], invert: true } },
      { name: 'Disabled', vectorFill: red, vectorMask: { paths: [rect('combine')], disable: true } },
    ],
  };
  const first = layersOf(bytesOf(psd));
  const { m } = layersOf(first.out);
  const [group, inverted, disabled] = m.layers;
  assert.equal(group.vector_mask.inverted, true);
  assert.equal(group.vector_mask.path.subpaths.length, 1);
  assert.equal(inverted.kind, 'fill');
  assert.equal(inverted.vector_mask.inverted, true);
  assert.equal(disabled.kind, 'fill');
  assert.equal(disabled.vector_mask.enabled, false);
});
