import { X } from 'lucide-react';
import type { DocInfo } from './worker/types.ts';

// One tab per open document; the active document's size and depth show in its tooltip.
export function TabBar({ doc, switchTo, close }: { doc: DocInfo; switchTo: (key: string) => void; close: (key: string) => void }) {
  return (
    <div className="tab-bar" role="tablist" aria-label="Open documents">
      {doc.docs.map(t => (
        <div key={t.key} className={`doc-tab${t.active ? ' active' : ''}`} role="tab" aria-selected={t.active} tabIndex={t.active ? 0 : -1}
          title={t.active ? `${t.name}\n${doc.width} x ${doc.height} px, ${doc.depth}-bit` : t.name}
          onClick={() => !t.active && switchTo(t.key)}
          onAuxClick={e => { if (e.button === 1) { e.preventDefault(); close(t.key); } }}
          onMouseDown={e => { if (e.button === 1) e.preventDefault(); }}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!t.active) switchTo(t.key); } }}>
          <span className="doc-tab-name">{t.name}{t.dirty ? '*' : ''}</span>
          <button type="button" className="doc-tab-close" aria-label={`Close ${t.name}`} tabIndex={-1}
            onClick={e => { e.stopPropagation(); close(t.key); }}><X size={12} aria-hidden /></button>
        </div>
      ))}
    </div>
  );
}
