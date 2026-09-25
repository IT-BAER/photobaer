import init, { Engine } from './engine-pkg/photobaer_engine.js';
import { History } from './history.ts';
import { Autosave } from './autosave.ts';
import { packProject, unpackProject, tileIds } from './project.ts';
import { importPsd, exportPsd } from './psd.ts';

export interface LayerNode {
  id: number; name: string; kind: 'pixel' | 'group';
  visible: boolean; opacity: number; fill: number; blend: string; clipping: boolean;
  locks: { transparency: boolean; pixels: boolean; position: boolean };
  mask: { enabled: boolean; default: number } | null;
  children?: LayerNode[];
}
export interface DocInfo {
  docId: number; version: number; name: string;
  width: number; height: number; depth: number; maxLevel: number;
  undoLabel: string | null; redoLabel: string | null;
  layers: LayerNode[];
  history: { labels: string[]; current: number };
}
export type OpenResult = DocInfo & { warnings: string[] };
export type AutosaveState = 'off' | 'other-tab' | 'idle' | 'saving' | 'saved' | 'error';
export type WorkerEvent = { event: 'autosave'; state: AutosaveState; detail?: string };

// A new document has one pixel layer with node id 1.
const BACKGROUND = 1;

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
    layers: JSON.parse(eng.layers_json()),
    history: { labels: history.labels, current: history.current },
  };
}

function nextName(prefix: string): string {
  const used = new Set<string>();
  const walk = (nodes: LayerNode[]) => { for (const n of nodes) { used.add(n.name); if (n.children) walk(n.children); } };
  walk(JSON.parse(need().layers_json()));
  for (let i = 1; ; i++) if (!used.has(`${prefix} ${i}`)) return `${prefix} ${i}`;
}

