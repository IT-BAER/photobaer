import { test } from 'node:test';
import assert from 'node:assert/strict';
import { i18n } from '@lingui/core';
import { formatNumber, formatPercent, numberError, numberLocale, parseNumber, stepDecimals, stepValue } from './numbers.ts';

const activate = (locale: string) => i18n.loadAndActivate({ locale, messages: {} });

test('formatNumber and formatPercent follow the active locale', () => {
  activate('en');
  assert.equal(numberLocale(), 'en');
  assert.equal(formatNumber(0.5), '0.5');
  assert.equal(formatNumber(-1234.56789), '-1234.568');
  assert.equal(formatNumber(1234.5, 0), '1235');
  assert.equal(formatNumber(NaN), 'NaN');
  assert.equal(formatNumber(Infinity), 'Infinity');
  assert.equal(formatPercent(50), '50%');
  assert.equal(formatPercent(12.345, 1), '12.3%');
  activate('de');
  assert.equal(numberLocale(), 'de');
  assert.equal(formatNumber(0.5), '0,5');
  assert.equal(formatNumber(12345.25), '12345,25');
  assert.equal(formatPercent(50), '50 %');
  activate('pseudo');
  assert.equal(numberLocale(), 'en');
  assert.equal(formatNumber(0.5), '0.5');
  activate('ja');
  assert.equal(formatNumber(1234.5), '1234.5');
  assert.equal(formatPercent(50), '50%');
  activate('en');
});

test('parseNumber accepts both separators, signs and exponents, rejects partial and grouped input', () => {
  const ok: [string, number][] = [
    ['0', 0], ['12', 12], [' 3.5 ', 3.5], ['3,5', 3.5], ['-0,25', -0.25], ['+7', 7], ['−2.5', -2.5],
    ['0,', 0], ['5.', 5], [',5', 0.5], ['.5', 0.5], ['-.5', -0.5], ['1e3', 1000], ['1,5e2', 150], ['2.5E-1', 0.25], ['-1e+2', -100],
  ];
  for (const [s, v] of ok) assert.equal(parseNumber(s), v, s);
  for (const s of ['', '  ', '-', '+', '.', ',', '-,', '1.000,5', '1,000.5', '1.2.3', '1,2,3', 'abc', '1a', '1e', '1e-', 'e3', '--1', '1 000', 'Infinity', 'NaN', '0x10'])
    assert.equal(parseNumber(s), null, s);
});

test('stepDecimals counts step decimals and stepValue moves by step with clamping', () => {
  assert.equal(stepDecimals(undefined), 3);
  assert.equal(stepDecimals('any'), 3);
  assert.equal(stepDecimals(1), 0);
  assert.equal(stepDecimals(0.01), 2);
  assert.equal(stepDecimals('0.001'), 3);
  assert.equal(stepDecimals(1e-7), 7);
  assert.equal(stepValue(5, 1, undefined, false), 6);
  assert.equal(stepValue(5, -1, 'any', true), -5);
  assert.equal(stepValue(0.1, 1, 0.01, false), 0.11);
  assert.equal(stepValue(0.1, 1, 0.1, true), 1.1);
  assert.equal(stepValue(99, 1, 1, true, 0, 100), 100);
  assert.equal(stepValue(3, -1, 1, true, 0, 100), 0);
  assert.equal(stepValue(3, 1, '2', false, '0', '10'), 5);
});

test('numberError flags what native number validation blocked: bad text, range, step grid', () => {
  assert.equal(numberError('', 1, 10, 1), null);
  assert.equal(numberError('5', 1, 10, 1), null);
  assert.equal(numberError('abc', 1, 10, 1), 'invalid');
  assert.equal(numberError('12x', undefined, undefined, undefined), 'invalid');
  assert.equal(numberError('0', 1, 10, 1), 'range');
  assert.equal(numberError('100000', 1, 30000, 1), 'range');
  assert.equal(numberError('1,5', 1, 30000, 1), 'step');
  assert.equal(numberError('0,05', 0.1, 1000, 0.1), 'range');
  assert.equal(numberError('0,3', 0.1, 1000, 0.1), null);
  assert.equal(numberError('2.5', 0.5, undefined, 1), null);
  assert.equal(numberError('2.7', 0.5, undefined, 1), 'step');
  assert.equal(numberError('1.2345', undefined, undefined, 'any'), null);
});
