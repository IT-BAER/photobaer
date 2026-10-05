import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSliders, inGray, rgbOfSliders, slidersOf, type Convert } from './colorModes.ts';

// Fake profiles: CMYK is 1 - rgb with K 0, Gray is the red value; every call is logged.
function fake() {
  const calls: string[] = [];
  const convert: Convert = async (v, from, to) => {
    calls.push(`${from}>${to}`);
    if (from === 'rgb' && to === 'cmyk') return [1 - v[0], 1 - v[1], 1 - v[2], 0];
    if (from === 'cmyk' && to === 'rgb') return [1 - v[0], 1 - v[1], 1 - v[2]];
    if (from === 'rgb' && to === 'gray') return [v[0]];
    if (from === 'gray' && to === 'rgb') return [v[0], v[0], v[0]];
    throw new Error('unexpected');
  };
  return { calls, convert };
}

test('slider sets follow the document mode', () => {
  assert.equal(defaultSliders(null), 'rgb');
  assert.equal(defaultSliders({ gray: true, mode: null }), 'gray');
  assert.equal(defaultSliders({ gray: false, mode: { kind: 'cmyk' } }), 'cmyk');
  assert.equal(defaultSliders({ gray: false, mode: { kind: 'lab' } }), 'lab');
  assert.equal(defaultSliders({ gray: true, mode: { kind: 'duotone' } }), 'rgb');
});

test('CMYK and Gray K go through the profiles; Grayscale documents read neutral colors as their gray', async () => {
  const f = fake();
  assert.deepEqual(await slidersOf([255, 0, 51], 'cmyk', false, f.convert), [0, 100, 80, 0]);
  assert.deepEqual(await rgbOfSliders([0, 100, 80, 0], 'cmyk', false, f.convert), [255, 0, 51]);
  assert.deepEqual(await slidersOf([51, 0, 0], 'gray', false, f.convert), [80]);
  assert.deepEqual(await rgbOfSliders([80], 'gray', false, f.convert), [51, 51, 51]);
  f.calls.length = 0;
  assert.deepEqual(await slidersOf([51, 51, 51], 'gray', true, f.convert), [80]);
  assert.deepEqual(await rgbOfSliders([80], 'gray', true, f.convert), [51, 51, 51]);
  assert.deepEqual(f.calls, [], 'Grayscale numbers are the gray itself');
  assert.deepEqual(await slidersOf([10, 20, 30], 'rgb', false, f.convert), [10, 20, 30]);
  const lab = await slidersOf([255, 255, 255], 'lab', false, f.convert);
  assert.ok(Math.abs(lab[0] - 100) < 0.5 && Math.abs(lab[1]) < 0.5, `${lab}`);
});

test('inGray keeps neutral colors and converts others through the Gray profile', async () => {
  const f = fake();
  assert.deepEqual(await inGray([90, 90, 90], f.convert), [90, 90, 90]);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await inGray([204, 0, 0], f.convert), [204, 204, 204]);
});
