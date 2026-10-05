import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readPsd } from 'ag-psd';
import { initSync, Engine } from '../engine-pkg/photobaer_engine.js';
import { exportPsd, importPsd, psdIcc } from '../psd.ts';
import { grayFile, psdResources } from '../app/iccFiles.ts';
import { compositeFit, psdLayerCount, readPsdChannels } from './depth.ts';

initSync({ module: readFileSync(new URL('../engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });

const FIX = new URL('../../../tests/corpus/psd-tools-b5/', import.meta.url);
const fixture = (name: string) => (existsSync(new URL(name, FIX)) ? new Uint8Array(readFileSync(new URL(name, FIX))) : null);
const header = (b: Uint8Array) => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { channels: v.getUint16(12), depth: v.getUint16(22), mode: v.getUint16(24) };
};
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s, 'latin1'));

type Node = { id: number; name: string; tiles?: [number, number, number][]; mask?: { tiles?: [number, number, number][]; default: number }; children?: Node[] };
function nodeNamed(e: Engine, name: string): Node {
  const walk = (ns: Node[]): Node | undefined => ns.map(n => (n.name === name ? n : walk(n.children ?? []))).find(Boolean);
  const n = walk((JSON.parse(e.manifest()) as { layers: Node[] }).layers);
  assert.ok(n, `no layer ${name}`);
  return n;
}
const tileOf = (e: Engine, tiles: Node['tiles'], tx = 0, ty = 0) => {
  const t = tiles?.find(([x, y]) => x === tx && y === ty);
  return t ? e.tile_bytes(BigInt(t[2])) : null;
};
// Tiles compare by first difference: assert.deepEqual's diff of two large differing arrays takes gigabytes.
function sameTile(got: Uint8Array | null, want: Uint8Array | null, msg = '') {
  if (!got || !want) return assert.equal(got, want, msg);
  assert.equal(got.length, want.length, `${msg} length`);
  const i = got.findIndex((x, k) => x !== want[k]);
  assert.equal(i, -1, `${msg} byte ${i}: ${got[i]} vs ${want[i]}`);
}
type Chan = { id: number; name: string; default: number; spot: { color: number[]; solidity: number } | null; tiles?: [number, number, number][] };
const channelsOf = (e: Engine) => (JSON.parse(e.manifest()) as { channels: Chan[] }).channels;

// A 16-bit tile of `w` x `h` canvas pixels at tile (tx, ty); `f` gives RGBA, pixels past the canvas stay 0.
function tile16(w: number, h: number, tx: number, ty: number, f: (x: number, y: number) => number[]) {
  const t = new Uint16Array(256 * 256 * 4);
  for (let y = 0; y < 256 && ty * 256 + y < h; y++) for (let x = 0; x < 256 && tx * 256 + x < w; x++) t.set(f(tx * 256 + x, ty * 256 + y), (y * 256 + x) * 4);
  return new Uint8Array(t.buffer);
}

test('a Grayscale document saves as a Grayscale PSD with one color channel per layer', () => {
  const e = new Engine(300, 20, 8);
  e.fill(1, 'pixels', 90, 90, 90, 255);
  const top = e.add_layer('Top', 1);
  e.put_rgba8(top, 260, 2, 2, 1, Uint8Array.of(200, 200, 200, 128, 30, 30, 30, 255));
  e.add_mask(top, true);
  e.convert_mode(true);
  const { bytes, warnings } = exportPsd(e);
  assert.deepEqual(warnings, []);
  assert.deepEqual(header(bytes), { channels: 1, depth: 8, mode: 1 });
  assert.ok(grayFile(bytes));
  const raw = readPsd(bytes, { useRawData: true, skipThumbnail: true });
  for (const l of raw.children!) {
    const ids = (l as { rawData?: { channels: { id: number }[] } }).rawData!.channels.map(c => c.id).sort();
    assert.ok(!ids.includes(1) && !ids.includes(2) && ids.includes(0), `${l.name}: ${ids}`);
  }
  const back = importPsd(bytes).engine;
  for (const name of ['Background', 'Top']) {
    for (const [tx, ty] of [[0, 0], [1, 0]]) sameTile(tileOf(back, nodeNamed(back, name).tiles, tx, ty), tileOf(e, nodeNamed(e, name).tiles, tx, ty), `${name} ${tx}`);
  }
  assert.equal(nodeNamed(back, 'Top').mask?.default, 255);
});

test('16-bit documents save in an Lr16 block and reopen with exact values, masks and channels', () => {
  const [w, h] = [300, 20];
  const e = new Engine(w, h, 16);
  e.set_tile_bytes('pixels', 1, 0, 0, tile16(w, h, 0, 0, (x, y) => [x * 211 % 65536, y * 3001, 40000 - x, 65535]));
  e.set_tile_bytes('pixels', 1, 1, 0, tile16(w, h, 1, 0, x => [x, 1, 65534, 65535]));
  const top = e.add_layer('Top', 1);
  e.set_tile_bytes('pixels', top, 1, 0, tile16(w, h, 1, 0, (x, y) => (y < 5 ? [12345, 23456, 34567, 30001 + x] : [0, 0, 0, 0])));
  e.add_mask(top, false);
  const m = new Uint16Array(256 * 256);
  for (let y = 0; y < h; y++) for (let x = 0; x < 256; x++) m[y * 256 + x] = (x * 257 + y) % 65536;
  e.set_tile_bytes('mask', top, 0, 0, new Uint8Array(m.buffer));
  const a = e.new_channel('Alpha 1');
  e.set_tile_bytes('channel', a, 0, 0, new Uint8Array(m.buffer));
  const { bytes } = exportPsd(e);
  assert.deepEqual(header(bytes), { channels: 4, depth: 16, mode: 3 });
  assert.ok(has(bytes, '8BIMLr16'));
  const ag = readPsd(bytes.slice(), { useImageData: true, skipThumbnail: true, skipCompositeImageData: true });
  const bg = ag.children!.find(l => l.name === 'Background')!;
  assert.ok(bg.imageData!.data instanceof Uint16Array);
  assert.deepEqual([...bg.imageData!.data.slice(0, 8)], [0, 0, 40000, 65535, 211, 0, 39999, 65535]);

  const back = importPsd(bytes).engine;
  assert.equal(back.depth(), 16);
  for (const name of ['Background', 'Top']) {
    for (const tx of [0, 1]) sameTile(tileOf(back, nodeNamed(back, name).tiles, tx), tileOf(e, nodeNamed(e, name).tiles, tx), `${name} ${tx}`);
  }
  sameTile(tileOf(back, nodeNamed(back, 'Top').mask!.tiles), tileOf(e, nodeNamed(e, 'Top').mask!.tiles));
  const [ch] = channelsOf(back);
  assert.equal(ch.name, 'Alpha 1');
  sameTile(tileOf(back, ch.tiles), tileOf(e, channelsOf(e)[0].tiles));
});

test('32-bit documents save linear floats in an Lr32 block under the linear twin profile', () => {
  const e = new Engine(10, 10, 32);
  const px = new Float32Array(256 * 256 * 4);
  px.set([0.5, 2.5, 0.0, 1, 0.25, 0.25, 0.25, 0.5]);
  for (let i = 2; i < 100; i++) px.set([0.1, 0.2, 0.3, 1], i * 4);
  e.set_tile_bytes('pixels', 1, 0, 0, new Uint8Array(px.buffer));
  const { bytes } = exportPsd(e);
  assert.deepEqual(header(bytes), { channels: 4, depth: 32, mode: 3 });
  assert.ok(has(bytes, '8BIMLr32'));
  const lin = e.to_linear_f32(px.slice(0, 8));
  assert.ok(Math.abs(lin[0] - 0.214) < 1e-3 && lin[3] === 1 && lin[7] === 0.5);
  const ag = readPsd(bytes.slice(), { useImageData: true, skipThumbnail: true, skipCompositeImageData: true });
  const got = ag.children![0].imageData!.data as Float32Array;
  for (let i = 0; i < 8; i++) assert.ok(Math.abs(got[i] - lin[i]) < 1e-6, `${i}: ${got[i]} vs ${lin[i]}`);
  const icc = psdIcc(e);
  assert.match(new TextDecoder('latin1').decode(icc), /L.?i.?n.?e.?a.?r/);
  const back = importPsd(bytes).engine;
  const t = new Float32Array(back.tile_bytes(BigInt(nodeNamed(back, 'Background').tiles![0][2])).buffer);
  for (let i = 0; i < 8; i++) assert.ok(Math.abs(t[i] - lin[i]) < 1e-6);
});

test('alpha and spot channels save in the composite and reopen with name, kind, color and solidity', () => {
  const e = new Engine(300, 20, 8);
  e.fill(1, 'pixels', 10, 20, 30, 255);
  const a = e.new_channel('Mask A');
  const s = e.new_spot_channel('PANTONE X', Uint8Array.of(0, 128, 255), 0.4);
  const t = new Uint8Array(256 * 256);
  for (let i = 0; i < 20 * 256; i++) t[i] = i % 251;
  e.set_tile_bytes('channel', a, 0, 0, t);
  e.set_tile_bytes('channel', s, 1, 0, t.map((v, i) => (i % 256 < 300 - 256 && i < 20 * 256 ? v : 255)));
  const { bytes, warnings } = exportPsd(e);
  assert.deepEqual(warnings, []);
  assert.deepEqual(header(bytes), { channels: 5, depth: 8, mode: 3 });
  const read = readPsdChannels(bytes);
  assert.deepEqual(read.channels.map(c => [c.name, c.kind, c.color, c.opacity]), [['Mask A', 1, [255, 0, 0], 50], ['PANTONE X', 2, [0, 128, 255], 40]]);
  const back = importPsd(bytes).engine;
  const [ca, cs] = channelsOf(back);
  assert.deepEqual([ca.name, ca.spot ?? null, cs.name, cs.spot], ['Mask A', null, 'PANTONE X', { color: [0, 128, 255], solidity: 0.4 }]);
  sameTile(tileOf(back, ca.tiles), tileOf(e, channelsOf(e)[0].tiles));
  sameTile(tileOf(back, cs.tiles, 1, 0), tileOf(e, channelsOf(e)[1].tiles, 1, 0));
  assert.equal(tileOf(back, cs.tiles, 0, 0), null, 'no ink is the spot default');

  // A Selected Areas channel (kind 0) shows black as selected: it opens inverted.
  const [, , , di] = [...psdResources(bytes)].find(([id]) => id === 1077)!;
  const flipped = bytes.slice();
  flipped[di + 4 + 12] = 0;
  const inv = channelsOf(importPsd(flipped).engine)[0];
  assert.equal(tileOf(importPsd(flipped).engine, inv.tiles)![5], 255 - 5);
});

test('real Photoshop 16-bit and 32-bit files open at their depth with their values', t => {
  const b16 = fixture('16bit5x5.psd'), b32 = fixture('32bit5x5.psd'), psb = fixture('16bit5x5.psb');
  if (!b16 || !b32 || !psb) { t.skip('psd-tools fixtures are not in tests/corpus/psd-tools-b5'); return; }
  for (const [b, opts] of [[b16, {}], [psb, { psb: true }]] as const) {
    const e = importPsd(b, opts).engine;
    assert.equal(e.depth(), 16);
    const bg = new Uint16Array(tileOf(e, nodeNamed(e, 'Background').tiles)!.buffer);
    assert.deepEqual([...bg.slice(0, 4)], [60539, 62141, 64391, 65535]);
    const c2 = new Uint16Array(tileOf(e, nodeNamed(e, 'Background copy 2').tiles)!.buffer);
    assert.deepEqual([...c2.slice((1 * 256 + 4) * 4, (1 * 256 + 4) * 4 + 4)], [12020, 50409, 26806, 65535]);
  }
  const e = importPsd(b32).engine;
  assert.equal(e.depth(), 32);
  const want = readPsd(b32.slice(), { useImageData: true, skipThumbnail: true }).children!.find(l => l.name === 'Background copy 2')!;
  const got = new Float32Array(tileOf(e, nodeNamed(e, 'Background copy 2').tiles)!.buffer);
  assert.deepEqual([...got.slice((1 * 256 + 4) * 4, (1 * 256 + 4) * 4 + 4)], [...(want.imageData!.data as Float32Array).slice(0, 4)]);
});

test('real Photoshop Grayscale 16/32-bit files and alpha channels open', t => {
  const names = ['4x4_16bit_grayscale.psd', '4x4_32bit_grayscale.psd', '4x4_8bit_rgba.psd', 'gray0.psd', 'cmyk-alpha-spot.psd'];
  const [g16, g32, rgba, gray0, spot] = names.map(fixture);
  if (!g16 || !g32 || !rgba || !gray0 || !spot) { t.skip('psd-tools fixtures are not in tests/corpus/psd-tools-b5'); return; }
  assert.equal(importPsd(g16).engine.depth(), 16);
  assert.equal(importPsd(g32).engine.depth(), 32);
  const a = importPsd(rgba).engine;
  assert.deepEqual(channelsOf(a).map(c => [c.name, c.spot ?? null]), [['Alpha 1', null]]);
  // An older Photoshop names the merged transparency too: it is not an alpha channel.
  assert.deepEqual(channelsOf(importPsd(gray0).engine), []);
  const read = readPsdChannels(spot);
  assert.deepEqual(read.channels.map(c => [c.name, c.kind, c.opacity]), [['light teal', 2, 0], ['Alpha 1', 1, 50]]);
  const share = (p: Uint8Array, v: number) => { let n = 0; for (const x of p) n += +(x === v); return n / p.length; };
  assert.ok(share(read.channels[0].plane, 255) > 0.99, 'spot planes hold no ink as white');
  assert.ok(share(read.channels[1].plane, 0) > 0.99, 'a Masked Areas alpha holds unselected as black');
});

test('16-bit transparency that rounds to opaque at 8 bits keeps the transparency plane', () => {
  const e = new Engine(10, 10, 16);
  e.set_tile_bytes('pixels', 1, 0, 0, tile16(10, 10, 0, 0, () => [1000, 2000, 3000, 65500]));
  const { bytes } = exportPsd(e);
  assert.equal(header(bytes).channels, 4);
  assert.ok(psdLayerCount(bytes) < 0, 'the fourth channel is the merged transparency');
  assert.deepEqual(readPsdChannels(bytes).channels, []);
});

test('a truncated composite opens the layers and warns instead of reading past the end', () => {
  const e = new Engine(10, 10, 16);
  e.fill(1, 'pixels', 10, 20, 30, 255);
  e.new_channel('Alpha 1');
  const { bytes } = exportPsd(e);
  const { engine, warnings } = importPsd(bytes.slice(0, bytes.length - 50));
  assert.deepEqual(warnings, ['the composite image data is incomplete: alpha and spot channels were not imported']);
  assert.deepEqual(channelsOf(engine), []);
  assert.ok(nodeNamed(engine, 'Background'));
});

test('a 16-bit header over 8-bit data is rejected', () => {
  const e = new Engine(10, 10, 8);
  e.fill(1, 'pixels', 10, 20, 30, 255);
  e.put_rgba8(e.add_layer('Top', 1), 2, 2, 2, 1, Uint8Array.of(200, 100, 50, 255, 1, 2, 3, 255));
  const bytes = exportPsd(e).bytes.slice();
  bytes[23] = 16;
  assert.throws(() => importPsd(bytes), /does not match its 16-bit header/);
});

test('a 1-bit Bitmap composite fits when rows end in a partial byte', () => {
  // 10x2, mode 0, depth 1, no color data, resources or layers; RLE rows of ceil(10 / 8) = 2 bytes.
  const b = new Uint8Array(26 + 12 + 2 + 4 + 6);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x38425053); v.setUint16(4, 1); v.setUint16(12, 1); v.setUint32(14, 2); v.setUint32(18, 10); v.setUint16(22, 1);
  v.setUint16(38, 1); v.setUint16(40, 3); v.setUint16(42, 3);
  b.set([1, 0xff, 0xc0, 1, 0xff, 0xc0], 44);
  assert.equal(compositeFit(b), 'ok');
});

