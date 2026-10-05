import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelMatrix, channelThumb, COMPOSITE, editChannels, inkGray, paintColor, pickChannel, spotInk, inkThumb, viewState } from './channels.ts';

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

test('inkGray: CMYK through a separation table, interpolated between grid points', () => {
  // 2x2x2 table, red slowest: C = 1 - r, M = g, Y = b / 2, K = 0.25.
  const t = new Float32Array(8 * 4);
  for (let r = 0; r < 2; r++) for (let g = 0; g < 2; g++) for (let b = 0; b < 2; b++) t.set([1 - r, g, b / 2, 0.25], ((r * 2 + g) * 2 + b) * 4);
  assert.deepEqual([0, 1, 2, 3].map(c => inkGray('cmyk', c, 51, 102, 255, t)), [51, 153, 128, 191]);
  assert.deepEqual([...inkThumb(new Uint8Array([255, 0, 0, 77]), 'cmyk', 0, t)], [255, 255, 255, 77]);
});

test('inkGray: Lab through an ICC Lab table, falling back to the formula without one', () => {
  // 2x2x2 table, red slowest: L = r, a = g, b = 0.5.
  const t = new Float32Array(8 * 3);
  for (let r = 0; r < 2; r++) for (let g = 0; g < 2; g++) for (let b = 0; b < 2; b++) t.set([r, g, 0.5], ((r * 2 + g) * 2 + b) * 3);
  assert.deepEqual([0, 1, 2].map(c => inkGray('lab', c, 51, 102, 255, t)), [51, 102, 128]);
  assert.deepEqual([...inkThumb(new Uint8Array([255, 0, 0, 77]), 'lab', 1, t)], [0, 0, 0, 77]);
  assert.deepEqual([0, 1, 2].map(c => inkGray('lab', c, 255, 0, 0, null)), [136, 208, 195]);
});

test('with Quick Mask on, edits go into the quick mask, not the picked saved channel', () => {
  const v = { rgb: [true, true, true] as [boolean, boolean, boolean], alpha: [2], alphaTargets: [2] };
  assert.deepEqual(editChannels(v).alpha, [2]);
  assert.deepEqual(editChannels(v, true).alpha, []);
});

test('painting one targeted color channel uses the paint color\'s gray; several channels keep the color', () => {
  assert.deepEqual(paintColor([255, 0, 0], { rgb: [true, false, false], alpha: [] }), [77, 77, 77]);
  assert.deepEqual(paintColor([10, 200, 30], { rgb: [false, true, false], alpha: [] }), [124, 124, 124]);
  assert.deepEqual(paintColor([255, 0, 0], { rgb: [true, true, false], alpha: [] }), [255, 0, 0]);
  assert.deepEqual(paintColor([255, 0, 0], { rgb: [true, false, false], alpha: [2] }), [255, 0, 0], 'a saved channel paints by its own rules');
});

test('Shift+click targets several channels: color channels toggle, saved channels add and remove', () => {
  const red = pickChannel(COMPOSITE, { color: 0 }, false);
  assert.deepEqual([red.rgb, red.alphaTargets], [[true, false, false], []]);
  const rg = pickChannel(red, { color: 1 }, true);
  assert.deepEqual(rg.rgb, [true, true, false]);
  assert.deepEqual(editChannels(rg).rgb, [true, true, false]);
  assert.deepEqual(pickChannel(rg, { color: 0 }, true).rgb, [false, true, false]);
  assert.deepEqual(pickChannel(red, { color: 0 }, true).rgb, [true, false, false], 'the last targeted channel stays');
  const a = pickChannel(rg, { alpha: 4 }, false);
  assert.deepEqual([a.rgb, a.alpha, a.alphaTargets], [[false, false, false], [4], [4]]);
  const ab = pickChannel(a, { alpha: 7 }, true);
  assert.deepEqual([ab.alpha, ab.alphaTargets], [[4, 7], [4, 7]]);
  assert.deepEqual(editChannels(ab).alpha, [4, 7]);
  assert.deepEqual(pickChannel(ab, { alpha: 4 }, true).alphaTargets, [7]);
  assert.deepEqual(pickChannel(a, { alpha: 4 }, true).alphaTargets, [4], 'the last targeted channel stays');
});

test('spot ink previews multiplied over the image; solidity covers it', () => {
  const ink: [number, number, number] = [0, 153, 230];
  assert.deepEqual(spotInk(0, ink, 0), { multiply: [0, 153, 230], cover: 0 }, 'transparent ink multiplies');
  assert.deepEqual(spotInk(0, ink, 1), { multiply: [255, 255, 255], cover: 255 }, 'solid ink covers');
  assert.deepEqual(spotInk(255, ink, 0.5), { multiply: [255, 255, 255], cover: 0 }, 'white: no ink');
  assert.deepEqual(spotInk(51, [153, 153, 230], 0.5), { multiply: [214, 214, 245], cover: 102 });
});
