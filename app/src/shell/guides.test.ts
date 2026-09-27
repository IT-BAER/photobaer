// docs/M4.md section 12 / B16 acceptance: guide ops through the wasm engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, Engine } from '../engine-pkg/photobaer_engine.js';

initSync({ module: readFileSync(new URL('../engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });

function guidePositions(e: Engine): number[] {
  const v = JSON.parse(e.vector_json()) as { guides: { pos: number }[] };
  return v.guides.map(g => g.pos).sort((a, b) => a - b);
}

test('New Guide Layout: 3 columns gutter 20 on a 1000 px doc without margins places 6 vertical guides', () => {
  const e = new Engine(1000, 500, 8);
  const created = e.new_guide_layout(JSON.stringify({
    rect: [0, 0, 1000, 500], columns: 3, columnGutter: 20, rows: 0, rowGutter: 20, margins: null, clearExisting: false, artboard: 0,
  }));
  assert.equal(created.length, 6);
  assert.deepEqual(guidePositions(e), [0, 320, 340, 660, 680, 1000]);
});

test('rows 0 adds no horizontal guides, and clearExisting replaces rather than accumulates', () => {
  const e = new Engine(1000, 500, 8);
  e.new_guide_layout(JSON.stringify({
    rect: [0, 0, 1000, 500], columns: 3, columnGutter: 20, rows: 0, rowGutter: 20, margins: null, clearExisting: false, artboard: 0,
  }));
  e.new_guide_layout(JSON.stringify({
    rect: [0, 0, 1000, 500], columns: 1, columnGutter: 0, rows: 0, rowGutter: 0, margins: null, clearExisting: true, artboard: 0,
  }));
  assert.deepEqual(guidePositions(e), [0, 1000]);
});

test('a guide relative to a targeted artboard at x 200 lands at 200 + pos (pure origin offset, B18 pending)', () => {
  const e = new Engine(2000, 500, 8);
  e.new_guide_layout(JSON.stringify({
    rect: [200, 0, 1000, 500], columns: 1, columnGutter: 0, rows: 0, rowGutter: 0, margins: null, clearExisting: false, artboard: 0,
  }));
  assert.deepEqual(guidePositions(e), [200, 1200]);
});

test('locked guides refuse to move', () => {
  const e = new Engine(300, 300, 8);
  const id = e.add_guide('x', 10, 0);
  e.set_grid_and_locks(JSON.stringify({ guidesLocked: true }));
  assert.throws(() => e.move_guide(id, 20));
  e.set_grid_and_locks(JSON.stringify({ guidesLocked: false }));
  e.move_guide(id, 20);
  assert.deepEqual(guidePositions(e), [20]);
});
