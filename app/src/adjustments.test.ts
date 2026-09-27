import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIELD_SPECS, defaultAdjustment, getPath, setPath, type Kind } from './adjustments.ts';

test('every generic field path resolves in its kind\'s defaults, inside the field\'s range', () => {
  for (const [kind, specs] of Object.entries(FIELD_SPECS) as [Kind, NonNullable<(typeof FIELD_SPECS)[Kind]>][]) {
    const params = defaultAdjustment(kind).params;
    for (const s of specs) {
      const v = getPath(params, s.path);
      if (s.type === 'number') {
        assert.equal(typeof v, 'number', `${kind} ${s.path}`);
        assert.ok((v as number) >= s.min && (v as number) <= s.max, `${kind} ${s.path} = ${v}`);
      } else if (s.type === 'checkbox') assert.equal(typeof v, 'boolean', `${kind} ${s.path}`);
      else assert.ok(s.options.some(([o]) => o === v), `${kind} ${s.path}`);
    }
  }
});

test('setPath clones the touched branch and leaves the original alone', () => {
  const a = defaultAdjustment('channel_mixer');
  const b = setPath(a, 'red.3', 50);
  assert.equal(getPath(b.params, 'red.3'), 50);
  assert.equal(getPath(a.params, 'red.3'), 0);
  assert.ok(Array.isArray(getPath(b.params, 'red')));
  assert.equal(getPath(b.params, 'green'), getPath(a.params, 'green'));
});
