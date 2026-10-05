import { useEffect, useRef, useState } from 'react';
import { CircleDashed, Copy, Droplet, Eye, EyeOff, Plus, SquareDashed, Trash2 } from 'lucide-react';
import { client } from './client.ts';
import type { DocInfo } from './engine.worker.ts';
import type { Spot } from './worker/types.ts';
import type { Active } from './LayersPanel.tsx';
import { nodeById } from './layers.ts';
import { channelThumb, COMPOSITE, inkThumb, MODE_CHANNELS, type ChannelView } from './app/channels.ts';

type Run = (label: string | null, p: () => Promise<DocInfo | null>) => Promise<void>;

interface Props {
  doc: DocInfo;
  run: Run;
  view: ChannelView;
  setView: (v: ChannelView) => void;
  setError: (e: string | null) => void;
  active: Active | null;
  setActive: (a: Active) => void;
}

const ICON = { size: 16, strokeWidth: 1.75 };
const COLORS = ['Red', 'Green', 'Blue'];
const COMPOSITE_NAME = { bitmap: 'Bitmap', duotone: 'Duotone', indexed: 'Index', cmyk: 'CMYK', lab: 'Lab', multichannel: 'Multichannel' };
// CMYK and Lab channels are computed for display; the other modes show R, G and B data.
const inkMode = (doc: DocInfo) => (doc.mode?.kind === 'cmyk' || doc.mode?.kind === 'lab' ? doc.mode.kind : null);
const THUMB = 40;
const hex = (c: readonly number[]) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as Spot['color'];
// New Spot Channel (id null) or Spot Channel Options; solidity in percent.
type SpotForm = { id: number | null; name: string; color: string; solidity: number };

type Thumb = { w: number; h: number; data: Uint8ClampedArray<ArrayBuffer> };

function ThumbCanvas({ t }: { t: Thumb | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current, ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!t || !t.w || !t.h) return;
    const src = document.createElement('canvas');
    src.width = t.w; src.height = t.h;
    src.getContext('2d')!.putImageData(new ImageData(t.data, t.w, t.h), 0, 0);
    const s = Math.min(c.width / t.w, c.height / t.h);
    ctx.drawImage(src, (c.width - t.w * s) / 2, (c.height - t.h * s) / 2, t.w * s, t.h * s);
  }, [t]);
  return <canvas ref={ref} width={48} height={THUMB} className="channel-thumb" aria-hidden="true" />;
}

const grayThumb = (m: { w: number; h: number; data: ArrayBuffer | null }): Thumb => {
  const v = new Uint8Array(m.data!), data = new Uint8ClampedArray(v.length * 4);
  for (let i = 0; i < v.length; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v[i]; data[i * 4 + 3] = 255; }
  return { w: m.w, h: m.h, data };
};

// The composite and its R/G/B channels, the active layer's mask, then the saved channels, refreshed after edits.
function useThumbs(doc: DocInfo, maskId: number | null) {
  const [thumbs, setThumbs] = useState<{ color: Thumb[]; mask?: Thumb; alpha: Map<number, Thumb> }>({ color: [], alpha: new Map() });
  const ids = doc.channels.map(c => c.id).join(',');
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      const nav = await client.call('navigatorThumb', THUMB * 2);
      const rgba = new Uint8Array(nav.data);
      const ink = inkMode(doc);
      const sep = ink ? await client.call(ink === 'cmyk' ? 'cmykSeparation' : 'labTable') : null;
      const chans = ink ? MODE_CHANNELS[ink].map((_, c) => inkThumb(rgba, ink, c, sep)) : [0, 1, 2].map(c => channelThumb(rgba, c));
      const color = [new Uint8ClampedArray(rgba), ...chans].map(data => ({ w: nav.w, h: nav.h, data }));
      let level = 0;
      while (level < 8 && Math.max(doc.width, doc.height) >> (level + 1) >= THUMB * 2) level++;
      const mask = maskId === null ? undefined : grayThumb(await client.call('layerMask', maskId, level));
      const alpha = new Map<number, Thumb>();
      for (const c of doc.channels) alpha.set(c.id, grayThumb(await client.call('channelMask', c.id, level)));
      if (alive) setThumbs({ color, mask, alpha });
    }, 150);
    return () => { alive = false; clearTimeout(t); };
  }, [doc.docId, doc.version, ids, doc.width, doc.height, doc.mode?.kind, maskId]);
  return thumbs;
}

