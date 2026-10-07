// Locale-aware number display and parsing for UI fields. Stored values, scripting and client.call args
// stay plain JS numbers. Imports @lingui/core directly (not ./index.ts) so the worker may use this module.
import { i18n } from '@lingui/core';

export function numberLocale(): string {
  const l = i18n.locale;
  return !l || l === 'pseudo' ? 'en' : l;
}

const formatters = new Map<string, Intl.NumberFormat>();
function formatter(kind: 'n' | 'p', maxDecimals: number): Intl.NumberFormat {
  const locale = numberLocale(), key = `${kind}|${locale}|${maxDecimals}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: maxDecimals, ...(kind === 'p' ? { style: 'percent' } : {}) });
    formatters.set(key, f);
  }
  return f;
}

export function formatNumber(v: number, maxDecimals = 3): string {
  return Number.isFinite(v) ? formatter('n', maxDecimals).format(v) : String(v);
}

// `v` is the percent number: 50 -> "50%" (en), "50 %" (de).
export function formatPercent(v: number, maxDecimals = 0): string {
  return Number.isFinite(v) ? formatter('p', maxDecimals).format(v / 100) : String(v);
}

// One optional sign, digits with at most one "," or "." decimal separator, optional exponent.
// Grouped ("1.000,5") and partial ("-", ",", "1e") input yields null.
const NUMBER_RE = /^[+\-−]?(?:\d+[.,]?\d*|[.,]\d+)(?:[eE][+\-−]?\d+)?$/;

export function parseNumber(text: string): number | null {
  const s = text.trim();
  if (!NUMBER_RE.test(s)) return null;
  const v = Number(s.replace(',', '.').replaceAll('−', '-'));
  return Number.isFinite(v) ? v : null;
}

type Attr = number | string | undefined;
const attrNumber = (a: Attr): number | undefined => {
  if (a === undefined || a === '' || a === 'any') return undefined;
  const v = Number(a);
  return Number.isFinite(v) ? v : undefined;
};

// Decimals shown for a field with this `step`; 3 when step is "any" or absent.
export function stepDecimals(step: Attr): number {
  const v = attrNumber(step);
  if (v === undefined || v <= 0) return 3;
  const [mant, exp] = v.toExponential().split('e') as [string, string];
  const frac = mant.split('.')[1]?.length ?? 0;
  return Math.max(0, frac - Number(exp));
}

// ArrowUp/ArrowDown: move by step (1 for "any"/absent), x10 with Shift, clamped to min/max.
export function stepValue(value: number, dir: 1 | -1, step: Attr, shift: boolean, min?: Attr, max?: Attr): number {
  const s = attrNumber(step) ?? 1;
  let v = Number((value + dir * (s > 0 ? s : 1) * (shift ? 10 : 1)).toPrecision(12));
  const lo = attrNumber(min), hi = attrNumber(max);
  if (lo !== undefined && v < lo) v = lo;
  if (hi !== undefined && v > hi) v = hi;
  return v;
}

/** Why typed text fails native number validation (step grid based on min, else 0); null when valid or empty. */
export function numberError(text: string, min?: Attr, max?: Attr, step?: Attr): 'invalid' | 'range' | 'step' | null {
  if (text.trim() === '') return null;
  const v = parseNumber(text);
  if (v === null) return 'invalid';
  const lo = attrNumber(min), hi = attrNumber(max), s = step === undefined ? 1 : attrNumber(step);
  if ((lo !== undefined && v < lo) || (hi !== undefined && v > hi)) return 'range';
  if (s !== undefined && s > 0) {
    const n = (v - (lo ?? 0)) / s;
    if (Math.abs(n - Math.round(n)) > 1e-7) return 'step';
  }
  return null;
}
