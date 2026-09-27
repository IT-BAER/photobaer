import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packProject, unpackProject, tileIds } from './project.ts';
import { readFileSync } from 'node:fs';
import { initSync, Engine } from './engine-pkg/photobaer_engine.js';
import { Autosave } from './autosave.ts';
import { FakeDir } from './fake-opfs.ts';

initSync({ module: readFileSync(new URL('./engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });

const manifest = JSON.stringify({ format: 'photobaer-manifest', version: 1, layers: [{ tiles: [0, 7, 7, 2 ** 40 + 3] }, { tiles: [9, 0] }] });
const bytes = (id: number) => new Uint8Array([id % 251, 1, 2, 3, id % 7]);

const manifestV2 = JSON.stringify({
  format: 'photobaer-manifest', version: 2, layers: [
    { kind: 'pixel', mask: null, tiles: [0, 4] },
    {
      kind: 'group', mask: { enabled: true, default: 0, tiles: [5, 0] }, children: [
        { kind: 'pixel', mask: { enabled: true, default: 255, tiles: [0, 6] }, tiles: [7, 0] },
        { kind: 'group', mask: null, children: [{ kind: 'pixel', mask: null, tiles: [8, 8] }] },
      ],
    },
  ],
});

test('tileIds lists each referenced tile once and skips 0', () => {
  assert.deepEqual([...tileIds(manifest)].sort((a, b) => a - b), [7, 9, 2 ** 40 + 3]);
});

test('tileIds walks a v2 tree including mask tiles and nested groups', () => {
  assert.deepEqual([...tileIds(manifestV2)].sort((a, b) => a - b), [4, 5, 6, 7, 8]);
});

const manifestV3 = JSON.stringify({
  format: 'photobaer-manifest', version: 3,
  layers: [
    { kind: 'pixel', mask: null, tiles: [[-2, 0, 11], [0, 1, 12]] },
    {
      kind: 'group', mask: { enabled: true, default: 0, tiles: [[0, 0, 13]] }, children: [
        { kind: 'pixel', mask: { enabled: true, default: 255, tiles: [[1, -3, 14]] }, tiles: [[0, 0, 15]] },
      ],
    },
  ],
  selection: { default: 0, tiles: [[0, 0, 16]] },
  last_selection: { default: 255, tiles: [[1, 0, 17]] },
  channels: [{ id: 1, name: 'a', default: 0, tiles: [[0, 0, 18], [1, 1, 19]] }],
});

test('tileIds walks v3 sparse tiles, the selections and the channels', () => {
  assert.deepEqual([...tileIds(manifestV3)].sort((a, b) => a - b), [11, 12, 13, 14, 15, 16, 17, 18, 19]);
});

test('tileIds reads a v3 manifest without a selection or channels', () => {
  const m = JSON.stringify({ format: 'photobaer-manifest', version: 3, layers: [{ kind: 'pixel', mask: null, tiles: [[0, 0, 3]] }], selection: null, last_selection: null, channels: [] });
  assert.deepEqual([...tileIds(m)], [3]);
});

test('pack then unpack returns the manifest and every tile', async () => {
  const blob = await packProject(manifest, bytes);
  const p = await unpackProject(blob);
  assert.equal(p.manifest, manifest);
  assert.equal(p.tiles.size, 3);
  for (const id of tileIds(manifest)) assert.deepEqual(p.tiles.get(id), bytes(id));
});

test('the file is gzip compressed', async () => {
  const head = new Uint8Array(await (await packProject(manifest, bytes)).arrayBuffer()).slice(0, 2);
  assert.deepEqual([...head], [0x1f, 0x8b]);
});

test('a truncated file is rejected', async () => {
  const raw = new Uint8Array(await new Response((await packProject(manifest, bytes)).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const cut = raw.slice(0, raw.length - 10);
  const gz = await new Response(new Blob([cut]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  await assert.rejects(unpackProject(gz), /truncated/);
});

test('a file that is not a project is rejected', async () => {
  const gz = await new Response(new Blob(['hello world, not a project']).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  await assert.rejects(unpackProject(gz), /not a Photobaer project/);
  await assert.rejects(unpackProject(new Blob(['plain'])), /not a Photobaer project/);
});

const manifestV4 = JSON.stringify({
  format: 'photobaer-manifest', version: 4,
  layers: [
    { kind: 'adjustment', mask: { enabled: true, default: 255, tiles: [[0, 0, 21]] } },
    {
      kind: 'smart', mask: null, tiles: [[0, 0, 22]], smart: {
        source: { blob: 30, tiles: [[0, 0, 23]] },
        filters: [{ id: 1, mask: { enabled: true, default: 255, tiles: [[0, 0, 24]] } }, { id: 2, mask: null }],
        stack_mask: { enabled: true, default: 255, tiles: [[0, 0, 25]] },
      },
    },
    { kind: 'smart', mask: null, tiles: [], smart: { source: { blob: null, tiles: [] }, filters: [], stack_mask: null } },
  ],
  selection: null, last_selection: null, channels: [],
  blobs: [30, 31],
});

test('tileIds walks v4 smart sources, filter and stack masks and the blob list', () => {
  assert.deepEqual([...tileIds(manifestV4)].sort((a, b) => a - b), [21, 22, 23, 24, 25, 30, 31]);
});

test('a project with a 3-byte blob round-trips', async () => {
  const blob = new Uint8Array([1, 2, 3]);
  const data = (id: number) => (id === 30 ? blob : bytes(id));
  const p = await unpackProject(await packProject(manifestV4, data));
  assert.equal(p.manifest, manifestV4);
  assert.equal(p.tiles.size, 7);
  assert.deepEqual(p.tiles.get(30), blob);
  for (const id of tileIds(manifestV4)) assert.deepEqual(p.tiles.get(id), data(id));
});

const run = (length: number) => ({
  length, family: 'Noto Sans', style: 'Regular', postscript_name: 'NotoSans-Regular', size: 24, tracking: 0, leading: null,
  color: [0, 0, 0], faux_bold: false, faux_italic: false, underline: false, strikethrough: false, caps: 'normal',
  baseline: 'normal', baseline_shift: 0, horizontal_scale: 1, vertical_scale: 1, anti_alias: 'sharp', ligatures: true,
  discretionary_ligatures: false, kerning: 'metrics', language: '', no_break: false, tsume: 0, features: {},
});
const paragraph = (length: number) => ({
  length, alignment: 'left', indent_left: 0, indent_right: 0, indent_first: 0, space_before: 0, space_after: 0,
  hyphenate: false, rtl: false, composer: 'every_line',
  justification: { word: [0.8, 1, 1.33], letter: [0, 0, 0], glyph: [1, 1, 1] },
  hyphenation: { min_word: 5, after_first: 2, before_last: 2, limit: 2, zone: 36, capitalized: true },
  hanging_punctuation: false,
});
const cacheTile = (id: number) => new Uint8Array(256 * 256 * 4).fill(id * 40);

// A v5 document whose text layer carries a 3-tile cache (ids 1..3).
function textDoc() {
  const m = JSON.parse(new Engine(256, 256, 8).manifest());
  m.layers.push({
    ...m.layers[0], id: 2, name: 'Hello', kind: 'text', tiles: [[0, 0, 1], [1, 0, 2], [0, 1, 3]],
    text: {
      text: 'Hello', runs: [run(5)], paragraphs: [paragraph(5)], shape: { type: 'point' }, orientation: 'horizontal',
      transform: [1, 0, 0, 1, 10, 40], warp: null, psd: null,
    },
  });
  m.next_node_id = 3;
  const e = Engine.from_manifest(JSON.stringify(m));
  for (const id of [1, 2, 3]) e.put_tile(BigInt(id), cacheTile(id));
  e.finish_load();
  return e;
}

test('a .pbaer with a text layer and a 3-tile cache round-trips', async () => {
  const e = textDoc();
  const manifest = e.manifest();
  assert.deepEqual([...tileIds(manifest)].sort((a, b) => a - b), [1, 2, 3]);
  const p = await unpackProject(await packProject(manifest, id => e.tile_bytes(BigInt(id))));
  const back = Engine.from_manifest(p.manifest);
  for (const [id, bytes] of p.tiles) back.put_tile(BigInt(id), bytes);
  back.finish_load();
  assert.equal(back.manifest(), manifest);
  for (const id of [1, 2, 3]) assert.deepEqual(back.tile_bytes(BigInt(id)), cacheTile(id));
  assert.equal(JSON.parse(manifest).layers[1].text.text, 'Hello');
});

test('autosave writes the text cache once across saves', async () => {
  const e = textDoc();
  const s = await Autosave.fromRoot(new FakeDir() as unknown as FileSystemDirectoryHandle);
  s.startDocument();
  const calls: number[] = [];
  const data = (id: number) => { calls.push(id); return e.tile_bytes(BigInt(id)); };
  assert.equal(await s.save('t', e.manifest(), data, () => true), true);
  e.set_props(1, JSON.stringify({ name: 'bg' }));
  assert.equal(await s.save('t', e.manifest(), data, () => true), true);
  assert.deepEqual(calls.sort(), [1, 2, 3]);
});