export function ChannelsPanel({ doc, run, view, setView, setError, active, setActive }: Props) {
  const maskNode = active ? nodeById(doc.layers, active.id) : undefined;
  const masked = maskNode?.mask ? maskNode : undefined;
  const thumbs = useThumbs(doc, masked?.id ?? null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [spotForm, setSpotForm] = useState<SpotForm | null>(null);
  const spotDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (spotForm && !spotDialog.current?.open) spotDialog.current?.showModal(); }, [spotForm]);
  const saveSpot = (f: SpotForm) => {
    const spot = { color: unhex(f.color), solidity: f.solidity / 100 }, name = f.name.trim();
    if (f.id !== null) { void run(null, () => client.call('spotChannelOptions', f.id!, name || 'Spot Color', spot)); return; }
    void run(null, async () => {
      const r = await client.call('newSpotChannel', spot, name);
      setView({ ...view, alpha: [...view.alpha, r.created] });
      return r;
    });
  };
  const sel = doc.channels.find(c => c.id === view.alphaTarget)?.id ?? null;
  const colorOn = view.rgb.every(Boolean) && view.ink == null;
  const ink = inkMode(doc);
  const names: readonly string[] = doc.gray || doc.mode?.kind === 'indexed' ? [] : doc.mode?.kind === 'multichannel' ? MODE_CHANNELS.multichannel : ink ? MODE_CHANNELS[ink] : COLORS;

  const load = (id: number, mode = 'new') => run(null, () => client.call('loadSelection', id, false, mode));
  const nextName = () => {
    const names = new Set(doc.channels.map(c => c.name));
    let n = 1;
    while (names.has(`Alpha ${n}`)) n++;
    return `Alpha ${n}`;
  };
  const toggleColor = (i: number) => {
    const rgb = [...view.rgb] as ChannelView['rgb'];
    rgb[i] = !rgb[i];
    setView({ ...view, rgb });
  };
  const toggleAlpha = (id: number) => setView({ ...view, alpha: view.alpha.includes(id) ? view.alpha.filter(a => a !== id) : [...view.alpha, id] });
  const row = (key: string, name: string, on: boolean, active: boolean, thumb: Thumb | undefined, toggle: () => void, pick: () => void, extra?: { id: number; spot?: Spot | null }, keys?: string) => (
    <div key={key} role="option" aria-selected={active} className={`channel-row${active ? ' selected' : ''}`} onClick={pick}
      onDoubleClick={extra ? () => (extra.spot
        ? setSpotForm({ id: extra.id, name, color: hex(extra.spot.color), solidity: Math.round(extra.spot.solidity * 100) })
        : setRenaming({ id: extra.id, name })) : undefined}>
      <button className="channel-eye" aria-label={`${on ? 'Hide' : 'Show'} ${name}`} aria-pressed={on} onClick={e => { e.stopPropagation(); toggle(); }}>
        {on ? <Eye {...ICON} /> : <EyeOff {...ICON} />}
      </button>
      <span
        title={extra ? 'Ctrl+click to load as a selection' : undefined}
        onClick={extra ? e => { if (!e.ctrlKey && !e.metaKey) return; e.stopPropagation(); void load(extra.id, e.shiftKey ? (e.altKey ? 'intersect' : 'add') : e.altKey ? 'subtract' : 'new'); } : undefined}
      >
        <ThumbCanvas t={thumb} />
      </span>
      {extra && renaming?.id === extra.id ? (
        <input
          className="channel-rename" aria-label="Channel name" autoFocus value={renaming.name}
          onChange={e => setRenaming({ id: extra.id, name: e.target.value })}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(null); }}
          onBlur={() => {
            const n = renaming.name.trim();
            setRenaming(null);
            if (n && n !== name) void run(null, () => client.call('renameChannel', extra.id, n));
          }}
        />
      ) : <span className="channel-name">{name}</span>}
      {extra?.spot && <span className="channel-swatch" title="Spot color" style={{ background: hex(extra.spot.color) }} />}
      {keys && <span className="channel-keys">{keys}</span>}
    </div>
  );

  return (
    <div className="layers-panel channels-panel">
      <div className="panel-tabs"><span className="panel-tab">Channels</span></div>
      <div className="layers-tree" role="listbox" aria-label="Channels">
        {row('rgb', doc.mode ? COMPOSITE_NAME[doc.mode.kind] : doc.gray ? 'Gray' : 'RGB', colorOn, colorOn && !view.alpha.length && view.alphaTarget == null && active?.target !== 'mask', thumbs.color[0], () => setView({ ...view, ink: null, rgb: colorOn ? [false, false, false] : [true, true, true] }), () => { setView(COMPOSITE); if (active?.target === 'mask') setActive({ id: active.id, target: 'pixels' }); }, undefined, 'Ctrl+2')}
        {names.map((name, i) => ink
          ? row(name, name, view.ink === i, view.ink === i, thumbs.color[i + 1],
            () => setView(view.ink === i ? COMPOSITE : { rgb: [false, false, false], alpha: [], ink: i }),
            () => setView({ rgb: [false, false, false], alpha: [], ink: i }))
          : row(name, name, view.rgb[i], !colorOn && view.rgb[i] && view.rgb.filter(Boolean).length === 1, thumbs.color[i + 1],
            () => toggleColor(i),
            () => setView({ rgb: [0, 1, 2].map(j => j === i) as ChannelView['rgb'], alpha: [] }), undefined, `Ctrl+${i + 3}`))}
        {masked && row('mask', `${masked.name} Mask`, view.mask === masked.id, active?.target === 'mask', thumbs.mask,
          () => setView({ ...view, mask: view.mask === masked.id ? undefined : masked.id }),
          () => { setView({ rgb: [false, false, false], alpha: [], mask: masked.id }); setActive({ id: masked.id, target: 'mask' }); })}
        {doc.channels.map(c => row(`a${c.id}`, c.name, view.alpha.includes(c.id), c.id === sel, thumbs.alpha.get(c.id),
          () => toggleAlpha(c.id),
          () => { setView({ rgb: [false, false, false], alpha: [c.id], alphaTarget: c.id }); if (active?.target === 'mask') setActive({ id: active.id, target: 'pixels' }); }, { id: c.id, spot: c.spot }))}
      </div>
      <div className="layers-footer">
        <button aria-label="Load channel as selection" title="Load channel as selection" disabled={sel == null} onClick={() => void load(sel!)}>
          <CircleDashed {...ICON} />
        </button>
        <button
          aria-label="Save selection as channel" title="Save selection as channel"
          onClick={() => {
            if (!doc.selection) { setError('Make a selection first.'); return; }
            void run(null, () => client.call('saveSelection', nextName(), null, 'new'));
          }}
        >
          <SquareDashed {...ICON} />
        </button>
        <button aria-label="New channel" title="New channel" onClick={() => void run(null, () => client.call('newChannel'))}>
          <Plus {...ICON} />
        </button>
        <button aria-label="New spot channel" title="New spot channel" onClick={() => setSpotForm({ id: null, name: '', color: '#0099e6', solidity: 0 })}>
          <Droplet {...ICON} />
        </button>
        <button aria-label="Duplicate channel" title="Duplicate channel" disabled={sel == null} onClick={() => void run(null, () => client.call('duplicateChannel', sel!))}>
          <Copy {...ICON} />
        </button>
        <button
          aria-label="Delete channel" title="Delete channel" disabled={sel == null}
          onClick={() => {
            const id = sel!;
            setView({ ...COMPOSITE, alpha: view.alpha.filter(a => a !== id) });
            void run(null, () => client.call('deleteChannel', id));
          }}
        >
          <Trash2 {...ICON} />
        </button>
      </div>
      <dialog ref={spotDialog} aria-label={spotForm?.id == null ? 'New Spot Channel' : 'Spot Channel Options'} onClose={() => setSpotForm(null)}>
        {spotForm && (
          <form onSubmit={e => { e.preventDefault(); saveSpot(spotForm); spotDialog.current?.close(); }}>
            <h2>{spotForm.id === null ? 'New Spot Channel' : 'Spot Channel Options'}</h2>
            <label>Name <input aria-label="Name" value={spotForm.name} placeholder="Spot Color" autoFocus onChange={e => setSpotForm({ ...spotForm, name: e.target.value })} /></label>
            <label>Color <input type="color" aria-label="Color" value={spotForm.color} onChange={e => setSpotForm({ ...spotForm, color: e.target.value })} /></label>
            <label>Solidity <input type="number" aria-label="Solidity" min={0} max={100} step={1} value={spotForm.solidity}
              onChange={e => setSpotForm({ ...spotForm, solidity: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} /> %</label>
            <div className="actions">
              <button type="button" onClick={() => spotDialog.current?.close()}>Cancel</button>
              <button type="submit" className="primary">OK</button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}
