import { useEffect, useRef, useState } from 'react';
import { CircleDashed, Copy, Eye, EyeOff, Plus, SquareDashed, Trash2 } from 'lucide-react';
import { client } from './client.ts';
import type { DocInfo } from './engine.worker.ts';
import { channelThumb, COMPOSITE, inkThumb, MODE_CHANNELS, type ChannelView } from './app/channels.ts';

type Run = (label: string | null, p: () => Promise<DocInfo | null>) => Promise<void>;

interface Props {
  doc: DocInfo;
  run: Run;
  view: ChannelView;
  setView: (v: ChannelView) => void;
  setError: (e: string | null) => void;
}

const ICON = { size: 16, strokeWidth: 1.75 };
const COLORS = ['Red', 'Green', 'Blue'];
const COMPOSITE_NAME = { bitmap: 'Bitmap', duotone: 'Duotone', indexed: 'Index', cmyk: 'CMYK', lab: 'Lab', multichannel: 'Multichannel' };
// CMYK and Lab channels are computed for display; the other modes show R, G and B data.
const inkMode = (doc: DocInfo) => (doc.mode?.kind === 'cmyk' || doc.mode?.kind === 'lab' ? doc.mode.kind : null);
const THUMB = 40;

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

// The composite and its R/G/B channels, then thumbnails of the saved channels, refreshed after edits.
function useThumbs(doc: DocInfo) {
  const [thumbs, setThumbs] = useState<{ color: Thumb[]; alpha: Map<number, Thumb> }>({ color: [], alpha: new Map() });
  const ids = doc.channels.map(c => c.id).join(',');
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      const nav = await client.call('navigatorThumb', THUMB * 2);
      const rgba = new Uint8Array(nav.data);
      const ink = inkMode(doc);
      const chans = ink ? MODE_CHANNELS[ink].map((_, c) => inkThumb(rgba, ink, c)) : [0, 1, 2].map(c => channelThumb(rgba, c));
      const color = [new Uint8ClampedArray(rgba), ...chans].map(data => ({ w: nav.w, h: nav.h, data }));
      let level = 0;
      while (level < 8 && Math.max(doc.width, doc.height) >> (level + 1) >= THUMB * 2) level++;
      const alpha = new Map<number, Thumb>();
      for (const c of doc.channels) {
        const m = await client.call('channelMask', c.id, level);
        const v = new Uint8Array(m.data!), data = new Uint8ClampedArray(v.length * 4);
        for (let i = 0; i < v.length; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v[i]; data[i * 4 + 3] = 255; }
        alpha.set(c.id, { w: m.w, h: m.h, data });
      }
      if (alive) setThumbs({ color, alpha });
    }, 150);
    return () => { alive = false; clearTimeout(t); };
  }, [doc.docId, doc.version, ids, doc.width, doc.height, doc.mode?.kind]);
  return thumbs;
}

export function ChannelsPanel({ doc, run, view, setView, setError }: Props) {
  const thumbs = useThumbs(doc);
  const [selected, setSelected] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const sel = doc.channels.some(c => c.id === selected) ? selected : null;
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
  const row = (key: string, name: string, on: boolean, active: boolean, thumb: Thumb | undefined, toggle: () => void, pick: () => void, extra?: { id: number }, keys?: string) => (
    <div key={key} role="option" aria-selected={active} className={`channel-row${active ? ' selected' : ''}`} onClick={pick}
      onDoubleClick={extra ? () => setRenaming({ id: extra.id, name }) : undefined}>
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
      {keys && <span className="channel-keys">{keys}</span>}
    </div>
  );

  return (
    <div className="layers-panel channels-panel">
      <div className="panel-tabs"><span className="panel-tab">Channels</span></div>
      <div className="layers-tree" role="listbox" aria-label="Channels">
        {row('rgb', doc.mode ? COMPOSITE_NAME[doc.mode.kind] : doc.gray ? 'Gray' : 'RGB', colorOn, colorOn && !view.alpha.length, thumbs.color[0], () => setView({ ...view, ink: null, rgb: colorOn ? [false, false, false] : [true, true, true] }), () => { setSelected(null); setView(COMPOSITE); }, undefined, 'Ctrl+2')}
        {names.map((name, i) => ink
          ? row(name, name, view.ink === i, view.ink === i, thumbs.color[i + 1],
            () => setView(view.ink === i ? COMPOSITE : { rgb: [false, false, false], alpha: [], ink: i }),
            () => { setSelected(null); setView({ rgb: [false, false, false], alpha: [], ink: i }); })
          : row(name, name, view.rgb[i], !colorOn && view.rgb[i] && view.rgb.filter(Boolean).length === 1, thumbs.color[i + 1],
            () => toggleColor(i),
            () => { setSelected(null); setView({ rgb: [0, 1, 2].map(j => j === i) as ChannelView['rgb'], alpha: [] }); }, undefined, `Ctrl+${i + 3}`))}
        {doc.channels.map(c => row(`a${c.id}`, c.name, view.alpha.includes(c.id), c.id === sel, thumbs.alpha.get(c.id),
          () => toggleAlpha(c.id),
          () => { setSelected(c.id); setView({ rgb: [false, false, false], alpha: [c.id] }); }, { id: c.id }))}
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
        <button aria-label="Duplicate channel" title="Duplicate channel" disabled={sel == null} onClick={() => void run(null, () => client.call('duplicateChannel', sel!))}>
          <Copy {...ICON} />
        </button>
        <button
          aria-label="Delete channel" title="Delete channel" disabled={sel == null}
          onClick={() => {
            const id = sel!;
            setSelected(null);
            setView({ ...COMPOSITE, alpha: view.alpha.filter(a => a !== id) });
            void run(null, () => client.call('deleteChannel', id));
          }}
        >
          <Trash2 {...ICON} />
        </button>
      </div>
    </div>
  );
}
