import { useState, type DragEvent, type ReactNode } from 'react';
import { client } from './client.ts';
import { nodeById, dropTarget, type Where } from './layers.ts';
import type { DocInfo, LayerNode } from './engine.worker.ts';

export type Active = { id: number; target: 'pixels' | 'mask' };
type SelectAfter = (d: DocInfo) => Active;
type Run = (label: string | null, p: () => Promise<DocInfo | null>, selectAfter?: SelectAfter) => Promise<void>;

export const BLEND_MODES = [
  'normal', 'dissolve', 'darken', 'multiply', 'color burn', 'linear burn', 'darker color', 'lighten', 'screen',
  'color dodge', 'linear dodge', 'lighter color', 'overlay', 'soft light', 'hard light', 'vivid light',
  'linear light', 'pin light', 'hard mix', 'difference', 'exclusion', 'subtract', 'divide', 'hue', 'saturation',
  'color', 'luminosity',
];

interface Props {
  doc: DocInfo;
  active: Active;
  setActive: (a: Active) => void;
  run: Run;
  newLayer: () => void;
  newGroup: () => void;
  duplicateLayer: () => void;
  deleteLayer: () => void;
  deleteDisabled: boolean;
  addMask: () => void;
  deleteMask: () => void;
}

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

export function LayersPanel(props: Props) {
  const { doc, active, setActive, run } = props;
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [renaming, setRenaming] = useState<number | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropHint, setDropHint] = useState<{ id: number; where: Where } | null>(null);
  const [live, setLive] = useState<{ id: number; opacity?: number; fill?: number } | null>(null);

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

  function renderRow(n: LayerNode, depth: number, clipped: boolean): ReactNode {
    const isGroup = n.kind === 'group';
    const isActive = active.id === n.id;
    const dragging = dragId === n.id;
    const hint = dropHint?.id === n.id ? dropHint.where : null;
    return (
      <div key={n.id}>
        <div
          role="treeitem"
          aria-selected={isActive}
          aria-level={depth + 1}
          aria-label={n.name}
          className={`layer-row${isActive ? ' active' : ''}${dragging ? ' dragging' : ''}${clipped ? ' clipped' : ''}${hint === 'into' ? ' drop-into' : ''}`}
          style={{ paddingLeft: 8 + depth * 16 + (clipped ? 12 : 0) }}
          draggable
          onClick={() => select(n.id, 'pixels')}
          onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; setDragId(n.id); }}
          onDragEnd={() => { setDragId(null); setDropHint(null); }}
          onDragOver={e => {
            if (dragId === null || dragId === n.id) return;
            e.preventDefault();
            setDropHint({ id: n.id, where: zone(e, isGroup) });
          }}
          onDragLeave={() => setDropHint(h => (h?.id === n.id ? null : h))}
          onDrop={e => {
            e.preventDefault();
            const where = zone(e, isGroup);
            setDropHint(null);
            if (dragId !== null) move(dragId, n.id, where);
            setDragId(null);
          }}
        >
          {hint === 'above' && <div className="drop-line drop-above" />}
          {clipped && <span className="clip-marker" title="Clipped to layer below" />}
          {isGroup && (
            <button
              className="disclosure"
              aria-label={collapsed.has(n.id) ? `Expand ${n.name}` : `Collapse ${n.name}`}
              onClick={e => { e.stopPropagation(); toggleCollapsed(n.id); }}
            >{collapsed.has(n.id) ? '▸' : '▾'}</button>
          )}
          <button
            className="visibility"
            aria-label={n.visible ? `Hide ${n.name}` : `Show ${n.name}`}
            onClick={e => { e.stopPropagation(); setProps(n.id, { visible: !n.visible }); }}
          >{n.visible ? '\u{1F441}' : '\u{2014}'}</button>
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
          {n.mask && (
            <button
              className={`mask-chip${n.mask.enabled ? '' : ' disabled'}`}
              aria-label={`${n.name} mask`}
              onClick={e => { e.stopPropagation(); select(n.id, 'mask'); }}
            >M</button>
          )}
          {hint === 'below' && <div className="drop-line drop-below" />}
        </div>
        {isGroup && !collapsed.has(n.id) && n.children &&
          [...n.children].reverse().map(c => renderRow(c, depth + 1, c.clipping))}
      </div>
    );
  }

  return (
    <div className="layers-panel">
      <div className="layers-buttons">
        <button aria-label="New layer" onClick={props.newLayer}>+L</button>
        <button aria-label="New group" onClick={props.newGroup}>+G</button>
        <button aria-label="Duplicate layer" onClick={props.duplicateLayer}>⧉</button>
        <button aria-label="Add layer mask" disabled={!!node?.mask} onClick={props.addMask}>□</button>
        <button aria-label="Delete layer mask" disabled={!node?.mask} onClick={props.deleteMask}>□−</button>
        <button aria-label="Delete layer" disabled={props.deleteDisabled} onClick={props.deleteLayer}>🗑</button>
      </div>
      <div className="layers-tree" role="tree">
        {[...doc.layers].reverse().map(n => renderRow(n, 0, n.clipping))}
      </div>
      {node && (
        <div className="layer-props">
          <select
            aria-label="Blend mode"
            value={node.blend}
            onChange={e => setProps(node.id, { blend: e.target.value })}
          >
            {node.kind === 'group' && <option value="pass through">pass through</option>}
            {BLEND_MODES.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <label className="prop-range">
            Opacity
            <input
              type="range" min={0} max={100}
              aria-label="Opacity"
              value={live?.id === node.id && live.opacity !== undefined ? live.opacity : Math.round(node.opacity * 100)}
              onInput={e => setLive({ id: node.id, opacity: Number(e.currentTarget.value) })}
              onChange={e => { const v = Number(e.currentTarget.value); setProps(node.id, { opacity: v / 100 }).finally(() => setLive(null)); }}
            />
            <span>{live?.id === node.id && live.opacity !== undefined ? live.opacity : Math.round(node.opacity * 100)}%</span>
          </label>
          {node.kind === 'pixel' && (
            <label className="prop-range">
              Fill
              <input
                type="range" min={0} max={100}
                aria-label="Fill"
                value={live?.id === node.id && live.fill !== undefined ? live.fill : Math.round(node.fill * 100)}
                onInput={e => setLive({ id: node.id, fill: Number(e.currentTarget.value) })}
                onChange={e => { const v = Number(e.currentTarget.value); setProps(node.id, { fill: v / 100 }).finally(() => setLive(null)); }}
              />
              <span>{live?.id === node.id && live.fill !== undefined ? live.fill : Math.round(node.fill * 100)}%</span>
            </label>
          )}
          <div className="locks">
            <button aria-label="Lock transparency" aria-pressed={node.locks.transparency}
              onClick={() => setProps(node.id, { locks: { transparency: !node.locks.transparency } })}>T</button>
            <button aria-label="Lock pixels" aria-pressed={node.locks.pixels}
              onClick={() => setProps(node.id, { locks: { pixels: !node.locks.pixels } })}>P</button>
            <button aria-label="Lock position" aria-pressed={node.locks.position}
              onClick={() => setProps(node.id, { locks: { position: !node.locks.position } })}>+</button>
          </div>
        </div>
      )}
    </div>
  );
}
