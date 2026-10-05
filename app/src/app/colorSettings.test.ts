import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLOR_PRESETS, DEFAULT_COLOR_SETTINGS, matchPreset, openAction, parseColorSettings } from './colorSettings.ts';

test('open policies: keep, convert, discard and the ask cases', () => {
  const s = { ...DEFAULT_COLOR_SETTINGS, rgb: 'sRGB IEC61966-2.1' };
  assert.equal(openAction({ ...s, rgbPolicy: 'preserveEmbedded' }, 'Adobe RGB (1998)'), 'keep');
  assert.equal(openAction({ ...s, rgbPolicy: 'convertToWorking' }, 'Adobe RGB (1998)'), 'convert');
  assert.equal(openAction({ ...s, rgbPolicy: 'off' }, 'Adobe RGB (1998)'), 'discard');
  assert.equal(openAction({ ...s, rgbPolicy: 'off' }, 'sRGB IEC61966-2.1'), 'keep', 'a profile equal to the working space stays');
  assert.equal(openAction({ ...s, askWhenOpening: true }, 'Adobe RGB (1998)'), 'ask');
  assert.equal(openAction({ ...s, askWhenOpening: true }, 'sRGB IEC61966-2.1'), 'keep');
  assert.equal(openAction(s, null), 'leave');
  assert.equal(openAction({ ...s, askWhenMissing: true }, null), 'ask');
  assert.equal(openAction({ ...s, askWhenMissing: true, rgbPolicy: 'off' }, null), 'leave');
  assert.equal(openAction({ ...s, askWhenOpening: true, rgbPolicy: 'convertToWorking' }, 'Adobe RGB (1998)', false), 'convert', 'without asking, the policy decides');
  assert.equal(openAction({ ...s, askWhenMissing: true }, null, false), 'leave');
});

test('gray files follow the Gray policy and working Gray', () => {
  const s = { ...DEFAULT_COLOR_SETTINGS, gray: 'Dot Gain 20%', rgbPolicy: 'off' as const };
  assert.equal(openAction(s, 'Dot Gain 20%', true, 'gray'), 'keep');
  assert.equal(openAction({ ...s, grayPolicy: 'preserveEmbedded' }, 'Gray Gamma 2.2', true, 'gray'), 'keep');
  assert.equal(openAction({ ...s, grayPolicy: 'convertToWorking' }, 'Gray Gamma 2.2', true, 'gray'), 'convert');
  assert.equal(openAction({ ...s, grayPolicy: 'off', rgbPolicy: 'preserveEmbedded' }, 'Gray Gamma 2.2', true, 'gray'), 'discard');
  assert.equal(openAction({ ...s, askWhenOpening: true }, 'Gray Gamma 2.2', true, 'gray'), 'ask');
  assert.equal(openAction({ ...s, askWhenMissing: true }, null, true, 'gray'), 'ask', 'the Gray policy is on');
  assert.equal(openAction({ ...s, askWhenMissing: true, grayPolicy: 'off' }, null, true, 'gray'), 'leave');
});

test('stored settings are checked field by field and presets are recognized', () => {
  assert.deepEqual(parseColorSettings(null), DEFAULT_COLOR_SETTINGS);
  assert.deepEqual(parseColorSettings('{broken'), DEFAULT_COLOR_SETTINGS);
  const web = COLOR_PRESETS.find(p => p.name === 'North America Web/Internet')!;
  assert.deepEqual(parseColorSettings(JSON.stringify(web.settings)), web.settings);
  const bad = parseColorSettings(JSON.stringify({ ...web.settings, rgb: 'Nonexistent RGB', intent: 'loud', bpc: 'yes' }));
  assert.equal(bad.rgb, DEFAULT_COLOR_SETTINGS.rgb);
  assert.equal(bad.intent, DEFAULT_COLOR_SETTINGS.intent);
  assert.equal(bad.bpc, DEFAULT_COLOR_SETTINGS.bpc);
  const loaded = JSON.stringify({ ...web.settings, rgb: 'Display Q3', gray: 'Display Q3' });
  assert.equal(parseColorSettings(loaded, { rgb: ['Display Q3'] }).rgb, 'Display Q3', 'a loaded RGB profile is a working space');
  assert.equal(parseColorSettings(loaded, { rgb: ['Display Q3'] }).gray, DEFAULT_COLOR_SETTINGS.gray, 'but not as Gray');
  assert.equal(parseColorSettings(loaded).rgb, DEFAULT_COLOR_SETTINGS.rgb);
  const de = parseColorSettings(JSON.stringify({ ...web.settings, desaturateOn: true, desaturateBy: 35 }));
  assert.deepEqual([de.desaturateOn, de.desaturateBy], [true, 35]);
  assert.equal(parseColorSettings(JSON.stringify({ ...web.settings, desaturateBy: 0 })).desaturateBy, DEFAULT_COLOR_SETTINGS.desaturateBy, '1 to 100 %');
  assert.equal(matchPreset(web.settings), web.name);
  assert.equal(matchPreset({ ...web.settings, dither: !web.settings.dither }), 'Custom');
});
