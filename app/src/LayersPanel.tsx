import type { MessageDescriptor } from '@lingui/core';
import { Fragment, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import {
  Brush, ChevronDown, ChevronRight, Contrast, CornerLeftDown, Eye, Folder, FolderPlus, Frame, Grid2x2, Image as ImageIcon, Link2, Lock, Move,
  PaintBucket, Package, Shapes, SquareDashed, SquarePlus, Trash2, Type as TypeIcon,
} from 'lucide-react';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { client } from './client.ts';
import { i18n } from './i18n/index.ts';
import { NumberInput } from './shell/NumberInput.tsx';
import { choiceLabel } from './i18n/choices.ts';
import { BLEND_MODES, HDR_BLEND_MODES, nodeById, dropTarget, type Where } from './layers.ts';
import type { DocInfo, LayerNode } from './engine.worker.ts';
import { EFFECT_LABEL, effectRows, setEffectEnabled, type EffectKind } from './layerStyle.ts';
import { pathData } from './app/svgcss.ts';
import { itemId, whenBackground, type Item } from './app/helpers.ts';
import { filterByName, filterIds, filterLayers, KIND_FILTERS, type KindFilter } from './app/layerFilter.ts';

export type Active = { id: number; target: 'pixels' | 'mask' };
type SelectAfter = (d: DocInfo) => Active;
type Run = (label: string | null, p: () => Promise<DocInfo | null>, selectAfter?: SelectAfter) => Promise<void>;

interface Props {
  doc: DocInfo;
  active: Active | null;
  setActive: (a: Active | null) => void;
  run: Run;
  // Every selected layer id (the active one included) and the Ctrl/Shift+click pick that sets it.
  selected: number[];
  setPicked: (ids: number[]) => void;
  contextItems: (n: LayerNode, nodes: LayerNode[]) => Item[];
  newLayer: () => void;
  newGroup: () => void;
  deleteLayer: () => void;
  deleteDisabled: boolean;
  addMask: () => void;
  openProperties: () => void;
  openLayerStyle: (id: number, page: 'blending' | { kind: EffectKind; index: number }) => void;
  // Layer > Rename Layer: each increment starts the inline rename of the active layer.
  renameTick: number;
  // Select > Find Layers: each increment turns on the name filter and focuses its field.
  findTick: number;
  // Select > Isolate Layers: only these layers (and their groups) show; null shows all.
  isolated: number[] | null;
}

const ICON = { size: 16, strokeWidth: 1.75 };
const KIND_ICONS: Record<KindFilter, ReactNode> = {
  pixel: <ImageIcon size={14} strokeWidth={1.75} />, adjustment: <Contrast size={14} strokeWidth={1.75} />, type: <TypeIcon size={14} strokeWidth={1.75} />,
  shape: <Shapes size={14} strokeWidth={1.75} />, smart: <Package size={14} strokeWidth={1.75} />,
};

// Y within a row: top quarter = above, bottom quarter = below, middle half = into for a group,
// else nearest half.
function zone(e: DragEvent, isGroup: boolean): Where {
  const r = e.currentTarget.getBoundingClientRect();
  const f = (e.clientY - r.top) / r.height;
  if (f < 0.25) return 'above';
  if (f > 0.75) return 'below';
  if (isGroup) return 'into';
  return f < 0.5 ? 'above' : 'below';
}

// A 0-100 percent field that commits on Enter or blur, so typing and arrow keys make one history step.
function PercentField({ label, value, commit }: { label: string; value: number; commit: (v: number) => void }) {
  const [draft, setDraft] = useState<number | null>(null);
  const done = () => {
    const v = Math.round(draft ?? NaN);
    setDraft(null);
    if (draft !== null && Number.isFinite(v)) commit(Math.min(100, Math.max(0, v)));
  };
  return (
    <label className="percent-field">
      {label}
      <NumberInput
        min={0} max={100} aria-label={label}
        value={draft ?? value}
        onValue={setDraft}
        onBlur={done}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); }
        }}
      />
      <span>%</span>
    </label>
  );
}

type Thumb = { id: number; key: string; w: number; h: number; data: ArrayBuffer };
const THUMB_KINDS = new Set(['pixel', 'text', 'smart', 'shape']);
let thumbWarned = false;

