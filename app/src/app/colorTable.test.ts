import test from 'node:test';
import assert from 'node:assert/strict';
import { colorTablePreset } from './colorTable.ts';

test('color table presets keep the table length and run end to end', () => {
  assert.deepEqual(colorTablePreset('grayscale', 3), [[0, 0, 0], [128, 128, 128], [255, 255, 255]]);
  const bb = colorTablePreset('black_body', 256);
  assert.equal(bb.length, 256);
  assert.deepEqual([bb[0], bb[255]], [[0, 0, 0], [255, 255, 255]]);
  assert.deepEqual(colorTablePreset('spectrum', 1), [[128, 0, 255]]);
  assert.throws(() => colorTablePreset('nope', 4));
});
