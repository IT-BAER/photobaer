import { Engine } from '../engine-pkg/photobaer_engine.js';
import { tileIds } from '../project.ts';
import { importPsd, compositeRgba, isPsdBytes, type PendingSource } from '../psd.ts';
import { getHandle } from '../links.ts';
import type { Box, GlobalLight, LayerNode, SmartInfo, SmartLink, TransformKind, TransformOp } from './types.ts';

// Global Light: angle mod 360, altitude clamped to 0..90.
const normLight = (l: GlobalLight): GlobalLight => ({ angle: ((l.angle % 360) + 360) % 360, altitude: Math.min(90, Math.max(0, l.altitude)) });

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
// A string is a warp mesh (whole layer only); an array a row-major 3x3 matrix.
function applyTransform(e: Engine, kind: TransformKind, id: number, m: TransformOp, interp: string) {
  if (typeof m === 'string') {
    if (kind !== 'layer') throw new Error(WARP_LAYER_ONLY);
    e.warp_layer(id, m, interp);
    return;
  }
  const f = Float64Array.from(m);
  if (kind === 'layer') e.transform_layer(id, f, interp, true);
  else if (kind === 'pixels') e.transform_selected_pixels(id, f, interp, new Uint8Array(), false);
  else e.transform_selection(f, interp);
}
const WARP_LAYER_ONLY ='Warp bends a whole layer; deselect to warp it.';
const sameOp = (a: TransformOp, b: TransformOp) => typeof a === 'string' || typeof b === 'string' ? a === b : a.length === b.length && a.every((v, i) => v === b[i]);
// The session preview source: straight RGBA8 at scale f (longest side <= maxSide) over doc rect (x, y, w, h) / f.
function liftPreview(e: Engine, id: number, bounds: Box, selected: boolean, maxSide: number) {
  let f = Math.min(1, maxSide / Math.max(bounds[2], bounds[3]));
  if (f >= 0.9) f = 1;
  const x0 = Math.floor(bounds[0] * f), y0 = Math.floor(bounds[1] * f);
  const w = Math.ceil((bounds[0] + bounds[2]) * f) - x0, h = Math.ceil((bounds[1] + bounds[3]) * f) - y0;
  const data = e.transform_preview(id, Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1), f, selected, x0, y0, w, h).buffer as ArrayBuffer;
  return { image: { x: x0, y: y0, w, h, f }, data };
}
function intersect(a: Box | null, b: Box | null): Box | null {
  if (!a || !b) return null;
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
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

// Flattens `e`'s composite into an encoded image; JPEG has no alpha, so it flattens onto white.
async function encodeFlattened(e: Engine, type: 'image/png' | 'image/jpeg' | 'image/webp', quality?: number) {
  const w = e.width(), h = e.height();
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  tileLoop(w, h, (tx, ty) => {
    const px = e.flatten_tile_rgba8(tx, ty);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer, px.byteOffset, px.length), 256, 256), tx * 256, ty * 256);
  });
  let out: OffscreenCanvas = c;
  if (type === 'image/jpeg') {
    out = new OffscreenCanvas(w, h);
    const o = out.getContext('2d')!;
    o.fillStyle = '#fff';
    o.fillRect(0, 0, w, h);
    o.drawImage(c, 0, 0);
  }
  const blob = await out.convertToBlob({ type, quality });
  if (blob.type !== type) throw new Error(`${type} export is not supported by this browser`);
  return blob;
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

// Every node, topmost first (reading order): each root sibling before its children, siblings in
// top-to-bottom (reverse array) order; skips a node, and its whole subtree, once hidden or under
// a hidden ancestor.
function visibleTopDown(nodes: LayerNode[], ancestorVisible = true): LayerNode[] {
  const out: LayerNode[] = [];
  for (const n of [...nodes].reverse()) {
    const vis = ancestorVisible && n.visible;
    if (vis) out.push(n);
    if (n.children) out.push(...visibleTopDown(n.children, vis));
  }
  return out;
}

function containsId(nodes: LayerNode[], id: number): boolean {
  return nodes.some(n => n.id === id || (n.children && containsId(n.children, id)));
}

