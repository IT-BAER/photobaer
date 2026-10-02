import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readPsd, type Filter, type Psd } from 'ag-psd';
import descriptor from 'ag-psd/dist/descriptor.js';
import { createReader, readSignature, readInt32 } from 'ag-psd/dist/psdReader.js';
import { initSync, Engine } from '../engine-pkg/photobaer_engine.js';
import { importPsd, exportPsd } from '../psd.ts';
import { filterIn, meshToPblq, parseLiquifyMesh, pblqToMesh, prepareList, writeLiquifyMesh, writePsdRaw } from './filters.ts';

initSync({ module: readFileSync(new URL('../engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });

const SO = '20953ddb-9391-11ec-b4f1-c15674f50bc4';
const N = 16;
const px = (value: number) => ({ units: 'Pixels', value });
const pixel = (x: number, y: number) => [x * 16, y * 16, 100, 255];

function image() {
  const data = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) data.set(pixel(x, y), (y * N + x) * 4);
  return { width: N, height: N, data };
}

// The embedded source: a PSB of the same image (as Convert to Smart Object writes it).
function sourcePsb(): Uint8Array {
  const e = new Engine(N, N, 8);
  const tile = new Uint8Array(256 * 256 * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) tile.set(pixel(x, y), (y * 256 + x) * 4);
  e.set_tile_rgba8(1, 0, 0, tile);
  const b = exportPsd(e, { psb: true }).bytes;
  e.free();
  return b;
}
const SRC = sourcePsb();

const item = (type: string, filter?: object): Filter => ({
  type, ...(filter ? { filter } : {}), name: type, opacity: 1, blendMode: 'normal', enabled: true, hasOptions: !!filter,
  foregroundColor: { r: 0, g: 0, b: 0 }, backgroundColor: { r: 255, g: 255, b: 255 },
} as unknown as Filter);

function psdOf(list: Filter[]): Uint8Array {
  const psd: Psd = {
    width: N, height: N, colorMode: 3, bitsPerChannel: 8,
    children: [{
      name: 'S', top: 0, left: 0, imageData: image(),
      placedLayer: {
        id: SO, placed: SO, type: 'raster', transform: [0, 0, N, 0, N, N, 0, N], nonAffineTransform: [0, 0, N, 0, N, N, 0, N], width: N, height: N,
        filter: { enabled: true, validAtPosition: true, maskEnabled: true, maskLinked: true, maskExtendWithWhite: true, list },
      },
    }],
    linkedFiles: [{ id: SO, name: 's.psb', data: SRC }],
  };
  prepareList(list);
  return new Uint8Array(writePsdRaw(psd, { generateThumbnail: false }, new Map()));
}

const listOf = (bytes: Uint8Array) => readPsd(bytes, { skipThumbnail: true, useImageData: true }).children![0].placedLayer!.filter!.list;
type MNode = { id: number; smart: { transform: number[]; filters: { id: number; filter: { kind: string; params: any }; psd?: any }[] } };
const nodeOf = (e: Engine) => (JSON.parse(e.manifest()) as { layers: MNode[] }).layers[0];
const strip = (e: Engine) => nodeOf(e).smart.filters.map(f => f.filter);

function roundTrip(list: Filter[]) {
  const orig = psdOf(list);
  const { engine, warnings } = importPsd(orig);
  const out = exportPsd(engine).bytes;
  const again = importPsd(out).engine;
  return { orig, out, engine, again, warnings };
}

const GROUPS: Record<string, Filter[]> = {
  blur: [
    item('box blur', { radius: px(4) }), item('gaussian blur', { radius: px(3) }), item('motion blur', { angle: 30, distance: px(12) }),
    item('radial blur', { amount: 20, method: 'zoom', quality: 'best' }), item('smart blur', { radius: 3, threshold: 25, quality: 'medium', mode: 'edge only' }),
    item('surface blur', { radius: px(5), threshold: 15 }), item('average'), item('blur'), item('blur more'),
  ],
  distort: [
    item('pinch', { amount: 30 }), item('polar coordinates', { conversion: 'polar to rectangular' }), item('ripple', { amount: 100, size: 'large' }),
    item('spherize', { amount: 50, mode: 'horizontal only' }), item('twirl', { angle: 40 }),
    item('wave', { numberOfGenerators: 3, type: 'triangle', wavelength: { min: 10, max: 100 }, amplitude: { min: 5, max: 30 }, scale: { x: 100, y: 90 }, randomSeed: 7, undefinedAreas: 'wrap around' }),
    item('zigzag', { amount: 12, ridges: 6, style: 'out from center' }),
  ],
  noise: [
    item('add noise', { amount: 0.125, distribution: 'gaussian', monochromatic: true, randomSeed: 5 }), item('despeckle'),
    item('dust and scratches', { radius: 2, threshold: 3 }), item('median', { radius: px(2) }),
    item('reduce noise', { preset: 'Default', removeJpegArtifact: false, reduceColorNoise: 0.45, sharpenDetails: 0.25, channelDenoise: [{ channels: ['composite'], amount: 5, preserveDetails: 60 }] }),
  ],
  pixelate: [
    item('color halftone', { radius: 8, angle1: 108, angle2: 162, angle3: 90, angle4: 45 }), item('crystallize', { cellSize: 10, randomSeed: 3 }),
    item('facet'), item('fragment'), item('mezzotint', { type: 'medium dots', randomSeed: 2 }), item('mosaic', { cellSize: px(10) }),
    item('pointillize', { cellSize: 5, randomSeed: 9 }),
  ],
  render: [
    item('clouds', { randomSeed: 4 }), item('difference clouds', { randomSeed: 5 }), item('fibers', { variance: 16, strength: 4, randomSeed: 3 }),
    item('lens flare', { brightness: 100, position: { x: 0.5, y: 0.5 }, lensType: '105mm prime' }),
  ],
  sharpen: [
    item('sharpen'), item('sharpen edges'), item('sharpen more'),
    item('smart sharpen', { amount: 1.5, radius: px(1), threshold: 20, angle: 0, moreAccurate: true, blur: 'gaussian blur', preset: 'Custom', shadow: { fadeAmount: 0, tonalWidth: 0.5, radius: 1 }, highlight: { fadeAmount: 0, tonalWidth: 0.5, radius: 1 } }),
    item('unsharp mask', { amount: 0.5, radius: px(1), threshold: 0 }),
  ],
  stylize: [
    item('diffuse', { mode: 'darken only', randomSeed: 1 }), item('emboss', { angle: 135, height: 3, amount: 100 }),
    item('extrude', { type: 'pyramids', size: 30, depth: 30, depthMode: 'level-based', randomSeed: 2, solidFrontFaces: false, maskIncompleteBlocks: false }),
    item('find edges'), item('solarize'), item('tiles', { numberOfTiles: 10, maximumOffset: 10, fillEmptyAreaWith: 'inverse image', randomSeed: 1 }),
    item('trace contour', { level: 128, edge: 'lower' }), item('wind', { method: 'blast', direction: 'left' }),
  ],
  other: [
    item('custom', { scale: 1, offset: 0, matrix: Array.from({ length: 25 }, (_, i) => (i === 12 ? 1 : 0)) }), item('high pass', { radius: px(10) }),
    item('maximum', { radius: px(2) }), item('offset', { horizontal: 5, vertical: -3, undefinedAreas: 'wrap around' }),
    item('de-interlace', { eliminate: 'odd lines', newFieldsBy: 'interpolation' }), item('ntsc colors'),
  ],
  adjustments: [
    item('invert'), { ...item('curves', { presetKind: 'custom', adjustments: [{ channels: ['composite'], curve: [{ x: 0, y: 0 }, { x: 128, y: 200 }, { x: 255, y: 255 }] }] }), name: 'Curves' },
    { ...item('brightness/contrast', { brightness: 20, contrast: -10, useLegacy: false }), name: 'Brightness/Contrast' },
  ],
};

for (const [group, list] of Object.entries(GROUPS)) {
  test(`A1 ${group} smart filters keep their params and PSD object through open, save, open`, () => {
    const { orig, out, engine, again, warnings } = roundTrip(list);
    assert.deepEqual(warnings, []);
    const first = strip(engine);
    assert.equal(first.length, list.length);
    assert.ok(first.every(f => f.kind !== 'psd_filter'), first.map(f => f.kind).join());
    assert.deepEqual(strip(again), first, 'params');
    assert.deepEqual(listOf(out), listOf(orig), 'the ag-psd filter objects');
    engine.free(); again.free();
  });
}

test('A2 unmapped fields survive and an edited param is written back', () => {
  const sharp = GROUPS.sharpen[3] as Filter & { filter: any };
  const custom = { ...sharp, filter: { ...sharp.filter, preset: 'Highlight Custom' } } as Filter;
  const { orig, out, engine, again } = roundTrip([custom, GROUPS.distort[5]]);
  assert.deepEqual(listOf(out), listOf(orig));
  assert.equal((listOf(out)[0] as any).filter.preset, 'Highlight Custom');
  const n = nodeOf(engine);
  const wave = n.smart.filters.find(f => f.filter.kind === 'distort.wave')!;
  engine.set_smart_filter(n.id, wave.id, JSON.stringify({ filter: { kind: 'distort.wave', params: { ...wave.filter.params, generators: 4 } } }));
  const edited = listOf(exportPsd(engine).bytes).find(f => f.type === 'wave') as any;
  assert.equal(edited.filter.numberOfGenerators, 4);
  assert.equal(edited.filter.randomSeed, 7, 'the unmapped seed stays');
  assert.deepEqual(edited.filter.wavelength, { min: 10, max: 100 });
  engine.free(); again.free();
});

test('A3 a filter with no registry kind is kept as a Photoshop filter, renders the cached pixels and exports unchanged', () => {
  const unknown = item('future filter', { a: 1 });
  const j = filterIn(unknown, () => {});
  assert.equal(j.kind, 'psd_filter');
  assert.equal(j.params.name, 'future filter');
  // The engine refuses the radius, so the filter stays a pass-through.
  const bad = item('gaussian blur', { radius: px(100000) });
  const orig = psdOf([bad]);
  const { engine, warnings } = importPsd(orig);
  assert.ok(warnings.some(w => w.includes('gaussian blur')), warnings.join());
  const f = nodeOf(engine).smart.filters[0];
  assert.equal(f.filter.kind, 'psd_filter');
  assert.equal(f.filter.params.name, 'gaussian blur');
  const img = image().data;
  const flat = engine.flatten_tile_rgba8(0, 0);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) for (let c = 0; c < 4; c++) assert.equal(flat[(y * 256 + x) * 4 + c], img[(y * N + x) * 4 + c]);
  assert.deepEqual(listOf(exportPsd(engine).bytes), listOf(orig));
  // A pass-through renders nothing, also after a re-render from the source.
  engine.render_smart(nodeOf(engine).id);
  assert.deepEqual([...engine.flatten_tile_rgba8(0, 0)].slice(0, 4), [...img.slice(0, 4)]);
  engine.free();
});

// The bytes of the first SoLd block of a PSD.
function soldBlock(b: Uint8Array): Uint8Array {
  const at = b.findIndex((_, i) => b[i] === 0x38 && b[i + 1] === 0x42 && b[i + 2] === 0x49 && b[i + 3] === 0x4d && String.fromCharCode(...b.subarray(i + 4, i + 8)) === 'SoLd');
  assert.ok(at >= 0, 'a SoLd block');
  const len = new DataView(b.buffer, b.byteOffset).getUint32(at + 8);
  return b.slice(at + 12, at + 12 + len);
}

// Writes `list` with extra hand-built filter descriptors appended to the SoLd filter list.
function withDescriptors(list: Filter[], extra: (items: any[]) => void): Uint8Array {
  const orig = descriptor.writeVersionAndDescriptor;
  descriptor.writeVersionAndDescriptor = (w: any, n: any, c: any, d: any, r?: any) => {
    if (d?.filterFX) extra(d.filterFX.filterFXList);
    return orig(w, n, c, d, r);
  };
  try {
    return psdOf(list);
  } finally {
    descriptor.writeVersionAndDescriptor = orig;
  }
}

function droppedPsd() {
  return withDescriptors([GROUPS.blur[1]], items => {
    const d = structuredClone(items[0]);
    d['Nm  '] = 'Wave Burst';
    d.Fltr._classID = 'WvBr';
    d.Fltr._name = 'Wave Burst';
    items.push(d);
  });
}

test('I1 a raw SoLd block is refused after the smart object got a new link or source size, and written when unchanged', () => {
  const bytes = droppedPsd();
  const e = importPsd(bytes).engine;
  assert.deepEqual(soldBlock(exportPsd(e).bytes), soldBlock(bytes));
  const id = nodeOf(e).id;
  const copy = e.smart_via_copy(id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.throws(() => exportPsd(e), /Cannot export a changed placement with Wave Burst\./);
  e.delete_node(copy);
  assert.doesNotThrow(() => exportPsd(e));
  e.replace_smart_contents(id, JSON.stringify({ link: { type: 'embedded', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, source_blob: null, source_size: [N, N] }), new Uint8Array(N * N * 4).fill(9));
  assert.throws(() => exportPsd(e), /Cannot export a changed placement with Wave Burst\./);
  const f = importPsd(bytes).engine;
  f.replace_smart_contents(nodeOf(f).id, JSON.stringify({ source_blob: null, source_size: [8, 8] }), new Uint8Array(8 * 8 * 4).fill(9));
  assert.throws(() => exportPsd(f), /Cannot export a changed placement with Wave Burst\./);
  e.free(); f.free();
});

test('M1 M2 M3 untrusted mesh and puppet input is bounded', () => {
  // M2: a compressed mesh of a few bytes may not claim millions of nodes.
  const tiny = meshBytes(3, 4, 4, uniform(4, 4, 0));
  const dv = new DataView(tiny.buffer);
  dv.setUint32(16, 4096, true); dv.setUint32(20, 4096, true);
  assert.throws(() => parseLiquifyMesh(tiny), /size|truncated/);
  const ok = meshBytes(3, 2200, 2200, uniform(2200, 2200, 0));
  assert.throws(() => parseLiquifyMesh(ok), /size/, 'compressed meshes above 4M nodes');
  // M3: an empty layer rect cannot be divided by.
  const m = parseLiquifyMesh(meshBytes(2, 4, 4, uniform(4, 4, 1)));
  assert.throws(() => meshToPblq(m, { x: 0, y: 0, w: 0, h: 16 }, 16, 16), /empty/);
  const pb = meshToPblq(m, { x: 0, y: 0, w: 16, h: 16 }, 16, 16).bytes;
  assert.throws(() => pblqToMesh(pb, { x: 0, y: 0, w: 16, h: 0 }), /empty/);
  // M1: thousands of pins do not make the depth pass quadratic.
  const f = puppet(0) as any;
  const sh = f.filter.puppetShapeList[0];
  sh.pinPosition = Array.from({ length: 5000 }, () => ({ x: 1, y: 1 }));
  sh.pinDepth = sh.pinPosition.map((_: unknown, i: number) => i);
  const j = filterIn(f, () => {}, { e: new Engine(N, N, 8), w: N, h: N, rect: { x: 0, y: 0, w: N, h: N } });
  assert.equal(j.kind, 'psd_filter');
  assert.ok(j.params.puppet > 0);
});

test('A4 a filter ag-psd drops keeps the raw SoLd block, which is written back until the placement changes', () => {
  const bytes = withDescriptors([GROUPS.blur[1]], items => {
    const d = structuredClone(items[0]);
    d['Nm  '] = 'Wave Burst';
    d.Fltr._classID = 'WvBr';
    d.Fltr._name = 'Wave Burst';
    items.push(d);
  });
  assert.equal(listOf(bytes).length, 1, 'ag-psd drops the second filter');
  const { engine, warnings } = importPsd(bytes);
  assert.ok(warnings.some(w => w.includes('Wave Burst')), warnings.join());
  const filters = nodeOf(engine).smart.filters;
  assert.deepEqual(filters.map(f => f.filter.kind), ['gaussian_blur', 'psd_filter']);
  assert.equal(filters[1].filter.params.name, 'Wave Burst');
  const out = exportPsd(engine).bytes;
  assert.deepEqual(soldBlock(out), soldBlock(bytes), 'the raw block is written verbatim');
  const m = JSON.parse(engine.manifest());
  m.layers[0].smart.transform[2] += 3;
  const moved = Engine.from_manifest(JSON.stringify(m));
  for (const t of JSON.parse(engine.manifest()).blobs as number[]) moved.put_tile(BigInt(t), engine.tile_bytes(BigInt(t)));
  const ids = new Set<number>();
  const walk = (o: any) => { if (o && typeof o === 'object') { if (Array.isArray(o) && o.length === 3 && o.every((v: unknown) => typeof v === 'number')) ids.add(o[2]); Object.values(o).forEach(walk); } };
  walk(m.layers[0].tiles);
  for (const t of ids) moved.put_tile(BigInt(t), engine.tile_bytes(BigInt(t)));
  for (const t of (m.layers[0].smart.source.tiles as number[][]).map(c => c[2])) moved.put_tile(BigInt(t), engine.tile_bytes(BigInt(t)));
  moved.finish_load();
  assert.throws(() => exportPsd(moved), /Cannot export a changed placement with Wave Burst\./);
  engine.free(); moved.free();
});

test('A5 a filter made in the app without a PSD equivalent refuses export naming it', () => {
  const e = new Engine(N, N, 8);
  const src = new Engine(N, N, 8);
  const tile = new Uint8Array(256 * 256 * 4).fill(255);
  src.set_tile_rgba8(1, 0, 0, tile);
  const blob = e.blob_add(exportPsd(src, { psb: true }).bytes);
  const id = e.place_smart(0, JSON.stringify({ name: 'S', link: { type: 'embedded', id: SO }, source_blob: Number(blob), source_size: [N, N], transform: [1, 0, 0, 0, 1, 0, 0, 0, 1] }), new Uint8Array(N * N * 4).fill(255));
  e.add_smart_filter(id, JSON.stringify({ kind: 'render.tree', params: {} }));
  assert.throws(() => exportPsd(e), /Cannot export Tree as an editable Photoshop filter\./);
  e.free(); src.free();
});

// ---------- liquify ----------

function meshBytes(version: 2 | 3, cols: number, rows: number, d: number[][]): Uint8Array {
  const out: number[] = [0, 0, 0, version, ...Buffer.from('yfqLhseM')];
  const u32 = (v: number) => out.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const f32 = (v: number) => out.push(...new Uint8Array(new Float32Array([v]).buffer));
  u32(2); u32(cols); u32(rows);
  for (let r = 0; r < rows; r++) {
    if (version === 2) { for (let c = 0; c < cols; c++) { f32(d[r * cols + c][0]); f32(d[r * cols + c][1]); } continue; }
    let c = 0;
    while (c < cols) {
      let z = 0;
      while (c + z < cols && d[r * cols + c + z][0] === 0 && d[r * cols + c + z][1] === 0) z++;
      u32(z); c += z;
      if (c === cols) break;
      let l = 0;
      while (c + l < cols && (d[r * cols + c + l][0] !== 0 || d[r * cols + c + l][1] !== 0)) l++;
      u32(l);
      for (let k = 0; k < l; k++) { f32(d[r * cols + c + k][0]); f32(d[r * cols + c + k][1]); }
      c += l;
    }
  }
  return new Uint8Array(out);
}

const uniform = (cols: number, rows: number, dx: number, dy = 0) => Array.from({ length: cols * rows }, () => [dx, dy]);

test('A6 PSD liquify meshes v2 and v3 parse, bad ones are refused', () => {
  const d = uniform(4, 4, 0).map((v, i) => (i % 5 === 1 ? [0.5, -1] : v));
  for (const v of [2, 3] as const) {
    const m = parseLiquifyMesh(meshBytes(v, 4, 4, d));
    assert.deepEqual([m.cols, m.rows], [4, 4]);
    assert.deepEqual([...m.displacement], d.flat());
  }
  assert.deepEqual([...writeLiquifyMesh(parseLiquifyMesh(meshBytes(3, 4, 4, d)))], [...meshBytes(2, 4, 4, d)]);
  const ok = meshBytes(2, 4, 4, d);
  assert.throws(() => parseLiquifyMesh(ok.slice(0, ok.length - 4)), /truncated/);
  assert.throws(() => parseLiquifyMesh(meshBytes(3, 4, 4, d).slice(0, 40)), /truncated/);
  const huge = ok.slice();
  new DataView(huge.buffer).setUint32(16, 5000, true);
  new DataView(huge.buffer).setUint32(20, 5000, true);
  assert.throws(() => parseLiquifyMesh(huge), /size/);
  const nan = ok.slice();
  new DataView(nan.buffer).setFloat32(24, NaN, true);
  assert.throws(() => parseLiquifyMesh(nan), /non-finite/);
  assert.throws(() => parseLiquifyMesh(new Uint8Array(30)), /header/);
  assert.ok(meshToPblq(parseLiquifyMesh(ok), { x: 0, y: 0, w: 16, h: 16 }, 16, 16).bytes.length > 28);
});

test('A6 a liquify mesh renders through the engine: zero is identity, one cell moves pixels by a cell width, unchanged exports byte-equal', () => {
  const zero = meshBytes(2, 4, 4, uniform(4, 4, 0));
  const shifted = meshBytes(2, 4, 4, uniform(4, 4, 1));
  const liq = (b: Uint8Array) => psdOf([item('liquify', { liquifyMesh: b })]);
  const a = importPsd(liq(zero)).engine;
  assert.equal(nodeOf(a).smart.filters[0].filter.kind, 'liquify');
  a.render_smart(nodeOf(a).id);
  const img = image().data, flatA = a.flatten_tile_rgba8(0, 0);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) for (let c = 0; c < 4; c++) assert.equal(flatA[(y * 256 + x) * 4 + c], img[(y * N + x) * 4 + c], `zero ${x},${y}`);
  const bytes = liq(shifted);
  const b = importPsd(bytes).engine;
  b.render_smart(nodeOf(b).id);
  const flat = b.flatten_tile_rgba8(0, 0);
  for (let y = 0; y < N; y++) for (let x = 0; x < N - 4; x++) for (let c = 0; c < 4; c++) assert.equal(flat[(y * 256 + x) * 4 + c], img[(y * N + x + 4) * 4 + c], `shift ${x},${y}`);
  const out = exportPsd(b).bytes;
  assert.deepEqual([...(listOf(out)[0] as any).filter.liquifyMesh], [...shifted]);
  // An edited mesh is written as version 2.
  const n = nodeOf(b), f = n.smart.filters[0];
  const pb = meshToPblq(parseLiquifyMesh(meshBytes(2, 4, 4, uniform(4, 4, 0.5))), { x: 0, y: 0, w: 16, h: 16 }, 16, 16);
  const blob = Number(b.blob_add(pb.bytes));
  b.set_smart_filter(n.id, f.id, JSON.stringify({ filter: { kind: 'liquify', params: { mesh: blob, reach: pb.reach } } }));
  const edited = (listOf(exportPsd(b).bytes)[0] as any).filter.liquifyMesh as Uint8Array;
  assert.equal(new DataView(edited.buffer, edited.byteOffset).getUint32(0), 2);
  const m = parseLiquifyMesh(edited);
  assert.ok(Math.abs(m.displacement[0] - 0.5) < 1e-3, String(m.displacement[0]));
  a.free(); b.free();
});

// ---------- warps ----------

// The first filter descriptor of the SoLd block of `b`.
function writtenFilter(b: Uint8Array): any {
  const blk = soldBlock(b);
  const r = createReader(blk.buffer, blk.byteOffset, blk.byteLength);
  readSignature(r);
  readInt32(r);
  return descriptor.readVersionAndDescriptor(r, true).filterFX.filterFXList[0];
}

test('A7 perspective warp round-trips and is written as filter 442 of class perspectiveWarpTransform', () => {
  const pt = (x: number, y: number) => ({ x: px(x), y: px(y) });
  const f = item('perspective warp', {
    quads: [[0, 1, 2, 3]], vertices: [pt(0, 0), pt(16, 0), pt(16, 16), pt(0, 16)], warpedVertices: [pt(1, 0), pt(15, 2), pt(16, 15), pt(0, 16)],
  });
  const { orig, out, engine, again } = roundTrip([f]);
  assert.equal(strip(engine)[0].kind, 'perspective_warp');
  assert.deepEqual(strip(engine)[0].params.state.current, [[1, 0], [15, 2], [16, 15], [0, 16]]);
  assert.deepEqual(strip(again), strip(engine));
  assert.deepEqual((listOf(out)[0] as any).filter, (listOf(orig)[0] as any).filter);
  const d = writtenFilter(out);
  assert.equal(d.filterID, 442);
  assert.equal(d.Fltr._classID, 'perspectiveWarpTransform');
  // An edit in the app is written back.
  const n = nodeOf(engine), id = n.smart.filters[0].id, st = strip(engine)[0].params.state;
  st.current[0] = [2, 0];
  engine.set_smart_filter(n.id, id, JSON.stringify({ filter: { kind: 'perspective_warp', params: { state: st } } }));
  assert.equal((listOf(exportPsd(engine).bytes)[0] as any).filter.warpedVertices[0].x.value, 2);
  engine.free(); again.free();
});

function puppet(dx: number) {
  const v = (x: number, y: number) => ({ x, y });
  const o = [v(0, 0), v(16, 0), v(16, 16), v(0, 16)];
  const path = { pathComponents: [{ shapeOperation: 'xor', paths: [{ closed: true, points: o.map(p => ({ anchor: { x: px(p.x), y: px(p.y) }, forward: { x: px(p.x), y: px(p.y) }, backward: { x: px(p.x), y: px(p.y) }, smooth: false })) }] }] };
  return item('puppet', {
    rigidType: false, bounds: o,
    puppetShapeList: [{
      rigidType: false, originalVertexArray: o, deformedVertexArray: o.map(p => v(p.x + dx, p.y)), indexArray: [0, 1, 2, 0, 2, 3],
      pinOffsets: [v(0, 0)], posFinalPins: [v(0, 0)], pinVertexIndices: [0], selectedPin: [0], pinPosition: [v(0, 0)], pinRotation: [0], pinOverlay: [false], pinDepth: [0],
      meshQuality: 3, meshExpansion: 5, meshRigidity: 2, imageResolution: 72, meshBoundaryPath: path,
    }],
  });
}

test('A8 PSD puppet warp: undeformed is identity, deformed moves pixels, the shape list round-trips with class Puppet Warp, our own refuses export', () => {
  const rest = roundTrip([puppet(0)]);
  assert.equal(strip(rest.engine)[0].kind, 'psd_filter');
  rest.engine.render_smart(nodeOf(rest.engine).id);
  const img = image().data, flat = rest.engine.flatten_tile_rgba8(0, 0);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) for (let c = 0; c < 4; c++) assert.equal(flat[(y * 256 + x) * 4 + c], img[(y * N + x) * 4 + c]);
  assert.deepEqual(listOf(rest.out), listOf(rest.orig), 'shape list');
  assert.equal(writtenFilter(rest.out).Fltr._name, 'Puppet Warp');
  const moved = importPsd(psdOf([puppet(4)])).engine;
  moved.render_smart(nodeOf(moved).id);
  const f2 = moved.flatten_tile_rgba8(0, 0);
  for (let c = 0; c < 4; c++) assert.equal(f2[(8 * 256 + 8) * 4 + c], img[(8 * N + 4) * 4 + c], 'shifted by 4');
  assert.equal(f2[(8 * 256 + 1) * 4 + 3], 0, 'uncovered');
  // Our own Puppet Warp has no PSD form.
  const e = rest.engine, n = nodeOf(e);
  const mesh = JSON.parse(e.puppet_mesh(n.id, 'normal', 2));
  const rig = { mesh, pins: [{ x: 8, y: 8, tx: 9, ty: 8, rotation: 0, fixed: false, depth: 0 }], mode: 'normal', density: 'normal', expansion: 2 };
  e.add_smart_filter(n.id, JSON.stringify({ kind: 'puppet_warp', params: { rig } }));
  assert.throws(() => exportPsd(e), /Cannot export Puppet Warp as an editable Photoshop filter\./);
  rest.engine.free(); rest.again.free(); moved.free();
});

test('A9 Oil Paint from Photoshop exports with lightingOn as a boolean; HSB/HSL refuses export naming it', () => {
  for (const lightingOn of [true, false]) {
    const oil = item('oil paint', { lightingOn, stylization: 5, cleanliness: 4, brushScale: 1, microBrush: 2, lightDirection: 90, specularity: 1 });
    const { orig, out, engine, again, warnings } = roundTrip([oil]);
    assert.deepEqual(warnings, []);
    assert.equal(strip(engine)[0].kind, 'stylize.oil_paint');
    assert.deepEqual(listOf(out), listOf(orig));
    assert.equal((listOf(out)[0] as any).filter.lightingOn, lightingOn);
    engine.free(); again.free();
  }
  const { engine } = importPsd(psdOf([item('blur')]));
  engine.add_smart_filter(nodeOf(engine).id, JSON.stringify(filterIn(item('hsb/hsl', { inputMode: 'rgb', rowOrder: 'hsb' }), () => {})));
  assert.throws(() => exportPsd(engine), /Cannot export HSB\/HSL as an editable Photoshop filter\./);
  engine.free();
});
