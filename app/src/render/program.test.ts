import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, Engine } from '../engine-pkg/photobaer_engine.js';
import { OP, decodeProgram, referencedKeys, PayloadCache } from './program.ts';

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
  assert.equal(p.payloads[0].mask, false);
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
