import init, { Engine } from './engine-pkg/photobaer_engine.js';
import { History } from './history.ts';
import { Autosave } from './autosave.ts';
import { packProject, unpackProject, tileIds } from './project.ts';

export interface DocInfo {
  docId: number; version: number; name: string;
  width: number; height: number; depth: number; maxLevel: number;
  undoLabel: string | null; redoLabel: string | null;
}
export type AutosaveState = 'off' | 'other-tab' | 'idle' | 'saving' | 'saved' | 'error';
export type WorkerEvent = { event: 'autosave'; state: AutosaveState; detail?: string };

let eng: Engine | null = null;
let name = 'Untitled';
let docId = 0;
let version = 0;
let autosave: Autosave | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<void> | null = null;
let again = false;
let booted = false;
let lastState: AutosaveState = 'off';

const history = new History({
  snapshot: () => eng!.snapshot(),
  restore: id => eng!.restore(id),
  drop: id => eng!.drop_snapshot(id),
});

const emit = (state: AutosaveState, detail?: string) => {
  lastState = state;
  postMessage({ event: 'autosave', state, detail } satisfies WorkerEvent);
};

function info(): DocInfo | null {
  if (!eng) return null;
  return {
    docId, version, name,
    width: eng.width(), height: eng.height(), depth: eng.depth(), maxLevel: eng.max_level(),
    undoLabel: history.undoLabel, redoLabel: history.redoLabel,
  };
}

function need() {
  if (!eng) throw new Error('no document');
  return eng;
}

function adopt(e: Engine, n: string, restored = false) {
  history.clear();
  eng?.free();
  eng = e;
  name = n;
  docId++;
  version++;
  if (!restored) {
    autosave?.startDocument();
    scheduleSave(0);
  }
  return info()!;
}

function changed() {
  version++;
  scheduleSave(1000);
  return info()!;
}

function scheduleSave(ms: number) {
  if (!autosave) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (saving) { again = true; return; }
    saving = runSave().finally(() => {
      saving = null;
      if (again) { again = false; scheduleSave(0); }
    });
  }, ms);
}

async function runSave() {
  const e = eng, id = docId;
  if (!autosave || !e) return;
  emit('saving');
  // Hold a snapshot so every tile in this manifest stays readable while the async writes run.
  const snap = e.snapshot();
  const alive = () => eng === e && docId === id;
  try {
    const ok = await autosave.save(name, e.manifest(), t => e.tile_bytes(BigInt(t)), alive);
    emit(ok ? 'saved' : 'idle');
  } catch (err) {
    console.error('autosave failed', err);
    emit('error', String(err));
  } finally {
    if (alive()) e.drop_snapshot(snap);
  }
}

function loadEngine(manifest: string, tile: (id: number) => Uint8Array) {
  const e = Engine.from_manifest(manifest);
  try {
    for (const id of tileIds(manifest)) e.put_tile(BigInt(id), tile(id));
    e.finish_load();
  } catch (err) {
    e.free();
    throw err;
  }
  return e;
}

function tileLoop(w: number, h: number, fn: (tx: number, ty: number) => void) {
  for (let ty = 0; ty < Math.ceil(h / 256); ty++) for (let tx = 0; tx < Math.ceil(w / 256); tx++) fn(tx, ty);
}

const api = {
  async init() {
    // A UI hot reload calls init again; the engine and the autosave lock are already ours.
    if (booted) { emit(lastState); return info(); }
    booted = true;
    await init();
    autosave = await Autosave.open().catch(() => null);
    let restored: DocInfo | null = null;
    if (autosave) {
      try {
        const r = await autosave.load();
        if (r) {
          const tiles = new Map<number, Uint8Array>();
          for (const id of tileIds(r.manifest)) tiles.set(id, await r.tile(id));
          restored = adopt(loadEngine(r.manifest, id => tiles.get(id)!), r.name, true);
        }
      } catch (err) {
        console.error('autosave restore failed', err);
      }
      emit(restored ? 'saved' : 'idle');
    } else {
      emit('storage' in navigator && 'locks' in navigator && 'getDirectory' in navigator.storage ? 'other-tab' : 'off');
    }
    return restored;
  },

  newDoc(width: number, height: number, depth: number, bg: [number, number, number, number] | null) {
    const e = new Engine(width, height, depth);
    if (bg) e.fill(0, ...bg);
    return adopt(e, 'Untitled');
  },

  async openFile(file: File) {
    if (file.name.toLowerCase().endsWith('.pbaer')) {
      const p = await unpackProject(file);
      return adopt(loadEngine(p.manifest, id => {
        const t = p.tiles.get(id);
        if (!t) throw new Error(`project is missing tile ${id}`);
        return t;
      }), file.name.replace(/\.pbaer$/i, ''));
    }
    const bmp = await createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const e = new Engine(c.width, c.height, 8);
    tileLoop(c.width, c.height, (tx, ty) => {
      const d = ctx.getImageData(tx * 256, ty * 256, 256, 256).data;
      e.set_tile_rgba8(0, tx, ty, new Uint8Array(d.buffer, d.byteOffset, d.length));
    });
    return adopt(e, file.name.replace(/\.[^.]+$/, ''));
  },

  command(op: 'fill' | 'invert', rgba?: [number, number, number, number]) {
    const e = need();
    if (op === 'fill') history.run('Fill', () => e.fill(0, ...rgba!));
    else history.run('Invert', () => e.invert(0));
    return changed();
  },

  undo() { if (history.undo()) return changed(); return info(); },
  redo() { if (history.redo()) return changed(); return info(); },

  displayTile(level: number, tx: number, ty: number) {
    const e = need();
    const px = e.display_tile(level, tx, ty) as Uint8Array | undefined;
    return { docId, version, data: px ? px.buffer as ArrayBuffer : null };
  },

  async exportImage(type: 'image/png' | 'image/jpeg' | 'image/webp', quality?: number) {
    const e = need();
    const w = e.width(), h = e.height();
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d')!;
    tileLoop(w, h, (tx, ty) => {
      const px = e.flatten_tile_rgba8(tx, ty);
      ctx.putImageData(new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer, px.byteOffset, px.length), 256, 256), tx * 256, ty * 256);
    });
    let out = c;
    if (type === 'image/jpeg') {
      // JPEG has no alpha: flatten onto white like other editors do.
      out = new OffscreenCanvas(w, h);
      const o = out.getContext('2d')!;
      o.fillStyle = '#fff';
      o.fillRect(0, 0, w, h);
      o.drawImage(c, 0, 0);
    }
    const blob = await out.convertToBlob({ type, quality });
    if (blob.type !== type) throw new Error(`${type} export is not supported by this browser`);
    return blob;
  },

  saveProject() {
    const e = need();
    return packProject(e.manifest(), id => e.tile_bytes(BigInt(id)));
  },

  async closeDoc() {
    history.clear();
    eng?.free();
    eng = null;
    docId++;
    clearTimeout(timer);
    await saving;
    await autosave?.clear();
    if (autosave) emit('idle');
    return null;
  },
};

export type Api = typeof api;

onmessage = async (ev: MessageEvent<{ id: number; op: keyof Api; args: unknown[] }>) => {
  const { id, op, args } = ev.data;
  try {
    const result = await (api[op] as (...a: unknown[]) => unknown)(...args);
    const data = (result as { data?: unknown } | null)?.data;
    postMessage({ id, result }, { transfer: data instanceof ArrayBuffer ? [data] : [] });
  } catch (err) {
    postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
