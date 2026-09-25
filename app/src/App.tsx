import { useEffect, useRef, useState, type FormEvent } from 'react';
import { client } from './client.ts';
import { Viewer } from './viewer.ts';
import { createRenderer } from './render/renderer.ts';
import { locate, nodeById } from './layers.ts';
import { LayersPanel, type Active } from './LayersPanel.tsx';
import { HistoryPanel } from './HistoryPanel.tsx';
import type { AutosaveState, DocInfo } from './engine.worker.ts';

type Rgba = [number, number, number, number];
type CreateResult = DocInfo & { created: number };
type SelectAfter = (d: DocInfo) => Active;
interface Item { label: string; keys?: string; run: () => void; off?: boolean }

// Default and undo/redo fallback: the topmost root layer, pixels target.
function fallbackActive(d: DocInfo): Active {
  return { id: d.layers.at(-1)!.id, target: 'pixels' };
}

const selectCreated: SelectAfter = d => ({ id: (d as CreateResult).created, target: 'pixels' });

// The node now at the deleted node's place in its old parent list, else the topmost root layer.
function selectAfterDelete(before: DocInfo, id: number): SelectAfter {
  const loc = locate(before.layers, id);
  return d => {
    if (loc) {
      const siblings = loc.parent === 0 ? d.layers : nodeById(d.layers, loc.parent)?.children ?? [];
      if (siblings.length) return { id: siblings[Math.min(loc.index, siblings.length - 1)].id, target: 'pixels' };
    }
    return fallbackActive(d);
  };
}

const AUTOSAVE_TEXT: Record<AutosaveState, string> = {
  off: 'Autosave unavailable in this browser',
  'other-tab': 'Autosave off: open in another tab',
  idle: 'Autosave on',
  saving: 'Saving…',
  saved: 'All changes saved locally',
  error: 'Autosave failed',
};

