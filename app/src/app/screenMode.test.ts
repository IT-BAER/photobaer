import test from 'node:test';
import assert from 'node:assert/strict';
import { nextScreenMode, SCREEN_MODES } from './screenMode.ts';

test('F cycles the screen modes forward, Shift+F backward', () => {
  assert.deepEqual([...SCREEN_MODES], ['standard', 'fullMenu', 'full']);
  assert.equal(nextScreenMode('standard', false), 'fullMenu');
  assert.equal(nextScreenMode('fullMenu', false), 'full');
  assert.equal(nextScreenMode('full', false), 'standard');
  assert.equal(nextScreenMode('standard', true), 'full');
  assert.equal(nextScreenMode('full', true), 'fullMenu');
});
