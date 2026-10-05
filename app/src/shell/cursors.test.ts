import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolCursor } from './cursors.ts';
import { TOOLS } from './tools.ts';

test('icon tools get their toolbar icon as cursor with a hotspot and the CSS cursor as fallback', () => {
  const c = toolCursor('lasso');
  assert.match(c, /^url\("data:image\/svg\+xml,.+"\) 7 22, crosshair$/);
  const svg = decodeURIComponent(c.slice('url("data:image/svg+xml,'.length, c.indexOf('")')));
  assert.ok(svg.includes('M7 22a5 5 0 0 1-2-3.994'), svg);
  assert.match(toolCursor('eyedropper'), /\) 2 22, crosshair$/);
});

test('other tools use their CSS cursor; brush tools fall back to a crosshair under their outline', () => {
  assert.equal(toolCursor('marqueeRect'), 'crosshair');
  assert.equal(toolCursor('horizontalType'), 'text');
  assert.equal(toolCursor('hand'), 'grab');
  assert.equal(toolCursor('brush'), 'crosshair');
  assert.equal(toolCursor('nope'), 'default');
});

test('every tool resolves to a cursor', () => {
  for (const id of Object.keys(TOOLS)) assert.ok(toolCursor(id).length > 0, id);
});
