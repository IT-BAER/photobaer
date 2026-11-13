import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VIEW_SHOW, parseViewShow, SHOW_KEYS } from './viewShow.ts';

test('View > Show flags default on and keep only known booleans from storage', () => {
  assert.deepEqual([...SHOW_KEYS], ['targetPath', 'notes', 'brushPreview', 'mesh']);
  assert.deepEqual(parseViewShow(null), DEFAULT_VIEW_SHOW);
  assert.ok(SHOW_KEYS.every(k => DEFAULT_VIEW_SHOW[k]));
  assert.deepEqual(parseViewShow('{"notes":false,"mesh":"no","bogus":false}'), { ...DEFAULT_VIEW_SHOW, notes: false });
  assert.deepEqual(parseViewShow('not json'), DEFAULT_VIEW_SHOW);
});
