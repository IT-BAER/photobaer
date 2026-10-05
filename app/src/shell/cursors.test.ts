import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolCursor } from './cursors.ts';
import { TOOLS } from './tools.ts';

test('drawn tools get their symbol under an arrow whose tip is the hotspot, with the CSS cursor as fallback', () => {
  const c = toolCursor('lasso');
  assert.match(c, /^url\("data:image\/svg\+xml,.+"\) 2 2, crosshair$/);
  const svg = decodeURIComponent(c.slice('url("data:image/svg+xml,'.length, c.indexOf('")')));
  assert.ok(svg.includes('<ellipse cx="13" cy="8.5"'), svg);
  assert.match(toolCursor('eyedropper'), /\) 2 2, crosshair$/);
});

test('on a scaled display the icon is drawn at device pixels and declared at that resolution', () => {
  const c = toolCursor('lasso', 1.25);
  assert.match(c, /^image-set\(url\("data:image\/svg\+xml,.+"\) 1\.25x\) 2 2, crosshair$/);
  const svg = decodeURIComponent(c.slice('image-set(url("data:image/svg+xml,'.length, c.indexOf('")')));
  assert.ok(svg.includes('width="30" height="30" viewBox="0 0 24 24"'), svg);
  assert.equal(toolCursor('marqueeRect', 1.25), 'crosshair');
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