// The root-level sibling (direct child of `tree`) whose subtree contains `id`, or `id` itself
// when it is already root-level.
function topLevelAncestor(tree: LayerNode[], id: number): number {
  for (const n of tree) if (n.id === id || (n.children && containsId(n.children, id))) return n.id;
  return id;
}

// Every pixel-layer and smart-object id under `id` (itself included), depth-first.
function collectPixelIds(tree: LayerNode[], id: number): number[] {
  const moves = (n: LayerNode) => n.kind === 'pixel' || n.kind === 'smart';
  const flatten = (nodes: LayerNode[]): number[] => nodes.flatMap(n => (moves(n) ? [n.id] : []).concat(n.children ? flatten(n.children) : []));
  const find = (nodes: LayerNode[]): LayerNode | undefined => {
    for (const n of nodes) { if (n.id === id) return n; const h = n.children && find(n.children); if (h) return h; }
    return undefined;
  };
  const node = find(tree);
  if (!node) return [];
  return moves(node) ? [node.id] : flatten(node.children ?? []);
}

// Preset patterns copied into documents (D3), RGBA by preset id. A use re-adds a copy that an undo or
// a preview rerun dropped; a document pattern with the same id is reused as is.
type DocPattern = { id: string; name: string; width: number; height: number; blob: number };
const presetPatterns = new Map<string, { name: string; width: number; height: number; rgba: Uint8Array }>();

function docPatterns(e: Engine): DocPattern[] {
  return (JSON.parse(e.manifest()) as { patterns: DocPattern[] }).patterns;
}

// Adds the registered presets among `ids` that the document lacks; unknown ids are left to the engine to refuse.
function ensurePatterns(e: Engine, ids: Iterable<string>) {
  const have = new Set((JSON.parse(e.channels_json()) as { patterns: { id: string }[] }).patterns.map(p => p.id));
  const add = [...new Set(ids)].filter(id => !have.has(id) && presetPatterns.has(id));
  if (!add.length) return;
  const patterns = docPatterns(e);
  for (const id of add) {
    const p = presetPatterns.get(id)!;
    patterns.push({ id, name: p.name, width: p.width, height: p.height, blob: Number(e.blob_add(p.rgba)) });
  }
  e.set_document_m3(JSON.stringify({ patterns }));
}
// ---------- smart objects (docs/M3.md section 6) ----------

const uuid = () => crypto.randomUUID();

function findNode(e: Engine, id: number): LayerNode | undefined {
  const walk = (nodes: LayerNode[]): LayerNode | undefined => {
    for (const n of nodes) { if (n.id === id) return n; const c = n.children && walk(n.children); if (c) return c; }
    return undefined;
  };
  return walk(JSON.parse(e.layers_json()) as LayerNode[]);
}

function smartOf(e: Engine, id: number): { node: LayerNode; smart: SmartInfo } {
  const node = findNode(e, id);
  if (!node?.smart) throw new Error('Select a smart object first.');
  return { node, smart: node.smart };
}

// Straight RGBA8 of an image file (a PSD/PSB: its flattened document).
async function decodeSource(bytes: Uint8Array): Promise<{ w: number; h: number; rgba: Uint8Array }> {
  if (isPsdBytes(bytes)) {
    const { engine } = importPsd(bytes, { psb: true });
    try { return { w: engine.width(), h: engine.height(), rgba: compositeRgba(engine) }; } finally { engine.free(); }
  }
  const bmp = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const w = bmp.width, h = bmp.height;
  if (!w || !h) { bmp.close(); throw new Error('That file has no pixels to place.'); }
  const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const d = ctx.getImageData(0, 0, w, h).data;
  return { w, h, rgba: new Uint8Array(d.buffer, d.byteOffset, d.length) };
}

// Imported smart objects whose sources are image files get their source pixels here (no undo step).
async function loadSources(e: Engine, sources: PendingSource[], warn: (m: string) => void) {
  for (const { id, bytes } of sources) {
    try {
      e.load_smart_source(id, (await decodeSource(bytes)).rgba);
    } catch {
      warn('smart object sources that could not be read were not imported');
    }
  }
}

