import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelMatrix, channelThumb, COMPOSITE, inkGray, inkThumb, viewState } from './channels.ts';

test('channelMatrix: all channels need no filter, one channel is gray, two keep their color', () => {
  assert.equal(channelMatrix([true, true, true]), null);
  assert.equal(channelMatrix([false, true, false]), '0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 1 0');
  assert.equal(channelMatrix([true, false, true]), '1 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0');
  assert.equal(channelMatrix([false, false, false]), null);
});

test('channelThumb turns RGBA into one gray channel and keeps alpha', () => {
  const rgba = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
  assert.deepEqual([...channelThumb(rgba, 1)], [20, 20, 20, 40, 60, 60, 60, 80]);
});

test('viewState: an alpha channel alone is shown gray, with color it is a tint', () => {
  assert.deepEqual(viewState(COMPOSITE), { matrix: null, alpha: null, ink: null });
  assert.deepEqual(viewState({ rgb: [false, false, false], alpha: [7] }), { matrix: null, alpha: { id: 7, mode: 'gray' }, ink: null });
  assert.deepEqual(viewState({ rgb: [true, true, true], alpha: [7, 9] }), { matrix: null, alpha: { id: 7, mode: 'tint' }, ink: null });
});

test('inkGray: CMYK with full black generation and Lab from sRGB', () => {
  assert.deepEqual([0, 1, 2, 3].map(c => inkGray('cmyk', c, 255, 0, 0)), [255, 0, 0, 255]);
  assert.deepEqual([0, 1, 2, 3].map(c => inkGray('cmyk', c, 0, 0, 0)), [255, 255, 255, 0]);
  assert.deepEqual([0, 1, 2, 3].map(c => inkGray('cmyk', c, 128, 64, 128)), [255, 128, 255, 128]);
  assert.deepEqual([0, 1, 2].map(c => inkGray('lab', c, 255, 0, 0)), [136, 208, 195]);
  assert.deepEqual([0, 1, 2].map(c => inkGray('lab', c, 255, 255, 255)), [255, 128, 128]);
  assert.deepEqual([...inkThumb(new Uint8Array([255, 0, 0, 77]), 'cmyk', 1)], [0, 0, 0, 77]);
  assert.deepEqual(viewState({ rgb: [false, false, false], alpha: [], ink: 2 }).ink, 2);
});
