import type { ReactNode } from 'react';
import { rgbToHex, type Rgb } from './color.ts';
import { saveToolOptions, type Tool } from './tools.ts';

export type ToolOptions = Record<string, number | string | boolean>;

interface ControlProps { tool: Tool; values: ToolOptions; setValues: (v: ToolOptions) => void; option: Tool['options'][number]; fg: Rgb }

// Generic control for one option, keyed off its schema kind. Persists to the tool's localStorage
// slot on every commit, so options survive a reload without an explicit save step.
function Control({ tool, values, setValues, option: { id, kind, label, min, max, unit, choices }, fg }: ControlProps) {
  const value = values[id];
  const commit = (v: number | string | boolean) => {
    const next = { ...values, [id]: v };
    setValues(next);
    saveToolOptions(tool, next);
  };
  if (kind === 'boolean') {
    return (
      <label className="opt-bool">
        <input type="checkbox" checked={value as boolean} onChange={e => commit(e.currentTarget.checked)} />
        {label}
      </label>
    );
  }
  if (kind === 'color') {
    return (
      <label className="opt-color">
        {label}
        <input type="color" value={(value as string) || rgbToHex(fg)} onChange={e => commit(e.currentTarget.value)} />
      </label>
    );
  }
  if (kind === 'segmented') {
    return (
      <div className="opt-segmented" role="group" aria-label={label}>
        {choices?.map(c => (
          <button key={c} type="button" aria-pressed={value === c} onClick={() => commit(c)}>{c}</button>
        ))}
      </div>
    );
  }
  if (kind === 'select') {
    return (
      <label className="opt-select">
        {label}
        <select value={value as string} onChange={e => commit(e.currentTarget.value)}>
          {choices?.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
    );
  }
  return (
    <label className="opt-number">
      {label}
      <input
        type="number" min={min} max={kind === 'percent' ? 100 : max} value={value as number}
        onChange={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) commit(v); }}
      />
      {kind === 'percent' ? '%' : unit}
    </label>
  );
}

interface Props { tool: Tool; values: ToolOptions; setValues: (v: ToolOptions) => void; custom?: Record<string, ReactNode>; fg?: Rgb }

export function OptionsBar({ tool, values, setValues, custom = {}, fg = [0, 0, 0] }: Props) {
  return (
    <div className="options-bar" role="toolbar" aria-label={`${tool.label} options`}>
      <span className="options-tool-label">{tool.label}</span>
      {tool.options.map(o => (o.kind === 'custom'
        ? <span key={o.id}>{custom[o.id]}</span>
        : <Control key={o.id} tool={tool} values={values} setValues={setValues} option={o} fg={fg} />))}
    </div>
  );
}
