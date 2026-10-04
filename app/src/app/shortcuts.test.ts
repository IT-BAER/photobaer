import test from 'node:test';
import assert from 'node:assert/strict';
import { exportShortcut } from './shortcuts.ts';

test('layer export shortcuts use apostrophe with the documented modifiers', () => {
  assert.equal(exportShortcut({ key: '"', code: 'Quote', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }), 'quick');
  assert.equal(exportShortcut({ key: '"', code: 'Quote', ctrlKey: true, metaKey: false, altKey: true, shiftKey: true }), 'as');
  assert.equal(exportShortcut({ key: "'", code: 'Quote', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }), null);
  assert.equal(exportShortcut({ key: 'w', code: 'KeyW', ctrlKey: true, metaKey: false, altKey: true, shiftKey: true }), null);
});
