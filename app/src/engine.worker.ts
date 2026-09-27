import init, { Engine } from './engine-pkg/photobaer_engine.js';
import { History } from './history.ts';
import { Autosave } from './autosave.ts';
import { packProject, unpackProject, tileIds } from './project.ts';
import { importPsd, exportPsd, compositeRgba, isPsdBytes, type PendingSource } from './psd.ts';
import { getHandle, putHandle } from './links.ts';
import { denormalize, isIdentity } from './transform/matrix.ts';
import type { Blending, LayerStyle } from './layerStyle.ts';
import { DESTRUCTIVE_KINDS } from './adjustments.ts';

const DESTRUCTIVE = new Set<string>(DESTRUCTIVE_KINDS);

// A fill layer's content (docs/M3.md section 4); field names match the engine JSON verbatim.
export interface GradientDef {
  method: 'classic' | 'linear' | 'perceptual';
  color_stops: { position: number; color: [number, number, number]; midpoint: number }[];
  opacity_stops: { position: number; opacity: number; midpoint: number }[];
}
export type FillContent =
  | { type: 'solid'; color: [number, number, number] }
  | {
      type: 'gradient'; gradient: GradientDef; style: 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';
      angle: number; scale: number; reverse: boolean; dither: boolean; align_with_layer: boolean; offset: [number, number];
    }
  | { type: 'pattern'; pattern_id: string; scale: number; angle: number; linked: boolean; offset: [number, number] };

// The 16 adjustment layer kinds (docs/M3.md section 3); field names match the engine JSON verbatim.
export interface LevelsRecord { input_black: number; input_white: number; gamma: number; output_black: number; output_white: number }
export interface Hsl { hue: number; saturation: number; lightness: number }
export interface HueRange { bands: [number, number, number, number]; hue: number; saturation: number; lightness: number }
type Quad = [number, number, number, number];
export type Adjustment =
  | { kind: 'brightness_contrast'; params: { brightness: number; contrast: number; legacy: boolean } }
  | { kind: 'levels'; params: { composite: LevelsRecord; red?: LevelsRecord | null; green?: LevelsRecord | null; blue?: LevelsRecord | null } }
  | { kind: 'curves'; params: { mode: 'point' | 'pencil'; composite: [number, number][]; red?: [number, number][] | null; green?: [number, number][] | null; blue?: [number, number][] | null } }
  | { kind: 'exposure'; params: { exposure: number; offset: number; gamma: number } }
  | { kind: 'vibrance'; params: { vibrance: number; saturation: number } }
  | { kind: 'hue_saturation'; params: { master: Hsl; ranges: [HueRange, HueRange, HueRange, HueRange, HueRange, HueRange]; colorize: boolean; colorize_values: Hsl } }
  | { kind: 'color_balance'; params: { shadows: [number, number, number]; midtones: [number, number, number]; highlights: [number, number, number]; preserve_luminosity: boolean } }
  | { kind: 'black_white'; params: { reds: number; yellows: number; greens: number; cyans: number; blues: number; magentas: number; tint: boolean; tint_color: [number, number, number] } }
  | { kind: 'photo_filter'; params: { color: [number, number, number]; density: number; preserve_luminosity: boolean } }
  | { kind: 'channel_mixer'; params: { red: Quad; green: Quad; blue: Quad; gray: Quad; monochrome: boolean } }
  | { kind: 'color_lookup'; params: { name: string; format: 'cube' | '3dl'; table: number | null; interpolation: 'tetrahedral' | 'trilinear'; dither: boolean } }
  | { kind: 'invert'; params: Record<string, never> }
  | { kind: 'posterize'; params: { levels: number } }
  | { kind: 'threshold'; params: { level: number } }
  | { kind: 'gradient_map'; params: { gradient: GradientDef; reverse: boolean; dither: boolean } }
  | { kind: 'selective_color'; params: { mode: 'relative' | 'absolute'; reds: Quad; yellows: Quad; greens: Quad; cyans: Quad; blues: Quad; magentas: Quad; whites: Quad; neutrals: Quad; blacks: Quad } };

// The destructive-only kinds (docs/M3.md section 3, 17-25): Image menu commands, never layers.
type ToneRange = { amount: number; tone: number; radius: number };
export type DestructiveAdjustment =
  | { kind: 'shadows_highlights'; params: { shadows: ToneRange; highlights: ToneRange; color_correction: number; midtone_contrast: number; black_clip: number; white_clip: number } }
  | { kind: 'hdr_toning'; params: { method: 'local_adaptation' | 'exposure_gamma' | 'highlight_compression' | 'equalize_histogram'; radius: number; strength: number; detail: number; shadow: number; highlight: number; exposure: number; gamma: number; vibrance: number; saturation: number } }
  | { kind: 'desaturate'; params: Record<string, never> }
  | { kind: 'match_color'; params: { luminance: number; color_intensity: number; fade: number; neutralize: boolean } }
  | { kind: 'replace_color'; params: { target_color: [number, number, number]; fuzziness: number; range: number; localized: boolean; hue: number; saturation: number; lightness: number } }
  | { kind: 'equalize' | 'auto_tone' | 'auto_contrast' | 'auto_color'; params: Record<string, never> };

export type SmartLink = { type: 'embedded'; id: string } | { type: 'linked'; name: string; handle: string };
// Engine warp mesh JSON: document-px control points over the source rect.
export interface SmartWarp { cols: number; rows: number; points: [number, number][]; column_stops: number[]; row_stops: number[] }
export interface SmartInfo {
  link: SmartLink; source: { blob: number | null }; source_size: [number, number]; transform: number[];
  warp: SmartWarp | null; filters: unknown[]; stack_mode: string | null;
}
export interface LayerNode {
  id: number; name: string; kind: 'pixel' | 'group' | 'adjustment' | 'fill' | 'smart';
  visible: boolean; opacity: number; fill: number; blend: string; clipping: boolean;
  locks: { transparency: boolean; pixels: boolean; position: boolean };
  mask: { enabled: boolean; default: number } | null;
  content?: FillContent;
  adjustment?: Adjustment;
  smart?: SmartInfo;
  style: LayerStyle | null;
  blending: Blending;
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
  patterns: { id: string; name: string }[];
  layerComps: { id: number; name: string; layerCount: number }[];
  globalLight: GlobalLight;
  // Edit Contents (D6): the names of the documents this one is nested in, outermost first.
  parents: string[];
}
export interface GlobalLight { angle: number; altitude: number }
export type SelectShape = { kind: 'rect' | 'ellipse' | 'polygon'; x?: number; y?: number; w?: number; h?: number; points?: number[] };
export type OpenResult = DocInfo & { warnings: string[] };
export type AutosaveState = 'off' | 'other-tab' | 'idle' | 'saving' | 'saved' | 'error';
export type WorkerEvent = { event: 'autosave'; state: AutosaveState; detail?: string } | { event: 'transformCancelled'; doc: DocInfo | null };
export interface StrokeParams {
  rgba: [number, number, number, number]; mode: string; size: number;
  opacity?: number; flow?: number; hardness?: number; spacing?: number; angle?: number; roundness?: number;
  tip?: 'round' | 'square'; aliased?: boolean; wetEdges?: boolean; airbrush?: boolean;
  pressureSize?: boolean; pressureOpacity?: boolean;
  stride?: 3 | 6; seed?: number;
  // UI-level flag; strokeBegin resolves it to an actual snapshot id (or omits it) before it reaches the engine.
  eraseToHistory?: boolean;
}