function thumbIds(nodes: LayerNode[], collapsed: Set<number>): number[] {
  return nodes.flatMap(n => THUMB_KINDS.has(n.kind) ? [n.id] : n.children && !collapsed.has(n.id) ? thumbIds(n.children, collapsed) : []);
}

function LayerThumb({ thumb }: { thumb: Thumb }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (ctx && thumb.data.byteLength) ctx.putImageData(new ImageData(new Uint8ClampedArray(thumb.data), thumb.w, thumb.h), 0, 0);
  }, [thumb.key]);
  return thumb.data.byteLength ? <canvas ref={ref} width={thumb.w} height={thumb.h} /> : null;
}

export function LayersPanel(props: Props) {
  const { doc, active, setActive, run } = props;
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [renaming, setRenaming] = useState<number | null>(null);
  const [filterOn, setFilterOn] = useState(false);
  const [kinds, setKinds] = useState<Set<KindFilter>>(new Set());
  const [filterBy, setFilterBy] = useState<'kind' | 'name'>('kind');
  const [nameText, setNameText] = useState('');
  const filtered = !filterOn ? doc.layers : filterBy === 'kind' ? filterLayers(doc.layers, kinds) : filterByName(doc.layers, nameText);
  const shown = props.isolated ? filterIds(filtered, props.isolated) : filtered;
  const tick = useRef(props.renameTick);
  useEffect(() => {
    if (tick.current !== props.renameTick) { tick.current = props.renameTick; if (active) setRenaming(active.id); }
  }, [props.renameTick]);
  const nameField = useRef<HTMLInputElement>(null);
  const findTick = useRef(props.findTick);
  useEffect(() => {
    if (findTick.current === props.findTick) return;
    findTick.current = props.findTick;
    setFilterBy('name');
    setFilterOn(true);
    focusFind.current = true;
  }, [props.findTick]);
  // Focuses after the render that mounts the name field (switching from the kind filter).
  const focusFind = useRef(false);
  useEffect(() => {
    if (!focusFind.current || !nameField.current) return;
    focusFind.current = false;
    nameField.current.focus();
    nameField.current.select();
  });
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropHint, setDropHint] = useState<{ id: number; where: Where } | null>(null);
  // Layers whose effect rows are folded, and the layer whose fx badge is being dragged.
  const [fxFolded, setFxFolded] = useState<Set<number>>(new Set());
  const [fxDrag, setFxDrag] = useState<number | null>(null);
  const [context, setContext] = useState<{ x: number; y: number; n: LayerNode; nodes: LayerNode[] } | null>(null);

  const [thumbs, setThumbs] = useState<Map<number, Thumb>>(new Map());
  const thumbDoc = useRef(doc.docId);

  // Best-effort, debounced so a brush stroke does not request a thumbnail per dab, and held while a Move drag lands.
  useEffect(() => {
    if (thumbDoc.current !== doc.docId) { thumbDoc.current = doc.docId; setThumbs(new Map()); }
    let live = true;
    const timer = setTimeout(() => void whenBackground().then(() => {
      if (!live) return;
      const ids = thumbIds(doc.layers, collapsed);
      if (!ids.length) return;
      client.call('layerThumbs', ids, Math.round(26 * window.devicePixelRatio)).then(list => {
        if (thumbDoc.current !== doc.docId) return;
        setThumbs(prev => {
          const next = new Map(prev);
          let changed = false;
          for (const th of list) if (prev.get(th.id)?.key !== th.key) { next.set(th.id, th); changed = true; }
          return changed ? next : prev;
        });
      }).catch(err => { if (!thumbWarned) { thumbWarned = true; console.warn('layer thumbnails unavailable', err); } });
    }), 150);
    return () => { live = false; clearTimeout(timer); };
  }, [doc.docId, doc.version, collapsed]);

  const node = active ? nodeById(doc.layers, active.id) : undefined;

  function select(id: number, target: 'pixels' | 'mask') {
    props.setPicked([]);
    setActive({ id, target });
  }

  // Rows top to bottom as drawn (collapsed groups hide their children).
  const rowOrder = (nodes: LayerNode[]): number[] =>
    [...nodes].reverse().flatMap(n => [n.id, ...(n.children && !collapsed.has(n.id) ? rowOrder(n.children) : [])]);
  // Picking a kind turns the filter on (Photoshop); the switch only pauses it.
  const toggleKind = (k: KindFilter) => {
    setKinds(s => { const next = new Set(s); if (!next.delete(k)) next.add(k); return next; });
    setFilterOn(true);
  };

  // Ctrl+click toggles a layer in the selection, Shift+click selects the rows from the active one.
  function rowClick(e: MouseEvent, id: number) {
    if (e.shiftKey && active) {
      const order = rowOrder(shown), a = order.indexOf(active.id), b = order.indexOf(id);
      props.setPicked(order.slice(Math.min(a, b), Math.max(a, b) + 1));
      setActive({ id, target: 'pixels' });
    } else if (e.ctrlKey || e.metaKey) {
      const has = props.selected.includes(id);
      const next = has ? props.selected.filter(x => x !== id) : [...props.selected, id];
      if (!next.length) return;
      props.setPicked(next);
      setActive({ id: has ? next.at(-1)! : id, target: 'pixels' });
    } else select(id, 'pixels');
  }

  function openContext(e: MouseEvent, n: LayerNode) {
    e.preventDefault();
    const inSel = props.selected.includes(n.id);
    if (!inSel) select(n.id, 'pixels');
    const nodes = inSel ? props.selected.map(id => nodeById(doc.layers, id)).filter((x): x is LayerNode => !!x) : [n];
    setContext({ x: e.clientX, y: e.clientY, n, nodes });
  }

  function setProps(id: number, partial: Record<string, unknown>) {
    return run(null, () => client.call('setProps', id, partial));
  }

  function move(id: number, target: number, where: Where) {
    const drop = dropTarget(doc.layers, id, target, where);
    if (drop) run(null, () => client.call('moveNode', id, drop.parent, drop.index));
  }

  function toggleCollapsed(id: number) {
    setCollapsed(s => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleFx(id: number) {
    setFxFolded(s => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // The fx badge, its disclosure and the effect rows (the "Effects" row's eye is the style's master switch).
  function effects(n: LayerNode, depth: number) {
    const style = n.style;
    const name = n.name;
    const rows = style ? effectRows(style) : [];
    if (!style || !rows.length) return { badge: null, list: null };
    const open = !fxFolded.has(n.id);
    const eye = (on: boolean, label: string, toggle: () => void) => (
      <button className="visibility" aria-label={label} onClick={e => { e.stopPropagation(); toggle(); }}>{on && <Eye {...ICON} />}</button>
    );
    const badge = (
      <>
        <button
          className={`layer-fx-badge${style.enabled ? '' : ' disabled'}`} draggable aria-label={t`Edit effects for ${name}`}
          title={t`Drag to move effects; Alt or Ctrl drag to copy`}
          onClick={e => { e.stopPropagation(); props.openLayerStyle(n.id, 'blending'); }}
          onDragStart={e => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'copyMove'; setFxDrag(n.id); }}
          onDragEnd={() => { setFxDrag(null); setDropHint(null); }}
        >fx</button>
        <button className="disclosure" aria-label={open ? t`Hide effects of ${name}` : t`Show effects of ${name}`} aria-expanded={open}
          onClick={e => { e.stopPropagation(); toggleFx(n.id); }}>{open ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}</button>
      </>
    );
    const list = open && (
      <div role="group" className="layer-effects-list">
        <div className="layer-effect-row" role="treeitem" aria-level={depth + 2}>
          {eye(style.enabled, style.enabled ? t`Hide effects of ${name}` : t`Show effects of ${name}`,
            () => run(null, () => client.call('editLayerStyle', n.id, { ...style, enabled: !style.enabled }, style.enabled ? 'Hide Layer Effects' : 'Show Layer Effects')))}
          <span className="name"><Trans>Effects</Trans></span>
        </div>
        {rows.map(r => {
          const effectName = r.index > 0 ? `${i18n._(EFFECT_LABEL[r.kind])} ${r.index + 1}` : i18n._(EFFECT_LABEL[r.kind]);
          return (
          <div key={`${r.kind}.${r.index}`} className={`layer-effect-row instance${r.enabled ? '' : ' disabled'}`} role="treeitem" aria-level={depth + 3}>
            {eye(r.enabled, r.enabled ? t`Hide ${effectName} of ${name}` : t`Show ${effectName} of ${name}`,
              () => run(null, () => client.call('editLayerStyle', n.id, setEffectEnabled(style, r.kind, r.index, !r.enabled), `${r.enabled ? 'Hide' : 'Show'} ${r.name}`)))}
            <button className="name" onClick={() => props.openLayerStyle(n.id, { kind: r.kind, index: r.index })}>{effectName}</button>
          </div>
          );
        })}
      </div>
    );
    return { badge, list };
  }

  function renderRow(n: LayerNode, depth: number, clipped: boolean): ReactNode {
    const isGroup = n.kind === 'group';
    const open = isGroup && !collapsed.has(n.id);
    const isActive = active?.id === n.id;
    const picked = props.selected.length > 1 && props.selected.includes(n.id);
    const hint = dropHint?.id === n.id ? dropHint.where : null;
    const locked = n.locks.transparency || n.locks.pixels || n.locks.position;
    const fx = effects(n, depth);
    const name = n.name;
    return (
      <div
        key={n.id}
        role="treeitem"
        aria-selected={isActive}
        aria-level={depth + 1}
        aria-expanded={isGroup ? open : undefined}
        aria-label={n.name}
      >
        <div
          className={`layer-row${isGroup ? ' group' : ''}${isActive || picked ? ' active' : ''}${dragId === n.id ? ' dragging' : ''}${hint === 'into' ? ' drop-into' : ''}${n.visible ? '' : ' hidden'}`}
          draggable
          onClick={e => rowClick(e, n.id)}
          onContextMenu={e => openContext(e, n)}
          onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; setDragId(n.id); }}
          onDragEnd={() => { setDragId(null); setDropHint(null); }}
          onDragOver={e => {
            if (fxDrag !== null && fxDrag !== n.id && n.kind !== 'adjustment') {
              e.preventDefault();
              e.dataTransfer.dropEffect = e.altKey || e.ctrlKey ? 'copy' : 'move';
              setDropHint({ id: n.id, where: 'into' });
              return;
            }
            if (dragId === null || dragId === n.id) return;
            e.preventDefault();
            setDropHint({ id: n.id, where: zone(e, isGroup) });
          }}
          onDragLeave={() => setDropHint(h => (h?.id === n.id ? null : h))}
          onDrop={e => {
            e.preventDefault();
            if (fxDrag !== null) {
              const from = fxDrag;
              setFxDrag(null);
              setDropHint(null);
              if (from !== n.id) run(null, () => client.call('dragLayerStyle', from, n.id, e.altKey || e.ctrlKey));
              return;
            }
            const where = zone(e, isGroup);
            setDropHint(null);
            if (dragId !== null) move(dragId, n.id, where);
            setDragId(null);
          }}
        >
          {hint === 'above' && <div className="drop-line drop-above" />}
          <button
            className="visibility"
            aria-label={n.visible ? t`Hide ${name}` : t`Show ${name}`}
            onClick={e => { e.stopPropagation(); setProps(n.id, { visible: !n.visible }); }}
          >{n.visible && <Eye {...ICON} />}</button>
          {Array.from({ length: depth }, (_, i) => <span key={i} className="indent" />)}
          {clipped && <CornerLeftDown className="clip-marker" size={14} strokeWidth={1.75} aria-label={t`Clipped to layer below`} />}
          {isGroup ? (
            <>
              <button
                className="disclosure"
                aria-label={open ? t`Collapse ${name}` : t`Expand ${name}`}
                onClick={e => { e.stopPropagation(); toggleCollapsed(n.id); }}
              >{open ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}</button>
              {n.artboard
                ? <Frame className="group-icon" size={18} strokeWidth={1.75} aria-label={t`Artboard`} />
                : <Folder className="group-icon" size={18} strokeWidth={1.75} />}
            </>
          ) : n.kind === 'fill' ? (
            <PaintBucket className="fill-layer-icon" size={16} strokeWidth={1.75} aria-label={t`Fill layer`} />
          ) : (
            <span
              className={`thumb${isActive && active?.target === 'pixels' && n.mask ? ' target' : ''}`}
              onDoubleClick={n.kind === 'adjustment' ? e => { e.stopPropagation(); select(n.id, 'pixels'); props.openProperties(); } : undefined}
            >{thumbs.get(n.id) && THUMB_KINDS.has(n.kind) && <LayerThumb thumb={thumbs.get(n.id)!} />}</span>
          )}
          {n.mask && (
            <>
              <Link2 className="mask-link" size={14} strokeWidth={1.75} />
              <button
                className={`mask-chip${n.mask.enabled ? '' : ' disabled'}${isActive && active?.target === 'mask' ? ' target' : ''}`}
                style={{ background: `rgb(${n.mask.default} ${n.mask.default} ${n.mask.default})` }}
                aria-label={t`${name} mask`}
                onClick={e => { e.stopPropagation(); select(n.id, 'mask'); }}
              />
            </>
          )}
          {n.vector_mask && (
            <button
              className={`mask-chip vector-mask-chip${n.vector_mask.enabled ? '' : ' disabled'}${n.vector_mask.inverted ? ' inverted' : ''}`}
              aria-label={t`${name} vector mask`} title={t`Ctrl+click loads the vector mask as a selection`}
              onClick={e => {
                e.stopPropagation();
                if (e.ctrlKey || e.metaKey) run(null, () => client.call('makeSelectionFromPath', 'vectorMask', n.id, 'new', 'Make Selection from Vector Mask'));
                else select(n.id, 'pixels');
              }}
            >
              <svg viewBox={`0 0 ${doc.width} ${doc.height}`} preserveAspectRatio="none" aria-hidden>
                <path d={pathData(n.vector_mask.path)} fillRule={n.vector_mask.path.fill_rule} />
              </svg>
            </button>
          )}
          {renaming === n.id ? (
            <input
              className="rename"
              autoFocus
              defaultValue={n.name}
              onFocus={e => e.currentTarget.select()}
              onClick={e => e.stopPropagation()}
              onBlur={e => { setRenaming(null); const v = e.currentTarget.value.trim(); if (v && v !== n.name) setProps(n.id, { name: v }); }}
              onKeyDown={e => {
                if (e.key === 'Enter') e.currentTarget.blur();
                else if (e.key === 'Escape') { e.currentTarget.value = n.name; setRenaming(null); }
              }}
            />
          ) : (
            <span className="name" onDoubleClick={e => { e.stopPropagation(); setRenaming(n.id); }}>{n.name}</span>
          )}
          {fx.badge}
          {locked && <Lock className="lock-badge" size={13} strokeWidth={1.75} aria-label={t`Locked`} />}
          {hint === 'below' && <div className="drop-line drop-below" />}
        </div>
        {fx.list}
        {open && n.children && n.children.length > 0 && (
          <div role="group">
            {[...n.children].reverse().map(c => renderRow(c, depth + 1, c.clipping))}
          </div>
        )}
      </div>
    );
  }

  const lock = (key: 'transparency' | 'pixels' | 'position', label: string, icon: ReactNode) => node && (
    <button aria-label={label} aria-pressed={node.locks[key]} title={label}
      onClick={() => setProps(node.id, { locks: { [key]: !node.locks[key] } })}>{icon}</button>
  );
  const allLocked = !!node && node.locks.transparency && node.locks.pixels && node.locks.position;

  return (
    <div className="layers-panel">
      <div className="panel-tabs"><span className="panel-tab"><Trans>Layers</Trans></span></div>
      {node && (
        <div className="layer-props">
          <div className="props-row">
            <select aria-label={t`Blend mode`} value={node.blend} onChange={e => setProps(node.id, { blend: e.target.value })}>
              {node.kind === 'group' && <option value="pass through">{t`Pass Through`}</option>}
              {(doc.depth === 32 ? HDR_BLEND_MODES : BLEND_MODES).map(m => <option key={m} value={m}>{choiceLabel(m)}</option>)}
              {doc.depth === 32 && node.blend !== 'pass through' && !HDR_BLEND_MODES.includes(node.blend) && <option value={node.blend}>{choiceLabel(node.blend)}</option>}
            </select>
            <PercentField label={t`Opacity`} value={Math.round(node.opacity * 100)} commit={v => setProps(node.id, { opacity: v / 100 })} />
          </div>
          <div className="props-row">
            <div className="locks">
              <Trans>Lock:</Trans>
              {lock('transparency', t`Lock transparency`, <Grid2x2 size={14} strokeWidth={1.75} />)}
              {lock('pixels', t`Lock pixels`, <Brush size={14} strokeWidth={1.75} />)}
              {lock('position', t`Lock position`, <Move size={14} strokeWidth={1.75} />)}
              <button aria-label={t`Lock all`} aria-pressed={allLocked} title={t`Lock all`}
                onClick={() => setProps(node.id, { locks: { transparency: !allLocked, pixels: !allLocked, position: !allLocked } })}>
                <Lock size={14} strokeWidth={1.75} />
              </button>
            </div>
            {node.kind === 'pixel' && (
              <PercentField label={t({ message: 'Fill', context: 'noun' })} value={Math.round(node.fill * 100)} commit={v => setProps(node.id, { fill: v / 100 })} />
            )}
          </div>
        </div>
      )}
      <div className="layer-filter" role="group" aria-label={filterBy === 'kind' ? t`Filter layers by kind` : t`Filter layers by name`}>
        <select aria-label={t`Filter type`} value={filterBy} onChange={e => setFilterBy(e.currentTarget.value as 'kind' | 'name')}>
          <option value="kind">{t({ message: 'Kind', context: 'layer filter' })}</option>
          <option value="name">{t({ message: 'Name', context: 'layer filter' })}</option>
        </select>
        {filterBy === 'kind' ? KIND_FILTERS.map(f => (
          <button key={f.kind} aria-label={i18n._(f.label)} aria-pressed={kinds.has(f.kind)} title={i18n._(f.label)} onClick={() => toggleKind(f.kind)}>{KIND_ICONS[f.kind]}</button>
        )) : (
          <input ref={nameField} type="search" aria-label={t`Filter layers by name`} value={nameText}
            onChange={e => { setNameText(e.currentTarget.value); setFilterOn(true); }} />
        )}
        <button className="layer-filter-switch" aria-label={t`Layer filter`} aria-pressed={filterOn} title={t`Turn the layer filter on or off`} onClick={() => setFilterOn(v => !v)}><Trans>Filter</Trans></button>
      </div>
      {/* A click below the last row deselects all layers (Select > Deselect Layers). */}
      <div className="layers-tree" role="tree" aria-label={t`Layers`} onClick={e => {
        const last = e.currentTarget.lastElementChild;
        if (e.target === e.currentTarget && (!last || e.clientY > last.getBoundingClientRect().bottom)) { props.setPicked([]); setActive(null); }
      }}>
        {[...shown].reverse().map(n => renderRow(n, 0, n.clipping))}
      </div>
      {context && (
        <>
          <div className="scrim" onClick={() => setContext(null)} onContextMenu={e => { e.preventDefault(); setContext(null); }} />
          <div className="menu context-menu layer-context" style={{
            // The panel sits at the right edge, so the menu opens to the left (and up in the lower half).
            right: innerWidth - context.x, ...(context.y > innerHeight / 2 ? { bottom: innerHeight - context.y } : { top: context.y }),
          }}>
            <ul role="menu" aria-label={t`Layer`}>
              {props.contextItems(context.n, context.nodes).map(i => (
                <Fragment key={itemId(i)}>
                  {i.sep && <li role="separator" className="menu-sep" />}
                  <li><button role="menuitem" disabled={i.off} onClick={() => { setContext(null); i.run(); }}><span>{i.label}</span></button></li>
                </Fragment>
              ))}
            </ul>
          </div>
        </>
      )}
      <div className="layers-footer">
        <button aria-label={t`Add layer mask`} title={t`Add layer mask`} disabled={!!node?.mask} onClick={props.addMask}><SquareDashed {...ICON} /></button>
        <button aria-label={t`New group`} title={t`New group`} onClick={props.newGroup}><FolderPlus {...ICON} /></button>
        <button aria-label={t`New layer`} title={t`New layer`} onClick={props.newLayer}><SquarePlus {...ICON} /></button>
        <button aria-label={t`Delete layer`} title={t`Delete layer`} disabled={props.deleteDisabled} onClick={props.deleteLayer}><Trash2 {...ICON} /></button>
      </div>
    </div>
  );
}
