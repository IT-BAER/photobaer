import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilter, lastFilter, repeatLastFilter, resetLastFilter, type AppliedFilter } from './lastFilter.ts';

test('Last Filter repeats the last applied filter with the same params', async () => {
  resetLastFilter();
  const calls: AppliedFilter[] = [];
  const apply = async (f: AppliedFilter) => { calls.push(f); };
  const msgs: string[] = [];
  await repeatLastFilter(apply, m => msgs.push(m));
  assert.deepEqual(msgs, ['No filter to reapply.']);
  assert.equal(calls.length, 0);

  const params = { radius: 4.5 };
  await applyFilter(apply, { kind: 'gaussian_blur', params, label: 'Gaussian Blur' });
  params.radius = 99;
  await repeatLastFilter(apply, m => msgs.push(m));
  assert.deepEqual(calls[1], { kind: 'gaussian_blur', params: { radius: 4.5 }, label: 'Gaussian Blur' });
  assert.equal(msgs.length, 1);
});

test('a failed apply is not recorded', async () => {
  resetLastFilter();
  const ok = async () => {};
  await applyFilter(ok, { kind: 'blur.blur', params: {}, label: 'Blur' });
  await assert.rejects(applyFilter(async () => { throw new Error('There is nothing to filter here.'); }, { kind: 'stylize.solarize', params: {}, label: 'Solarize' }));
  assert.equal(lastFilter()?.kind, 'blur.blur');
});
