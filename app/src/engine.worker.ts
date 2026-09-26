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
  selection: { bounds: [number, number, number, number] | null; default: number } | null;
  hasLastSelection: boolean;
  selGen: number;
  channels: { id: number; name: string }[];
}
export type SelectShape = { kind: 'rect' | 'ellipse' | 'polygon'; x?: number; y?: number; w?: number; h?: number; points?: number[] };
export type OpenResult = DocInfo & { warnings: string[] };
export type AutosaveState = 'off' | 'other-tab' | 'idle' | 'saving' | 'saved' | 'error';
export type WorkerEvent = { event: 'autosave'; state: AutosaveState; detail?: string };
export interface StrokeParams {
  rgba: [number, number, number, number]; mode: string; size: number;
  opacity?: number; flow?: number; hardness?: number; spacing?: number; angle?: number; roundness?: number;
  tip?: 'round' | 'square'; aliased?: boolean; wetEdges?: boolean; airbrush?: boolean;
  pressureSize?: boolean; pressureOpacity?: boolean;
  // UI-level flag; strokeBegin resolves it to an actual snapshot id (or omits it) before it reaches the engine.
  eraseToHistory?: boolean;
}

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
let selGen = 0;
let strokeOpen = false;

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
  const ch = JSON.parse(eng.channels_json()) as {
    selection: { default: number; bounds: [number, number, number, number] | null } | null;
    has_last_selection: boolean;
    channels: { id: number; name: string }[];
  };
  return {
    docId, version, name,
    width: eng.width(), height: eng.height(), depth: eng.depth(), maxLevel: eng.max_level(),
    undoLabel: history.undoLabel, redoLabel: history.redoLabel,
    layers: JSON.parse(eng.layers_json()),
    history: { labels: history.labels, current: history.current },
    selection: ch.selection && { bounds: ch.selection.bounds, default: ch.selection.default },
    hasLastSelection: ch.has_last_selection,
    selGen,
    channels: ch.channels,
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
  selGen++;
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

type Sparse = [number, number, number][];
interface TileNode { id: number; tiles?: Sparse; children?: TileNode[] }

function nodeTiles(e: Engine, id: number): Sparse | undefined {
  const walk = (nodes: TileNode[]): Sparse | undefined => {
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
function layerTile(e: Engine, ids: Sparse | undefined, tx: number, ty: number): Uint8Array | null {
  const id = ids?.find(t => t[0] === tx && t[1] === ty)?.[2];
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

  command(op: 'fill' | 'invert', id: number, target: 'pixels' | 'mask' | 'selection', rgba?: [number, number, number, number]) {
    const e = need();
    if (op === 'fill') history.run('Fill', () => e.fill(id, target, ...rgba!));
    else history.run('Invert', () => e.invert(id, target));
    return changed();
  },

  select(shape: SelectShape, mode: string, antialias: boolean, feather: number, label: string) {
    const e = need();
    const empty = shape.kind === 'polygon' ? (shape.points?.length ?? 0) < 6 : shape.w! < 1 || shape.h! < 1;
    if (empty) {
      if (mode !== 'new') return info();
      history.run('Deselect', () => e.deselect());
      selGen++;
      return changed();
    }
    history.run(label, () => {
      if (shape.kind === 'rect') e.select_rect(shape.x!, shape.y!, shape.w!, shape.h!, mode);
      else if (shape.kind === 'ellipse') e.select_ellipse(shape.x!, shape.y!, shape.w!, shape.h!, antialias, mode);
      else e.select_polygon(Float64Array.from(shape.points!), antialias, mode);
      if (feather > 0 && e.has_selection()) e.feather_selection(feather);
    });
    selGen++;
    return changed();
  },

  selectCommand(op: 'all' | 'deselect' | 'reselect' | 'inverse' | 'feather', radius?: number) {
    const e = need();
    const labels = { all: 'Select All', deselect: 'Deselect', reselect: 'Reselect', inverse: 'Select Inverse', feather: 'Feather' };
    const hasLast = () => (JSON.parse(e.channels_json()) as { has_last_selection: boolean }).has_last_selection;
    const noop = op === 'reselect' ? !hasLast() : op !== 'all' && !e.has_selection();
    if (noop) return info();
    history.run(labels[op], () => {
      if (op === 'all') e.select_all();
      else if (op === 'deselect') e.deselect();
      else if (op === 'reselect') e.reselect();
      else if (op === 'inverse') e.invert_selection();
      else e.feather_selection(radius!);
    });
    selGen++;
    return changed();
  },

  clearSelected(id: number, target: 'pixels' | 'mask' | 'selection') {
    const e = need();
    if (!e.has_selection()) return info();
    history.run('Clear', () => e.clear(id, target));
    return changed();
  },

  magicWand(id: number, x: number, y: number, tolerance: number, antialias: boolean, contiguous: boolean, sampleAll: boolean, mode: string) {
    const e = need();
    history.run('Magic Wand', () => e.magic_wand(Math.floor(x), Math.floor(y), tolerance, antialias, contiguous, sampleAll, id, mode));
    selGen++;
    return changed();
  },

  quickSelect(id: number, points: number[], radius: number, sampleAll: boolean, mode: string, autoEnhance: boolean) {
    const e = need();
    if (points.length < 2) return info();
    history.run('Quick Selection', () => e.quick_select(Float64Array.from(points), radius, sampleAll, id, mode, autoEnhance));
    selGen++;
    return changed();
  },

  magneticBegin(layerId: number, sampleAll: boolean) {
    return need().magnetic_begin(sampleAll, layerId);
  },

  magneticPath(handle: number, x0: number, y0: number, x1: number, y1: number, width: number, contrast: number) {
    return need().magnetic_path(handle, x0, y0, x1, y1, width, contrast);
  },

  magneticSuggestAnchor(path: Int32Array, frequency: number) {
    return need().magnetic_suggest_anchor(path, frequency);
  },

  magneticEnd(handle: number) {
    need().magnetic_end(handle);
  },

  // target is a parameter so a later batch can point bucket at the quick-mask selection channel;
  // this batch only ever passes 'pixels'.
  bucket(id: number, target: 'pixels' | 'selection', x: number, y: number, rgba: [number, number, number, number], mode: string, opacity: number, tolerance: number, antialias: boolean, contiguous: boolean, allLayers: boolean) {
    const e = need();
    history.run('Paint Bucket', () => e.bucket(id, target, Math.floor(x), Math.floor(y), ...rgba, mode, opacity, tolerance, antialias, contiguous, allLayers));
    return changed();
  },

  modifySelection(op: 'border' | 'smooth' | 'expand' | 'contract', radius: number, canvasBounds: boolean) {
    const e = need();
    const labels = { border: 'Border', smooth: 'Smooth', expand: 'Expand', contract: 'Contract' };
    history.run(labels[op], () => e.modify_selection(op, radius, canvasBounds));
    selGen++;
    return changed();
  },

  grow(id: number, tolerance: number, sampleAll: boolean) {
    const e = need();
    history.run('Grow', () => e.grow(tolerance, sampleAll, id));
    selGen++;
    return changed();
  },

  similar(id: number, tolerance: number, sampleAll: boolean) {
    const e = need();
    history.run('Similar', () => e.similar(tolerance, sampleAll, id));
    selGen++;
    return changed();
  },

  colorRange(id: number, sampleAll: boolean, preset: string, samples: number[], fuzziness: number, range: number, center: number[], localized: boolean, invert: boolean) {
    const e = need();
    history.run('Color Range', () => e.color_range(sampleAll, id, preset, Uint8Array.from(samples), fuzziness, range, Float64Array.from(center), localized, invert, 'new'));
    selGen++;
    return changed();
  },

  // Read-only grayscale preview for the Color Range dialog; does not touch history/selection.
  colorRangePreview(level: number, id: number, sampleAll: boolean, preset: string, samples: number[], fuzziness: number, range: number, center: number[], localized: boolean, invert: boolean) {
    const e = need();
    const scale = 1 << level;
    const w = Math.ceil(e.width() / scale), h = Math.ceil(e.height() / scale);
    const data = e.color_range_preview(level, sampleAll, id, preset, Uint8Array.from(samples), fuzziness, range, Float64Array.from(center), localized, invert);
    return { w, h, data: data.buffer as ArrayBuffer };
  },

  saveSelection(name: string | null, channel: number | null, mode: string) {
    const e = need();
    if (!e.has_selection()) return info();
    history.run('Save Selection', () => { if (channel !== null) e.combine_into_channel(channel, mode); else e.save_selection(name!); });
    return changed();
  },

  loadSelection(channel: number, invert: boolean, mode: string) {
    const e = need();
    history.run('Load Selection', () => e.load_selection(channel, invert, mode));
    selGen++;
    return changed();
  },

  // Assembles selection_tile results at `level` into one coverage buffer; missing tiles fill
  // with the selection default (255 if default > 0 else 0).
  selectionMask(level: number) {
    const e = need();
    const scale = 1 << level;
    const w = Math.ceil(e.width() / scale), h = Math.ceil(e.height() / scale);
    const ch = JSON.parse(e.channels_json()) as { selection: { default: number } | null };
    if (!ch.selection) return { docId, version, w, h, data: null };
    const fill = ch.selection.default > 0 ? 255 : 0;
    const data = new Uint8Array(w * h);
    if (fill) data.fill(fill);
    for (let ty = 0; ty < Math.ceil(h / 256); ty++) {
      for (let tx = 0; tx < Math.ceil(w / 256); tx++) {
        const tile = e.selection_tile(level, tx, ty) as Uint8Array | undefined;
        if (!tile) continue;
        const x0 = tx * 256, y0 = ty * 256, tw = Math.min(256, w - x0), th = Math.min(256, h - y0);
        for (let y = 0; y < th; y++) data.set(tile.subarray(y * 256, y * 256 + tw), (y0 + y) * w + x0);
      }
    }
    return { docId, version, w, h, data: data.buffer as ArrayBuffer };
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

  // Opens a stroke (docs/M2.md section 4) as one undo step spanning every strokeTo until strokeEnd.
  strokeBegin(layerId: number, target: 'pixels' | 'selection', params: StrokeParams, label: string) {
    const e = need();
    const { eraseToHistory, ...rest } = params;
    const p: Record<string, unknown> = rest;
    if (eraseToHistory) {
      const snap = history.oldestSnapshot();
      if (snap !== null) p.eraseToHistory = snap;
    }
    history.begin(label);
    try {
      e.stroke_begin(layerId, target, JSON.stringify(p));
    } catch (err) {
      history.abort();
      throw err;
    }
    strokeOpen = true;
    return info();
  },

  // Bumps version by exactly one (the viewer's dirty-rect invalidation relies on it) but never schedules autosave; only
  // strokeEnd commits the history step and schedules the save.
  strokeTo(samples: Float64Array) {
    const dirty = need().stroke_to(samples);
    version++;
    return { version, dirty: Array.from(dirty) };
  },

  strokeEnd() {
    need().stroke_end();
    strokeOpen = false;
    history.commit();
    return changed();
  },

  strokeCancel() {
    need().stroke_cancel();
    strokeOpen = false;
    history.abort();
    return changed();
  },

  undo() { if (history.undo()) { selGen++; return changed(); } return info(); },
  redo() { if (history.redo()) { selGen++; return changed(); } return info(); },
  historyGoto(n: number) { need(); if (history.goto(n)) { selGen++; return changed(); } return info(); },

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

  savePsd(): { blob: Blob; warnings: string[] } {
    const e = need();
    const { bytes, warnings } = exportPsd(e);
    return { blob: new Blob([bytes], { type: 'image/vnd.adobe.photoshop' }), warnings };
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

const STROKE_OPS = new Set<keyof Api>(['strokeBegin', 'strokeTo', 'strokeEnd', 'strokeCancel']);

// Calls run one at a time, so an async call (open, close, export) never interleaves with the next one.
// displayTile, displayProgram and selectionMask are synchronous and read-only, so they skip the
// queue and the viewer keeps drawing.
let queue = Promise.resolve();
onmessage = (ev: MessageEvent<{ id: number; op: keyof Api; args: unknown[] }>) => {
  const { id, op, args } = ev.data;
  if (op === 'displayTile' || op === 'displayProgram' || op === 'selectionMask' || op === 'colorRangePreview') { void handle(id, op, args); return; }
  queue = queue.then(() => {
    // Any other op queued while a stroke is open first commits it, so undo/save never see a half stroke.
    if (strokeOpen && !STROKE_OPS.has(op) && eng) { eng.stroke_end(); strokeOpen = false; history.commit(); changed(); }
    return handle(id, op, args);
  });
};
