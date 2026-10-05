import test from 'node:test';
import assert from 'node:assert/strict';
import { colorTablePreset, fitTable, readTableFile, writeAct } from './colorTable.ts';
import { writeAco } from '../shell/swatches.ts';

test('color table presets keep the table length and run end to end', () => {
  assert.deepEqual(colorTablePreset('grayscale', 3), [[0, 0, 0], [128, 128, 128], [255, 255, 255]]);
  const bb = colorTablePreset('black_body', 256);
  assert.equal(bb.length, 256);
  assert.deepEqual([bb[0], bb[255]], [[0, 0, 0], [255, 255, 255]]);
  assert.deepEqual(colorTablePreset('spectrum', 1), [[128, 0, 255]]);
  assert.throws(() => colorTablePreset('nope', 4));
});

test('.act color tables: 768 bytes of RGB plus count and no transparent index; loads back', () => {
  const t: [number, number, number][] = [[255, 0, 0], [0, 128, 255], [7, 8, 9]];
  const act = writeAct(t);
  assert.equal(act.length, 772);
  assert.deepEqual([...act.subarray(0, 9)], [255, 0, 0, 0, 128, 255, 7, 8, 9]);
  assert.deepEqual([...act.subarray(768)], [0, 3, 0xff, 0xff]);
  assert.deepEqual(readTableFile('t.ACT', act), t);
  // A bare 768-byte file has 256 entries.
  assert.equal(readTableFile('old.act', act.subarray(0, 768)).length, 256);
  assert.throws(() => readTableFile('x.act', new Uint8Array(10)));
});

test('.aco swatch files load as a color table; tables fit a fixed length', () => {
  const aco = writeAco([{ name: 'a', rgb: [1, 2, 3] }, { name: 'b', rgb: [200, 100, 0] }]);
  assert.deepEqual(readTableFile('s.aco', aco), [[1, 2, 3], [200, 100, 0]]);
  assert.throws(() => readTableFile('s.txt', aco));
  assert.deepEqual(fitTable([[1, 1, 1], [2, 2, 2]], 3), [[1, 1, 1], [2, 2, 2], [2, 2, 2]]);
  assert.deepEqual(fitTable([[1, 1, 1], [2, 2, 2]], 1), [[1, 1, 1]]);
});
