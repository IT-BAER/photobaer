import { useState } from 'react';
import { PaintBucket, PenLine, Plus, Save, Shapes, Spline, SquareDashed, Trash2 } from 'lucide-react';
import { client } from './client.ts';
import type { DocInfo, LayerNode, PathRole } from './engine.worker.ts';
import { selectMode } from './shell/selecttools.ts';
import { selectCreated, type Run } from './app/helpers.ts';
import type { Rgb } from './shell/color.ts';

interface Props {
  doc: DocInfo;
  // The active layer (Fill/Stroke Path paint on it; its shape or vector mask is a fallback target).
  node: LayerNode | null;
  fg: Rgb;
  run: Run;
  // Lifted to the app: the pen and path selection tools edit the selected path. `cleared` = the
  // user cleared the selection (a click on the empty list area).
  selected: number | null;
  setSelected: (id: number | null, cleared?: boolean) => void;
}

const ICON = { size: 16, strokeWidth: 1.75 };

// The panel's target: the selected row, else the active shape layer's path, else its vector
// mask, else the work path, else the first saved path.
export function pathTarget(doc: DocInfo, node: LayerNode | null, selected: number | null): [PathRole, number] | null {
  if (selected != null && doc.paths.some(p => p.id === selected)) return ['document', selected];
  if (node?.shape) return ['shape', node.id];
  if (node?.vector_mask) return ['vectorMask', node.id];
  const p = doc.paths.find(q => q.work) ?? doc.paths[0];
  return p ? ['document', p.id] : null;
}

export function PathsPanel({ doc, node, fg, run, selected, setSelected }: Props) {
  const [renaming, setRenaming] = useState<number | null>(null);
  const target = pathTarget(doc, node, selected);
  const pixel = node?.kind === 'pixel';

  const load = (id: number, e: { shiftKey: boolean; altKey: boolean }) =>
    void run(null, () => client.call('makeSelectionFromPath', 'document', id, selectMode('new', e.shiftKey, e.altKey)));

  return (
    <div className="layers-panel">
      <div className="layers-tree" role="listbox" aria-label="Paths" onClick={e => { if (e.target === e.currentTarget) setSelected(null, true); }}>
        {doc.paths.length === 0 && <div className="panel-empty">No paths</div>}
        {doc.paths.map(p => (
          <div
            key={p.id} role="option" aria-selected={p.id === selected}
            className={`layer-comp-row path-row${p.id === selected ? ' selected' : ''}`}
            onClick={() => setSelected(p.id)}
          >
            <span
              className="path-thumb" role="button" tabIndex={0} aria-label={`Load ${p.name} as a selection`}
              title="Ctrl-click: load as selection (Shift add, Alt subtract, Shift+Alt intersect)"
              onClick={e => { if (e.ctrlKey || e.metaKey) { e.stopPropagation(); setSelected(p.id); load(p.id, e); } }}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); load(p.id, e); } }}
            />
            {renaming === p.id ? (
              <input
                className="path-name" autoFocus defaultValue={p.name} aria-label="Path name"
                onClick={e => e.stopPropagation()}
                onBlur={e => {
                  const name = e.currentTarget.value.trim();
                  setRenaming(null);
                  if (name && name !== p.name) void run(null, () => client.call('renamePath', p.id, name));
                }}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') setRenaming(null); }}
              />
            ) : (
              <span className="path-name" style={p.work ? { fontStyle: 'italic' } : undefined} title={p.name} onDoubleClick={() => setRenaming(p.id)}>
                {p.work ? 'Work Path' : p.name}
              </span>
            )}
            <span className="layer-comp-count">{p.path.subpaths.length}</span>
            {p.work && (
              <button className="path-action" aria-label="Save path" title="Save path" onClick={e => { e.stopPropagation(); void run(null, () => client.call('savePath', p.id)); }}>
                <Save {...ICON} />
              </button>
            )}
            <button
              className="path-action" aria-label="Delete path" title="Delete path"
              onClick={e => { e.stopPropagation(); if (selected === p.id) setSelected(null); void run(null, () => client.call('deletePath', p.id)); }}
            >
              <Trash2 {...ICON} />
            </button>
          </div>
        ))}
      </div>
      <div className="layers-footer">
        <button aria-label="Fill path with foreground color" title="Fill path with foreground color" disabled={!target || !pixel}
          onClick={() => void run(null, () => client.call('fillPath', ...target!, node!.id, fg))}>
          <PaintBucket {...ICON} />
        </button>
        <button aria-label="Stroke path" title="Stroke path" disabled={!target || !pixel}
          onClick={() => void run(null, () => client.call('strokePath', ...target!, node!.id, fg))}>
          <PenLine {...ICON} />
        </button>
        <button aria-label="Load path as a selection" title="Load path as a selection" disabled={!target}
          onClick={e => void run(null, () => client.call('makeSelectionFromPath', ...target!, selectMode('new', e.shiftKey, e.altKey)))}>
          <SquareDashed {...ICON} />
        </button>
        <button aria-label="Make work path from selection" title="Make work path from selection" disabled={!doc.selection}
          onClick={() => void run(null, () => client.call('makeWorkPath'))}>
          <Spline {...ICON} />
        </button>
        <button aria-label="Convert path to shape" title="Convert path to shape" disabled={!target}
          onClick={() => void run(null, () => client.call('convertPathToShape', ...target!, fg), selectCreated)}>
          <Shapes {...ICON} />
        </button>
        <button aria-label="New path" title="New path"
          onClick={() => void run(null, async () => { const r = await client.call('newPath'); setSelected(r.created); return r; })}>
          <Plus {...ICON} />
        </button>
      </div>
    </div>
  );
}