type Rgba = [number, number, number, number];
// Engine fill_ex / stroke_selection / gradient params (opacity 0..1); patternId is a worker asset id.
export interface FillParams {
  source: 'solid' | 'pattern' | 'history'; rgba?: Rgba; patternId?: number;
  mode: string; opacity: number; preserveTransparency: boolean;
}
export interface StrokeSelectionParams {
  width: number; rgba: Rgba; location: 'inside' | 'center' | 'outside'; mode: string; opacity: number; preserveTransparency: boolean;
}
export interface GradientParams {
  stops: { position: number; rgb: [number, number, number]; midpoint: number }[];
  opacityStops: { position: number; opacity: number; midpoint: number }[];
  method: 'perceptual' | 'linear' | 'classic'; style: 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';
  start: { x: number; y: number }; end: { x: number; y: number };
  reverse: boolean; dither: boolean; transparency: boolean; opacity: number;
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
// Move tool live session: a snapshot taken right after any duplicate, restored and replayed
// from on every step so the previewed offset never compounds.
let moveSession: { liveBase: number; targetId: number; duplicated: boolean; lastDx: number; lastDy: number } | null = null;
// Free transform / Transform Selection / Warp session: one open history step. `hidden` is the document
// with the source removed (the UI previews it), `refined` the matrix or warp mesh JSON last rendered for
// real, `base` the snapshot a warp applies to after a baked matrix (null: the step's start), `label` the
// commit label when it differs from the one the step opened with.
type TransformKind = 'layer' | 'pixels' | 'selection';
type TransformOp = number[] | string;
let transformSession: { id: number; kind: TransformKind; hidden: number; refined: TransformOp | null; base: number | null; label: string | null } | null = null;
// Copy Layer Style's clipboard: the style JSON only (never blending options), kept across documents.
let styleClipboard: string | null = null;
// Global Light: angle mod 360, altitude clamped to 0..90.
const normLight = (l: GlobalLight): GlobalLight => ({ angle: ((l.angle % 360) + 360) % 360, altitude: Math.min(90, Math.max(0, l.altitude)) });
// Open live-preview session (Fill/Stroke dialogs): one history step, rerun from its start on every change.
let previewOpen = false;
let previewError: string | null = null;

const historyOf = (e: Engine) => new History({
  snapshot: () => e.snapshot(),
  restore: id => e.restore(id),
  drop: id => e.drop_snapshot(id),
});
let history = new History({ snapshot: () => need().snapshot(), restore: id => need().restore(id), drop: id => need().drop_snapshot(id) });
// Edit Contents sessions (D6): each open source document's parent, innermost last. `id` is the smart object
// being edited in the parent, `saved` the nested document's version at its last write-back.
interface Parent { eng: Engine; history: History; name: string; id: number; saved: number }
const parents: Parent[] = [];

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
    patterns: { id: string; name: string }[];
    layer_comps: { id: number; name: string; layer_count: number }[];
    global_light: GlobalLight;
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
    patterns: ch.patterns,
    layerComps: ch.layer_comps.map(c => ({ id: c.id, name: c.name, layerCount: c.layer_count })),
    globalLight: ch.global_light,
    parents: parents.map(p => p.name),
  };
}

