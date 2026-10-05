import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURSOR_NAMES, cursorOverrides, namedCursor, toolCursor } from './cursors.ts';
import { TOOLS } from './tools.ts';

const svgOf = (css: string) => decodeURIComponent(css.slice(css.indexOf('data:image/svg+xml,') + 19, css.indexOf('")')));
const hot = (css: string) => css.match(/\) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?), /)!.slice(1).map(Number);

test('a named cursor is an SVG with its own hotspot and a CSS keyword fallback', () => {
  const c = namedCursor('lasso');
  assert.match(c, /^url\("data:image\/svg\+xml,.+"\) 4 22, crosshair$/);
  assert.deepEqual(hot(namedCursor('eyedropper')), [2, 22]);
  assert.match(namedCursor('handOpen'), /, grab$/);
  for (const n of CURSOR_NAMES) assert.ok(svgOf(namedCursor(n)).startsWith('<svg'), n);
});

test('on a scaled display the icon is drawn at device pixels and declared at that resolution', () => {
  const c = namedCursor('lasso', 1.25);
  assert.match(c, /^image-set\(url\("data:image\/svg\+xml,.+"\) 1\.25x\) 4 22, crosshair$/);
  assert.ok(svgOf(c).includes('width="30" height="30" viewBox="0 0 24 24"'));
});

test('selection tools show the add, subtract and intersect badge from Shift, Alt or the Mode option', () => {
  const plain = svgOf(toolCursor('marqueeRect'));
  const add = svgOf(toolCursor('marqueeRect', 1, { shift: true }));
  const sub = svgOf(toolCursor('lasso', 1, { alt: true }));
  const both = svgOf(toolCursor('magicWand', 1, { shift: true, alt: true }));
  assert.notEqual(plain, add);
  assert.ok(add.includes('M19 16v6M16 19h6'), add);
  assert.ok(sub.includes('M16 19h6') && !sub.includes('M19 16v6'), sub);
  assert.ok(both.includes('l5 5'), both);
  assert.equal(toolCursor('marqueeRect', 1, { mode: 'add' }), toolCursor('marqueeRect', 1, { shift: true }));
});

test('modifiers and view state pick the Photoshop variant', () => {
  assert.equal(toolCursor('zoom', 1, { alt: true }), namedCursor('zoomOut'));
  assert.equal(toolCursor('zoom', 1, { zoom: 64 }), namedCursor('zoomLimit'));
  assert.equal(toolCursor('hand', 1, { grabbing: true }), namedCursor('handClosed'));
  assert.equal(toolCursor('move', 1, { alt: true }), namedCursor('moveCopy'));
  assert.equal(toolCursor('cloneStamp', 1, { alt: true }), namedCursor('target'));
  assert.equal(toolCursor('brush'), 'none');
  assert.equal(toolCursor('brush', 1, { spring: 'hand' }), namedCursor('handOpen'));
  assert.equal(toolCursor('lasso', 1, { spring: 'zoomOut' }), namedCursor('zoomOut'));
});

test('Precise (Caps Lock or the preference) turns tool icons into the crosshair, but not hand, zoom, type or arrows', () => {
  assert.equal(toolCursor('eyedropper', 1, { precise: true }), namedCursor('precise'));
  assert.equal(toolCursor('lasso', 1, { precise: true, shift: true }), toolCursor('marqueeRect', 1, { shift: true }));
  assert.equal(toolCursor('hand', 1, { precise: true }), namedCursor('handOpen'));
  assert.equal(toolCursor('horizontalType', 1, { precise: true }), namedCursor('text'));
  assert.ok(cursorOverrides('pen', { precise: true }));
  assert.ok(!cursorOverrides('pen', {}));
  assert.ok(cursorOverrides('pen', { spring: 'hand' }));
});

test('every tool resolves to a cursor', () => {
  for (const id of Object.keys(TOOLS)) assert.ok(toolCursor(id).length > 0, id);
  assert.equal(toolCursor('nope'), 'default');
});
