import { useEffect, useState, type FormEvent, type RefObject } from 'react';
import { RectangleHorizontal, RectangleVertical } from 'lucide-react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { i18n } from './i18n/index.ts';
import { formatNumber } from './i18n/numbers.ts';
import { NumberInput } from './shell/NumberInput.tsx';
import { hexToRgb, rgbToHex, type Rgb } from './shell/color.ts';
import { RULER_UNIT_LABEL } from './app/statusInfo.ts';
import {
  CATEGORIES, convertSize, depthsFor, estimateSize, loadRecent, NEW_MODES, presetPx, presetTitle, pushRecent, saveRecent, searchPresets, SIZE_UNITS, toPx,
  type NewBackground, type NewMode, type Preset, type RecentDoc, type SizeUnit,
} from './app/newDocument.ts';

export interface NewDocSpec { w: number; h: number; depth: number; fill: [number, number, number, number] | null; name: string; resolution: number; mode: NewMode }

const UNIT_SHORT: Record<SizeUnit, string> = { px: 'px', in: 'in', cm: 'cm', mm: 'mm', pt: 'pt', pica: 'pica' };
const sizeLine = (p: Preset) => {
  const w = formatNumber(p.w, 3), h = formatNumber(p.h, 3), unit = UNIT_SHORT[p.unit], ppi = formatNumber(p.ppi, 2);
  return t`${w} x ${h} ${unit} @ ${ppi} ppi`;
};
const recentPreset = (d: RecentDoc): Preset => {
  const w = formatNumber(d.w, 3), h = formatNumber(d.h, 3), unit = UNIT_SHORT[d.unit];
  return { name: t`${w} x ${h} ${unit}`, w: d.w, h: d.h, unit: d.unit, ppi: d.ppi };
};

