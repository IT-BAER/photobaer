import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { client } from './client.ts';
import type { DocInfo } from './engine.worker.ts';

type Run = (label: string | null, p: () => Promise<DocInfo | null>) => Promise<void>;

interface Props {
  doc: DocInfo;
  run: Run;
}

const ICON = { size: 16, strokeWidth: 1.75 };

export function LayerCompsPanel({ doc, run }: Props) {
  const [selected, setSelected] = useState<number | null>(null);

  return (
    <div className="layers-panel">
      <div className="panel-tabs"><span className="panel-tab">Layer Comps</span></div>
      <div className="layers-tree" role="listbox" aria-label="Layer Comps">
        {doc.layerComps.map(c => (
          <div
            key={c.id}
            role="option"
            aria-selected={c.id === selected}
            className={`layer-comp-row${c.id === selected ? ' selected' : ''}`}
            onClick={() => { setSelected(c.id); void run(null, () => client.call('applyLayerComp', c.id)); }}
          >
            <span className="layer-comp-name">{c.name}</span>
            <span className="layer-comp-count">{c.layerCount}</span>
          </div>
        ))}
      </div>
      <div className="layers-footer">
        <button aria-label="New layer comp" title="New layer comp" onClick={() => void run(null, () => client.call('captureLayerComp'))}>
          <Plus {...ICON} />
        </button>
        <button
          aria-label="Delete layer comp" title="Delete layer comp" disabled={selected == null}
          onClick={() => { const id = selected!; setSelected(null); void run(null, () => client.call('deleteLayerComp', id)); }}
        >
          <Trash2 {...ICON} />
        </button>
      </div>
    </div>
  );
}
