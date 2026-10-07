import { useEffect, useRef, useState } from 'react';
import { Download, Plus, Upload } from 'lucide-react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { rgbToHex, type Rgb } from './color.ts';
import { openSwatchStore, parseAco, parseAse, writeAco, writeAse, type Swatch, type SwatchStore } from './swatches.ts';

interface Props { fg: Rgb; setFg: (rgb: Rgb) => void; setBg: (rgb: Rgb) => void }

export function SwatchesPanel({ fg, setFg, setBg }: Props) {
  const [swatches, setSwatches] = useState<Swatch[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const store = useRef<SwatchStore | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    openSwatchStore().then(async s => {
      if (!alive) return;
      store.current = s;
      setSwatches(await s.list());
    });
    return () => { alive = false; };
  }, []);

  function save(next: Swatch[]) {
    setSwatches(next);
    store.current?.save(next);
  }

  async function importFile(f: File) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const isAse = f.name.toLowerCase().endsWith('.ase');
    const { swatches: parsed, warnings } = isAse ? parseAse(bytes) : parseAco(bytes);
    save([...swatches, ...parsed]);
    setWarning(warnings.length ? warnings.join('; ') : null);
  }

  function exportFile(kind: 'aco' | 'ase') {
    const bytes = kind === 'aco' ? writeAco(swatches) : writeAse(swatches);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `swatches.${kind}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  }

  return (
    <div className="swatches-panel">
      <div className="panel-tabs"><span className="panel-tab"><Trans>Swatches</Trans></span></div>
      <div className="swatches-grid" role="list" aria-label={t`Swatches`}>
        {swatches.map((sw, i) => (
          <button
            key={i} role="listitem" className="swatch-cell" style={{ background: rgbToHex(sw.rgb) }}
            aria-label={sw.name || rgbToHex(sw.rgb)} title={sw.name || rgbToHex(sw.rgb)}
            onClick={e => { if (e.altKey) setBg(sw.rgb); else setFg(sw.rgb); }}
            onContextMenu={e => { e.preventDefault(); save(swatches.filter((_, j) => j !== i)); }}
          />
        ))}
        <button className="swatch-cell add" aria-label={t`Add foreground color`} title={t`Add foreground color`} onClick={() => save([...swatches, { name: '', rgb: fg }])}>
          <Plus size={14} strokeWidth={1.75} />
        </button>
      </div>
      <div className="swatches-footer">
        <button aria-label={t`Import swatches`} title={t`Import ACO/ASE`} onClick={() => fileInput.current?.click()}><Upload size={14} strokeWidth={1.75} /></button>
        <button aria-label={t`Export as ACO`} title={t`Export as ACO`} onClick={() => exportFile('aco')}>ACO</button>
        <button aria-label={t`Export as ASE`} title={t`Export as ASE`} onClick={() => exportFile('ase')}><Download size={14} strokeWidth={1.75} />ASE</button>
      </div>
      {warning && <p className="swatches-warning" role="status">{warning}</p>}
      <input
        ref={fileInput} type="file" hidden accept=".aco,.ase"
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importFile(f); }}
      />
    </div>
  );
}
