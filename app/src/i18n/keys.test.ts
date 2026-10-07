import { test } from 'node:test';
import assert from 'node:assert/strict';
import { i18n } from './index.ts';
import { KEY_NAMES, keysLabel } from './keys.ts';

test('keysLabel shows shortcut strings with the UI language modifier names and leaves other keys alone', () => {
  assert.equal(keysLabel('Ctrl+Shift+Alt+S'), 'Ctrl+Shift+Alt+S');
  i18n.load('de', { [KEY_NAMES.Ctrl.id!]: 'Strg', [KEY_NAMES.Shift.id!]: 'Umschalt', [KEY_NAMES.Alt.id!]: 'Alt' });
  i18n.activate('de');
  try {
    assert.equal(keysLabel('Ctrl+Shift+Alt+S'), 'Strg+Umschalt+Alt+S');
    assert.equal(keysLabel('Shift+Tab'), 'Umschalt+Tab');
    assert.equal(keysLabel('F5'), 'F5');
    assert.equal(keysLabel('›'), '›');
    assert.equal(keysLabel(''), '');
  } finally {
    i18n.activate('en');
  }
});
