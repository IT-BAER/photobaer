import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { t } from '@lingui/core/macro';
import { i18n } from './i18n/index.ts';
import { client } from './client.ts';
import { flatNodes } from './layers.ts';
import { DEFAULT_SCALE } from './app/analysis.ts';
import { RULER_UNITS, type RulerUnit } from './shell/units.ts';
import { documentSizes, isRulerUnit, loadStatusInfo, RULER_UNIT_LABEL, saveStatusInfo, STATUS_INFO, STATUS_INFO_LABEL, statusInfoText, type StatusInfo } from './app/statusInfo.ts';
import type { Box, DocInfo } from './worker/types.ts';

// Status bar: the chosen document info with its Show menu, and the units selector (Units & Rulers > Rulers).
export function StatusInfoField({ doc, toolName, unit, setUnit }: { doc: DocInfo; toolName: string; unit: RulerUnit; setUnit: (u: RulerUnit) => void }) {
  const [info, setInfo] = useState<StatusInfo>(loadStatusInfo);
  const [menu, setMenu] = useState<number | null>(null);
  const [sizes, setSizes] = useState<{ key: string; version: number; sizes: [number, number] } | null>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (info !== 'sizes') return;
    let live = true;
    const { key, version } = doc;
    const extraChannels = doc.channels.length;
    const timer = setTimeout(() => {
      void client.call('layerBoxes').then((boxes: Box[]) => {
        if (live) setSizes({ key, version, sizes: documentSizes({ ...doc, extraChannels }, boxes) });
      }).catch(() => {});
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [info, doc.key, doc.version]);

  useEffect(() => {
    if (menu === null) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [menu]);

  const text = statusInfoText(info, {
    width: doc.width, height: doc.height, depth: doc.depth, resolution: doc.resolution,
    modeName: doc.docs.find(d => d.active)?.mode ?? 'RGB', profile: doc.profile?.name ?? null, unit,
    sizes: sizes?.key === doc.key ? sizes.sizes : null, scale: doc.annotations.scale ?? DEFAULT_SCALE,
    toolName, layerCount: flatNodes(doc.layers).length,
  });
  const choose = (k: StatusInfo) => { setInfo(k); saveStatusInfo(k); setMenu(null); };
  return (
    <>
      <span className="status-info">
        <span>{text}</span>
        <button ref={button} type="button" title={t`Show`} aria-label={t`Show`} aria-haspopup="menu" aria-expanded={menu !== null}
          onClick={() => setMenu(menu === null ? button.current?.getBoundingClientRect().left ?? 0 : null)}><ChevronRight size={12} /></button>
        <select aria-label={t`Units`} title={t`Units`} value={unit} onChange={e => { if (isRulerUnit(e.target.value)) setUnit(e.target.value); }}>
          {RULER_UNITS.map(u => <option key={u} value={u}>{i18n._(RULER_UNIT_LABEL[u])}</option>)}
        </select>
      </span>
      {menu !== null && (
        <>
          <div className="scrim" onClick={() => setMenu(null)} onContextMenu={e => { e.preventDefault(); setMenu(null); }} />
          <div className="menu context-menu status-menu" style={{ left: Math.max(0, Math.min(menu, innerWidth - 240)) }}>
            <ul role="menu" aria-label={t`Show`}>
              {STATUS_INFO.map(k => (
                <li key={k}><button role="menuitemradio" aria-checked={k === info} onClick={() => choose(k)}>
                  <span>{`${k === info ? '✓ ' : ''}${i18n._(STATUS_INFO_LABEL[k])}`}</span>
                </button></li>
              ))}
            </ul>
          </div>
        </>
      )}
    </>
  );
}
