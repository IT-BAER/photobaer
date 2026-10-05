import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pixels, rasterSize, setHeight, setPpi, setWidth, svgAtSize, svgSize } from './rasterSize.ts';

test('svgSize reads width and height with units, else the viewBox, else 300 x 150', () => {
  assert.deepEqual(svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80px">'), [120, 80]);
  assert.deepEqual(svgSize('<?xml version="1.0"?><!-- <svg width="1"> --><svg width="1in" height="72pt" viewBox="0 0 5 5">'), [96, 96]);
  assert.deepEqual(svgSize(`<svg viewBox='0,0 400.5 200'>`), [400.5, 200]);
  assert.deepEqual(svgSize('<svg width="100%" viewBox="0 0 40 20">'), [40, 20]);
  assert.deepEqual(svgSize('<svg width="10mm" viewBox="0 0 40 20">').map(v => +v.toFixed(3)), [37.795, 18.898]);
  assert.deepEqual(svgSize('<svg height="50" viewBox="0 0 40 20">'), [100, 50]);
  assert.deepEqual(svgSize('<svg>'), [300, 150]);
});

test('svgAtSize sets the root size and keeps the drawing scaled through a viewBox', () => {
  assert.equal(svgAtSize('<svg width="10" height="5" viewBox="0 0 2 1"><rect/></svg>', 400, 200), '<svg width="400" height="200" viewBox="0 0 2 1"><rect/></svg>');
  assert.equal(svgAtSize('<svg\nwidth="1in" height="0.5in"><g/></svg>', 192, 96), '<svg\nwidth="192" height="96" viewBox="0 0 96 48"><g/></svg>');
  assert.equal(svgAtSize('<svg xmlns="x"><g/></svg>', 600, 300), '<svg xmlns="x" width="600" height="300" viewBox="0 0 300 150"><g/></svg>');
});

test('resolution scales the pixel size from 72 ppi; width and height stay linked while constrained', () => {
  const base: [number, number] = [200, 100];
  let s = rasterSize(72);
  assert.deepEqual(pixels(s, base), [200, 100]);
  s = setPpi(s, 144);
  assert.deepEqual(pixels(s, base), [400, 200]);
  s = setWidth(s, base, 300);
  assert.deepEqual(pixels(s, base), [300, 150]);
  assert.equal(s.ppi, 144);
  s = { ...setHeight({ ...s, constrain: false }, base, 400) };
  assert.deepEqual(pixels(s, base), [300, 400]);
  s = setPpi(s, 72);
  assert.deepEqual(pixels(s, base), [150, 200]);
  s = setWidth({ ...s, constrain: true }, base, 0);
  assert.deepEqual(pixels(s, base), [1, 1]);
});