function nextCompName(): string {
  const used = new Set((JSON.parse(need().channels_json()) as { layer_comps: { name: string }[] }).layer_comps.map(c => c.name));
  for (let i = 1; ; i++) if (!used.has(`Layer Comp ${i}`)) return `Layer Comp ${i}`;
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

// Drops every open Edit Contents parent (a new or closed document replaces the whole stack).
function dropParents() {
  for (const p of parents.splice(0)) { p.history.clear(); p.eng.free(); }
}

function adopt(e: Engine, n: string, restored = false) {
  history.clear();
  eng?.free();
  dropParents();
  eng = e;
  history = historyOf(e);
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

// One undo step, or with `preview` a rerun inside the open preview session (no autosave until previewEnd).
function edit(label: string, preview: boolean, fn: () => void) {
  if (!preview) {
    history.run(label, fn);
    return changed();
  }
  if (previewOpen) history.restoreOpen(); else { history.begin(label); previewOpen = true; }
  try {
    fn();
    previewError = null;
  } catch (err) {
    history.restoreOpen();
    previewError = err instanceof Error ? err.message : String(err);
    version++;
    throw err;
  }
  version++;
  return info()!;
}

function endPreview(commit: boolean) {
  if (!previewOpen) return;
  previewOpen = false;
  if (commit && previewError === null) { history.commit(); return; }
  history.restoreOpen();
  history.abort();
  if (commit) { const e = previewError; previewError = null; throw new Error(e!); }
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

const CANVAS_REMAPS = { '180': '180°', cw: '90° Clockwise', ccw: '90° Counter Clockwise', flipH: 'Flip Canvas Horizontal', flipV: 'Flip Canvas Vertical' };

// One step for an engine canvas op; a false result (nothing to change) records none.
function canvasEdit(label: string, fn: () => boolean) {
  history.begin(label);
  let done: boolean;
  try {
    done = fn();
  } catch (err) {
    history.restoreOpen();
    history.abort();
    throw err;
  }
  if (!done) { history.abort(); return info()!; }
  history.commit();
  selGen++;
  return changed();
}

const WARP_LAYER_ONLY ='Warp bends a whole layer; deselect to warp it.';
const sameOp = (a: TransformOp, b: TransformOp) => typeof a === 'string' || typeof b === 'string' ? a === b : a.length === b.length && a.every((v, i) => v === b[i]);

// Puts the document back to the state the session's transform applies to.
function restoreBase(e: Engine, base: number | null) {
  if (base === null) history.restoreOpen();
  else e.restore(base);
}

// The session preview source: straight RGBA8 at scale f (longest side <= maxSide) over doc rect (x, y, w, h) / f.
function liftPreview(e: Engine, id: number, bounds: Box, selected: boolean, maxSide: number) {
  let f = Math.min(1, maxSide / Math.max(bounds[2], bounds[3]));
  if (f >= 0.9) f = 1;
  const x0 = Math.floor(bounds[0] * f), y0 = Math.floor(bounds[1] * f);
  const w = Math.ceil((bounds[0] + bounds[2]) * f) - x0, h = Math.ceil((bounds[1] + bounds[3]) * f) - y0;
  const data = e.transform_preview(id, Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1), f, selected, x0, y0, w, h).buffer as ArrayBuffer;
  return { image: { x: x0, y: y0, w, h, f }, data };
}

type Box = [number, number, number, number];
function intersect(a: Box | null, b: Box | null): Box | null {
  if (!a || !b) return null;
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

function scheduleSave(ms: number) {
  if (!autosave) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    // A transform session hides its source pixels; commit and cancel schedule the next save. An Edit
    // Contents session never autosaves: the autosave keeps the outermost document.
    if (transformSession || parents.length) return;
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

// Sampled tips and patterns live inside an Engine instance, which a new document replaces. The worker keeps them
// under its own stable ids and registers them lazily into whichever engine paints (the document or a preview scratch).
type Asset = { kind: 'tip'; w: number; h: number; data: Uint8Array } | { kind: 'pattern'; w: number; h: number; data: Uint8Array; channels: number };
const assets = new Map<number, Asset>();
const engineIds = new WeakMap<Engine, Map<number, number>>();
let nextAsset = 1;
let scratch: Engine | null = null;

function engineAsset(e: Engine, id: unknown, kind: Asset['kind']): number {
  const a = typeof id === 'number' ? assets.get(id) : undefined;
  if (!a || a.kind !== kind) throw new Error(`unknown ${kind} id ${String(id)}`);
  let ids = engineIds.get(e);
  if (!ids) engineIds.set(e, ids = new Map());
  let eid = ids.get(id as number);
  if (eid === undefined) {
    eid = a.kind === 'tip' ? e.tip_add(a.w, a.h, a.data) : e.pattern_add(a.w, a.h, a.data, a.channels);
    ids.set(id as number, eid);
  }
  return eid;
}

// Rewrites worker tip/pattern ids in stroke params to the engine's own ids.
function withEngineAssets(e: Engine, params: Record<string, unknown>): Record<string, unknown> {
  const p = { ...params };
  if (p.tip === 'sampled') p.tipId = engineAsset(e, p.tipId, 'tip');
  const db = p.dualBrush as Record<string, unknown> | undefined;
  if (db?.tip === 'sampled') p.dualBrush = { ...db, tipId: engineAsset(e, db.tipId, 'tip') };
  const tx = p.texture as Record<string, unknown> | undefined;
  if (tx?.patternId !== undefined) p.texture = { ...tx, patternId: engineAsset(e, tx.patternId, 'pattern') };
  return p;
}

function addAsset(e: Engine, a: Asset) {
  // Validates against the engine's bounds right away so a bad bitmap fails at registration, not mid-stroke.
  const id = nextAsset++;
  assets.set(id, a);
  try { engineAsset(e, id, a.kind); } catch (err) { assets.delete(id); throw err; }
  return id;
}

function removeAsset(id: number) {
  const a = assets.get(id);
  if (!a) return;
  assets.delete(id);
  for (const e of [eng, scratch]) {
    const eid = e ? engineIds.get(e)?.get(id) : undefined;
    if (e && eid !== undefined) { if (a.kind === 'tip') e.tip_remove(eid); else e.pattern_remove(eid); engineIds.get(e)!.delete(id); }
  }
}

const previewEngine = () => eng ?? (scratch ??= new Engine(1, 1, 8));

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
      const { engine, warnings, sources } = importPsd(new Uint8Array(await file.arrayBuffer()));
      await loadSources(engine, sources, m => { if (!warnings.includes(m)) warnings.push(m); });
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

  // Edit > Fill and the quick fills. A history source reads the oldest kept snapshot, like erase-to-history.
  fillEx(id: number, target: 'pixels' | 'mask' | 'selection', params: FillParams, label: string, preview = false) {
    const e = need();
    const p: Record<string, unknown> = { ...params };
    if (params.source === 'pattern') p.patternId = engineAsset(e, params.patternId, 'pattern');
    if (params.source === 'history') {
      const snap = history.oldestSnapshot();
      if (snap === null) throw new Error('Fill needs a pixel layer.');
      p.snapshotId = snap;
    }
    return edit(label, preview, () => e.fill_ex(id, target, JSON.stringify(p)));
  },

  strokeSelection(id: number, params: StrokeSelectionParams, preview = false) {
    const e = need();
    return edit('Stroke', preview, () => e.stroke_selection(id, JSON.stringify(params)));
  },

  previewEnd(commit: boolean) {
    need();
    endPreview(commit);
    return changed();
  },

  gradient(id: number, target: 'pixels' | 'mask' | 'selection', params: GradientParams) {
    const e = need();
    return edit('Gradient', false, () => e.gradient(id, target, JSON.stringify(params)));
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

  // Selection coverage (0-255) at a document point; 255 everywhere with no selection.
  selectionAt(x: number, y: number) {
    const e = need();
    const px = Math.floor(x), py = Math.floor(y);
    const ch = JSON.parse(e.channels_json()) as { selection: { default: number } | null };
    if (!ch.selection) return 255;
    if (px < 0 || py < 0 || px >= e.width() || py >= e.height()) return 0;
    const tile = e.selection_tile(0, Math.floor(px / 256), Math.floor(py / 256)) as Uint8Array | undefined;
    return tile ? tile[(py % 256) * 256 + (px % 256)] : ch.selection.default > 0 ? 255 : 0;
  },

  // Move tool: the union of the document bounds and every visible layer's content bounds
  // except `excludeId`'s own subtree, as [start, center, end] anchors per axis for snapping.
  snapTargets(excludeId: number) {
    const e = need();
    const rects: [number, number, number, number][] = [[0, 0, e.width(), e.height()]];
    const walk = (nodes: LayerNode[], excluded: boolean) => {
      for (const n of nodes) {
        const skip = excluded || n.id === excludeId;
        if (!skip && n.visible && (n.kind === 'pixel' || n.kind === 'smart')) {
          const b = e.layer_bounds(n.id) as [number, number, number, number] | null;
          if (b) rects.push(b);
        }
        if (n.children) walk(n.children, skip || !n.visible);
      }
    };
    walk(JSON.parse(e.layers_json()) as LayerNode[], false);
    const x: number[] = [], y: number[] = [];
    for (const [rx, ry, rw, rh] of rects) { x.push(rx, rx + rw / 2, rx + rw); y.push(ry, ry + rh / 2, ry + rh); }
    return { x, y };
  },

  // Union of the content bounds of every pixel layer under `id` (itself included), or null when
  // none has any pixels. The moving rect for snapping and for the union offset bounding box.
  movingBounds(id: number) {
    const e = need();
    const tree = JSON.parse(e.layers_json()) as LayerNode[];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const pid of collectPixelIds(tree, id)) {
      const b = e.layer_bounds(pid) as [number, number, number, number] | null;
      if (!b) continue;
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]);
      x1 = Math.max(x1, b[0] + b[2]); y1 = Math.max(y1, b[1] + b[3]);
    }
    return x0 === Infinity ? null : [x0, y0, x1 - x0, y1 - y0];
  },

  // Move tool auto-select: the topmost visible pixel layer with a non-transparent pixel at (x, y),
  // or (with `group`) that layer's top-level ancestor. Null off-canvas or over empty pixels.
  hitTestLayer(x: number, y: number, group: boolean): number | null {
    const e = need();
    const px = Math.floor(x), py = Math.floor(y);
    if (px < 0 || py < 0 || px >= e.width() || py >= e.height()) return null;
    const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
    const ox = px - tx * 256, oy = py - ty * 256;
    const tree = JSON.parse(e.layers_json()) as LayerNode[];
    for (const n of visibleTopDown(tree)) {
      if (n.kind !== 'pixel' && n.kind !== 'smart') continue;
      const buf = layerTile(e, nodeTiles(e, n.id), tx, ty);
      if (buf && buf[(oy * 256 + ox) * 4 + 3] > 0) return group ? topLevelAncestor(tree, n.id) : n.id;
    }
    return null;
  },

  // Whole-layer move/duplicate session: `moveLayerBegin` opens one history step (duplicating the
  // node first when asked), `moveLayerStep` previews a cumulative offset from the session's start,
  // `moveLayerCommit`/`moveLayerCancel` close it. A zero net offset with no duplicate makes no step.
  moveLayerBegin(id: number, duplicate: boolean, label: string) {
    const e = need();
    history.begin(label);
    const targetId = duplicate ? e.duplicate_node(id) : id;
    if (duplicate) {
      const used = new Set<string>();
      let base = '';
      const walk = (ns: LayerNode[]) => { for (const n of ns) { if (n.id === targetId) base = n.name; else used.add(n.name); if (n.children) walk(n.children); } };
      walk(JSON.parse(e.layers_json()) as LayerNode[]);
      if (used.has(base)) { let i = 2; while (used.has(`${base} ${i}`)) i++; e.set_props(targetId, JSON.stringify({ name: `${base} ${i}` })); }
    }
    moveSession = { liveBase: e.snapshot(), targetId, duplicated: duplicate, lastDx: 0, lastDy: 0 };
    return { ...changed(), activeId: targetId };
  },

  moveLayerStep(dx: number, dy: number) {
    const e = need(), s = moveSession!;
    e.restore(s.liveBase);
    const tree = JSON.parse(e.layers_json()) as LayerNode[];
    for (const pid of collectPixelIds(tree, s.targetId)) e.offset_layer(pid, dx, dy);
    s.lastDx = dx;
    s.lastDy = dy;
    version++;
    return info()!;
  },

  moveLayerCommit() {
    const e = need(), s = moveSession!;
    e.drop_snapshot(s.liveBase);
    moveSession = null;
    if (!s.duplicated && s.lastDx === 0 && s.lastDy === 0) history.abort(); else history.commit();
    return changed();
  },

  moveLayerCancel() {
    const s = moveSession;
    if (!s) return info();
    moveSession = null;
    need().drop_snapshot(s.liveBase);
    history.restoreOpen();
    history.abort();
    return changed();
  },

  // Selected-pixels move session (engine lift/hole via transform_selected_pixels), same begin/
  // step/commit/cancel shape as the whole-layer session above; no layer is a background layer.
  movePixelsBegin(id: number, label: string, copy = false) {
    const e = need();
    history.begin(label);
    moveSession = { liveBase: e.snapshot(), targetId: id, duplicated: copy, lastDx: 0, lastDy: 0 };
    return changed();
  },

  movePixelsStep(dx: number, dy: number) {
    const e = need(), s = moveSession!;
    e.restore(s.liveBase);
    e.transform_selected_pixels(s.targetId, Float64Array.of(1, 0, dx, 0, 1, dy, 0, 0, 1), 'nearest', new Uint8Array(), s.duplicated);
    s.lastDx = dx;
    s.lastDy = dy;
    version++;
    selGen++;
    return info()!;
  },

  movePixelsCommit() {
    const e = need(), s = moveSession!;
    e.drop_snapshot(s.liveBase);
    moveSession = null;
    if (s.lastDx === 0 && s.lastDy === 0) history.abort(); else history.commit();
    return changed();
  },

  movePixelsCancel() {
    const s = moveSession;
    if (!s) return info();
    moveSession = null;
    need().drop_snapshot(s.liveBase);
    history.restoreOpen();
    history.abort();
    return changed();
  },

  // Opens a transform session on the layer, its selected pixels or the selection. The preview
  // source comes back as straight RGBA8 at scale f (longest side <= maxSide) over doc rect
  // (x, y, w, h) / f; the live document then shows the layer without the source.
  // `warp` opens a smart object's warp: bounds are its mesh parameter box and `mesh` its current look.
  transformBegin(id: number, kind: TransformKind, label: string, maxSide = 2048, warp = false) {
    const e = need();
    const sel = (JSON.parse(e.channels_json()) as { selection: { bounds: Box | null } | null }).selection;
    if (kind !== 'layer' && !sel) throw new Error('Make a selection first.');
    const layer = kind === 'selection' ? null : e.layer_bounds(id) as Box | null;
    const found = kind === 'layer' ? layer : kind === 'pixels' ? intersect(sel!.bounds, layer) : sel!.bounds;
    const bounds = found && Array.from(found) as Box;
    if (!bounds) throw new Error(kind === 'selection' ? 'Make a selection first.' : 'There are no pixels to transform.');
    const smart = warp && kind === 'layer' && findNode(e, id)?.kind === 'smart' ? smartWarpStart(e, id, maxSide) : null;
    const { image, data } = smart ?? (kind === 'selection' ? { image: null, data: null } : liftPreview(e, id, bounds, kind === 'pixels', maxSide));
    history.begin(label);
    try {
      if (kind !== 'selection') e.clear(id, 'pixels');
    } catch (err) {
      history.restoreOpen();
      history.abort();
      throw err;
    }
    transformSession = { id, kind, hidden: e.snapshot(), refined: null, base: null, label: null };
    version++;
    return { ...info()!, bounds: smart?.bounds ?? bounds, image, data, mesh: smart?.mesh ?? null };
  },

  // Renders the session's real result (bicubic) into the live document.
  // Refine, unrefine and commit do nothing once another op has cancelled the session.
  transformRefine(m: TransformOp) {
    const e = need(), s = transformSession;
    if (!s) return info();
    restoreBase(e, s.base);
    try {
      applyTransform(e, s.kind, s.id, m, 'bicubic');
    } catch (err) {
      e.restore(s.hidden);
      s.refined = null;
      version++;
      throw err;
    }
    s.refined = m;
    version++;
    return info()!;
  },

  transformUnrefine() {
    const e = need(), s = transformSession;
    if (!s) return info();
    e.restore(s.hidden);
    s.refined = null;
    version++;
    return info()!;
  },

  // Commits `m` as one history step under the session label; null (unmodified) commits nothing
  // unless a matrix was baked before a warp.
  transformCommit(m: TransformOp | null) {
    const e = need(), s = transformSession;
    if (!s) throw new Error('The transform was cancelled.');
    if (!m && s.base === null) return api.transformCancel();
    try {
      if (!m) restoreBase(e, s.base);
      else if (!s.refined || !sameOp(s.refined, m)) {
        restoreBase(e, s.base);
        applyTransform(e, s.kind, s.id, m, 'bicubic');
      }
    } catch (err) {
      api.transformCancel();
      throw err;
    }
    transformSession = null;
    e.drop_snapshot(s.hidden);
    if (s.base !== null) e.drop_snapshot(s.base);
    history.commit(s.label ?? undefined);
    selGen++;
    return changed();
  },

  transformCancel() {
    const s = transformSession;
    if (!s) return info();
    transformSession = null;
    need().drop_snapshot(s.hidden);
    if (s.base !== null) need().drop_snapshot(s.base);
    history.restoreOpen();
    history.abort();
    selGen++;
    return changed();
  },

  // Turns the open layer session into a warp: the pending matrix `m` (null: unmodified) is rendered
  // bicubic and the result becomes the warp source, returned like transformBegin.
  transformWarp(m: number[] | null, maxSide = 2048) {
    const e = need(), s = transformSession;
    if (!s) throw new Error('The transform was cancelled.');
    if (s.kind === 'selection') throw new Error('Warp bends layer pixels, not the selection outline.');
    if (s.kind !== 'layer') throw new Error(WARP_LAYER_ONLY);
    const kind = findNode(e, s.id)?.kind;
    if (kind !== 'pixel' && kind !== 'smart') throw new Error('Only pixel layers and smart objects can be warped.');
    let base: number | null = null;
    try {
      restoreBase(e, s.base);
      if (m) applyTransform(e, s.kind, s.id, m, 'bicubic');
      const found = e.layer_bounds(s.id) as Box | null;
      if (!found) throw new Error('There are no pixels to warp.');
      const smart = kind === 'smart' ? smartWarpStart(e, s.id, maxSide) : null;
      const bounds = smart?.bounds ?? Array.from(found) as Box;
      const lifted = smart ?? { ...liftPreview(e, s.id, bounds, false, maxSide), mesh: null };
      if (m) base = e.snapshot();
      e.clear(s.id, 'pixels');
      e.drop_snapshot(s.hidden);
      if (s.base !== null) e.drop_snapshot(s.base);
      Object.assign(s, { hidden: e.snapshot(), refined: null, base, label: m ? 'Free Transform and Warp' : 'Warp' });
      version++;
      return { ...info()!, bounds, ...lifted };
    } catch (err) {
      if (base !== null) e.drop_snapshot(base);
      e.restore(s.hidden);
      s.refined = null;
      version++;
      throw err;
    }
  },

  // Replays the unit-square transform `n` on the layer's tight bounds; the mask stays.
  transformAgain(id: number, n: number[], interp: string) {
    const e = need(), b = e.layer_bounds(id) as Box | null;
    const m = b && denormalize(n, { x: b[0], y: b[1], w: b[2], h: b[3] });
    if (!m || isIdentity(m)) throw new Error('Transform Again changed nothing.');
    history.run('Transform Again', () => e.transform_layer(id, Float64Array.from(m), interp, false));
    return changed();
  },

  rotateExact(id: number, kind: 'cw' | 'ccw' | '180' | 'flipH' | 'flipV', label: string) {
    const e = need();
    history.run(label, () => e.rotate_layer_exact(id, kind));
    return changed();
  },

  // Image menu canvas commands: every plane moves with the canvas, so the selection changes too.
  cropToSelection() {
    const e = need();
    const sel = (JSON.parse(e.channels_json()) as { selection: { bounds: Box | null } | null }).selection;
    const r = intersect(sel?.bounds ?? null, [0, 0, e.width(), e.height()]);
    if (!r) throw new Error('Make a selection to crop to.');
    return canvasEdit('Crop', () => e.apply_crop(...r, false));
  },

  // Crop tool commit: a non-zero straighten angle turns the canvas by -angle first, same step.
  cropTool(x: number, y: number, w: number, h: number, angle: number, deleteCropped: boolean) {
    const e = need();
    return canvasEdit('Crop', () => e.crop_rotated(x, y, w, h, angle, deleteCropped));
  },

  // quad = c0..c3 as flat x, y, mapped to the output's corners clockwise from the top-left.
  perspectiveCrop(quad: number[], w: number, h: number) {
    const e = need();
    return canvasEdit('Perspective Crop', () => { e.perspective_crop(Float64Array.from(quad), w, h, 'bicubic'); return true; });
  },

  trim(basedOn: 'transparent' | 'topLeftPixel' | 'bottomRightPixel', top: boolean, bottom: boolean, left: boolean, right: boolean) {
    const e = need();
    return canvasEdit('Trim', () => e.trim(basedOn, top, bottom, left, right));
  },

  revealAll() {
    const e = need();
    return canvasEdit('Reveal All', () => e.reveal_all());
  },

  rotateCanvas(kind: '180' | 'cw' | 'ccw' | 'flipH' | 'flipV') {
    const e = need();
    return canvasEdit(CANVAS_REMAPS[kind], () => { e.rotate_canvas_exact(kind); return true; });
  },

  rotateCanvasArbitrary(deg: number, interp: 'nearest' | 'bilinear' | 'bicubic') {
    const e = need();
    return canvasEdit('Rotate Canvas', () => e.rotate_canvas(deg, interp));
  },

  // `label` overrides the generic per-key label, for the Properties panel's "Adjustment
  // Visibility"/"Adjustment Clipping" checkboxes (B5-5), which share `visible`/`clipping` with
  // every other layer but need their own undo text.
  setProps(id: number, props: Partial<{
    name: string; visible: boolean; opacity: number; fill: number; blend: string; clipping: boolean;
    locks: Partial<{ transparency: boolean; pixels: boolean; position: boolean }>; mask_enabled: boolean;
  }>, label?: string) {
    const e = need();
    history.run(label ?? propsLabel(props), () => e.set_props(id, JSON.stringify(props)));
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

  // Layer > New Fill Layer: `label` is the per-type menu label ("Solid Color"/"Gradient"/"Pattern"),
  // `name` the layer's name ("Color Fill"/"Gradient Fill"/"Pattern Fill"). One engine call masks the
  // new layer to the selection (or reveals all) and drops the selection, so this is one undo step.
  newFillLayer(above: number, content: FillContent, name: string, label: string) {
    const e = need();
    let created = 0;
    history.run(label, () => { created = e.add_fill_layer(above, JSON.stringify({ name, content })); });
    selGen++;
    return { ...changed(), created };
  },

  // Layer > Layer Content Options: replaces every selected fill layer's content as one undo step.
  setFillContent(ids: number[], content: FillContent) {
    const e = need();
    history.run('Layer Content Options', () => { for (const id of ids) e.set_content(id, JSON.stringify(content)); });
    return changed();
  },

  // Color Lookup file picker (D9): adds the `.cube`/`.3dl` bytes as a blob, no undo step of its
  // own (the params commit that follows is the actual edit).
  loadLookupTable(bytes: Uint8Array) {
    return Number(need().blob_add(bytes));
  },

  // Layer > New Adjustment Layer / the Adjustments panel: `label` is both the layer's default name
  // and the undo label (B5-5), the kind's plain menu label ("Hue/Saturation", no spaces).
  newAdjustmentLayer(above: number, adjustment: Adjustment, label: string) {
    const e = need();
    let created = 0;
    history.run(label, () => { created = e.add_special(above, JSON.stringify({ name: label, adjustment })); });
    return { ...changed(), created };
  },

  // Properties panel edit: one undo step per committed change, `label` the spaced B5-5 form
  // ("Hue / Saturation"); `preview` reruns a slider drag live until `previewEnd`.
  setAdjustment(id: number, adjustment: Adjustment, label: string, preview = false) {
    const e = need();
    return edit(label, preview, () => e.set_adjustment(id, JSON.stringify(adjustment)));
  },

  // Image > Adjustments: destructive apply on the layer's pixels; `preview` reruns inside the open
  // preview session opened by the dialog (see `previewEnd`), like `fillEx`.
  adjust(id: number, adjustment: Adjustment | DestructiveAdjustment, label: string, preview = false) {
    const e = need();
    const json = JSON.stringify(adjustment);
    return edit(label, preview, () => (DESTRUCTIVE.has(adjustment.kind) ? e.apply_destructive(id, json) : e.apply_adjustment(id, 'pixels', json)));
  },

  // Layer > Rasterize > Fill Content.
  rasterizeFill(id: number) {
    const e = need();
    history.run('Rasterize Fill Content', () => e.rasterize_fill(id));
    return changed();
  },

  // Layer Style dialog: the style, blending options, fill opacity and (when an angle with global light
  // changed) the document light as one "Layer Style" step; `preview` reruns inside the preview session.
  setLayerStyle(id: number, style: LayerStyle, blending: Blending, fill: number, light: GlobalLight | null, preview = false) {
    const e = need();
    return edit('Layer Style', preview, () => {
      e.paste_style(Uint32Array.of(id), JSON.stringify(style));
      e.set_blending(id, JSON.stringify(blending));
      e.set_props(id, JSON.stringify({ fill }));
      if (light) e.set_document_m3(JSON.stringify({ global_light: normLight(light) }));
    });
  },

  // Layers panel eyes and fx-badge drags: one step under `label` replacing `id`'s style.
  editLayerStyle(id: number, style: LayerStyle, label: string) {
    const e = need();
    history.run(label, () => e.paste_style(Uint32Array.of(id), JSON.stringify(style)));
    return changed();
  },

  // Copy changes nothing, so it records no step.
  copyLayerStyle(id: number) {
    styleClipboard = need().copy_style(id);
    return info();
  },

  pasteLayerStyle(ids: number[]) {
    const e = need();
    const json = styleClipboard;
    if (!json) throw new Error('Copy a layer style first.');
    history.run('Paste Layer Style', () => e.paste_style(Uint32Array.from(ids), json));
    return changed();
  },

  clearLayerStyle(ids: number[]) {
    const e = need();
    history.run('Clear Layer Style', () => { for (const id of ids) e.clear_style(id); });
    return changed();
  },

  // Drag of the fx badge: moves the effects to `to`, or copies them with `copy`.
  dragLayerStyle(from: number, to: number, copy: boolean) {
    const e = need();
    history.run(copy ? 'Copy Layer Style' : 'Move Layer Style', () => {
      e.paste_style(Uint32Array.of(to), e.copy_style(from));
      if (!copy) e.clear_style(from);
    });
    return changed();
  },

  setGlobalLight(light: GlobalLight) {
    const e = need();
    history.run('Global Light', () => e.set_document_m3(JSON.stringify({ global_light: normLight(light) })));
    return changed();
  },

  createLayersFromStyle(id: number) {
    const e = need();
    let created: number[] = [];
    history.run('Create Layers', () => { created = Array.from(e.create_layers_from_style(id)); });
    return { ...changed(), created };
  },

  hideAllEffects() {
    const e = need();
    history.run('Hide All Effects', () => e.hide_all_effects());
    return changed();
  },

  // `percent` 1..1000.
  scaleEffects(id: number, percent: number) {
    const e = need();
    history.run('Scale Effects', () => e.scale_effects(id, percent / 100));
    return changed();
  },

  // Window > Layer Comps footer "+": snapshots every layer under "Layer Comp N" (lowest free N).
  captureLayerComp() {
    const e = need();
    let created = 0;
    history.run('New Layer Comp', () => { created = e.capture_layer_comp(nextCompName()); });
    return { ...changed(), created };
  },

  applyLayerComp(id: number) {
    const e = need();
    history.run('Apply Layer Comp', () => e.apply_layer_comp(id));
    return changed();
  },

  deleteLayerComp(id: number) {
    const e = need();
    history.run('Delete Layer Comp', () => e.delete_layer_comp(id));
    return changed();
  },

  // Layer Comps panel options: name, comment and the three apply flags.
  updateLayerComp(id: number, options: { name?: string; comment?: string; applyVisibility?: boolean; applyPosition?: boolean; applyAppearance?: boolean }) {
    const e = need();
    const { applyVisibility, applyPosition, applyAppearance, ...rest } = options;
    const json = { ...rest, apply_visibility: applyVisibility, apply_position: applyPosition, apply_appearance: applyAppearance };
    history.run('Layer Comp Options', () => e.update_layer_comp(id, JSON.stringify(json)));
    return changed();
  },

  // 4 x 256 counts (luminosity, R, G, B) of a layer's pixels, or of the composite for id 0.
  histogram(id: number): Uint32Array {
    return need().histogram(id);
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
  // Brush presets send the full engine StrokeIn shape (brushes/preset.ts toStrokeParams).
  strokeBegin(layerId: number, target: 'pixels' | 'selection', params: StrokeParams | Record<string, unknown>, label: string) {
    const e = need();
    const { eraseToHistory, ...rest } = params as StrokeParams;
    const p: Record<string, unknown> = rest;
    if (eraseToHistory) {
      const snap = history.oldestSnapshot();
      if (snap !== null) p.eraseToHistory = snap;
    }
    history.begin(label);
    try {
      e.stroke_begin(layerId, target, JSON.stringify(withEngineAssets(e, p)));
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

  // RGBA8 stroke preview (w x h, engine caps it at 1024 x 256); needs no open document.
  brushPreview(params: StrokeParams | Record<string, unknown>, w: number, h: number) {
    const e = previewEngine();
    const px = e.brush_preview(JSON.stringify(withEngineAssets(e, params as Record<string, unknown>)), w, h);
    return { w, h, data: px.buffer as ArrayBuffer };
  },

  // Sampled tip (8-bit alpha, row-major) / pattern (channels 1 gray or 4 RGBA); ids are stable across documents.
  tipAdd(w: number, h: number, alpha: Uint8Array) { return addAsset(previewEngine(), { kind: 'tip', w, h, data: alpha }); },
  tipRemove(id: number) { removeAsset(id); },
  patternAdd(w: number, h: number, data: Uint8Array, channels: number) { return addAsset(previewEngine(), { kind: 'pattern', w, h, data, channels }); },
  patternRemove(id: number) { removeAsset(id); },

  // File > Place Embedded / Place Linked: fit down only, centred, one step, no transform session. A linked
  // placement stores the file handle (D7) under a new link id.
  async placeSmart(above: number, file: File, linked: boolean, handle: FileSystemFileHandle | null = null) {
    const e = need();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const src = await decodeSource(bytes);
    const W = e.width(), H = e.height(), f = Math.min(1, W / src.w, H / src.h);
    const transform = [f, 0, Math.round((W - f * src.w) / 2), 0, f, Math.round((H - f * src.h) / 2), 0, 0, 1];
    let link: SmartLink = { type: 'embedded', id: uuid() };
    if (linked) {
      if (!handle) throw new Error('Place Linked needs a file from the file picker.');
      link = { type: 'linked', name: file.name, handle: uuid() };
      await putHandle(link.handle, handle);
    }
    let created = 0;
    history.run(linked ? 'Place Linked' : 'Place Embedded', () => {
      const blob = linked ? null : Number(e.blob_add(bytes));
      const json = { name: file.name.replace(/\.[^.]+$/, ''), link, source_blob: blob, source_size: [src.w, src.h], transform };
      created = e.place_smart(above, JSON.stringify(json), src.rgba);
    });
    return { ...changed(), created };
  },

  // Sibling layers into one smart object; its source bytes are a PSB of the layers (D5).
  convertToSmart(ids: number[]) {
    const e = need();
    const nodes = ids.map(id => findNode(e, id));
    if (!nodes.length || nodes.some(n => !n)) throw new Error('Select a layer to convert.');
    const used = new Set<string>();
    const walk = (ns: LayerNode[]) => { for (const n of ns) { used.add(n.name); if (n.children) walk(n.children); } };
    walk(JSON.parse(e.layers_json()));
    const name = nodes.length === 1 ? nodes[0]!.name : used.has('Group') ? nextName('Group') : 'Group';
    const sub = e.extract_document(Uint32Array.from(ids));
    let bytes: Uint8Array | null = null;
    // A source PSD cannot hold everything (16-bit, smart filters): the source pixels still render and edit.
    try { bytes = exportPsd(sub, { psb: true }).bytes; } catch { bytes = null; } finally { sub.free(); }
    let created = 0;
    history.run('Convert to Smart Object', () => {
      const blob = bytes ? Number(e.blob_add(bytes)) : null;
      created = e.convert_to_smart(Uint32Array.from(ids), JSON.stringify({ name, link_id: uuid(), source_blob: blob }));
    });
    return { ...changed(), created };
  },

  smartViaCopy(id: number) {
    const e = need();
    let created = 0;
    history.run('New Smart Object via Copy', () => { created = e.smart_via_copy(id, uuid()); });
    return { ...changed(), created };
  },

  // Layer > Smart Objects > Rasterize and Layer > Rasterize > Smart Object.
  rasterizeSmart(id: number, label: string) {
    const e = need();
    history.run(label, () => e.rasterize_smart(id));
    return changed();
  },

  // A linked object becomes embedded, since the new bytes come from another file.
  async replaceContents(id: number, file: File) {
    const e = need(), s = smartOf(e, id).smart;
    const bytes = new Uint8Array(await file.arrayBuffer()), src = await decodeSource(bytes);
    history.run('Replace Contents', () => {
      const link = s.link.type === 'linked' ? { type: 'embedded', id: uuid() } : undefined;
      const json = { link, source_blob: Number(e.blob_add(bytes)), source_size: [src.w, src.h] };
      e.replace_smart_contents(id, JSON.stringify(json), src.rgba);
    });
    return changed();
  },

  // The original placed bytes, unmodified, and a file name for them.
  async exportContents(id: number) {
    const e = need(), { node, smart } = smartOf(e, id);
    const bytes = await sourceBytes(e, smart);
    if (!bytes) throw new Error('This Smart Object has no source file to export. Reopen the original PSD or use Replace Contents.');
    const name = smart.link.type === 'linked' ? smart.link.name : `${node.name}.${extOf(bytes)}`;
    return { name, blob: new Blob([bytes as Uint8Array<ArrayBuffer>]) };
  },

  // Writes the embedded bytes to `handle` and links to it.
  async convertToLinked(id: number, handle: FileSystemFileHandle) {
    const e = need(), s = smartOf(e, id).smart;
    if (s.link.type === 'linked') throw new Error('This Smart Object is already linked.');
    const bytes = await sourceBytes(e, s);
    if (!bytes) throw new Error('This Smart Object has no source file to link.');
    await writeHandle(handle, bytes);
    const key = uuid();
    await putHandle(key, handle);
    history.run('Convert to Linked', () => e.set_smart_link(id, JSON.stringify({ link: { type: 'linked', name: handle.name, handle: key }, source_blob: null })));
    return changed();
  },

  async convertToEmbedded(id: number) {
    const e = need(), s = smartOf(e, id).smart;
    if (s.link.type !== 'linked') throw new Error('This Smart Object is already embedded.');
    const bytes = await readLinked(s.link);
    history.run('Convert to Embedded', () => e.set_smart_link(id, JSON.stringify({ link: { type: 'embedded', id: uuid() }, source_blob: Number(e.blob_add(bytes)) })));
    return changed();
  },

  // Links to another file; the placement keeps its corners like Replace Contents.
  async relinkToFile(id: number, file: File, handle: FileSystemFileHandle) {
    const e = need();
    smartOf(e, id);
    const src = await decodeSource(new Uint8Array(await file.arrayBuffer()));
    const link = { type: 'linked', name: file.name, handle: uuid() };
    await putHandle(link.handle, handle);
    history.run('Relink Smart Object', () => e.replace_smart_contents(id, JSON.stringify({ link, source_blob: null, source_size: [src.w, src.h] }), src.rgba));
    return changed();
  },

  // Rereads linked files: `id`'s, or every linked smart object's (null), as one step.
  async updateModified(id: number | null) {
    const e = need();
    const linked: LayerNode[] = [];
    const walk = (ns: LayerNode[]) => { for (const n of ns) { if (n.smart?.link.type === 'linked') linked.push(n); if (n.children) walk(n.children); } };
    walk(JSON.parse(e.layers_json()));
    const pick = id === null ? linked : linked.filter(n => n.id === id);
    if (!pick.length) throw new Error(id === null ? 'There are no linked smart objects.' : 'Update Modified Content works on linked smart objects.');
    const seen = new Set<string>(), jobs: { id: number; w: number; h: number; rgba: Uint8Array }[] = [];
    for (const n of pick) {
      const link = n.smart!.link as SmartLink & { type: 'linked' };
      if (seen.has(link.handle)) continue;
      seen.add(link.handle);
      jobs.push({ id: n.id, ...await decodeSource(await readLinked(link)) });
    }
    history.run('Update Smart Object Contents', () => {
      for (const j of jobs) e.update_smart_source(j.id, JSON.stringify({ source_blob: null, source_size: [j.w, j.h] }), j.rgba);
    });
    return changed();
  },

  // Stored only (D11); null is None.
  setStackMode(id: number, mode: string | null) {
    const e = need();
    history.run('Stack Mode', () => e.set_stack_mode(id, JSON.stringify(mode)));
    return changed();
  },

  // Edit Contents (D6): the source opens in place of this document; its parent waits on a stack.
  async editContents(id: number) {
    const e = need(), { node, smart } = smartOf(e, id);
    const bytes = await sourceBytes(e, smart);
    let sub: Engine;
    if (bytes && isPsdBytes(bytes)) {
      const r = importPsd(bytes, { psb: true });
      sub = r.engine;
      await loadSources(sub, r.sources, () => {});
    } else if (bytes) {
      const src = await decodeSource(bytes);
      sub = new Engine(src.w, src.h, 8);
      putRgba(sub, BACKGROUND, src.w, src.h, src.rgba);
    } else {
      throw new Error('This Smart Object has no embedded source file. Use Replace Contents or reopen the original PSD.');
    }
    parents.push({ eng: e, history, name, id, saved: 0 });
    eng = sub;
    history = historyOf(sub);
    name = node.name;
    docId++;
    version++;
    selGen++;
    parents.at(-1)!.saved = version;
    return info()!;
  },

  // Writes the open contents back to every smart object in the parent sharing the source, as one parent step.
  async smartEditSave() {
    const p = parents.at(-1);
    if (!p) throw new Error('No smart object contents are open.');
    const sub = need();
    const node = findNode(p.eng, p.id);
    if (!node?.smart) throw new Error('The original Smart Object was removed or replaced. Use Save As to keep these contents.');
    const link = node.smart.link;
    let bytes: Uint8Array;
    if (link.type === 'embedded') bytes = exportPsd(sub, { psb: true }).bytes;
    else {
      const ext = (link.name.split('.').pop() ?? '').toLowerCase();
      if (ext === 'psd' || ext === 'psb') bytes = exportPsd(sub, { psb: ext === 'psb' }).bytes;
      else if (RASTER[ext]) bytes = new Uint8Array(await (await encodeFlattened(sub, RASTER[ext])).arrayBuffer());
      else throw new Error(`Cannot save linked .${ext} contents. Use Save As to keep your edits.`);
      const h = await getHandle(link.handle).catch(() => null);
      if (!h) throw unavailable(link.name);
      try { await writeHandle(h, bytes); } catch { throw new Error('Could not save the linked source file.'); }
    }
    const rgba = compositeRgba(sub), size = [sub.width(), sub.height()];
    p.history.run('Update Smart Object Contents', () => {
      const blob = link.type === 'embedded' ? Number(p.eng.blob_add(bytes)) : null;
      p.eng.update_smart_source(p.id, JSON.stringify({ source_blob: blob, source_size: size }), rgba);
    });
    p.saved = version;
    return info()!;
  },

  // Writes back unsaved changes, then the parent returns with its history.
  async smartEditClose() {
    const p = parents.at(-1);
    if (!p) throw new Error('No smart object contents are open.');
    if (version !== p.saved) await api.smartEditSave();
    parents.pop();
    history.clear();
    eng!.free();
    eng = p.eng;
    history = p.history;
    name = p.name;
    docId++;
    selGen++;
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
    return encodeFlattened(need(), type, quality);
  },

  // File > Export > Layer Comps to Files: applies each comp to a clone of the document, flattens
  // and encodes it, and discards the clone; the open document stays unchanged. TIFF is not
  // available through the browser's canvas encoder, so only PNG/JPEG/WebP are offered.
  async exportLayerCompsToFiles(type: 'image/png' | 'image/jpeg' | 'image/webp', quality?: number) {
    const e = need();
    const manifest = e.manifest();
    const comps = (JSON.parse(e.channels_json()) as { layer_comps: { id: number; name: string }[] }).layer_comps;
    const files: { name: string; blob: Blob }[] = [];
    for (const c of comps) {
      const clone = loadEngine(manifest, id => e.tile_bytes(BigInt(id)));
      try {
        clone.apply_layer_comp(c.id);
        files.push({ name: c.name, blob: await encodeFlattened(clone, type, quality) });
      } finally {
        clone.free();
      }
    }
    return files;
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
    if (parents.length) return api.smartEditClose();
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

// Ops that may run while a stroke is open without committing it (they never touch the document or history).
const STROKE_OPS = new Set<keyof Api>(['strokeBegin', 'strokeTo', 'strokeEnd', 'strokeCancel', 'brushPreview', 'tipAdd', 'tipRemove', 'patternAdd', 'patternRemove']);
const PREVIEW_OPS = new Set<keyof Api>(['fillEx', 'strokeSelection', 'adjust', 'setAdjustment', 'setLayerStyle', 'previewEnd', 'sample', 'brushPreview', 'tipAdd', 'patternAdd']);
// An open move session commits before any other op, so history never sees a half move.
const MOVE_OPS = new Set<keyof Api>(['moveLayerStep', 'moveLayerCommit', 'moveLayerCancel', 'movePixelsStep', 'movePixelsCommit', 'movePixelsCancel', 'sample', 'snapTargets', 'movingBounds']);
// An open transform session is cancelled by any other op: only the UI knows its current matrix.
const TRANSFORM_OPS = new Set<keyof Api>(['transformRefine', 'transformUnrefine', 'transformCommit', 'transformCancel', 'transformWarp', 'sample', 'snapTargets', 'movingBounds', 'selectionAt']);

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
    // Anything but a preview rerun, its end or a read cancels an open preview.
    if (previewOpen && !PREVIEW_OPS.has(op) && eng) { try { endPreview(false); } catch { /* cancel never throws */ } version++; }
    if (moveSession && !MOVE_OPS.has(op) && eng) api.moveLayerCommit();
    if (transformSession && !TRANSFORM_OPS.has(op) && eng) postMessage({ event: 'transformCancelled', doc: api.transformCancel() } satisfies WorkerEvent);
    return handle(id, op, args);
  });
};