// File > New: Photoshop's New Document dialog. Category tabs and search over blank-document presets on the
// left, Preset Details on the right; Width and Height stay in the chosen unit, so a typed 5 mm stays 5 mm.
export function NewDocumentDialog({ dialog, create, bgColor, clipboardSize }: {
  dialog: RefObject<HTMLDialogElement | null>; create: (spec: NewDocSpec) => void; bgColor: Rgb; clipboardSize(): Promise<[number, number] | null>;
}) {
  const [tab, setTab] = useState('recent');
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState(loadRecent);
  const [clip, setClip] = useState<[number, number] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [w, setW] = useState(1920);
  const [h, setH] = useState(1080);
  const [unit, setUnit] = useState<SizeUnit>('px');
  const [ppi, setPpi] = useState(72);
  const [perCm, setPerCm] = useState(false);
  const [mode, setMode] = useState<NewMode>('rgb');
  const [depth, setDepth] = useState(8);
  const [bg, setBg] = useState<NewBackground>('white');
  const [custom, setCustom] = useState('#ffffff');

  // Each opening: a fresh name, the current clipboard size and the recent list.
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const mo = new MutationObserver(() => {
      if (!d.open) return;
      setName('');
      setQuery('');
      setRecent(loadRecent());
      void clipboardSize().then(setClip).catch(() => setClip(null));
    });
    mo.observe(d, { attributes: true, attributeFilter: ['open'] });
    return () => mo.disconnect();
  }, [dialog, clipboardSize]);

  const clipPreset: Preset | null = clip ? { name: t`Clipboard`, w: clip[0], h: clip[1], unit: 'px', ppi: 72 } : null;
  const recentList = [...(clipPreset ? [clipPreset] : []), ...recent.map(recentPreset)];
  const fallback: Preset = { name: t`Default photobaer Size`, w: 1920, h: 1080, unit: 'px', ppi: 72 };
  const shown = query.trim() ? searchPresets(query)
    : tab === 'recent' ? (recentList.length ? recentList : [fallback])
      : CATEGORIES.find(c => c.id === tab)?.presets ?? [];
  const keyOf = (p: Preset) => `${presetTitle(p)}|${p.w}|${p.h}|${p.unit}|${p.ppi}`;

  const apply = (p: Preset) => {
    setPicked(keyOf(p));
    setW(p.w); setH(p.h); setUnit(p.unit); setPpi(p.ppi);
    const r = recent.find(d => d.w === p.w && d.h === p.h && d.unit === p.unit && d.ppi === p.ppi);
    if (r && tab === 'recent' && !query.trim()) { setMode(r.mode); setDepth(r.depth); }
  };
  const changeUnit = (u: SizeUnit) => {
    // The size stays the same; only the numbers change to the new unit.
    setW(convertSize(w, unit, u, ppi)); setH(convertSize(h, unit, u, ppi)); setUnit(u); setPicked(null);
  };
  const changeMode = (m: NewMode) => {
    setMode(m);
    const ok = depthsFor(m);
    if (!ok.includes(depth)) setDepth(ok.includes(8) ? 8 : ok[0]);
    if (m === 'bitmap' && bg === 'transparent') setBg('white');
  };
  const wPx = toPx(w, unit, ppi), hPx = toPx(h, unit, ppi);
  const landscape = w >= h;
  const fill = (): NewDocSpec['fill'] => {
    if (bg === 'transparent') return null;
    const rgb: Rgb = bg === 'white' ? [255, 255, 255] : bg === 'black' ? [0, 0, 0] : bg === 'background' ? bgColor : hexToRgb(custom) ?? [255, 255, 255];
    return [...rgb, 255];
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const list = pushRecent(recent, { w, h, unit, ppi, mode, depth });
    saveRecent(list);
    setRecent(list);
    dialog.current?.close();
    create({ w: wPx, h: hPx, depth: mode === 'bitmap' ? 8 : depth, fill: fill(), name: name.trim() || t`Untitled`, resolution: ppi, mode });
  };
  const size = estimateSize(wPx, hPx, mode, mode === 'bitmap' ? 8 : depth);
  const tabs: [string, string][] = [['recent', t`Recent`], ...CATEGORIES.map(c => [c.id, i18n._(c.label)] as [string, string])];

  return (
    <dialog ref={dialog} className="new-doc-dialog">
      <form onSubmit={submit}>
        <div className="new-doc-head">
          <div role="tablist" aria-label={t`Preset categories`}>
            {tabs.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={!query.trim() && tab === id} onClick={() => { setTab(id); setQuery(''); }}>{label}</button>
            ))}
          </div>
          <input type="search" aria-label={t`Find a preset`} placeholder={t`Find a preset`} value={query} onChange={e => setQuery(e.currentTarget.value)} />
        </div>
        <div className="new-doc-body">
          <section aria-label={t`Blank Document Presets`}>
            <h3>{query.trim() ? t`Search results` : t`Blank Document Presets`}</h3>
            {shown.length ? (
              <ul className="preset-grid">
                {shown.map(p => {
                  const [pw, ph] = presetPx(p), s = 34 / Math.max(pw, ph);
                  return (
                    <li key={keyOf(p)}>
                      <button type="button" aria-pressed={picked === keyOf(p)} onClick={() => apply(p)}>
                        <span className="preset-page" style={{ width: Math.max(4, pw * s), height: Math.max(4, ph * s) }} />
                        <span className="preset-title">{presetTitle(p)}</span>
                        <span className="preset-size">{sizeLine(p)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="panel-empty"><Trans>No presets match.</Trans></p>}
          </section>
          <section className="new-doc-details" aria-label={t`Preset Details`}>
            <h3><Trans>Preset Details</Trans></h3>
            <input className="new-doc-name" aria-label={t`Name`} placeholder={t`Untitled`} value={name} maxLength={255} onChange={e => setName(e.currentTarget.value)} />
            <label><Trans>Width</Trans>
              <NumberInput aria-label={t`Width`} min={0.001} step="any" max={unit === 'px' ? 65536 : undefined} value={w} onValue={v => { if (v > 0) { setW(v); setPicked(null); } }} required />
              <select aria-label={t`Units`} value={unit} onChange={e => changeUnit(e.currentTarget.value as SizeUnit)}>
                {SIZE_UNITS.map(u => <option key={u} value={u}>{i18n._(RULER_UNIT_LABEL[u])}</option>)}
              </select>
            </label>
            <label><Trans>Height</Trans>
              <NumberInput aria-label={t`Height`} min={0.001} step="any" max={unit === 'px' ? 65536 : undefined} value={h} onValue={v => { if (v > 0) { setH(v); setPicked(null); } }} required />
            </label>
            <div className="new-doc-row" role="group" aria-label={t`Orientation`}>
              <span><Trans>Orientation</Trans></span>
              <button type="button" title={t`Portrait`} aria-label={t`Portrait`} aria-pressed={!landscape} onClick={() => { if (landscape) { setW(h); setH(w); setPicked(null); } }}><RectangleVertical size={16} /></button>
              <button type="button" title={t`Landscape`} aria-label={t`Landscape`} aria-pressed={landscape} onClick={() => { if (!landscape) { setW(h); setH(w); setPicked(null); } }}><RectangleHorizontal size={16} /></button>
            </div>
            <label><Trans>Resolution</Trans>
              <NumberInput aria-label={t`Resolution`} min={0.01} step="any" max={10000} value={perCm ? Math.round(ppi / 2.54 * 1000) / 1000 : ppi}
                onValue={v => { if (v > 0) { setPpi(perCm ? v * 2.54 : v); setPicked(null); } }} required />
              <select aria-label={t`Resolution unit`} value={perCm ? 'cm' : 'in'} onChange={e => setPerCm(e.currentTarget.value === 'cm')}>
                <option value="in">{t`Pixels/Inch`}</option><option value="cm">{t`Pixels/Centimeter`}</option>
              </select>
            </label>
            <label><Trans>Color Mode</Trans>
              <select aria-label={t`Color Mode`} value={mode} onChange={e => changeMode(e.currentTarget.value as NewMode)}>
                {NEW_MODES.map(([m, label]) => <option key={m} value={m}>{i18n._(label)}</option>)}
              </select>
              <select aria-label={t`Bit depth`} value={mode === 'bitmap' ? 1 : depth} disabled={mode === 'bitmap'} onChange={e => setDepth(Number(e.currentTarget.value))}>
                {depthsFor(mode).map(d => <option key={d} value={d}>{d === 1 ? t`1 bit` : d === 8 ? t`8 bit` : d === 16 ? t`16 bit` : t`32 bit`}</option>)}
              </select>
            </label>
            <label><Trans>Background Contents</Trans>
              <select aria-label={t`Background Contents`} value={bg} onChange={e => setBg(e.currentTarget.value as NewBackground)}>
                <option value="white">{t`White`}</option><option value="black">{t`Black`}</option><option value="background">{t`Background Color`}</option>
                {mode !== 'bitmap' && <option value="transparent">{t`Transparent`}</option>}<option value="custom">{t`Custom…`}</option>
              </select>
              {bg === 'custom' && <input type="color" aria-label={t`Custom background color`} value={custom} onChange={e => setCustom(e.currentTarget.value)} />}
              {bg === 'background' && <span className="new-doc-swatch" style={{ background: rgbToHex(bgColor) }} />}
            </label>
            <p className="new-doc-size">{t`Image size: ${size} · ${wPx} x ${hPx} px`}</p>
          </section>
        </div>
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Close</Trans></button>
          <button type="submit" className="primary"><Trans>Create</Trans></button>
        </div>
      </form>
    </dialog>
  );
}
