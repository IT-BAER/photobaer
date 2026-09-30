import test from 'node:test';
import assert from 'node:assert/strict';
import { FILL_CONTENTS } from './helpers.ts';

test('Fill contents list Content-Aware between Color… and Pattern', () => {
  assert.deepEqual(Object.values(FILL_CONTENTS), ['Foreground Color', 'Background Color', 'Color…', 'Content-Aware', 'Pattern', 'History', 'Black', '50% Gray', 'White']);
});
