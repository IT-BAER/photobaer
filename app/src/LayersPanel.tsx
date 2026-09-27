import { useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
  Brush, ChevronDown, ChevronRight, CornerLeftDown, Eye, Folder, FolderPlus, Frame, Grid2x2, Link2, Lock, Move,
  PaintBucket, SquareDashed, SquarePlus, Trash2,
} from 'lucide-react';
import { client } from './client.ts';
import { BLEND_MODES, nodeById, dropTarget, type Where } from './layers.ts';
import type { DocInfo, LayerNode } from './engine.worker.ts';
import { effectRows, setEffectEnabled, type EffectKind } from './layerStyle.ts';

export type Active = { id: number; target: 'pixels' | 'mask' };
type SelectAfter = (d: DocInfo) => Active;
type Run = (label: string | null, p: () => Promise<DocInfo | null>, selectAfter?: SelectAfter) => Promise<void>;

interface Props {
  doc: DocInfo;
  active: Active;
  setActive: (a: Active) => void;
  run: Run;
  newLayer: () => void;
  newGroup: () => void;
  deleteLayer: () => void;
  deleteDisabled: boolean;
  addMask: () => void;
  openProperties: () => void;
  openLayerStyle: (id: number, page: 'blending' | { kind: EffectKind; index: number }) => void;
}

