import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ERROR_LABELS, errorLabel } from './errors.ts';

test('errorLabel shows known engine and worker errors, interpolates patterns, passes unknown text through', () => {
  assert.equal(errorLabel('Make a selection first.'), 'Make a selection first.');
  assert.equal(errorLabel('Layer not found: 7'), 'Layer not found: 7');
  assert.equal(errorLabel('Error: Make a selection first.'), 'Make a selection first.');
  assert.equal(errorLabel('something else'), 'something else');
  assert.equal(errorLabel('toString'), 'toString');
});

test('every user-facing worker error literal has a message', () => {
  const src = ['../engine.worker.ts', '../worker/helpers.ts'].map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  const literals = [...src.matchAll(/new Error\('((?:[^'\\]|\\.)+)'\)/g)].map(m => m[1]!.replaceAll("\\'", "'")).filter(s => /^[A-Z]/.test(s));
  assert.deepEqual(literals.filter(s => !Object.hasOwn(ERROR_LABELS, s)), []);
});
