import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURSOR_NAMES, cursorOverrides, iconCursor, namedCursor, toolCursor } from './cursors.ts';
import { TOOL_ART } from './toolArt.ts';
import { TOOLS } from './tools.ts';

const svgOf = (css: string) => decodeURIComponent(css.slice(css.indexOf('data:image/svg+xml,') + 19, css.indexOf('")')));
const hot = (css: string) => css.match(/\) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?), /)!.slice(1).map(Number);

test('a named cursor is a 32 px SVG with its Photoshop hotspot and a CSS keyword fallback', () => {
  assert.match(namedCursor('eyedropper'), /^url\("data:image\/svg\+xml,.+"\) 2 17, crosshair$/);
  assert.deepEqual(hot(namedCursor('arrow')), [1, 1]);
  assert.deepEqual(hot(namedCursor('pen')), [1, 1]);
  assert.deepEqual(hot(namedCursor('bucket')), [1, 1]);
  assert.deepEqual(hot(namedCursor('handOpen')), [11, 11]);
  assert.match(namedCursor('handOpen'), /, grab$/);
  for (const n of CURSOR_NAMES) assert.ok(svgOf(namedCursor(n)).includes('viewBox="0 0 32 32"'), n);
});

test('tools without a cursor of their own use their toolbar icon, hotspot on the tip', () => {
  const lasso = toolCursor('lasso');
  assert.equal(lasso, iconCursor('lasso'));
  assert.deepEqual(hot(lasso), [5, 18]);
  assert.ok(svgOf(lasso).includes('<ellipse cx="13" cy="10.5"'));
});

test('on a scaled display the icon is drawn at device pixels and declared at that resolution', () => {
  const c = namedCursor('arrow', 1.25);
  assert.match(c, /^image-set\(url\("data:image\/svg\+xml,.+"\) 1\.25x\) 1 1, default$/);
  assert.ok(svgOf(c).includes('width="40" height="40" viewBox="0 0 32 32"'));
});

test('selection tools show the add, subtract and intersect badge from Shift, Alt or the Mode option', () => {
  const plain = svgOf(toolCursor('marqueeRect'));
  const add = svgOf(toolCursor('marqueeRect', 1, { shift: true }));
  const sub = svgOf(toolCursor('lasso', 1, { alt: true }));
  const both = svgOf(toolCursor('magicWand', 1, { shift: true, alt: true }));
  assert.notEqual(plain, add);
  assert.ok(add.includes('M20 15.5v7M16.5 19h7'), add);
  assert.ok(sub.includes('M16.5 19h7') && !sub.includes('v7M'), sub);
  assert.ok(both.includes('l6 3.4'), both);
  assert.equal(toolCursor('marqueeRect', 1, { mode: 'add' }), toolCursor('marqueeRect', 1, { shift: true }));
});

test('modifiers and view state pick the Photoshop variant', () => {
  assert.equal(toolCursor('zoom', 1, { alt: true }), namedCursor('zoomOut'));
  assert.equal(toolCursor('zoom', 1, { zoom: 64 }), namedCursor('zoomLimit'));
  assert.equal(toolCursor('hand', 1, { grabbing: true }), namedCursor('handClosed'));
  assert.equal(toolCursor('move', 1, { alt: true }), namedCursor('moveCopy'));
  assert.equal(toolCursor('cloneStamp', 1, { alt: true }), namedCursor('target'));
  assert.equal(toolCursor('brush'), 'none');
  assert.equal(toolCursor('brush', 1, { paintIcon: true }), iconCursor('brush'));
  assert.equal(toolCursor('brush', 1, { spring: 'hand' }), namedCursor('handOpen'));
  assert.equal(toolCursor('lasso', 1, { spring: 'zoomOut' }), namedCursor('zoomOut'));
  assert.equal(toolCursor('addAnchor'), namedCursor('pen', 1, 'add'));
  assert.equal(toolCursor('directSelection', 1, { grabbing: true }), namedCursor('arrow'));
  assert.equal(toolCursor('patch', 1, { mode: 'destination' }), namedCursor('patchDest'));
  assert.equal(toolCursor('freeformPen', 1, { magnetic: true }), namedCursor('freeformMagnetic'));
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

test('every tool has a toolbar drawing and resolves to a cursor', () => {
  for (const id of Object.keys(TOOLS)) {
    assert.ok(TOOL_ART[id], id);
    assert.ok(toolCursor(id).length > 0, id);
    assert.ok(toolCursor(id, 1, { paintIcon: true }).length > 0, id);
  }
  assert.equal(toolCursor('nope'), 'default');
});