// Writes straight RGBA8 (w x h) into pixel layer `id` of `e`.
function putRgba(e: Engine, id: number, w: number, h: number, rgba: Uint8Array) {
  tileLoop(w, h, (tx, ty) => {
    const buf = new Uint8Array(256 * 256 * 4);
    const cw = Math.min(256, w - tx * 256);
    for (let y = 0; y < Math.min(256, h - ty * 256); y++) {
      const s = ((ty * 256 + y) * w + tx * 256) * 4;
      buf.set(rgba.subarray(s, s + cw * 4), y * 256 * 4);
    }
    e.set_tile_rgba8(id, tx, ty, buf);
  });
}

const unavailable = (name: string) => new Error(`The linked source is unavailable: ${name}. Relink the Smart Object to an existing file.`);

async function readLinked(link: SmartLink & { type: 'linked' }): Promise<Uint8Array> {
  const h = await getHandle(link.handle).catch(() => null);
  if (!h) throw unavailable(link.name);
  try { return new Uint8Array(await (await h.getFile()).arrayBuffer()); } catch { throw unavailable(link.name); }
}

// The placed file's bytes, unmodified: the embedded blob or the linked file.
async function sourceBytes(e: Engine, s: SmartInfo): Promise<Uint8Array | null> {
  if (s.link.type === 'linked') return readLinked(s.link);
  return s.source.blob === null ? null : e.tile_bytes(BigInt(s.source.blob));
}

async function writeHandle(h: FileSystemFileHandle, bytes: Uint8Array) {
  const w = await (h as unknown as { createWritable(): Promise<{ write(b: Uint8Array): Promise<void>; close(): Promise<void> }> }).createWritable();
  await w.write(bytes);
  await w.close();
}

const RASTER: Record<string, 'image/png' | 'image/jpeg' | 'image/webp'> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

function extOf(b: Uint8Array): string {
  if (isPsdBytes(b)) return b[5] === 2 ? 'psb' : 'psd';
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x52 && b[8] === 0x57) return 'webp';
  return 'bin';
}

// The warp session source of a smart object: the mesh parameter box B (the placement's bounding box), the source
// drawn axis-aligned into B as the preview, and the current look as a mesh (the stored warp, else the transform).
function smartWarpStart(e: Engine, id: number, maxSide: number) {
  const s = smartOf(e, id).smart, [sw, sh] = s.source_size, t = s.transform;
  const at = (x: number, y: number): [number, number] => {
    const d = t[6] * x + t[7] * y + t[8];
    return [(t[0] * x + t[1] * y + t[2]) / d, (t[3] * x + t[4] * y + t[5]) / d];
  };
  const q = [at(0, 0), at(sw, 0), at(sw, sh), at(0, sh)];
  const x0 = Math.min(...q.map(p => p[0])), y0 = Math.min(...q.map(p => p[1]));
  const bounds: Box = [x0, y0, Math.max(...q.map(p => p[0])) - x0, Math.max(...q.map(p => p[1])) - y0];
  const snap = e.snapshot();
  let lifted;
  try {
    e.set_smart_placement(id, Float64Array.of(bounds[2] / sw, 0, x0, 0, bounds[3] / sh, y0, 0, 0, 1), '');
    const found = e.layer_bounds(id) as Box | null;
    if (!found) throw new Error('There are no pixels to warp.');
    lifted = liftPreview(e, id, Array.from(found) as Box, false, maxSide);
  } finally {
    e.restore(snap);
    e.drop_snapshot(snap);
  }
  const w = s.warp;
  const mesh = w
    ? { cols: w.cols, rows: w.rows, points: w.points, columnStops: w.column_stops, rowStops: w.row_stops }
    : { cols: 1, rows: 1, points: Array.from({ length: 16 }, (_, k) => at((k % 4) * sw / 3, Math.floor(k / 4) * sh / 3)), columnStops: [0, 1], rowStops: [0, 1] };
  return { bounds, ...lifted, mesh };
}

export { applyTransform, collectPixelIds, decodeSource, docPatterns, encodeFlattened, ensurePatterns, extOf, findNode, intersect, layerTile, liftPreview, loadEngine, loadSources, nodeTiles, normLight, presetPatterns, propsLabel, putRgba, RASTER, readLinked, sameOp, smartOf, smartWarpStart, sourceBytes, tileLoop, topLevelAncestor, unavailable, uuid, visibleTopDown, WARP_LAYER_ONLY, writeHandle };
