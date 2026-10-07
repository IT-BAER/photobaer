import { useMemo, useRef, useState } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { i18n } from './i18n/index.ts';
import { TOOLS } from './shell/tools.ts';
import type { ToolPreset, ToolPresetLibrary } from './app/toolPresets.ts';

interface Props {
  library: ToolPresetLibrary;
  currentTool: string;
  create: (name: string, includeColors: boolean) => void;
  rename: (id: string, name: string) => void;
  apply: (preset: ToolPreset) => void;
  remove: (id: string) => void;
  importJson: (json: string) => void;
  exportJson: () => string;
  onError: (message: string) => void;
}

export function ToolPresetsPanel({ library, currentTool, create, rename, apply, remove, importJson, exportJson, onError }: Props) {
  const [search, setSearch] = useState('');
  const [currentOnly, setCurrentOnly] = useState(false);
  const [name, setName] = useState('');
  const [includeColors, setIncludeColors] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => library.presets.filter(preset =>
    (!currentOnly || preset.tool === currentTool) && preset.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())),
  [library, currentOnly, currentTool, search]);
  const add = () => { create(name, includeColors); setName(''); };
  const download = () => {
    const url = URL.createObjectURL(new Blob([exportJson()], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'photobaer-tool-presets.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url));
  };
  const load = async (input: HTMLInputElement) => {
    const selected = input.files?.[0];
    input.value = '';
    if (!selected) return;
    if (selected.size > 1_000_000) { onError(t`Tool preset import is too large.`); return; }
    try { importJson(await selected.text()); }
    catch (e) { const reason = (e as Error).message; onError(t`Tool preset file could not be read: ${reason}`); }
  };
  return (
    <section className="tool-presets-panel" aria-label={t`Tool Presets`}>
      <h2><Trans>Tool Presets</Trans></h2>
      <div className="tool-preset-search">
        <input type="search" aria-label={t`Search tool presets`} placeholder={t`Search`} value={search} onChange={event => setSearch(event.currentTarget.value)} />
        <label><input type="checkbox" checked={currentOnly} onChange={event => setCurrentOnly(event.currentTarget.checked)} /> <Trans>Current tool</Trans></label>
      </div>
      <div className="tool-preset-new">
        <input aria-label={t`New tool preset name`} placeholder={t`Preset name`} maxLength={64} value={name} onChange={event => setName(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') add(); }} />
        <label><input type="checkbox" checked={includeColors} onChange={event => setIncludeColors(event.currentTarget.checked)} /> <Trans>Include Colors</Trans></label>
        <button type="button" onClick={add} disabled={!name.trim()}><Trans>New</Trans></button>
      </div>
      <ul className="tool-preset-list">
        {shown.map(preset => <li key={preset.id} onDoubleClick={() => apply(preset)}>
          {renaming === preset.id ? <input autoFocus aria-label={t`Rename tool preset`} maxLength={64} value={renameValue} onChange={event => setRenameValue(event.currentTarget.value)} onKeyDown={event => {
            if (event.key === 'Enter') { rename(preset.id, renameValue); setRenaming(null); }
            if (event.key === 'Escape') setRenaming(null);
          }} /> : <span><strong>{preset.name}</strong><small>{i18n._(TOOLS[preset.tool].label)}</small></span>}
          <span className="tool-preset-actions">
            <button type="button" onClick={() => apply(preset)}><Trans>Apply</Trans></button>
            <button type="button" onClick={() => { setRenaming(preset.id); setRenameValue(preset.name); }}><Trans>Rename</Trans></button>
            <button type="button" onClick={() => remove(preset.id)}><Trans>Delete</Trans></button>
          </span>
        </li>)}
      </ul>
      {!shown.length && <p className="panel-empty"><Trans>No tool presets.</Trans></p>}
      <div className="tool-preset-files">
        <button type="button" onClick={download}><Trans>Export JSON</Trans></button>
        <button type="button" onClick={() => file.current?.click()}><Trans>Import JSON…</Trans></button>
        <input ref={file} type="file" accept="application/json,.json" hidden onChange={event => void load(event.currentTarget)} />
      </div>
    </section>
  );
}