test('alpha and spot channels beyond Photoshop\'s 56-channel limit are left out with a warning', () => {
  const cases: [Engine, number][] = [[new Engine(10, 10, 8), 53], [new Engine(10, 10, 16), 52]];
  cases[0][0].fill(1, 'pixels', 10, 20, 30, 255);
  cases[1][0].set_tile_bytes('pixels', 1, 0, 0, tile16(10, 10, 0, 0, () => [1000, 2000, 3000, 65500]));
  for (const [e, kept] of cases) {
    for (let i = 1; i <= 60; i++) e.new_channel(`Alpha ${i}`);
    const { bytes, warnings } = exportPsd(e);
    assert.deepEqual(warnings, [`${60 - kept} alpha and spot channels beyond Photoshop's 56-channel limit were not saved`]);
    assert.equal(header(bytes).channels, 56);
    const names = readPsdChannels(bytes).channels.map(c => c.name);
    assert.deepEqual(names, Array.from({ length: kept }, (_, i) => `Alpha ${i + 1}`));
    assert.equal(channelsOf(importPsd(bytes).engine).length, kept);
  }
});

test('PSD files with more than 16 channels open with every alpha and spot channel', () => {
  for (const depth of [8, 16]) {
    const e = new Engine(300, 20, depth);
    if (depth === 8) e.fill(1, 'pixels', 10, 20, 30, 255);
    else e.set_tile_bytes('pixels', 1, 0, 0, tile16(256, 20, 0, 0, () => [1000, 2000, 3000, 30000]));
    for (let i = 1; i <= 20; i++) e.new_channel(`Alpha ${i}`);
    const last = channelsOf(e)[19].id, t = new Uint8Array(256 * 256 * (depth / 8));
    for (let i = 0; i < 20 * 256 * (depth / 8); i++) t[i] = i % 251;
    e.set_tile_bytes('channel', last, 0, 0, t);
    const { bytes } = exportPsd(e);
    assert.ok(header(bytes).channels > 16);
    const back = importPsd(bytes).engine;
    const got = channelsOf(back);
    assert.deepEqual(got.map(c => c.name), Array.from({ length: 20 }, (_, i) => `Alpha ${i + 1}`));
    sameTile(tileOf(back, got[19].tiles), tileOf(e, channelsOf(e)[19].tiles), `${depth}-bit last channel`);
  }
});
