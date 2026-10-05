import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, Engine } from '../engine-pkg/photobaer_engine.js';
import { PayloadCache, referencedKeys, type Program } from './program.ts';
import type { Renderer, TileCompositor } from './renderer.ts';
import type { EngineClient } from '../client.ts';
import { makeTileSource } from './tiles.ts';

initSync({ module: readFileSync(new URL('../engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });

// A worker stand-in: one engine per document, docId counts up like engine.worker.ts.
function fakeClient() {
  let e: Engine, docId = 0, version = 1;
  const open = (depth: number, r: number, g: number, b: number) => {
    e = new Engine(300, 200, depth);
    e.fill(1, 'pixels', r, g, b, 255);
    docId++;
  };
  // A view change bumps the version, as the worker's setView does.
  const view = (v: object) => {
    e.set_view(JSON.stringify(v), new Uint8Array());
    version++;
  };
  const client = {
    call: async (op: string, level: number, tx: number, ty: number, known?: BigUint64Array) => {
      if (op === 'displayProgram') return { docId, version, data: e.display_program(level, tx, ty, known!).buffer };
      const px = e.display_tile(level, tx, ty) as Uint8Array | undefined;
      return { docId, version, data: px ? px.buffer : null };
    },
  } as unknown as EngineClient;
  return { client, open, view };
}

// A GPU stand-in: the payload cache holds tile bytes; `run` "draws" the first pixel of the first source tile.
function fakeRenderer() {
  const cache = new PayloadCache<Uint8Array>(1 << 30, () => {});
  const drawn: number[][] = [], uploads: number[][] = [];
  const gpu: TileCompositor & { reset(): void } = {
    keys: () => cache.keys(),
    missing: (p: Program) => {
      for (const t of p.payloads) if (!cache.get(t.key)) cache.set(t.key, t.bytes, t.bytes.length);
      return referencedKeys(p).filter(k => !cache.get(k));
    },
    run: (_slot: number, p: Program) => {
      const px = cache.get(p.steps[0].src);
      if (!px) return false;
      drawn.push([...px.subarray(0, 4)]);
      return true;
    },
    reset: () => cache.clear(),
  };
  const r = { kind: 'webgpu', slots: 8, gpu, upload: (_s: number, d: Uint8Array) => uploads.push([...d.subarray(0, 4)]), draw() {} } as unknown as Renderer;
  return { r, drawn, uploads, cache };
}

test('a second document never composites from the first document\'s GPU payloads', async () => {
  const { client, open } = fakeClient();
  const { r, drawn } = fakeRenderer();
  const src = makeTileSource(client, r);
  open(8, 255, 0, 0);
  (await src(0, 0, 0)).fill!(0);
  open(8, 0, 0, 255);
  (await src(0, 0, 0)).fill!(0);
  assert.deepEqual(drawn, [[255, 0, 0, 255], [0, 0, 255, 255]]);
});

test('a GPU fill reports false when its payload was evicted after the check', async () => {
  const { client, open } = fakeClient();
  const { r, cache } = fakeRenderer();
  const src = makeTileSource(client, r);
  open(8, 255, 0, 0);
  const t = await src(0, 0, 0);
  cache.clear();
  assert.equal(t.fill!(0), false);
});

test('a 16-bit document uses CPU tiles without turning the GPU path off for the next document', async () => {
  const { client, open } = fakeClient();
  const { r, drawn, uploads } = fakeRenderer();
  const src = makeTileSource(client, r);
  const warn = console.warn;
  console.warn = () => {};
  try {
    open(16, 255, 0, 0);
    (await src(0, 0, 0)).fill!(0);
    (await src(0, 0, 0)).fill!(0);
  } finally {
    console.warn = warn;
  }
  assert.equal(uploads.length, 2);
  // The first tile after the switch still comes from the CPU; it carries the new document id.
  open(8, 0, 255, 0);
  (await src(0, 0, 0)).fill!(0);
  (await src(0, 0, 0)).fill!(0);
  assert.equal(uploads.length, 3);
  assert.deepEqual(drawn, [[0, 255, 0, 255]]);
});

test('switching through a 16-bit document still drops the first document\'s GPU payloads', async () => {
  const { client, open } = fakeClient();
  const { r, drawn } = fakeRenderer();
  const src = makeTileSource(client, r);
  const warn = console.warn;
  console.warn = () => {};
  try {
    open(8, 255, 0, 0);
    (await src(0, 0, 0)).fill!(0);
    open(16, 0, 0, 255);
    (await src(0, 0, 0)).fill!(0);
    open(8, 0, 255, 0);
    (await src(0, 0, 0)).fill!(0);
    (await src(0, 0, 0)).fill!(0);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(drawn.at(-1), [0, 255, 0, 255]);
});

test('turning Proof Colors off brings the GPU path back without reopening the document', async () => {
  const { client, open, view } = fakeClient();
  const { r, drawn, uploads } = fakeRenderer();
  const src = makeTileSource(client, r);
  const warn = console.warn;
  console.warn = () => {};
  try {
    open(8, 255, 0, 0);
    view({ setup: { kind: 'device', profile: 'Coated Offset CMYK (analytic)' }, proofColors: true });
    (await src(0, 0, 0)).fill!(0);
    (await src(0, 0, 0)).fill!(0);
    assert.equal(uploads.length, 2, 'proofing shows CPU tiles');
    view({ setup: { kind: 'device', profile: 'Coated Offset CMYK (analytic)' }, proofColors: false });
    (await src(0, 0, 0)).fill!(0);
    (await src(0, 0, 0)).fill!(0);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(drawn, [[255, 0, 0, 255]], 'GPU again after proofing ends');
});
