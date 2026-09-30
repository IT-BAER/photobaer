// Window > Clone Source (docs/M5.md section 9): the 5 app-wide clone source slots and the active
// slot's offset, transform and overlay settings.
import { useSyncExternalStore } from 'react';
import { Link2, Link2Off, RotateCcw, Stamp } from 'lucide-react';
import { cloneSources, SLOT_COUNT, type CloneSlot, type OverlayMode } from './shell/retouch.ts';

const ICON = { size: 16, strokeWidth: 1.75 };
const MODES: OverlayMode[] = ['normal', 'darken', 'lighten', 'difference'];

function Num({ label, value, unit, min, max, step = 1, disabled, set }: {
  label: string; value: number; unit: string; min: number; max: number; step?: number; disabled?: boolean; set: (v: number) => void;
}) {
  return (
    <label className="clone-field">
      <span>{label}</span>
      <input type="number" aria-label={label} value={Math.round(value * 100) / 100} min={min} max={max} step={step} disabled={disabled}
        onChange={e => { const v = Number(e.currentTarget.value); if (e.currentTarget.value.trim() && Number.isFinite(v)) set(Math.max(min, Math.min(max, v))); }} />
      <span>{unit}</span>
    </label>
  );
}

export function CloneSourcePanel({ docId }: { docId: number }) {
  useSyncExternalStore(cloneSources.subscribe, cloneSources.version);
  const active = cloneSources.active, s = cloneSources.slot(), o = cloneSources.offset(s);
  const set = (patch: Partial<CloneSlot>) => cloneSources.update(active, patch);
  const scale = (k: 'scaleX' | 'scaleY', pct: number) => {
    const other = k === 'scaleX' ? 'scaleY' : 'scaleX', v = pct / 100;
    set({ [k]: v, ...(s.scaleLinked ? { [other]: Math.max(0.01, Math.min(10, s[other] * v / s[k])) } : {}) });
  };
  const check = (label: string, key: 'lockOffset' | 'flipX' | 'flipY' | 'showOverlay' | 'overlayClipped' | 'overlayAutoHide' | 'overlayInverted') => (
    <label className="clone-check"><input type="checkbox" checked={s[key]} onChange={e => set({ [key]: e.currentTarget.checked })} />{label}</label>
  );
  return (
    <div className="adjustments-panel clone-source-panel">
      <div className="panel-tabs"><span className="panel-tab">Clone Source</span></div>
      <div className="clone-slots" role="group" aria-label="Clone sources">
        {Array.from({ length: SLOT_COUNT }, (_, i) => (
          <button key={i} type="button" aria-label={`Clone source ${i + 1}`} title={`Clone source ${i + 1}`} aria-pressed={i === active}
            data-sampled={!!cloneSources.slot(i).anchor} onClick={() => cloneSources.setActive(i)}>
            <Stamp {...ICON} /><span aria-hidden>{i + 1}</span>
          </button>
        ))}
      </div>
      <p className="panel-empty">
        {s.anchor ? `Source at ${Math.round(s.anchor.x)}, ${Math.round(s.anchor.y)} px` : 'Alt-click with the Clone Stamp to set a source.'}
      </p>
      <div className="clone-row">
        <span>Offset</span>{check('Lock Offset', 'lockOffset')}
      </div>
      <div className="clone-row">
        <Num label="X" value={o.x} unit="px" min={-300000} max={300000} disabled={!s.anchor} set={v => cloneSources.setOffset('x', v, docId)} />
        <Num label="Y" value={o.y} unit="px" min={-300000} max={300000} disabled={!s.anchor} set={v => cloneSources.setOffset('y', v, docId)} />
      </div>
      <div className="clone-row">
        <Num label="W" value={s.scaleX * 100} unit="%" min={1} max={1000} set={v => scale('scaleX', v)} />
        <button type="button" aria-label={s.scaleLinked ? 'Unlink dimensions' : 'Link dimensions'} title={s.scaleLinked ? 'Unlink dimensions' : 'Link dimensions'}
          aria-pressed={s.scaleLinked} onClick={() => set({ scaleLinked: !s.scaleLinked })}>
          {s.scaleLinked ? <Link2 {...ICON} /> : <Link2Off {...ICON} />}
        </button>
        <Num label="H" value={s.scaleY * 100} unit="%" min={1} max={1000} set={v => scale('scaleY', v)} />
      </div>
      <div className="clone-row">
        <Num label="Rotation" value={s.rotation} unit="°" min={-180} max={180} step={0.1} set={v => set({ rotation: v })} />
        <button type="button" aria-label="Reset Transform" title="Reset Transform" onClick={() => cloneSources.resetTransform()}><RotateCcw {...ICON} /></button>
      </div>
      <div className="clone-row">{check('Flip horizontally', 'flipX')}{check('Flip vertically', 'flipY')}</div>
      <div className="clone-row">{check('Show Overlay', 'showOverlay')}</div>
      <fieldset className="clone-overlay" disabled={!s.showOverlay}>
        <div className="clone-row">
          <Num label="Opacity" value={s.overlayOpacity * 100} unit="%" min={0} max={100} set={v => set({ overlayOpacity: v / 100 })} />
          <select aria-label="Overlay mode" value={s.overlayMode} onChange={e => set({ overlayMode: e.currentTarget.value as OverlayMode })}>
            {MODES.map(m => <option key={m} value={m}>{m[0].toUpperCase() + m.slice(1)}</option>)}
          </select>
        </div>
        <div className="clone-row">{check('Clipped', 'overlayClipped')}{check('Auto Hide', 'overlayAutoHide')}{check('Invert', 'overlayInverted')}</div>
      </fieldset>
    </div>
  );
}