function propsLabel(props: Record<string, unknown>): string {
  const keys = Object.keys(props);
  if (keys.length !== 1) return 'Layer Properties';
  switch (keys[0]) {
    case 'name': return 'Rename Layer';
    case 'visible': return props.visible ? 'Show Layer' : 'Hide Layer';
    case 'opacity': return 'Opacity';
    case 'fill': return 'Fill Opacity';
    case 'blend': return 'Blend Mode';
    case 'clipping': return props.clipping ? 'Create Clipping Mask' : 'Release Clipping Mask';
    case 'locks': return 'Lock Layer';
    case 'mask_enabled': return props.mask_enabled ? 'Enable Layer Mask' : 'Disable Layer Mask';
    default: return 'Layer Properties';
  }
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

interface TileNode { id: number; tiles?: number[]; children?: TileNode[] }

function nodeTiles(e: Engine, id: number): number[] | undefined {
  const walk = (nodes: TileNode[]): number[] | undefined => {
    for (const n of nodes) {
      if (n.id === id) return n.tiles;
      const t = n.children && walk(n.children);
      if (t) return t;
    }
    return undefined;
  };
  return walk((JSON.parse(e.manifest()) as { layers: TileNode[] }).layers);
}

// A tile's raw RGBA8 bytes, or null (transparent) for a missing tile id.
function layerTile(e: Engine, ids: number[] | undefined, tx: number, ty: number): Uint8Array | null {
  const id = ids?.[ty * e.tiles_x() + tx];
  return id ? e.tile_bytes(BigInt(id)) : null;
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
    if (bg) e.fill(BACKGROUND, 'pixels', ...bg);
    return adopt(e, 'Untitled');
  },

  async openFile(file: File): Promise<OpenResult> {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.pbaer')) {
      const p = await unpackProject(file);
      return { ...adopt(loadEngine(p.manifest, id => {
        const t = p.tiles.get(id);
        if (!t) throw new Error(`project is missing tile ${id}`);
        return t;
      }), file.name.replace(/\.pbaer$/i, '')), warnings: [] };
    }
    if (lower.endsWith('.psb')) throw new Error('PSB files are not supported yet');
    if (lower.endsWith('.psd')) {
      const { engine, warnings } = importPsd(new Uint8Array(await file.arrayBuffer()));
      return { ...adopt(engine, file.name.replace(/\.psd$/i, '')), warnings };
    }
    const bmp = await createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const e = new Engine(c.width, c.height, 8);
    tileLoop(c.width, c.height, (tx, ty) => {
      const d = ctx.getImageData(tx * 256, ty * 256, 256, 256).data;
      e.set_tile_rgba8(BACKGROUND, tx, ty, new Uint8Array(d.buffer, d.byteOffset, d.length));
    });
    return { ...adopt(e, file.name.replace(/\.[^.]+$/, '')), warnings: [] };
  },

  command(op: 'fill' | 'invert', id: number, target: 'pixels' | 'mask', rgba?: [number, number, number, number]) {
    const e = need();
    if (op === 'fill') history.run('Fill', () => e.fill(id, target, ...rgba!));
    else history.run('Invert', () => e.invert(id, target));
    return changed();
  },

  addLayer(above: number, name?: string) {
    const e = need();
    let created = 0;
    history.run('New Layer', () => { created = e.add_layer(name ?? nextName('Layer'), above); });
    return { ...changed(), created };
  },

  addGroup(above: number, name?: string) {
    const e = need();
    let created = 0;
    history.run('New Group', () => { created = e.add_group(name ?? nextName('Group'), above); });
    return { ...changed(), created };
  },

  groupNodes(ids: number[]) {
    const e = need();
    let created = 0;
    history.run('Group Layers', () => { created = e.group_nodes(Uint32Array.from(ids)); });
    return { ...changed(), created };
  },

  ungroup(id: number) {
    const e = need();
    history.run('Ungroup Layers', () => e.ungroup(id));
    return changed();
  },

  deleteNode(id: number) {
    const e = need();
    history.run('Delete Layer', () => e.delete_node(id));
    return changed();
  },

  duplicateNode(id: number) {
    const e = need();
    let created = 0;
    history.run('Duplicate Layer', () => { created = e.duplicate_node(id); });
    return { ...changed(), created };
  },

  moveNode(id: number, parent: number, index: number) {
    const e = need();
    history.run('Layer Order', () => e.move_node(id, parent, index));
    return changed();
  },

  setProps(id: number, props: Partial<{
    name: string; visible: boolean; opacity: number; fill: number; blend: string; clipping: boolean;
    locks: Partial<{ transparency: boolean; pixels: boolean; position: boolean }>; mask_enabled: boolean;
  }>) {
    const e = need();
    history.run(propsLabel(props), () => e.set_props(id, JSON.stringify(props)));
    return changed();
  },

  addMask(id: number, reveal: boolean) {
    const e = need();
    history.run('Add Layer Mask', () => e.add_mask(id, reveal));
    return changed();
  },

  deleteMask(id: number) {
    const e = need();
    history.run('Delete Layer Mask', () => e.delete_mask(id));
    return changed();
  },

  // Mean RGBA over an odd-sized box centered on (x, y), clamped to the canvas; layerId null
  // samples the flattened composite of all layers, else that layer's own pixels.
  sample(x: number, y: number, size: number, layerId: number | null): [number, number, number, number] {
    const e = need();
    const half = Math.floor(size / 2);
    const cx = Math.floor(x), cy = Math.floor(y);
    const x0 = Math.max(0, cx - half), y0 = Math.max(0, cy - half);
    const x1 = Math.min(e.width(), cx + half + 1), y1 = Math.min(e.height(), cy + half + 1);
    const ids = layerId === null ? undefined : nodeTiles(e, layerId);
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
        const buf = layerId === null ? e.flatten_tile_rgba8(tx, ty) : layerTile(e, ids, tx, ty);
        if (buf) {
          const o = ((py - ty * 256) * 256 + (px - tx * 256)) * 4;
          r += buf[o]; g += buf[o + 1]; b += buf[o + 2]; a += buf[o + 3];
        }
        n++;
      }
    }
    return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round(a / n)] : [0, 0, 0, 0];
  },

  undo() { if (history.undo()) return changed(); return info(); },
  redo() { if (history.redo()) return changed(); return info(); },
  historyGoto(n: number) { need(); if (history.goto(n)) return changed(); return info(); },

  displayTile(level: number, tx: number, ty: number) {
    const e = need();
    const px = e.display_tile(level, tx, ty) as Uint8Array | undefined;
    return { docId, version, data: px ? px.buffer as ArrayBuffer : null };
  },

  // The GPU draw program for one display tile; `known` are payload keys the caller already holds.
  displayProgram(level: number, tx: number, ty: number, known: BigUint64Array) {
    const e = need();
    const bytes = e.display_program(level, tx, ty, known);
    return { docId, version, data: bytes.buffer as ArrayBuffer };
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

  savePsd(): Blob {
    const e = need();
    return new Blob([exportPsd(e)], { type: 'image/vnd.adobe.photoshop' });
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

async function handle(id: number, op: keyof Api, args: unknown[]) {
  try {
    const result = await (api[op] as (...a: unknown[]) => unknown)(...args);
    const data = (result as { data?: unknown } | null)?.data;
    postMessage({ id, result }, { transfer: data instanceof ArrayBuffer ? [data] : [] });
  } catch (err) {
    postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
}

// Calls run one at a time, so an async call (open, close, export) never interleaves with the next one.
// displayTile and displayProgram are synchronous and read-only, so they skip the queue and the
// viewer keeps drawing.
let queue = Promise.resolve();
onmessage = (ev: MessageEvent<{ id: number; op: keyof Api; args: unknown[] }>) => {
  const { id, op, args } = ev.data;
  if (op === 'displayTile' || op === 'displayProgram') void handle(id, op, args);
  else queue = queue.then(() => handle(id, op, args));
};
