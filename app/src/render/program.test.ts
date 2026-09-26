import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, Engine } from '../engine-pkg/photobaer_engine.js';
import { ADJUST, OP, PAYLOAD, decodeProgram, referencedKeys, PayloadCache } from './program.ts';

initSync({ module: readFileSync(new URL('../engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });

const NONE = new BigUint64Array(0);

function redDoc() {
  const e = new Engine(300, 200, 8);
  e.fill(1, 'pixels', 255, 0, 0, 255);
  return e;
}

test('a one-layer program decodes to one draw step with its tile payload', () => {
  const p = decodeProgram(redDoc().display_program(0, 0, 0, NONE).buffer as ArrayBuffer);
  assert.deepEqual([p.level, p.ox, p.oy, p.vw, p.vh], [0, 0, 0, 256, 200]);
  assert.equal(p.steps.length, 1);
  assert.equal(p.steps[0].op, OP.draw);
  assert.equal(p.steps[0].mode, 0);
  assert.equal(p.steps[0].scale, 1);
  assert.equal(p.steps[0].maskKind, 0);
  assert.equal(p.payloads.length, 1);
  assert.equal(p.payloads[0].kind, PAYLOAD.rgba);
  assert.equal(p.payloads[0].bytes.length, 256 * 256 * 4);
  assert.deepEqual([...p.payloads[0].bytes.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual(referencedKeys(p), [p.steps[0].src]);
});

test('known keys drop the payload bytes but keep the reference', () => {
  const e = redDoc();
  const first = decodeProgram(e.display_program(0, 0, 0, NONE).buffer as ArrayBuffer);
  const key = first.payloads[0].key;
  const again = e.display_program(0, 0, 0, BigUint64Array.from([key]));
  const p = decodeProgram(again.buffer as ArrayBuffer);
  assert.equal(p.payloads.length, 0);
  assert.deepEqual(referencedKeys(p), [key]);
});

test('a masked group with a clipped layer decodes to its stack ops', () => {
  const e = new Engine(256, 256, 8);
  e.fill(1, 'pixels', 0, 0, 255, 255);
  const inner = e.add_layer('inner', 0);
  e.fill(inner, 'pixels', 0, 255, 0, 255);
  const g = e.group_nodes(new Uint32Array([inner]));
  e.set_props(g, JSON.stringify({ blend: 'multiply', opacity: 0.5 }));
  e.add_mask(g, true);
  const clip = e.add_layer('clip', 0);
  e.fill(clip, 'pixels', 255, 0, 0, 255);
  e.set_props(clip, JSON.stringify({ clipping: true }));
  const p = decodeProgram(e.display_program(0, 0, 0, NONE).buffer as ArrayBuffer);
  const ops = p.steps.map(s => s.op);
  assert.deepEqual(ops, [
    OP.draw,                                    // background
    OP.pushTransparent, OP.pushTransparent,     // clipping group share, then the group base
    OP.draw,                                    // the group's child
    OP.pushShape, OP.draw,                      // base shape, base into the share
    OP.divShape, OP.draw, OP.mulShape,          // clipped layer inside the share
    OP.draw, OP.popShape,                       // the share onto the backdrop
  ]);
  // The group mask is revealed everywhere and has no tile, so it is the constant kind.
  const shape = p.steps[4];
  assert.equal(shape.maskKind, 1);
  assert.equal(shape.maskConst, 1);
  assert.equal(p.steps[9].mode, 3, 'multiply is index 3');
  assert.equal(p.steps[9].scale, 0.5);
});

test('the payload cache evicts the least recently used key and reports what it holds', () => {
  const gone: string[] = [];
  const c = new PayloadCache<string>(30, v => gone.push(v));
  c.set(1n, 'a', 10);
  c.set(2n, 'b', 10);
  c.set(3n, 'c', 10);
  assert.deepEqual([...c.keys()], [1n, 2n, 3n]);
  assert.equal(c.get(1n), 'a');
  c.set(4n, 'd', 10);
  assert.deepEqual(gone, ['b'], 'key 2 was the least recently used');
  assert.deepEqual([...c.keys()], [3n, 1n, 4n]);
  assert.equal(c.get(2n), undefined);
  assert.equal(c.size, 30);
  c.set(5n, 'e', 40);
  assert.deepEqual([...c.keys()], [5n], 'one oversized payload evicts the rest');
  c.clear();
  assert.deepEqual([...c.keys()], []);
  assert.deepEqual(gone, ['b', 'c', 'a', 'd', 'e']);
});

test('lowering the payload cache limit evicts down to it, and delete drops one key', () => {
  const gone: string[] = [];
  const c = new PayloadCache<string>(40, v => gone.push(v));
  for (const [k, v] of [[1n, 'a'], [2n, 'b'], [3n, 'c'], [4n, 'd']] as const) c.set(k, v, 10);
  c.get(1n);
  c.limit = 20;
  assert.deepEqual(gone, ['b', 'c'], 'least recently used first');
  assert.deepEqual([...c.keys()], [4n, 1n]);
  c.delete(4n);
  assert.deepEqual(gone, ['b', 'c', 'd']);
  assert.equal(c.size, 10);
  c.delete(9n);
  assert.equal(c.limit, 20);
});

test('the draw op codes match the engine enum', () => {
  const src = readFileSync(new URL('../../../engine/src/doc.rs', import.meta.url), 'utf8');
  const body = /enum Op \{([^}]*)\}/.exec(src)![1];
  const rust = Object.fromEntries([...body.matchAll(/(\w+) = (\d+)/g)].map(([, name, v]) =>
    [name[0].toLowerCase() + name.slice(1), Number(v)]));
  assert.deepEqual(rust, { ...OP });
});

test('the adjust opcodes match the engine constants', () => {
  const src = readFileSync(new URL('../../../engine/src/adjust.rs', import.meta.url), 'utf8');
  const rust = Object.fromEntries([...src.matchAll(/pub const OP_(\w+): u32 = (\d+);/g)].map(([, name, v]) =>
    [name.toLowerCase(), Number(v)]));
  assert.deepEqual(rust, { ...ADJUST });
});

test('version 2 steps carry the adjust opcode, clip flag, knockout and blend-if ranges', () => {
  const range = [0, 0, 255, 255];
  const blending = (knockout: string, gray: number[]) => JSON.stringify({
    blend_if: {
      gray: { source: gray, destination: range }, red: { source: range, destination: range },
      green: { source: range, destination: range }, blue: { source: range, destination: range },
    },
    channels: [true, true, true], knockout, blend_interior: false, blend_clipped: true,
    transparency_shapes: true, layer_mask_hides_effects: false, vector_mask_hides_effects: false,
  });
  const e = redDoc();
  const a = e.add_special(1, JSON.stringify({ name: 'Invert', adjustment: { kind: 'invert', params: {} } }));
  e.set_blending(a, blending('none', [0, 128, 255, 255]));
  const k = e.add_layer('k', a);
  e.fill(k, 'pixels', 0, 255, 0, 255);
  e.set_blending(k, blending('shallow', range));
  e.set_style(k, JSON.stringify({
    enabled: true, scale: 1, drop_shadows: [], inner_shadows: [],
    color_overlays: [{ present: true, enabled: true, blend: 'normal', opacity: 1, color: [0, 0, 0] }],
    gradient_overlays: [], pattern_overlays: [], strokes: [], outer_glow: null, inner_glow: null,
    bevel: null, contour: null, texture: null, satin: null,
  }));
  const c = e.add_special(k, JSON.stringify({ name: 'Invert 2', adjustment: { kind: 'invert', params: {} } }));
  e.set_props(c, JSON.stringify({ clipping: true }));
  const p = decodeProgram(e.display_program(0, 0, 0, NONE).buffer as ArrayBuffer);
  assert.deepEqual(p.steps.map(s => s.op), [
    OP.draw, OP.adjust,                                  // background, unclipped invert
    OP.pushShape, OP.pushTransparent, OP.draw, OP.divShape, // clip base: its knockout is dropped
    OP.adjust, OP.mulShape, OP.draw, OP.popShape,           // clipped invert inside the share
  ]);
  const [adj, clipped] = p.steps.filter(s => s.op === OP.adjust);
  assert.equal(adj.opcode, ADJUST.invert);
  assert.deepEqual([adj.flags, clipped.flags], [0, 1]);
  assert.deepEqual([...adj.blendIf.subarray(0, 8)], [0, 128, 255, 255, 0, 0, 255, 255]);
  e.set_props(c, JSON.stringify({ clipping: false }));
  const q = decodeProgram(e.display_program(0, 0, 0, NONE).buffer as ArrayBuffer);
  assert.deepEqual(q.steps.map(s => s.op), [OP.draw, OP.adjust, OP.knockout, OP.draw, OP.adjust]);
  assert.equal(q.steps[2].src, q.steps[3].src, 'the knockout shape is the layer tile');
  assert.equal(q.steps[2].scale, 1);
});

test('an adjustment ships its data block as a kind 2 payload the step references', () => {
  const e = redDoc();
  const rec = { input_black: 20, input_white: 235, gamma: 1, output_black: 0, output_white: 255 };
  e.add_special(1, JSON.stringify({ name: 'Levels', adjustment: { kind: 'levels', params: { composite: rec, red: null, green: null, blue: null } } }));
  const p = decodeProgram(e.display_program(0, 0, 0, NONE).buffer as ArrayBuffer);
  const adj = p.steps.find(s => s.op === OP.adjust)!;
  assert.equal(adj.opcode, ADJUST.table);
  const data = p.payloads.find(t => t.key === adj.src)!;
  assert.equal(data.kind, PAYLOAD.data);
  assert.equal(data.bytes.length, (2 + 3 * 65536) * 4);
  const f = new Float32Array(data.bytes.slice().buffer);
  assert.deepEqual([f[0], f[1]], [0, 65536], 'interpolated, 65536 entries');
  assert.ok(referencedKeys(p).includes(adj.src));
  const q = decodeProgram(e.display_program(0, 0, 0, BigUint64Array.from([adj.src])).buffer as ArrayBuffer);
  assert.equal(q.payloads.filter(t => t.kind === PAYLOAD.data).length, 0, 'a known data key is left out');
});