async function saveBlob(blob: Blob, name: string, mime: string, ext: string) {
  const picker = (window as unknown as { showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker) {
    try {
      const h = await picker({ suggestedName: name, types: [{ description: ext.toUpperCase(), accept: { [mime]: [`.${ext}`] } }] });
      const w = await (h as unknown as { createWritable(): Promise<WritableStream & { write(b: Blob): Promise<void>; close(): Promise<void> }> }).createWritable();
      await w.write(blob);
      await w.close();
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      throw e;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

const hex = (c: string): Rgba => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 255];

export function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const newDialog = useRef<HTMLDialogElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [doc, setDoc] = useState<DocInfo | null>(null);
  const [view, setView] = useState({ zoom: 1, rot: 0 });
  const [autosave, setAutosave] = useState<AutosaveState>('off');
  const [renderer, setRenderer] = useState('');
  const [busy, setBusy] = useState<string | null>('Starting…');
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [fg, setFg] = useState('#e8a23a');
  const [active, setActive] = useState<Active | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;

  function show(d: DocInfo | null, selectAfter?: SelectAfter) {
    setDoc(d);
    viewer.current?.setDoc(d);
    document.title = d ? `${d.name} - Photobaer` : 'Photobaer';
    if (!d) { setActive(null); return; }
    setActive(prev => selectAfter ? selectAfter(d) : prev && nodeById(d.layers, prev.id) ? prev : fallbackActive(d));
  }

  async function run(label: string | null, p: () => Promise<DocInfo | null>, selectAfter?: SelectAfter) {
    setMenu(null);
    if (label) setBusy(label);
    try {
      show(await p(), selectAfter);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (label) setBusy(null);
    }
  }

  async function open(f: File) {
    setMenu(null);
    setBusy(`Opening ${f.name}…`);
    try {
      const d = await client.call('openFile', f);
      show(d);
      if (d.warnings.length) setError(`Opened with warnings: ${d.warnings.join('; ')}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function savePsd() {
    setMenu(null);
    const d = docRef.current;
    if (!d) return;
    setBusy('Saving PSD…');
    try {
      await saveBlob(await client.call('savePsd'), `${d.name}.psd`, 'image/vnd.adobe.photoshop', 'psd');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function exportAs(mime: 'image/png' | 'image/jpeg' | 'image/webp', ext: string) {
    setMenu(null);
    const d = docRef.current;
    if (!d) return;
    setBusy('Exporting…');
    try {
      await saveBlob(await client.call('exportImage', mime, 0.92), `${d.name}.${ext}`, mime, ext);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function saveProject() {
    setMenu(null);
    const d = docRef.current;
    if (!d) return;
    setBusy('Saving project…');
    try {
      await saveBlob(await client.call('saveProject'), `${d.name}.pbaer`, 'application/x-photobaer', 'pbaer');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function createNew(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const bg = String(f.get('bg'));
    const fill: Rgba | null = bg === 'white' ? [255, 255, 255, 255] : bg === 'black' ? [0, 0, 0, 255] : null;
    newDialog.current?.close();
    run('Creating…', () => client.call('newDoc', Number(f.get('w')), Number(f.get('h')), Number(f.get('depth')), fill));
  }

  const has = !!doc;
  const node = doc && active ? nodeById(doc.layers, active.id) : undefined;
  const deleteDisabled = !doc || !active || (doc.layers.length === 1 && doc.layers[0].id === active.id);

  const newLayer = () => active && run('New layer', () => client.call('addLayer', active.id), selectCreated);
  const newGroup = () => active && run('New group', () => client.call('addGroup', active.id), selectCreated);
  const duplicateLayer = () => active && run('Duplicate layer', () => client.call('duplicateNode', active.id), selectCreated);
  const deleteLayer = () => doc && active && run('Delete layer', () => client.call('deleteNode', active.id), selectAfterDelete(doc, active.id));
  const groupLayers = () => active && run('Group layers', () => client.call('groupNodes', [active.id]), selectCreated);
  const ungroupLayers = () => active && run('Ungroup layers', () => client.call('ungroup', active.id));
  const toggleClipping = () => node && run(null, () => client.call('setProps', node.id, { clipping: !node.clipping }));
  const addMask = () => active && run('Add layer mask', () => client.call('addMask', active.id, true));
  const deleteMask = () => active && run('Delete layer mask', () => client.call('deleteMask', active.id));
  const toggleMaskEnabled = () => node?.mask && run(null, () => client.call('setProps', node.id, { mask_enabled: !node.mask!.enabled }));

  const menus: Record<string, Item[]> = {
    File: [
      { label: 'New…', keys: 'Alt+Ctrl+N', run: () => { setMenu(null); newDialog.current?.showModal(); } },
      { label: 'Open…', keys: 'Ctrl+O', run: () => { setMenu(null); fileInput.current?.click(); } },
      { label: 'Save project…', keys: 'Ctrl+S', run: saveProject, off: !has },
      { label: 'Save as PSD…', run: savePsd, off: !has },
      { label: 'Export PNG…', run: () => exportAs('image/png', 'png'), off: !has },
      { label: 'Export JPEG…', run: () => exportAs('image/jpeg', 'jpg'), off: !has },
      { label: 'Export WebP…', run: () => exportAs('image/webp', 'webp'), off: !has },
      { label: 'Close', run: () => run(null, () => client.call('closeDoc')), off: !has },
    ],
    Edit: [
      { label: doc?.undoLabel ? `Undo ${doc.undoLabel}` : 'Undo', keys: 'Ctrl+Z', run: () => run(null, () => client.call('undo')), off: !doc?.undoLabel },
      { label: doc?.redoLabel ? `Redo ${doc.redoLabel}` : 'Redo', keys: 'Shift+Ctrl+Z', run: () => run(null, () => client.call('redo')), off: !doc?.redoLabel },
      { label: 'Fill with foreground color', keys: 'Alt+Backspace', run: () => run('Filling…', () => client.call('command', 'fill', active!.id, active!.target, hex(fg))), off: !has },
    ],
    Layer: [
      { label: 'New Layer', run: newLayer, off: !has },
      { label: 'New Group', run: newGroup, off: !has },
      { label: 'Duplicate Layer', keys: 'Ctrl+J', run: duplicateLayer, off: !has },
      { label: 'Delete Layer', run: deleteLayer, off: deleteDisabled },
      { label: 'Group Layers', keys: 'Ctrl+G', run: groupLayers, off: !has },
      { label: 'Ungroup Layers', keys: 'Shift+Ctrl+G', run: ungroupLayers, off: !has || node?.kind !== 'group' },
      { label: node?.clipping ? 'Release Clipping Mask' : 'Create Clipping Mask', keys: 'Alt+Ctrl+G', run: toggleClipping, off: !has },
      { label: 'Add Layer Mask', run: addMask, off: !has || !!node?.mask },
      { label: 'Delete Layer Mask', run: deleteMask, off: !has || !node?.mask },
      { label: node?.mask?.enabled === false ? 'Enable Layer Mask' : 'Disable Layer Mask', run: toggleMaskEnabled, off: !has || !node?.mask },
    ],
    Image: [
      { label: 'Invert', keys: 'Ctrl+I', run: () => run('Inverting…', () => client.call('command', 'invert', active!.id, active!.target)), off: !has },
    ],
    View: [
      { label: 'Zoom in', keys: 'Ctrl++', run: () => { setMenu(null); viewer.current?.zoomBy(2); }, off: !has },
      { label: 'Zoom out', keys: 'Ctrl+-', run: () => { setMenu(null); viewer.current?.zoomBy(0.5); }, off: !has },
      { label: 'Fit on screen', keys: 'Ctrl+0', run: () => { setMenu(null); viewer.current?.fit(); }, off: !has },
      { label: '100%', keys: 'Ctrl+1', run: () => { setMenu(null); viewer.current?.actualPixels(); }, off: !has },
      { label: 'Reset rotation', keys: 'Esc', run: () => { setMenu(null); viewer.current?.resetRotation(); }, off: !has },
    ],
  };
  const menusRef = useRef(menus);
  menusRef.current = menus;

  useEffect(() => {
    let alive = true;
    client.onEvent = e => { if (e.event === 'autosave') setAutosave(e.state); };
    (async () => {
      try {
        const r = await createRenderer(canvas.current!, new URLSearchParams(location.search).get('renderer'));
        if (!alive) return;
        setRenderer(r.kind === 'webgpu' ? 'WebGPU' : 'WebGL2');
        const v = new Viewer(canvas.current!, r, (l, tx, ty) => client.call('displayTile', l, tx, ty));
        v.onView = x => setView({ zoom: x.zoom * v.dpr, rot: x.rot });
        viewer.current = v;
        (window as unknown as { photobaer: unknown }).photobaer = { viewer: v, client };
        show(await client.call('init'));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
      const lq = (window as unknown as { launchQueue?: { setConsumer(f: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
      lq?.setConsumer(async p => { if (p.files.length) open(await p.files[0].getFile()); });
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const find = (pred: (label: string) => boolean) => Object.values(menusRef.current).flat().find(i => pred(i.label));
    const trigger = (label: string, e: KeyboardEvent) => {
      const it = find(l => l.startsWith(label));
      e.preventDefault();
      if (it && !it.off) it.run();
    };
    const triggerBy = (pred: (label: string) => boolean, e: KeyboardEvent) => {
      const it = find(pred);
      e.preventDefault();
      if (it && !it.off) it.run();
    };
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest('input, select, dialog')) return;
      const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.altKey && k === 'n') trigger('New', e);
      else if (ctrl && k === 'o') trigger('Open', e);
      else if (ctrl && k === 's') trigger('Save project', e);
      else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) trigger('Redo', e);
      else if (ctrl && k === 'z') trigger('Undo', e);
      else if (ctrl && k === 'i') trigger('Invert', e);
      else if (ctrl && k === 'j') trigger('Duplicate Layer', e);
      else if (ctrl && e.altKey && k === 'g') triggerBy(l => l.endsWith('Clipping Mask'), e);
      else if (ctrl && e.shiftKey && k === 'g') trigger('Ungroup Layers', e);
      else if (ctrl && k === 'g') trigger('Group Layers', e);
      else if (ctrl && (k === '+' || k === '=')) trigger('Zoom in', e);
      else if (ctrl && k === '-') trigger('Zoom out', e);
      else if (ctrl && k === '0') trigger('Fit', e);
      else if (ctrl && k === '1') trigger('100%', e);
      else if (e.altKey && k === 'backspace') trigger('Fill', e);
      else if (k === 'escape') { setMenu(null); viewer.current?.resetRotation(); }
      else if (k === 'r' && !ctrl && viewer.current) viewer.current.rotateMode = true;
    };
    const up = (e: KeyboardEvent) => { if (e.key.toLowerCase() === 'r' && viewer.current) viewer.current.rotateMode = false; };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const f = e.dataTransfer?.files[0];
      if (f) open(f);
    };
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    addEventListener('dragover', over);
    addEventListener('drop', drop);
    return () => {
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
      removeEventListener('dragover', over);
      removeEventListener('drop', drop);
    };
  }, []);

  const deg = Math.round(((view.rot * 180) / Math.PI) % 360);
  return (
    <div className="app">
      <header className="menubar">
        <span className="brand">Photobaer</span>
        {Object.entries(menus).map(([name, items]) => (
          <div key={name} className="menu">
            <button className={menu === name ? 'open' : ''} onClick={() => setMenu(menu === name ? null : name)} onMouseEnter={() => menu && setMenu(name)}>{name}</button>
            {menu === name && (
              <ul role="menu">
                {items.map(i => (
                  <li key={i.label}>
                    <button role="menuitem" disabled={i.off} onClick={i.run}><span>{i.label}</span><kbd>{i.keys}</kbd></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        <label className="swatch" title="Foreground color">
          <input type="color" value={fg} onChange={e => setFg(e.target.value)} />
        </label>
      </header>
      {menu && <div className="scrim" onClick={() => setMenu(null)} />}
      <main className={doc ? 'workspace with-sidebar' : 'workspace'}>
        <div className="stage">
          <canvas ref={canvas} />
          {!doc && !busy && (
            <div className="welcome">
              <h1>Photobaer</h1>
              <div className="actions">
                <button onClick={() => newDialog.current?.showModal()}>New image</button>
                <button onClick={() => fileInput.current?.click()}>Open…</button>
              </div>
              <p>Or drop a PNG, JPEG, WebP, PSD or .pbaer file here.</p>
            </div>
          )}
          {busy && <div className="busy">{busy}</div>}
          {error && <div className="error" role="alert" onClick={() => setError(null)}>{error}</div>}
        </div>
        {doc && active && (
          <aside className="sidebar">
            <LayersPanel
              doc={doc} active={active} setActive={setActive} run={run}
              newLayer={newLayer} newGroup={newGroup} duplicateLayer={duplicateLayer}
              deleteLayer={deleteLayer} deleteDisabled={deleteDisabled}
              addMask={addMask} deleteMask={deleteMask}
            />
            <HistoryPanel history={doc.history} goto={n => run(null, () => client.call('historyGoto', n))} />
          </aside>
        )}
      </main>
      <footer className="status">
        <span>{doc ? `${doc.width} × ${doc.height} px, ${doc.depth}-bit` : 'No document'}</span>
        <span>{Math.round(view.zoom * 1000) / 10}%</span>
        <span>{deg ? `${deg}°` : ''}</span>
        <span className="grow">{doc ? 'Drag to pan, wheel to zoom, hold R and drag to rotate' : ''}</span>
        <span>{AUTOSAVE_TEXT[autosave]}</span>
        <span>{renderer}</span>
      </footer>
      <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,.pbaer,.psd"
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) open(f); }} />
      <dialog ref={newDialog}>
        <form onSubmit={createNew}>
          <h2>New image</h2>
          <label>Width <input name="w" type="number" min={1} max={65536} defaultValue={1920} required /> px</label>
          <label>Height <input name="h" type="number" min={1} max={65536} defaultValue={1080} required /> px</label>
          <label>Bit depth <select name="depth" defaultValue="8"><option value="8">8-bit</option><option value="16">16-bit</option></select></label>
          <label>Background <select name="bg" defaultValue="white"><option value="white">White</option><option value="black">Black</option><option value="transparent">Transparent</option></select></label>
          <div className="actions">
            <button type="button" onClick={() => newDialog.current?.close()}>Cancel</button>
            <button type="submit" className="primary">Create</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
