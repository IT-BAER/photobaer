import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, fieldSpecs, filterOff, menuLabel, previewScale, setColorSource, type FilterSpec } from './schema.ts';

const spec = (params: FilterSpec['params']): FilterSpec => ({ id: 'x.y', label: 'Thing', group: 'noise', params, exec: 'local', alpha: 'kept', preview: true, rgb_only: false, hdr: true });
const p = (key: string, kind: FilterSpec['params'][number]['kind'], extra: Partial<FilterSpec['params'][number]> = {}) =>
  ({ key, label: key, kind, min: 0, max: 10, step: 1, unit: '', default: 1, ...extra });

test('menu label, fields and defaults follow the schema; blob and seed stay hidden', () => {
  assert.equal(menuLabel(spec([])), 'Thing');
  assert.equal(menuLabel(spec([p('s', 'seed'), p('b', 'blob', { default: null })])), 'Thing', 'hidden params alone take no dialog');
  const s = spec([p('radius', 'number', { unit: 'px' }), p('mode', 'select', { default: 'gaussianBlur', choices: ['gaussianBlur', 'motion'] }), p('on', 'bool', { default: true }), p('seed', 'seed', { min: 1, max: 1 })]);
  assert.equal(menuLabel(s), 'Thing…');
  assert.deepEqual(fieldSpecs(s), [
    { type: 'number', label: 'radius (px)', path: 'radius', min: 0, max: 10, step: 1 },
    { type: 'select', label: 'mode', path: 'mode', options: [['gaussianBlur', 'Gaussian Blur'], ['motion', 'Motion']] },
    { type: 'checkbox', label: 'on', path: 'on' },
  ]);
  assert.deepEqual(defaults(s), { radius: 1, mode: 'gaussianBlur', on: true, seed: 1 });
});

test('filters missing from the Photoshop 32-bit list are off in 32-bit documents only', () => {
  const off = { ...spec([]), hdr: false };
  assert.equal(filterOff(off, 32), true);
  assert.equal(filterOff(off, 16), false);
  assert.equal(filterOff(spec([]), 32), false);
});

test('preview proxy scale keeps the visible area at or under 512 x 512', () => {
  assert.equal(previewScale(400, 300), 1);
  assert.equal(previewScale(1024, 1024), 0.5);
});

test('a point param shows as X and Y fields of its fractions', () => {
  const s = spec([p('center', 'point', { min: 0, max: 1, step: 0.01, default: { x: 0.5, y: 0.5 } })]);
  assert.equal(menuLabel(s), 'Thing…');
  assert.deepEqual(fieldSpecs(s), [
    { type: 'number', label: 'center X', path: 'center.x', min: 0, max: 1, step: 0.01 },
    { type: 'number', label: 'center Y', path: 'center.y', min: 0, max: 1, step: 0.01 },
  ]);
  assert.deepEqual(defaults(s), { center: { x: 0.5, y: 0.5 } });
});

test('a kernel param shows as 25 fields row by row and a curve as none', () => {
  const k = spec([p('kernel', 'kernel', { min: -999, max: 999, default: Array.from({ length: 25 }, (_, i) => (i === 12 ? 1 : 0)) })]);
  const f = fieldSpecs(k);
  assert.equal(f.length, 25);
  assert.deepEqual(f[7], { type: 'number', label: 'kernel 2,3', path: 'kernel.7', min: -999, max: 999, step: 1 });
  assert.equal(menuLabel(k), 'Thing…');
  assert.deepEqual((defaults(k).kernel as number[])[12], 1);
  assert.deepEqual(fieldSpecs(spec([p('shearCurve', 'curve', { default: [{ y: 0, offset: 0 }, { y: 1, offset: 0 }] })])), []);
});

test('color params stay hidden and take the current colors; lights and path draw their own editors', () => {
  const s = spec([p('foreground', 'color', { default: '#000000' }), p('background', 'color', { default: '#ffffff' }), p('lights', 'lights', { default: [] }), p('path', 'path', { default: [] })]);
  assert.deepEqual(fieldSpecs(s), []);
  assert.equal(menuLabel(s), 'Thing…', 'lights and path open the dialog');
  assert.equal(menuLabel(spec([p('foreground', 'color', { default: '#000000' })])), 'Thing', 'colors alone take no dialog');
  setColorSource(() => ({ foreground: '#102030', background: '#a0b0c0' }));
  assert.deepEqual(defaults(s), { foreground: '#102030', background: '#a0b0c0', lights: [], path: [] });
});

test('blur gallery pins and paths take no fields: the canvas overlay edits them', () => {
  const pins = [{ x: 0.5, y: 0.5, blur: 15 }], paths = [[{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }]];
  const s = spec([p('pins', 'pins', { default: pins }), p('paths', 'paths', { default: paths })]);
  assert.deepEqual(fieldSpecs(s), []);
  assert.deepEqual(defaults(s), { pins, paths });
});
