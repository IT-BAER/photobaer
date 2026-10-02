import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VIEW, LEGACY_MAC, engineView, presetSetup, sanitizeHdr } from './proof.ts';

const CMYK = 'Coated Offset CMYK (analytic)';

test('proof presets resolve to engine setups', () => {
  const view = (id: Parameters<typeof presetSetup>[0]) => engineView({ ...DEFAULT_VIEW, setup: presetSetup(id), proofColors: true }, CMYK).setup;
  assert.deepEqual(view('workingCmyk'), {
    kind: 'device', profile: CMYK, plates: undefined, intent: 'relativeColorimetric', blackPointCompensation: true,
    preserveNumbers: false, simulatePaper: false, simulateBlackInk: false,
  });
  assert.deepEqual(view('workingCyanPlate').plates, [true, false, false, false]);
  assert.deepEqual(view('workingCmyPlate').plates, [true, true, true, false]);
  assert.equal(view('workingBlackPlate').profile, CMYK);
  assert.deepEqual([view('legacyMacintoshRgb').profile, view('legacyMacintoshRgb').preserveNumbers], [LEGACY_MAC, true]);
  assert.deepEqual([view('internetStandardRgb').profile, view('internetStandardRgb').preserveNumbers], ['sRGB IEC61966-2.1', true]);
  assert.deepEqual([view('monitorRgb').profile, view('monitorRgb').preserveNumbers], [undefined, true]);
  assert.deepEqual([view('colorBlindnessProtanopia').kind, view('colorBlindnessProtanopia').profile], ['protanopia', undefined]);
  assert.equal(view('colorBlindnessDeuteranopia').kind, 'deuteranopia');
});

test('custom setups keep their device and paper implies black ink', () => {
  const setup = { ...presetSetup('custom'), profile: 'Uncoated Offset CMYK (analytic)', simulatePaper: true };
  const s = engineView({ ...DEFAULT_VIEW, setup }, CMYK).setup;
  assert.equal(s.profile, 'Uncoated Offset CMYK (analytic)');
  assert.equal(s.simulateBlackInk, true);
  assert.equal(engineView({ ...DEFAULT_VIEW, setup: presetSetup('custom') }, CMYK).setup.profile, CMYK, 'no device yet: the working CMYK');
});

test('32-bit preview options are clamped', () => {
  assert.deepEqual(sanitizeHdr({ method: 'highlightCompression', exposure: 99, gamma: 0 }), { method: 'highlightCompression', exposure: 20, gamma: 0.1 });
  assert.deepEqual(sanitizeHdr({ exposure: Number.NaN, gamma: 50 }), { method: 'exposureAndGamma', exposure: 0, gamma: 10 });
});
