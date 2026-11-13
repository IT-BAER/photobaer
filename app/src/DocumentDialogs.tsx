// Image > Duplicate and Image > Trap.
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { NumberInput } from './shell/NumberInput.tsx';
import { unitToPx } from './shell/units.ts';

export interface DuplicateHandle { open(name: string, layers: number): void }

// Photoshop's Duplicate Image: the copy's name, and Duplicate Merged Layers Only when there is more than one layer.
export function DuplicateDialog({ ref, duplicate }: { ref: Ref<DuplicateHandle>; duplicate: (name: string, mergedOnly: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState('');
  const [name, setName] = useState('');
  const [merged, setMerged] = useState(false);
  const [layers, setLayers] = useState(1);
  useImperativeHandle(ref, () => ({
    open(n, count) { setSource(n); setName(t`${n} copy`); setMerged(false); setLayers(count); dialog.current?.showModal(); },
  }));
  return (
    <dialog ref={dialog} aria-labelledby="duplicate-title">
      <form onSubmit={e => { e.preventDefault(); dialog.current?.close(); duplicate(name, merged && layers > 1); }}>
        <h2 id="duplicate-title"><Trans>Duplicate Image</Trans></h2>
        <p><Trans>Duplicate: {source}</Trans></p>
        <label><Trans>As:</Trans> <input value={name} onChange={e => setName(e.currentTarget.value)} autoFocus /></label>
        <label><input type="checkbox" checked={merged && layers > 1} disabled={layers < 2} onChange={e => setMerged(e.currentTarget.checked)} /> <Trans>Duplicate Merged Layers Only</Trans></label>
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

type TrapUnit = 'px' | 'pt' | 'mm';
// The engine's limit (engine/src/trap.rs MAX_TRAP).
const MAX_TRAP = 10;

export interface TrapHandle { open(resolution: number): void }

export function TrapDialog({ ref, trap }: { ref: Ref<TrapHandle>; trap: (px: number) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(1);
  const [unit, setUnit] = useState<TrapUnit>('px');
  const [resolution, setResolution] = useState(72);
  useImperativeHandle(ref, () => ({ open(res) { setResolution(res || 72); dialog.current?.showModal(); } }));
  const px = Math.max(1, Math.round(unitToPx(value, unit, resolution))), tooWide = px > MAX_TRAP;
  return (
    <dialog ref={dialog} aria-labelledby="trap-title">
      <form onSubmit={e => { e.preventDefault(); if (tooWide) return; dialog.current?.close(); trap(px); }}>
        <h2 id="trap-title"><Trans>Trap</Trans></h2>
        <label><Trans>Width:</Trans>
          <NumberInput min={unit === 'px' ? 1 : 0.01} max={100} step={unit === 'px' ? 1 : 0.1} value={value} onValue={v => setValue(v)} aria-label={t`Width`} />
          <select value={unit} onChange={e => setUnit(e.currentTarget.value as TrapUnit)} aria-label={t`Unit`}>
            <option value="px">{t`Pixels`}</option>
            <option value="pt">{t`Points`}</option>
            <option value="mm">{t`Millimeters`}</option>
          </select>
        </label>
        {tooWide && <p className="hint" role="alert"><Trans>The trap can be at most {MAX_TRAP} pixels wide.</Trans></p>}
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary" disabled={tooWide}><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}
