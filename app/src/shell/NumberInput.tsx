import { useLayoutEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { t } from '@lingui/core/macro';
import { formatNumber, numberError, parseNumber, stepDecimals, stepValue } from '../i18n/numbers.ts';

// A controlled number field in a text input so the decimal separator follows the UI locale. It keeps
// the typed text while editing; `onValue` gets each complete number ("," or "." accepted); on blur the
// field shows `value` again. ArrowUp/ArrowDown step like a native number input (Shift x10).
export function NumberInput({ value, onValue, onBlur, onKeyDown, className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: number | string; onValue: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const { step, min, max } = rest;
  // At least 3 decimals: a step of 1 must not hide a fractional value (12.5 shown as 13).
  const digits = Math.max(3, stepDecimals(step));
  const shown = typeof value === 'number' ? formatNumber(value, digits) : value;
  const text = draft ?? String(shown);
  // A text input ignores min/max/step: custom validity keeps forms from submitting what native fields blocked.
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const err = numberError(text, min, max, step), lo = min === undefined ? '' : formatNumber(Number(min), digits), hi = max === undefined ? '' : formatNumber(Number(max), digits);
    ref.current?.setCustomValidity(err === 'invalid' ? t`Enter a number.`
      : err === 'range' ? (min === undefined ? t`Enter a value of at most ${hi}.` : max === undefined ? t`Enter a value of at least ${lo}.` : t`Enter a value from ${lo} to ${hi}.`)
      : err === 'step' ? t`Enter a value that fits the step of ${formatNumber(Number(step ?? 1), digits)}.` : '');
  }, [text, min, max, step, digits]);
  return (
    <input {...rest} ref={ref} type="text" inputMode="decimal" className={className ? `number-input ${className}` : 'number-input'}
      value={text}
      onChange={e => {
        const s = e.currentTarget.value, v = parseNumber(s);
        setDraft(s);
        if (v !== null) onValue(v);
      }}
      onKeyDown={e => {
        onKeyDown?.(e);
        if (e.defaultPrevented || rest.readOnly || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        const cur = (draft !== null ? parseNumber(draft) : null) ?? (typeof value === 'number' ? value : parseNumber(value)) ?? 0;
        const next = stepValue(cur, e.key === 'ArrowUp' ? 1 : -1, step, e.shiftKey, min, max);
        // Keep the stepped text: fields that commit on blur (no-op onValue) read it from the input.
        setDraft(formatNumber(next, digits));
        onValue(next);
      }}
      onBlur={e => { setDraft(null); onBlur?.(e); }} />
  );
}