const ICON = { size: 16, strokeWidth: 1.75 };

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
  const [draft, setDraft] = useState<string | null>(null);
  const done = () => {
    const v = Math.round(Number(draft));
    setDraft(null);
    if (draft !== null && Number.isFinite(v)) commit(Math.min(100, Math.max(0, v)));
  };
  return (
    <label className="percent-field">
      {label}
      <input
        type="number" min={0} max={100} aria-label={label}
        value={draft ?? value}
        onChange={e => setDraft(e.currentTarget.value)}
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

export function LayersPanel(props: Props) {
  const { doc, active, setActive, run } = props;
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [renaming, setRenaming] = useState<number | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropHint, setDropHint] = useState<{ id: number; where: Where } | null>(null);
  // Layers whose effect rows are folded, and the layer whose fx badge is being dragged.
  const [fxFolded, setFxFolded] = useState<Set<number>>(new Set());
  const [fxDrag, setFxDrag] = useState<number | null>(null);

  const node = nodeById(doc.layers, active.id);

  function select(id: number, target: 'pixels' | 'mask') {
    setActive({ id, target });
  }

  function setProps(id: number, partial: Record<string, unknown>) {
    return run(null, () => client.call('setProps', id, partial));
  }

  function move(id: number, target: number, where: Where) {
    const t = dropTarget(doc.layers, id, target, where);
    if (t) run(null, () => client.call('moveNode', id, t.parent, t.index));
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
    const rows = style ? effectRows(style) : [];
    if (!style || !rows.length) return { badge: null, list: null };
    const open = !fxFolded.has(n.id);
    const eye = (on: boolean, label: string, toggle: () => void) => (
      <button className="visibility" aria-label={label} onClick={e => { e.stopPropagation(); toggle(); }}>{on && <Eye {...ICON} />}</button>
    );
    const badge = (
      <>
        <button
          className={`layer-fx-badge${style.enabled ? '' : ' disabled'}`} draggable aria-label={`Edit effects for ${n.name}`}
          title="Drag to move effects; Alt or Ctrl drag to copy"
          onClick={e => { e.stopPropagation(); props.openLayerStyle(n.id, 'blending'); }}
          onDragStart={e => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'copyMove'; setFxDrag(n.id); }}
          onDragEnd={() => { setFxDrag(null); setDropHint(null); }}
        >fx</button>
        <button className="disclosure" aria-label={open ? `Hide effects of ${n.name}` : `Show effects of ${n.name}`} aria-expanded={open}
          onClick={e => { e.stopPropagation(); toggleFx(n.id); }}>{open ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}</button>
      </>
    );
    const list = open && (
      <div role="group" className="layer-effects-list">
        <div className="layer-effect-row" role="treeitem" aria-level={depth + 2}>
          {eye(style.enabled, style.enabled ? `Hide effects of ${n.name}` : `Show effects of ${n.name}`,
            () => run(null, () => client.call('editLayerStyle', n.id, { ...style, enabled: !style.enabled }, style.enabled ? 'Hide Layer Effects' : 'Show Layer Effects')))}
          <span className="name">Effects</span>
        </div>
        {rows.map(r => (
          <div key={`${r.kind}.${r.index}`} className={`layer-effect-row instance${r.enabled ? '' : ' disabled'}`} role="treeitem" aria-level={depth + 3}>
            {eye(r.enabled, `${r.enabled ? 'Hide' : 'Show'} ${r.name} of ${n.name}`,
              () => run(null, () => client.call('editLayerStyle', n.id, setEffectEnabled(style, r.kind, r.index, !r.enabled), `${r.enabled ? 'Hide' : 'Show'} ${r.name}`)))}
            <button className="name" onClick={() => props.openLayerStyle(n.id, { kind: r.kind, index: r.index })}>{r.name}</button>
          </div>
        ))}
      </div>
    );
    return { badge, list };
  }

  function renderRow(n: LayerNode, depth: number, clipped: boolean): ReactNode {
    const isGroup = n.kind === 'group';
    const open = isGroup && !collapsed.has(n.id);
    const isActive = active.id === n.id;
    const hint = dropHint?.id === n.id ? dropHint.where : null;
    const locked = n.locks.transparency || n.locks.pixels || n.locks.position;
    const fx = effects(n, depth);
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
          className={`layer-row${isGroup ? ' group' : ''}${isActive ? ' active' : ''}${dragId === n.id ? ' dragging' : ''}${hint === 'into' ? ' drop-into' : ''}${n.visible ? '' : ' hidden'}`}
          draggable
          onClick={() => select(n.id, 'pixels')}
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
            aria-label={n.visible ? `Hide ${n.name}` : `Show ${n.name}`}
            onClick={e => { e.stopPropagation(); setProps(n.id, { visible: !n.visible }); }}
          >{n.visible && <Eye {...ICON} />}</button>
          {Array.from({ length: depth }, (_, i) => <span key={i} className="indent" />)}
          {clipped && <CornerLeftDown className="clip-marker" size={14} strokeWidth={1.75} aria-label="Clipped to layer below" />}
          {isGroup ? (
            <>
              <button
                className="disclosure"
                aria-label={open ? `Collapse ${n.name}` : `Expand ${n.name}`}
                onClick={e => { e.stopPropagation(); toggleCollapsed(n.id); }}
              >{open ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}</button>
              {n.artboard
                ? <Frame className="group-icon" size={18} strokeWidth={1.75} aria-label="Artboard" />
                : <Folder className="group-icon" size={18} strokeWidth={1.75} />}
            </>
          ) : n.kind === 'fill' ? (
            <PaintBucket className="fill-layer-icon" size={16} strokeWidth={1.75} aria-label="Fill layer" />
          ) : (
            <span
              className={`thumb${isActive && active.target === 'pixels' && n.mask ? ' target' : ''}`}
              onDoubleClick={n.kind === 'adjustment' ? e => { e.stopPropagation(); select(n.id, 'pixels'); props.openProperties(); } : undefined}
            />
          )}
          {n.mask && (
            <>
              <Link2 className="mask-link" size={14} strokeWidth={1.75} />
              <button
                className={`mask-chip${n.mask.enabled ? '' : ' disabled'}${isActive && active.target === 'mask' ? ' target' : ''}`}
                style={{ background: `rgb(${n.mask.default} ${n.mask.default} ${n.mask.default})` }}
                aria-label={`${n.name} mask`}
                onClick={e => { e.stopPropagation(); select(n.id, 'mask'); }}
              />
            </>
          )}
          {renaming === n.id ? (
            <input
              className="rename"
              autoFocus
              defaultValue={n.name}
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
          {locked && <Lock className="lock-badge" size={13} strokeWidth={1.75} aria-label="Locked" />}
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
      <div className="panel-tabs"><span className="panel-tab">Layers</span></div>
      {node && (
        <div className="layer-props">
          <div className="props-row">
            <select aria-label="Blend mode" value={node.blend} onChange={e => setProps(node.id, { blend: e.target.value })}>
              {node.kind === 'group' && <option value="pass through">pass through</option>}
              {BLEND_MODES.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <PercentField label="Opacity" value={Math.round(node.opacity * 100)} commit={v => setProps(node.id, { opacity: v / 100 })} />
          </div>
          <div className="props-row">
            <div className="locks">
              Lock:
              {lock('transparency', 'Lock transparency', <Grid2x2 size={14} strokeWidth={1.75} />)}
              {lock('pixels', 'Lock pixels', <Brush size={14} strokeWidth={1.75} />)}
              {lock('position', 'Lock position', <Move size={14} strokeWidth={1.75} />)}
              <button aria-label="Lock all" aria-pressed={allLocked} title="Lock all"
                onClick={() => setProps(node.id, { locks: { transparency: !allLocked, pixels: !allLocked, position: !allLocked } })}>
                <Lock size={14} strokeWidth={1.75} />
              </button>
            </div>
            {node.kind === 'pixel' && (
              <PercentField label="Fill" value={Math.round(node.fill * 100)} commit={v => setProps(node.id, { fill: v / 100 })} />
            )}
          </div>
        </div>
      )}
      <div className="layers-tree" role="tree" aria-label="Layers">
        {[...doc.layers].reverse().map(n => renderRow(n, 0, n.clipping))}
      </div>
      <div className="layers-footer">
        <button aria-label="Add layer mask" title="Add layer mask" disabled={!!node?.mask} onClick={props.addMask}><SquareDashed {...ICON} /></button>
        <button aria-label="New group" title="New group" onClick={props.newGroup}><FolderPlus {...ICON} /></button>
        <button aria-label="New layer" title="New layer" onClick={props.newLayer}><SquarePlus {...ICON} /></button>
        <button aria-label="Delete layer" title="Delete layer" disabled={props.deleteDisabled} onClick={props.deleteLayer}><Trash2 {...ICON} /></button>
      </div>
    </div>
  );
}
