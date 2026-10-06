import { useState, type InputHTMLAttributes } from 'react';

// A controlled number field that keeps the typed text while editing: Chrome reports "" for
// partial input such as "-" or "1.", which a plain controlled field would reset. `onValue` gets
// each complete finite number; on blur the field shows `value` again.
export function NumberInput({ value, onValue, onBlur, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: number | string; onValue: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input {...rest} type="number" value={draft ?? value}
      onChange={e => {
        const s = e.currentTarget.value, v = Number(s);
        setDraft(s);
        if (s.trim() !== '' && Number.isFinite(v)) onValue(v);
      }}
      onBlur={e => { setDraft(null); onBlur?.(e); }} />
  );
}
