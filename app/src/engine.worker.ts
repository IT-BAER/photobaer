import init, { Engine, Fonts, HdrMerge, convert_color, filter_schema, type ImageTiles, fit_path, icc_builtins, icc_describe, live_path, puppet_geometry, vanishing_connected, vanishing_render, type Liquify } from './engine-pkg/photobaer_engine.js';
import { FontStore } from './fonts/store.ts';
import { History } from './history.ts';
import { Autosave } from './autosave.ts';
import { tileIds } from './project.ts';
import { importPsd, exportPsd, compositeRgba, grayIcc, isPsdBytes, psdIcc } from './psd.ts';
import { getHandle, putHandle } from './links.ts';
import { denormalize, isIdentity } from './transform/matrix.ts';
import type { Density, Geometry, Grid, Rig } from './transform/puppet.ts';
import { defaultBlending, effectRows, patternRefs, type Blending, type LayerStyle } from './layerStyle.ts';
import type { PatternRecord } from './brushes/preset.ts';
import { DESTRUCTIVE_KINDS } from './adjustments.ts';
import { layerCss, pngSvg, shapeSvg } from './app/svgcss.ts';
import { makePdf, type PdfPage } from './app/webExport.ts';
import { BOOL_LABEL } from './shell/shapetools.ts';
import { layerName } from './shell/typesession.ts';
import { flatNodes, locate, nodeById } from './layers.ts';
import { toParagraphText, toPointText } from './shell/typecommands.ts';
import type { TextJson } from './psd/text.ts';
import type { Spot, AlignMode, Adjustment, ColorMode, ModeSpec, IccProfile, FaceInfo, LiquifyOp, VanishingPlane, VanishingState, AutosaveState, Box, ContentAwareOpts, DestructiveAdjustment, DocInfo, FillContent, FillParams, GlobalLight, GradientParams, ArtboardBackground, BoolOp, Guide, LayerNode, OpenResult, PathRole, SavedPathInfo, SelectShape, SmartFilterInfo, SmartFilterKind, SmartLink, StrokeParams, StrokeSelectionParams, TransformKind, TransformOp, VectorMaskInfo, VectorPath, WorkerEvent } from './worker/types.ts';
import { boxScale, thumbSize } from './app/navigator.ts';
import { inkGray } from './app/channels.ts';
import { CMYK_SPACES, DEFAULT_COLOR_SETTINGS, RGB_SPACES, openAction, type ColorSettings, type OpenAction } from './app/colorSettings.ts';
import { openProfileStore, type ProfileStore } from './app/profileStore.ts';
import { DEFAULT_VIEW, engineView, proofLabel, sanitizeHdr, type ViewState } from './app/proof.ts';
import { grayFile, psdWithIcc, readIcc } from './app/iccFiles.ts';
import { embedInfo, hasInfo, readInfo, type FileInfo } from './app/fileInfo.ts';
import { emptyAnnotations, framePath, rotationAbout, type Annotations } from './app/measure.ts';
import { emptyVariables, planDataSet, replaceText, type Variables } from './app/variables.ts';
import { assetSpecs } from './app/webExport.ts';
import { TILE, levelFor } from './view.ts';
import { NO_RECORD, decodeCall, encodeCall, hot, newIds, recordable, type ActionStep, type Call, type Layers } from './actions.ts';
import { decodeExr, decodeHdr, encodeExr, encodeHdr, encodeIco, fromLinear, toLinear, type FloatImage } from './formats.ts';
import { applyTransform, collectPixelIds, decodeSource, displayRegion, displayTiers, shiftedRegion, docInfo, docPatterns, encodeFlattened, exportAsset, type ExportOptions, ensurePatterns, extOf, icoEntries, findNode, gather, intersect, layerPng, layerTile, liftPreview, loadEngine, loadSources, nodeTiles, normLight, presetPatterns, propsLabel, putRgba, RASTER, readLinked, sameOp, smartOf, smartWarpStart, sourceBytes, tierLevel, tileLoop, tileThumb, topLevelAncestor, unavailable, uuid, visibleTopDown, WARP_LAYER_ONLY, writeHandle } from './worker/helpers.ts';

export type { GradientDef, FillContent, LevelsRecord, Hsl, HueRange, Adjustment, DestructiveAdjustment, SmartLink, SmartWarp, SmartFilterKind, SmartFilterInfo, SmartInfo, LayerNode, DocInfo, GlobalLight, ArtboardBackground, Guide, PathRole, SavedPathInfo, VectorPath, SelectShape, OpenResult, AutosaveState, WorkerEvent, StrokeParams, FillParams, StrokeSelectionParams, GradientParams } from './worker/types.ts';

const DESTRUCTIVE = new Set<string>(DESTRUCTIVE_KINDS);

// A new document has one pixel layer with node id 1.
const BACKGROUND = 1;

let eng: Engine | null = null;
let name = 'Untitled';
let docId = 0;
let version = 0;
// Layers panel thumbnail cache (layerThumbs), valid for one document id.
const thumbs = new Map<number, { key: string; thumb: { id: number; key: string; w: number; h: number; data: ArrayBuffer } }>();
let thumbDoc = -1;
let autosave: Autosave | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<void> | null = null;
let again = false;
let booted = false;
let lastState: AutosaveState = 'off';
let selGen = 0;
// Image > Mode > Indexed Color: the last conversion's table, for Palette: Previous.
let previousTable: [number, number, number][] | null = null;
let strokeOpen = false;
// The open Liquify dialog's mesh and layer proxy (docs/M5.md section 6).
let liquify: Liquify | null = null;
// The open Vanishing Point dialog's layer proxy (straight RGBA8, docs/M5.md section 7).
let vp: { data: Uint8Array; w: number; h: number; scale: number } | null = null;
// Move tool live session: a snapshot taken right after any duplicate, restored and replayed
// from on every step so the previewed offset never compounds.
// `pixels`: a selected-pixels session; `floating`: the live document hides the moved pixels (moveFloat).
// `patch` renders sharp images of an open float over other doc rects (moveFloatPatch); `base` its
// whole-layer images when moveFloat returned only the view's; `reveal` shows the layers an open float
// hides and returns the call that hides them again.
let moveSession: {
  liveBase: number; targetId: number; duplicated: boolean; lastDx: number; lastDy: number; pixels: boolean; floating: boolean;
  patch?: (moved: Box | null, above: Box | null) => { moved: ReturnType<typeof liftPreview> | null; above: ReturnType<typeof liftPreview> | null };
  base?: () => { moved: ReturnType<typeof shiftedRegion>; above: ReturnType<typeof shiftedRegion> };
  reveal?: () => () => void;
} | null = null;
// Runs `f` on the document as it is without an open layer float (Navigator, Histogram).
function unfloated<T>(e: Engine, f: () => T): T {
  const s = moveSession, hide = s?.floating && e === eng ? s.reveal?.() : undefined;
  try { return f(); } finally { hide?.(); }
}
// moveFloat for a top-level layer the plain float cannot show: the moved layer with its effects and the
// visible layers above come back as display images at the view's level, and the document shows what is
// below until the next step. Null when the images over that would not look the same: non-normal blends,
// adjustments, clipping onto the layer, Blend If, knockout, or a shadow or outer glow whose blend mixes
// with what is below (exact alone only as normal, black multiply or white screen).
function moveSplit(e: Engine, s: NonNullable<typeof moveSession>, tree: LayerNode[], i: number, scale: number, view: Box | null) {
  const n = tree[i], above = tree.slice(i + 1), plainIf = JSON.stringify(defaultBlending().blend_if);
  const exact = (e: { present: boolean; enabled: boolean; blend: string }, c: number[] | null) =>
    !e.present || !e.enabled || e.blend === 'normal' || (e.blend === 'multiply' && !!c?.every(v => v === 0)) || (e.blend === 'screen' && !!c?.every(v => v === 255));
  const behind = (st: LayerStyle | null) => !st?.enabled || (st.drop_shadows.every(d => exact(d, d.color))
    && (!st.outer_glow || exact(st.outer_glow, st.outer_glow.fill.type === 'color' ? st.outer_glow.fill.color : null)));
  const alone = (m: LayerNode) => m.kind !== 'adjustment' && (m.blend === 'normal' || (m.kind === 'group' && m.blend === 'pass through'))
    && m.blending.knockout === 'none' && m.blending.channels.every(Boolean) && JSON.stringify(m.blending.blend_if) === plainIf && behind(m.style);
  // Layers that clip onto the moved one (the run of clipped layers right above, hidden ones included).
  const run = above.findIndex(t => !t.clipping);
  if (n.clipping || above.slice(0, run < 0 ? above.length : run).some(t => t.visible)) return null;
  if (![n, ...visibleTopDown(n.children ?? []), ...visibleTopDown(above)].every(alone)) return null;
  const W = e.width(), H = e.height(), level = levelFor(scale, 1, e.max_level());
  // The moved layer's extent with its effects, which may reach outside the canvas.
  const ids = collectPixelIds(tree, n.id), pad = e.effect_reach(n.id);
  const ext = ids.map(id => e.layer_bounds(id) as Box | null).reduce<Box | null>((u, b) => !b ? u : !u ? b
    : [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[0] + u[2], b[0] + b[2]) - Math.min(u[0], b[0]), Math.max(u[1] + u[3], b[1] + b[3]) - Math.min(u[1], b[1])], null);
  // shortcut: live preview only within one canvas size around the canvas (bounded memory and cells), and
  // only while shifting the layers per off-canvas cell stays cheap; farther parts appear on drop.
  const wide = intersect(ext ? [ext[0] - pad, ext[1] - pad, ext[2] + 2 * pad, ext[3] + 2 * pad] : [0, 0, W, H], [-W, -H, 3 * W, 3 * H]) ?? [0, 0, W, H];
  const area = ids.reduce((a, id) => { const b = e.layer_bounds(id) as Box | null; return a + (b ? b[2] * b[3] : 0); }, 0);
  const cells = (Math.ceil(wide[2] / W) + 1) * (Math.ceil(wide[3] / H) + 1) - 1;
  const reach: Box = area * cells * (e.depth() / 8) <= 1 << 28 ? wide : [0, 0, W, H];
  // The view's own tiles are drawn already, so their effects come from the tile cache; patches add the rest.
  const near = view && intersect([0, 0, W, H], view);
  const shown = tree.filter(t => t.visible).map(t => t.id), up = above.filter(t => t.visible).map(t => t.id);
  const show = (ids: number[]) => { for (const id of shown) e.set_props(id, JSON.stringify({ visible: ids.includes(id) })); };
  const below = shown.filter(id => id !== n.id && !up.includes(id));
  // The whole-layer images (coarse within 2 MP, sharp over `at` too), or with `only` the sharp images over `at` alone.
  const images = (at: Box | null, only: boolean) => {
    show([n.id]);
    const moved = only ? shiftedRegion(e, ids, level, at!) : displayTiers(e, level, at, reach, ids);
    show(up);
    const above = !up.length ? null : only ? displayRegion(e, level, at!) : displayTiers(e, level, at);
    show(below);
    return { moved, above };
  };
  // When the whole-layer image is coarser than the view, the drag starts with the sharp view images and
  // the coarse ones follow through moveFloatPatch.
  let pending = !!near && tierLevel(e, level, reach) > level, r: ReturnType<typeof images>;
  try {
    r = images(near, pending);
    if (pending && !r.moved) { pending = false; r = images(near, false); }
  } catch (err) {
    show(shown);
    throw err;
  }
  const { moved, above: top } = r;
  if (!moved) { show(shown); return null; }
  if (pending) s.base = () => { try { return images(null, false); } finally { show(below); } };
  s.patch = (mr, ar) => {
    const m = mr && intersect(reach, mr), a = up.length && ar ? intersect([0, 0, W, H], ar) : null;
    try {
      if (m) show([n.id]);
      const movedPatch = m && shiftedRegion(e, ids, level, m);
      if (a) show(up);
      return { moved: movedPatch, above: a && displayRegion(e, level, a) };
    } finally {
      show(below);
    }
  };
  s.reveal = () => { show(shown); return () => show(below); };
  s.floating = true;
  version++;
  return { ...info()!, layers: tree, over: null, ...moved, above: top && { over: null, ...top }, pending };
}
// Free transform / Transform Selection / Warp session: one open history step. `hidden` is the document
// with the source removed (the UI previews it), `refined` the matrix or warp mesh JSON last rendered for
// real, `base` the snapshot a warp applies to after a baked matrix (null: the step's start), `label` the
// commit label when it differs from the one the step opened with.
// Type edit session (docs/M4.md section 10): one open history step ("Edit Type Layer", or "Type Mask"
// holding the temporary layer); each update replaces the model and re-renders the layer.
let typeSession: { id: number; isNew: boolean; mask: boolean; changed: boolean; empty: boolean } | null = null;
let transformSession: { id: number; kind: TransformKind; hidden: number; refined: TransformOp | null; base: number | null; label: string | null } | null = null;
// Copy Layer Style's clipboard: the style JSON only (never blending options), kept across documents.
let styleClipboard: string | null = null;
// Edit > Copy / Cut / Copy Merged clipboard: straight RGBA8 with its document origin and the profile of
// its numbers, kept across documents.
let clipboard: { x: number; y: number; w: number; h: number; rgba: Uint8Array; icc?: Uint8Array } | null = null;
// Edit > Toggle Last State: the history and its serial right after a toggle undid a step (the next toggle redoes).
let toggled: { h: History; serial: number } | null = null;
const toggleRedo = () => !!toggled && toggled.h === history && toggled.serial === history.serial;
// Whether the selection is a hard-edged rectangle (Define Pattern), cached per selection generation.
let rectSel = { gen: -1, rect: false };
// Font registry and upload store: app scope, kept across documents; created on first use (after WASM init).
let fonts: Fonts | null = null;
const fontReg = () => fonts ??= new Fonts();
const resolution = (e: Engine) => (JSON.parse(e.vector_json()) as { resolution: number }).resolution;
let fontStore: Promise<FontStore | null> | null = null;
// Open live-preview session (Fill/Stroke dialogs): one history step, rerun from its start on every change.
let previewOpen = false;
// Actions: an open recording buffers the calls of the step in progress; playback suspends it.
let rec: { doc: number; last: Layers; created: number[]; buf: Call[] } | null = null;
let playing = false;
let playState: { created: number[]; last: Layers } | null = null;
let previewError: string | null = null;

const historyOf = (e: Engine) => new History({
  snapshot: () => e.snapshot(),
  restore: id => e.restore(id),
  drop: id => e.drop_snapshot(id),
  settle: () => e.settle_smart(),
});
let history = new History({ snapshot: () => need().snapshot(), restore: id => need().restore(id), drop: id => need().drop_snapshot(id), settle: () => need().settle_smart() });
// Edit Contents sessions (D6): each open source document's parent, innermost last. `id` is the smart object
// being edited in the parent, `saved` the nested document's version at its last write-back.
interface Parent { eng: Engine; history: History; name: string; id: number; saved: number }
let parents: Parent[] = [];
// Open documents (tabs) in tab order. The active one's state lives in the module globals above and is
// copied back into its entry only on switch, so `docs[active]` is stale while it is active.
// `saved` is the outermost history's top at the last project/PSD save (History.top); a document is dirty while it differs.
interface Doc { key: string; eng: Engine; history: History; name: string; version: number; parents: Parent[]; saved: object | null }
const docs: Doc[] = [];
let active = -1;
let saved: object | null = null;
// The save in progress: its tab and the `saved` it replaced, so a cancelled or failed write can put it back (saveEnd).
let pendingSave: { key: string; prev: object | null } | null = null;

function stash() {
  if (active >= 0) Object.assign(docs[active], { eng: eng!, history, name, version, parents, saved });
}

// Makes tab `i` the active document under a new document id (D1).
function activate(i: number) {
  active = i;
  ({ eng, history, name, version, parents, saved } = docs[i]);
  docId++;
  selGen++;
}

// Frees a non-active document with its history and Edit Contents parents.
function freeDoc(d: Doc) {
  for (const p of d.parents) { p.history.clear(); p.eng.free(); }
  d.history.clear();
  d.eng.free();
}

// The tab name: the outermost document's, also while Edit Contents shows a nested one.
// Unsaved history steps in the outermost document, or Edit Contents changes not written back yet.
function isDirty(i: number) {
  const d = i === active ? { history, version, parents, saved } : docs[i];
  return (d.parents[0]?.history ?? d.history).top !== d.saved || (d.parents.length > 0 && d.version !== d.parents.at(-1)!.saved);
}

const tabEngine = (i: number) => (i === active ? parents[0]?.eng ?? eng! : docs[i].parents[0]?.eng ?? docs[i].eng);
const tabDepth = (i: number) => tabEngine(i).depth();
const MODE_TAB: Record<ColorMode['kind'], string> = { bitmap: 'Bitmap', duotone: 'Duotone', indexed: 'Index', cmyk: 'CMYK', lab: 'Lab', multichannel: 'Multichannel' };
const tabMode = (i: number) => {
  const v = JSON.parse(tabEngine(i).vector_json()) as { gray?: boolean; mode?: ColorMode };
  return v.mode ? MODE_TAB[v.mode.kind] : v.gray ? 'Gray' : 'RGB';
};

const tabProof = (i: number) => {
  const v = viewOf(i === active ? eng! : docs[i].eng);
  return v.proofColors ? proofLabel(v.setup) : null;
};

const tabName = (i: number) => i === active ? parents[0]?.name ?? name : docs[i].parents[0]?.name ?? docs[i].name;

// One 8-bit mask at `level` from per-tile reads; tiles that read null are the default
// (255 if def > 0 else 0). A null default means there is no mask (data null).
// Apply Image / Calculations source: `doc` the tab key of another open document of the same size
// (absent: the active one), `layer` null is the merged image; see the engine's ImageSource.
export type ImageSource = { doc?: string; layer: number | null; channel: string; invert: boolean };
// Blending (a layer mode, or 'add' / 'subtract' with `scale` 1..2 and `offset` -255..255),
// opacity 0..1, and an optional mask source whose gray scales the effect.
export type CalcOpts = { mode: string; opacity: number; scale: number; offset: number; mask: ImageSource | null };

function maskAt(e: Engine, level: number, def: number | null, tile: (tx: number, ty: number) => unknown) {
  const scale = 1 << level;
  const w = Math.ceil(e.width() / scale), h = Math.ceil(e.height() / scale);
  if (def === null) return { docId, version, w, h, data: null };
  const data = new Uint8Array(w * h);
  if (def > 0) data.fill(255);
  for (let ty = 0; ty < Math.ceil(h / 256); ty++) {
    for (let tx = 0; tx < Math.ceil(w / 256); tx++) {
      const t = tile(tx, ty) as Uint8Array | null | undefined;
      if (!t) continue;
      const x0 = tx * 256, y0 = ty * 256, tw = Math.min(256, w - x0), th = Math.min(256, h - y0);
      for (let y = 0; y < th; y++) data.set(t.subarray(y * 256, y * 256 + tw), (y0 + y) * w + x0);
    }
  }
  return { docId, version, w, h, data: data.buffer as ArrayBuffer };
}

const emit = (state: AutosaveState, detail?: string) => {
  lastState = state;
  postMessage({ event: 'autosave', state, detail } satisfies WorkerEvent);
};

function info(): DocInfo | null {
  if (!eng) return null;
  const ch = JSON.parse(eng.channels_json()) as {
    selection: { default: number; bounds: [number, number, number, number] | null } | null;
    has_last_selection: boolean;
    channels: { id: number; name: string; spot: Spot | null }[];
    patterns: { id: string; name: string }[];
    layer_comps: { id: number; name: string; layer_count: number }[];
    global_light: GlobalLight;
  };
  const vec = JSON.parse(eng.vector_json()) as {
    resolution: number; guides: Guide[]; grid: { spacing_x: number; spacing_y: number }; gray?: boolean; mode?: ColorMode;
    guides_locked: boolean; artboards_locked: boolean; paths: SavedPathInfo[]; annotations?: Annotations;
  };
  return {
    resolution: vec.resolution, guides: vec.guides, paths: vec.paths, grid: vec.grid, gray: vec.gray ?? false, mode: vec.mode ?? null, profile: JSON.parse(eng.profile_json()), view: viewOf(eng),
    guidesLocked: vec.guides_locked, artboardsLocked: vec.artboards_locked, annotations: vec.annotations ?? emptyAnnotations(),
    docId, version, name,
    width: eng.width(), height: eng.height(), depth: eng.depth(), maxLevel: eng.max_level(),
    undoLabel: history.undoLabel, redoLabel: history.redoLabel, toggleRedo: toggleRedo(), hasClipboard: clipboard !== null,
    selectionRect: !!ch.selection && rectSelection(eng, ch.selection.default),
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
    key: docs[active].key,
    dirty: isDirty(active),
    docs: docs.map((d, i) => ({ key: d.key, name: tabName(i), active: i === active, dirty: isDirty(i), mode: tabMode(i), depth: tabDepth(i), proof: tabProof(i), width: tabEngine(i).width(), height: tabEngine(i).height() })),
  };
}

// Edit > Color Settings as the app sent them; null (the default) leaves documents untagged.
let colorSettings: ColorSettings | null = null;

type Embedded = { name: string | null; icc: Uint8Array | null; space: 'rgb' | 'gray'; warning?: string };

// The profile embedded in file bytes `b` when it matches the file's space (Gray for grayscale
// files, else RGB); a profile of another space is dropped with a warning.
async function embeddedProfile(b: Uint8Array): Promise<Embedded> {
  const space = grayFile(b) ? 'gray' : 'rgb';
  const icc = await readIcc(b);
  if (!icc) return { name: null, icc: null, space };
  try {
    const d = JSON.parse(icc_describe(icc)) as { name: string; space: string };
    if (d.space === space) return { name: d.name, icc, space };
    return { name: null, icc: null, space, warning: `The embedded ${d.space} profile "${d.name}" was ignored.` };
  } catch {
    return { name: null, icc: null, space, warning: 'The embedded color profile could not be read and was ignored.' };
  }
}

// Tags, converts or drops the embedded profile `p` of a just-opened engine (no history step).
function applyOpenProfile(e: Engine, p: Embedded, action: OpenAction, s: ColorSettings) {
  const builtin = (n: string) => (JSON.parse(icc_builtins()) as IccProfile[]).some(b => b.name === n);
  const working = s[p.space];
  if ((action === 'keep' || action === 'convert') && p.name && p.icc) e.assign_profile(p.name, builtin(p.name) ? new Uint8Array() : p.icc);
  if (action === 'convert') e.convert_to_profile(working, profileBytes(working), JSON.stringify({ intent: s.intent, blackPointCompensation: s.bpc, dither: s.dither }));
  if (action === 'assign') e.assign_profile(working, profileBytes(working));
}

// Grid points per axis of the CMYK separation table the channel views read.
const SEPARATION_GRID = 17;

// Profiles loaded with Load... this session, by name.
const loadedProfiles = new Map<string, { info: IccProfile; bytes: Uint8Array }>();
// The bytes of a loaded profile `name`, empty for a built-in one (the engine resolves it by name).
const profileBytes = (name: string) => loadedProfiles.get(name)?.bytes ?? new Uint8Array();
// The profiles stored by earlier sessions, read once; settings wait for them.
let storedProfiles: Promise<void> | null = null;
function readStoredProfiles() {
  storedProfiles ??= openProfileStore().then(async store => {
    profileStore = store;
    for (const p of (await store?.all().catch(() => [])) ?? []) {
      try { addProfile(p.bytes); } catch { /* unreadable now: skipped */ }
    }
  });
  return storedProfiles;
}
let profileStore: ProfileStore | null = null;
// The open Assign Profile preview: its engine and the snapshot from before it.
let assignPreview: { e: Engine; snap: number } | null = null;

function addProfile(bytes: Uint8Array): IccProfile {
  const d = JSON.parse(icc_describe(bytes)) as { name: string; space: string; class: string };
  if (d.space !== 'rgb' && d.space !== 'gray' && d.space !== 'cmyk') throw new Error(`"${d.name}" is a ${d.space} profile; only RGB, CMYK and Gray profiles can be used.`);
  const info = { name: d.name, space: d.space, loaded: true } as IccProfile;
  loadedProfiles.set(d.name, { info, bytes });
  return info;
}
// Each engine's view state (View menu proofing); engines without an entry show DEFAULT_VIEW.
const views = new WeakMap<Engine, ViewState>();
const viewOf = (e: Engine) => views.get(e) ?? DEFAULT_VIEW;

function applyView(e: Engine, v: ViewState) {
  const s = colorSettings;
  const json = { ...engineView(v, s?.cmyk ?? CMYK_SPACES[0]), desaturate: s?.desaturateOn ? s.desaturateBy / 100 : 0 };
  e.set_view(JSON.stringify(json), json.setup.profile ? profileBytes(json.setup.profile) : new Uint8Array());
}

// Base names of generated layers ("Layer 1", "Group 1"): the app passes the UI language's words to init;
// the counting below runs on whatever base is set.
let nameBases: Record<string, string> = {};
const baseName = (prefix: string) => nameBases[prefix] ?? prefix;

function nextCompName(): string {
  const base = baseName('Layer Comp');
  const used = new Set((JSON.parse(need().channels_json()) as { layer_comps: { name: string }[] }).layer_comps.map(c => c.name));
  for (let i = 1; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}

function nextName(prefix: string): string {
  prefix = baseName(prefix);
  const used = new Set<string>();
  const walk = (nodes: LayerNode[]) => { for (const n of nodes) { used.add(n.name); if (n.children) walk(n.children); } };
  walk(JSON.parse(need().layers_json()));
  for (let i = 1; ; i++) if (!used.has(`${prefix} ${i}`)) return `${prefix} ${i}`;
}

// Layer `id`'s pixels (null: the visible composite) in the selection times its coverage, cropped to
// the selection bounds and the layer content, both inside the canvas.
function copyPixels(e: Engine, id: number | null) {
  if (id !== null && findNode(e, id)?.kind !== 'pixel') throw new Error('Could not copy: the layer is not a pixel layer.');
  const sel = JSON.parse(e.channels_json()).selection as { default: number } | null;
  const canvas: Box = [0, 0, e.width(), e.height()], box = (v: unknown) => v ? Array.from(v as ArrayLike<number>) as Box : null;
  const b = intersect(sel ? intersect(canvas, box(e.selection_bounds())) : canvas, id === null ? canvas : box(e.layer_bounds(id)));
  const rgba = b && (id === null ? gather(b, 4, (tx, ty) => e.flatten_tile_rgba8(tx, ty)) : e.transform_preview(id, Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1), 1, false, ...b));
  if (b && rgba && sel) {
    const cov = gather(b, 1, (tx, ty) => e.selection_tile(0, tx, ty) as Uint8Array | null, sel.default > 0 ? 255 : 0);
    for (let i = 0; i < cov.length; i++) rgba[i * 4 + 3] = Math.round(rgba[i * 4 + 3] * cov[i] / 255);
  }
  if (!b || !rgba || !rgba.some((v, i) => i % 4 === 3 && v > 0)) throw new Error('Could not copy: the selected area is empty.');
  return { x: b[0], y: b[1], w: b[2], h: b[3], rgba };
}

// True when every pixel inside the selection bounds is fully selected.
function rectSelection(e: Engine, fill: number) {
  if (rectSel.gen !== selGen) {
    const sb = e.selection_bounds() as Int32Array | null;
    const b = sb && intersect([0, 0, e.width(), e.height()], Array.from(sb) as Box);
    const cov = b && gather(b, 1, (tx, ty) => e.selection_tile(0, tx, ty) as Uint8Array | null, fill > 0 ? 255 : 0);
    rectSel = { gen: selGen, rect: !!cov && cov.every(v => v === 255) };
  }
  return rectSel.rect;
}

// Merged visible straight RGBA8 inside the selection bounds (the canvas without a selection), at most `max` px a side.
function sampleMerged(e: Engine, max: number, tooLarge: () => never) {
  const canvas: Box = [0, 0, e.width(), e.height()];
  const sb = e.has_selection() ? e.selection_bounds() as Int32Array | null : undefined;
  const b = sb === undefined ? canvas : sb && intersect(canvas, Array.from(sb) as Box);
  if (!b) throw new Error('The selected area is empty.');
  if (b[2] > max || b[3] > max) tooLarge();
  return { b, rgba: gather(b, 4, (tx, ty) => e.flatten_tile_rgba8(tx, ty)) };
}

function need() {
  if (!eng) throw new Error('no document');
  return eng;
}

// [x, y, w, h] bounds of every anchor and handle in `path` (handles are absolute points, so this
// over-approximates a curve's extent by its control polygon - a cubic bezier never leaves the
// convex hull of its control points). Used for shape and vector-mask snap targets.
function vectorPathBounds(path: VectorPath): [number, number, number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sp of path.subpaths) {
    for (const p of sp.points) {
      for (let i = 0; i < 6; i += 2) {
        x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
        y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
      }
    }
  }
  return x0 === Infinity ? null : [x0, y0, x1 - x0, y1 - y0];
}

// Drops every open Edit Contents parent (a new or closed document replaces the whole stack).
function dropParents() {
  for (const p of parents.splice(0)) { p.history.clear(); p.eng.free(); }
}

// An Apply Image / Calculations source read from its document: the active one (`e`) or another tab.
function readSource(e: Engine, src: ImageSource) {
  const { doc, ...rest } = src;
  const i = doc === undefined ? active : docs.findIndex(d => d.key === doc);
  if (i < 0) throw new Error('The source document is no longer open.');
  return (i === active ? e : outerEng(i)).image_source(JSON.stringify(rest));
}

// Adds `e` as a new tab after the others and activates it; the open documents stay open.
// `key` restores an autosaved tab under its own key (its autosave folder), without scheduling a save.
function adopt(e: Engine, n: string, key?: string) {
  stash();
  docs.push({ key: key ?? uuid(), eng: e, history: historyOf(e), name: n, version: 1, parents: [], saved: null });
  if (colorSettings?.desaturateOn) applyView(e, viewOf(e));
  activate(docs.length - 1);
  if (!key) scheduleSave(0);
  return info()!;
}

// The PSD (or PSB) file of `e` with its color profile and File Info.
function psdFile(e: Engine, psb = false): { blob: Blob; warnings: string[] } {
  const { bytes, warnings } = exportPsd(e, { psb });
  const icc = psdIcc(e), i = docInfo(e);
  let b: Uint8Array = icc.length ? psdWithIcc(bytes, icc) : bytes;
  if (hasInfo(i)) b = embedInfo(b, 'image/vnd.adobe.photoshop', i);
  return { blob: new Blob([b as Uint8Array<ArrayBuffer>], { type: 'image/vnd.adobe.photoshop' }), warnings };
}

function markSaved() {
  pendingSave = null;
  if (parents.length) return;
  pendingSave = { key: docs[active].key, prev: saved };
  saved = history.top;
}

function changed() {
  version++;
  if (eng && eng.depth() === 32 && viewOf(eng).hdr.method === 'highlightCompression') eng.refresh_hdr_max();
  scheduleSave(1000);
  return info()!;
}

// One undo step, or with `preview` a rerun inside the open preview session (no autosave until previewEnd).
// One undo step when `fn` changed a pixel, none when it did not.
// Layer > Flatten Image: root nodes not drawn are deleted, the rest merges onto a white Background.
function flattenImage(e: Engine, tree: LayerNode[]) {
  const visible = drawnRoots(tree);
  const bg = e.add_special(0, JSON.stringify({ name: 'Background', content: { type: 'solid', color: [255, 255, 255] } }));
  e.move_node(bg, 0, 0);
  for (const n of tree) if (!visible.includes(n.id)) e.delete_node(n.id);
  e.merge_nodes(Uint32Array.of(bg, ...visible), false, true);
}

// Sibling layers `ids` into one smart object named `name`; its source bytes are a PSB of the layers (D5).
// A source PSD cannot hold everything (16-bit, smart filters): the source pixels still render and edit.
function toSmart(e: Engine, ids: number[], name: string) {
  const sub = e.extract_document(Uint32Array.from(ids));
  let bytes: Uint8Array | null = null;
  try { bytes = exportPsd(sub, { psb: true }).bytes; } catch { bytes = null; } finally { sub.free(); }
  const blob = bytes ? Number(e.blob_add(bytes)) : null;
  return e.convert_to_smart(Uint32Array.from(ids), JSON.stringify({ name, link_id: uuid(), source_blob: blob }));
}

// Replaces `n` by a pixel layer of itself alone (mask applied; effects and fill baked unless `keepStyle`)
// and gives it back its own settings. A disabled layer mask is applied too.
function bakeLayer(e: Engine, n: LayerNode, keepStyle: boolean) {
  const { name, visible, opacity, fill, blend, clipping, locks, blending, style } = n;
  e.set_props(n.id, JSON.stringify({ visible: true, opacity: 1, blend: 'normal', clipping: false, ...(keepStyle ? { fill: 1 } : {}), ...(n.mask ? { mask_enabled: true } : {}) }));
  e.set_blending(n.id, JSON.stringify(defaultBlending()));
  if (keepStyle) e.set_style(n.id, 'null');
  const id = e.merge_nodes(Uint32Array.of(n.id), false, false);
  e.set_props(id, JSON.stringify({ name, visible, opacity, blend, clipping, locks, ...(keepStyle ? { fill } : {}) }));
  e.set_blending(id, JSON.stringify(blending));
  if (keepStyle) e.set_style(id, JSON.stringify(style));
}

// Drawn root nodes: a clipped node is skipped with its hidden base, as the compositor does.
function drawnRoots(tree: LayerNode[]) {
  let baseShown = false;
  return tree.filter((n, i) => { if (i === 0 || !n.clipping) baseShown = n.visible; return n.visible && baseShown; }).map(n => n.id);
}

function stepIfChanged(label: string, fn: () => boolean) {
  history.begin(label);
  let ok = false;
  try {
    ok = fn();
  } catch (err) {
    history.restoreOpen();
    history.abort();
    throw err;
  }
  if (ok) history.commit(); else history.abort();
  return changed();
}

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

// Applies data set `name` in place and makes it the active one; returns the bindings that could not be applied.
function applyDataSet(e: Engine, name: string): string[] {
  const v = JSON.parse(e.vector_json());
  const m: Variables = v.variables ?? emptyVariables();
  const plan = planDataSet(m, flatNodes(JSON.parse(e.layers_json()) as LayerNode[]), name);
  for (const [id, visible] of plan.visible) e.set_props(id, JSON.stringify({ visible }));
  for (const [id, text] of plan.text) {
    e.set_text(id, JSON.stringify(replaceText(findNode(e, id)!.text as TextJson, text)));
    e.render_text(id, fontReg(), resolution(e));
  }
  e.set_document_vector(JSON.stringify({ ...v, variables: { ...m, active: name } }));
  return plan.errors;
}

// Every point-valued length in a text model (run size, leading, baseline shift; paragraph indents and spacing) times k.
function scaleTextPt(t: TextJson, k: number): TextJson {
  const f = (o: Record<string, any>, keys: string[]) => {
    const r = { ...o };
    for (const key of keys) if (typeof r[key] === 'number') r[key] *= k;
    return r;
  };
  return {
    ...t,
    runs: t.runs.map((r: Record<string, any>) => f(r, ['size', 'leading', 'baseline_shift'])),
    paragraphs: t.paragraphs.map((p: Record<string, any>) => f(p, ['indent_left', 'indent_right', 'indent_first', 'space_before', 'space_after'])),
  };
}

const CANVAS_REMAPS = { '180': '180°', cw: '90° Clockwise', ccw: '90° Counter Clockwise', flipH: 'Flip Canvas Horizontal', flipV: 'Flip Canvas Vertical' };

function sampleDocument(e: Engine, x: number, y: number, size: number, layerId: number | null): [number, number, number, number] {
  const half = Math.floor(size / 2);
  const cx = Math.floor(x), cy = Math.floor(y);
  const x0 = Math.max(0, cx - half), y0 = Math.max(0, cy - half);
  const x1 = Math.min(e.width(), cx + half + 1), y1 = Math.min(e.height(), cy + half + 1);
  const ids = layerId === null ? undefined : nodeTiles(e, layerId);
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
      const buf = layerId === null ? e.flatten_tile_rgba8(tx, ty) : layerTile(e, ids, tx, ty);
      if (buf) {
        const o = ((py - ty * TILE) * TILE + (px - tx * TILE)) * 4;
        r += buf[o]; g += buf[o + 1]; b += buf[o + 2]; a += buf[o + 3];
      }
      n++;
    }
  }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round(a / n)] : [0, 0, 0, 0];
}

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

// Puts the document back to the state the session's transform applies to.
function restoreBase(e: Engine, base: number | null) {
  if (base === null) history.restoreOpen();
  else e.restore(base);
}

function scheduleSave(ms: number) {
  if (!autosave) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    // Transform, move and preview sessions show unfinished pixels; commit and cancel schedule the next save.
    // An Edit Contents session never autosaves: the autosave keeps the outermost document.
    if (transformSession || moveSession || previewOpen || parents.length) return;
    if (saving) { again = true; return; }
    saving = runSave().finally(() => {
      saving = null;
      if (again) { again = false; scheduleSave(0); }
    });
  }, ms);
}

// The engine of tab `i`'s outermost document (Edit Contents parent stacks are not autosaved).
const outerEng = (i: number) => i === active ? parents[0]?.eng ?? eng! : docs[i].parents[0]?.eng ?? docs[i].eng;

// Shows the documents the autosave could not restore as an error, which a later save must not hide.
function lostError() {
  const lost = autosave?.lost ?? [];
  if (lost.length) emit('error', `Could not restore ${lost.join(', ')}`);
  return lost.length > 0;
}

// Saves every open tab; the autosave writes tiles only for documents whose manifest changed.
async function runSave() {
  if (!autosave || !eng) return;
  emit('saving');
  const tabs = docs.map((_, i) => {
    const e = outerEng(i);
    // Hold a snapshot so every tile in this manifest stays readable while the async writes run.
    return { e, snap: e.snapshot(), doc: { key: docs[i].key, name: tabName(i), dirty: isDirty(i), manifest: e.manifest(), tile: (t: number) => e.tile_bytes(BigInt(t)) } };
  });
  const open = (e: Engine) => docs.some((_, i) => outerEng(i) === e);
  try {
    const ok = await autosave.save(tabs.map(t => t.doc), docs[active].key, () => tabs.every(t => open(t.e)));
    if (!lostError()) emit(ok ? 'saved' : 'idle');
  } catch (err) {
    console.error('autosave failed', err);
    emit('error', String(err));
  } finally {
    // A closed tab's engine is freed and has no snapshot left.
    for (const t of tabs) if (open(t.e)) t.e.drop_snapshot(t.snap);
  }
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
  // docs[active].eng is stale (it can be a freed Edit Contents engine); `eng` stands for the active tab.
  for (const e of [eng, scratch, ...docs.map((d, i) => i === active ? null : d.eng)]) {
    const eid = e ? engineIds.get(e)?.get(id) : undefined;
    if (e && eid !== undefined) { if (a.kind === 'tip') e.tip_remove(eid); else e.pattern_remove(eid); engineIds.get(e)!.delete(id); }
  }
}

const previewEngine = () => eng ?? (scratch ??= new Engine(1, 1, 8));

// A 32-bit document from linear float pixels, one Background layer.
function floatEngine(img: FloatImage) {
  const { width: w, height: h, data } = img;
  const e = new Engine(w, h, 32);
  const t = new Float32Array(TILE * TILE * 4);
  tileLoop(w, h, (tx, ty) => {
    t.fill(0);
    for (let y = 0; y < TILE && ty * TILE + y < h; y++) for (let x = 0; x < TILE && tx * TILE + x < w; x++) {
      const o = ((ty * TILE + y) * w + tx * TILE + x) * 4, d = (y * TILE + x) * 4;
      for (let c = 0; c < 3; c++) t[d + c] = fromLinear(Math.max(0, data[o + c]));
      t[d + 3] = data[o + 3];
    }
    e.set_tile_f32(BACKGROUND, tx, ty, t);
  });
  return e;
}

// The flattened document as linear Rec. 709 floats, through the document's profile.
function floatImage(e: Engine): FloatImage {
  const w = e.width(), h = e.height(), data = new Float32Array(w * h * 4);
  tileLoop(w, h, (tx, ty) => {
    const t = e.flatten_tile_linear(tx, ty);
    for (let y = 0; y < TILE && ty * TILE + y < h; y++) for (let x = 0; x < TILE && tx * TILE + x < w; x++) {
      const o = ((ty * TILE + y) * w + tx * TILE + x) * 4, d = (y * TILE + x) * 4;
      data.set(t.subarray(d, d + 4), o);
    }
  });
  return { width: w, height: h, data };
}

// The document's layers in layers_json order (bottom-up).
function layersOf(e: Engine): Layers {
  const ids: number[] = [], names = new Map<number, string>();
  const walk = (ns: LayerNode[]) => { for (const n of ns) { ids.push(n.id); names.set(n.id, n.name); if (n.children) walk(n.children); } };
  walk(JSON.parse(e.layers_json()) as LayerNode[]);
  return { ids, names };
}

// Runs a queued call; while recording, a call that changed the document joins the step in progress,
// and the step goes to the UI when its history step lands.
async function recorded(op: keyof Api, args: unknown[], run: () => Promise<void>) {
  if (!rec || !eng || playing || NO_RECORD.has(op)) { settle(op); return run(); }
  if (rec.doc !== docId) rec = { doc: docId, last: layersOf(eng), created: [], buf: [] };
  const r = rec, top0 = history.top, open0 = history.isOpen;
  settle(op);
  // A session that settle committed ends the step in progress; one it cancelled drops it.
  if (history.top !== top0 && r.buf.length) {
    postMessage({ event: 'actionStep', step: { id: uuid(), label: history.undoLabel ?? op, enabled: true, calls: r.buf } } satisfies WorkerEvent);
    r.last = layersOf(eng);
  }
  if (history.top !== top0 || (open0 && !history.isOpen)) r.buf = [];
  const v = version, top = history.top, open = history.isOpen, before = r.last, created = [...r.created];
  await run();
  if (rec !== r || docId !== r.doc || !eng) return;
  // A cancelled preview or session: what led to it is not part of any step.
  if (open && !history.isOpen && history.top === top) { r.buf = []; return; }
  if (version === v && history.top === top && history.isOpen === open && !op.endsWith('Begin')) return;
  if (!recordable(args)) {
    postMessage({ event: 'actionStep', step: { id: uuid(), label: `${history.undoLabel ?? op} (uses a file, not recorded)`, enabled: false, calls: [] } } satisfies WorkerEvent);
    r.buf = [];
    return;
  }
  r.buf.push(encodeCall({ op, args }, before, created));
  if (!hot(op)) { const now = layersOf(eng); r.created.push(...newIds(before, now)); r.last = now; }
  if (history.top !== top && !history.isOpen) {
    postMessage({ event: 'actionStep', step: { id: uuid(), label: history.undoLabel ?? op, enabled: true, calls: r.buf } } satisfies WorkerEvent);
    r.buf = [];
  }
}

// A document engine from an opened file: .psd/.psb, .exr/.hdr as 32 bits, or a browser-decoded image as one Background layer.
// A decoded file with the File Info of its XMP packet.
// Grayscale PSD, PNG and JPEG files decode to R = G = B pixels and open as Grayscale documents.
async function engineOf(file: File): Promise<{ e: Engine; name: string; warnings: string[] }> {
  const r = await decodeFile(file);
  const b = new Uint8Array(await file.arrayBuffer());
  const i = readInfo(b);
  try {
    if (i || grayFile(b)) r.e.set_document_vector(JSON.stringify({ ...JSON.parse(r.e.vector_json()), ...(i ? { info: i } : {}), ...(grayFile(b) ? { gray: true } : {}) }));
  } catch (err) {
    r.warnings.push(`The File Info was not kept: ${(err as Error).message}`);
  }
  return r;
}

async function decodeFile(file: File): Promise<{ e: Engine; name: string; warnings: string[] }> {
  const lower = file.name.toLowerCase();
  const base = file.name.replace(/\.[^.]+$/, '');
  if (lower.endsWith('.psd') || lower.endsWith('.psb')) {
    const { engine, warnings, sources } = importPsd(new Uint8Array(await file.arrayBuffer()), { psb: lower.endsWith('.psb') });
    await loadSources(engine, sources, m => { if (!warnings.includes(m)) warnings.push(m); });
    return { e: engine, name: base, warnings };
  }
  if (lower.endsWith('.exr')) return { e: floatEngine(await decodeExr(new Uint8Array(await file.arrayBuffer()))), name: base, warnings: [] };
  if (lower.endsWith('.hdr')) return { e: floatEngine(decodeHdr(new Uint8Array(await file.arrayBuffer()))), name: base, warnings: [] };
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
  return { e, name: base, warnings: [] };
}

function unionBounds(e: ReturnType<typeof need>, ids: number[]): Box | null {
  const tree = JSON.parse(e.layers_json()) as LayerNode[];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pid of ids.flatMap(id => collectPixelIds(tree, id))) {
    const b = e.layer_bounds(pid) as Box | null;
    if (!b) continue;
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]);
    x1 = Math.max(x1, b[0] + b[2]); y1 = Math.max(y1, b[1] + b[3]);
  }
  return x0 === Infinity ? null : [x0, y0, x1 - x0, y1 - y0];
}

const api = {
  async init(names?: Record<string, string>) {
    if (names) nameBases = names;
    // A UI hot reload calls init again; the engine and the autosave lock are already ours.
    if (booted) { emit(lastState); return info(); }
    booted = true;
    await init();
    autosave = await Autosave.open().catch(() => null);
    let restored: DocInfo | null = null;
    if (autosave) {
      // Each tab restores on its own: a broken one (or running out of memory) keeps the tabs before it,
      // and the autosave keeps listing it (autosave.lost).
      try {
        const r = await autosave.load();
        for (const d of r?.docs ?? []) {
          try {
            const tiles = new Map<number, Uint8Array>();
            for (const id of tileIds(d.manifest)) tiles.set(id, await d.tile(id));
            adopt(loadEngine(d.manifest, id => tiles.get(id)!), d.name, d.key);
            saved = d.dirty ? {} : history.top;
          } catch (err) {
            console.error('autosave restore failed', d.name, err);
            autosave.keep(d);
          }
        }
        const i = docs.findIndex(d => d.key === r?.active);
        if (i >= 0 && i !== active) { stash(); activate(i); }
      } catch (err) {
        console.error('autosave restore failed', err);
      }
      restored = info();
      if (!lostError()) emit(restored ? 'saved' : 'idle');
    } else {
      emit('storage' in navigator && 'locks' in navigator && 'getDirectory' in navigator.storage ? 'other-tab' : 'off');
    }
    return restored;
  },

  newDoc(width: number, height: number, depth: number, bg: [number, number, number, number] | null) {
    const e = new Engine(width, height, depth);
    if (bg) e.fill(BACKGROUND, 'pixels', ...bg);
    if (colorSettings && colorSettings.rgbPolicy !== 'off') e.assign_profile(colorSettings.rgb, profileBytes(colorSettings.rgb));
    return adopt(e, 'Untitled');
  },

  // Color Picker and Color panel numbers (0..1) between the active document's RGB (CMYK and Lab
  // documents store sRGB), the working or document CMYK, and the working or document Gray profile.
  convertColor(values: number[], from: 'rgb' | 'cmyk' | 'gray', to: 'rgb' | 'cmyk' | 'gray') {
    const s = colorSettings ?? DEFAULT_COLOR_SETTINGS;
    const kind = eng ? (JSON.parse(eng.vector_json()) as { mode?: ColorMode }).mode?.kind : undefined;
    const named = (name: string): [string, Uint8Array] => [name, profileBytes(name)];
    const own = (icc: Uint8Array | null | undefined, fallback: string): [string, Uint8Array] => (icc?.length ? ['', icc] : named(fallback));
    const side = (space: 'rgb' | 'cmyk' | 'gray') =>
      space === 'cmyk' ? own(kind === 'cmyk' ? eng?.pixels_profile_icc() : null, s.cmyk)
        : space === 'gray' ? own(eng ? grayIcc(eng) : null, s.gray)
          : kind === 'cmyk' || kind === 'lab' ? named(RGB_SPACES[0]) : own(eng?.profile_icc(), s.rgb);
    const [a, b] = [side(from), side(to)];
    return [...convert_color(a[0], a[1], b[0], b[1], Float64Array.from(values))];
  },

  async setColorSettings(s: ColorSettings | null) {
    await readStoredProfiles();
    colorSettings = s;
    // Proofs to the working CMYK follow it.
    for (const e of new Set([...docs.map(d => d.eng), ...(eng ? [eng] : [])])) applyView(e, viewOf(e));
    if (!eng) return null;
    version++;
    return info();
  },

  // Channels panel target of the active document: edits change only these color channels, or
  // selection-target edits paint saved channel `alpha`. UI state, so no history step.
  // `alpha`: the targeted saved channels (a single id or null in recorded actions).
  setChannelTarget(rgb: [boolean, boolean, boolean], alpha: number[] | number | null) {
    need().set_channel_target(Uint8Array.from(rgb, Number), Uint32Array.from(alpha == null ? [] : Array.isArray(alpha) ? alpha : [alpha]));
  },

  // View > Proof Setup, Proof Colors, Gamut Warning and 32-bit Preview Options of the active
  // document; display only, so no history step and no autosave.
  setView(patch: Partial<ViewState>) {
    const e = need();
    const v = { ...viewOf(e), ...patch };
    if (patch.hdr) v.hdr = sanitizeHdr(patch.hdr);
    applyView(e, v);
    views.set(e, v);
    version++;
    return info()!;
  },

  // The embedded RGB or Gray (`space`) profile of `file` and what opening it does under the color settings;
  // 'ask' means the app shows Profile Mismatch or Missing Profile and passes the choice to openFile.
  async openProfileQuestion(file: File): Promise<{ embedded: string | null; action: OpenAction | 'ask'; space: 'rgb' | 'gray' }> {
    const { name: embedded, space } = await embeddedProfile(new Uint8Array(await file.arrayBuffer()));
    return { embedded, action: colorSettings ? openAction(colorSettings, embedded, true, space) : 'leave', space };
  },

  // `action` (from the open dialogs) or, without one, the policy decides about the embedded profile.
  // `resolution` (ppi) is set for rasterized PDF pages.
  async openFile(file: File, action?: OpenAction, resolution?: number): Promise<OpenResult> {
    const { e, name: n, warnings } = await engineOf(file);
    if (resolution) e.set_document_vector(JSON.stringify({ ...JSON.parse(e.vector_json()), resolution }));
    if (colorSettings) {
      const p = await embeddedProfile(new Uint8Array(await file.arrayBuffer()));
      if (p.warning) warnings.push(p.warning);
      try {
        applyOpenProfile(e, p, action ?? openAction(colorSettings, p.name, false, p.space) as OpenAction, colorSettings);
      } catch (err) {
        warnings.push(`The color profile was not applied: ${(err as Error).message}`);
      }
    }
    return { ...adopt(e, n), warnings };
  },

  // File > Revert: tab `key` (the active one) becomes `file`'s content at the same place and name, history
  // cleared and clean. A new key: autosave tiles are immutable per key and tile id. A failed load keeps the document.
  async revertDoc(file: File, key: string): Promise<OpenResult> {
    if (docs[active]?.key !== key) throw new Error('The document to revert is no longer active.');
    if (parents.length) throw new Error('Close Edit Contents before reverting.');
    const { e, warnings } = await engineOf(file);
    if (colorSettings) {
      const p = await embeddedProfile(new Uint8Array(await file.arrayBuffer()));
      const policy = p.space === 'gray' ? colorSettings.grayPolicy : colorSettings.rgbPolicy;
      if (policy !== 'off') try { applyOpenProfile(e, p, 'keep', colorSettings); } catch { /* reverted untagged */ }
    }
    if (docs[active]?.key !== key) { e.free(); throw new Error('The document to revert is no longer active.'); }
    const old = eng!, h = history;
    docs[active] = { key: uuid(), eng: e, history: historyOf(e), name, version: version + 1, parents: [], saved: null };
    activate(active);
    h.clear();
    old.free();
    scheduleSave(0);
    return { ...info()!, warnings };
  },

  // The tab name (Save As takes the file's base name); no history step, the dirty state stays.
  setDocName(n: string) {
    if (parents.length) parents[0].name = n; else name = n;
    scheduleSave(0);
    return info()!;
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

  // Red Eye tool (docs/M5.md section 9): the rect in document px, pupil and darken 0..1.
  redEye(id: number, rect: [number, number, number, number], pupil: number, darken: number) {
    const e = need();
    return stepIfChanged('Red Eye Correction', () => e.red_eye(id, ...rect, pupil, darken));
  },

  // Patch / Content-Aware Move: the selection moved by (dx, dy); the selection itself stays.
  patch(id: number, dx: number, dy: number, params: { mode: 'source' | 'destination'; contentAware: boolean; transparent: boolean; structure: number; color: number }) {
    const e = need();
    return stepIfChanged('Patch', () => e.patch(id, dx, dy, JSON.stringify(params)));
  },
  contentAwareMove(id: number, dx: number, dy: number, params: { extend: boolean; structure: number; color: number; scale?: number[] }) {
    const e = need();
    return stepIfChanged('Content-Aware Move', () => e.content_aware_move(id, dx, dy, JSON.stringify(params)));
  },

  // Clone overlay: the clone source seen through the doc rect (x, y, w, h), as out_w x out_h RGBA8.
  cloneSample(layerId: number, source: Record<string, unknown>, rect: [number, number, number, number], outW: number, outH: number) {
    const px = need().clone_sample(layerId, JSON.stringify(source), ...rect, outW, outH);
    return { w: outW, h: outH, data: px.buffer as ArrayBuffer };
  },

  // Edit > Content-Aware Fill / Delete and Fill Selection; `opts` null = Normal at full opacity.
  // No changed pixel throws, so the step is dropped.
  contentAwareFill(id: number, structure: number, color: number, opts: ContentAwareOpts | null, deselect: boolean, label: string) {
    const e = need();
    const params = JSON.stringify({ structure, color, ...(opts ?? {}), deselect });
    if (deselect) selGen++;
    return edit(label, false, () => {
      if (!e.content_aware_fill(id, params)) throw new Error('Content-Aware Fill produced no pixels.');
    });
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

  // Edit > Copy / Copy Merged (`merged`) / Cut (`cut`, one 'Cut' step clearing the selected pixels).
  // `clip` is the copied RGBA8 for the system clipboard.
  copy(id: number, merged: boolean, cut: boolean) {
    const e = need();
    if (cut && !e.has_selection()) return info();
    const c = copyPixels(e, merged ? null : id);
    if (cut) history.run('Cut', () => e.clear(id, 'pixels'));
    clipboard = { ...c, icc: e.pixels_profile_icc() };
    return { ...(cut ? changed() : info())!, clip: { w: c.w, h: c.h, data: c.rgba.slice().buffer } };
  },

  // Edit > Define Brush Preset: the merged image in the selection bounds as a tip; darkness is opacity
  // (transparent pixels count as white), outside the selection is transparent.
  brushTipSample() {
    const e = need();
    const { b, rgba } = sampleMerged(e, 5000, () => { throw new Error('The brush is larger than 5000 x 5000 pixels.'); });
    const sel = JSON.parse(e.channels_json()).selection as { default: number } | null;
    const cov = sel && gather(b, 1, (tx, ty) => e.selection_tile(0, tx, ty) as Uint8Array | null, sel.default > 0 ? 255 : 0);
    const alpha = new Uint8Array(b[2] * b[3]);
    for (let i = 0; i < alpha.length; i++) {
      const a = rgba[i * 4 + 3] / 255, white = 255 * (1 - a);
      const gray = 0.299 * (rgba[i * 4] * a + white) + 0.587 * (rgba[i * 4 + 1] * a + white) + 0.114 * (rgba[i * 4 + 2] * a + white);
      alpha[i] = Math.round((255 - gray) * (cov ? cov[i] / 255 : 1));
    }
    return { ...info()!, tip: { width: b[2], height: b[3], alpha } };
  },

  // Edit > Define Pattern: the merged image in the bounds of a hard-edged rectangular selection (the canvas without one).
  patternSample() {
    const e = need();
    if (e.has_selection() && !rectSelection(e, (JSON.parse(e.channels_json()).selection as { default: number }).default)) {
      throw new Error('Define Pattern needs a rectangular selection without feathering.');
    }
    const { b, rgba } = sampleMerged(e, 4000, () => { throw new Error('The pattern is larger than 4000 x 4000 pixels.'); });
    return { ...info()!, pattern: { width: b[2], height: b[3], data: rgba } };
  },

  // The selected pixels of `id` as an overlay image (Content-Aware Move Transform On Drop); no history step.
  selectedPixels(id: number) {
    const c = copyPixels(need(), id);
    return { image: { x: c.x, y: c.y, w: c.w, h: c.h, f: 1 }, data: c.rgba.slice().buffer };
  },

  // Layer > New > Layer via Copy: the selected pixels as a new layer above `id`, in place; the clipboard is untouched.
  layerViaCopy(id: number) {
    const e = need();
    const c = copyPixels(e, id);
    let created = 0;
    history.run('Layer via Copy', () => {
      created = e.add_layer(nextName('Layer'), id);
      e.put_rgba8(created, c.x, c.y, c.w, c.h, c.rgba);
    });
    return { ...changed(), created };
  },

  // Layer > New > Layer via Cut: Layer via Copy, then the selected pixels of `id` are cleared (as Edit > Cut), one step.
  layerViaCut(id: number) {
    const e = need();
    const c = copyPixels(e, id);
    let created = 0;
    history.run('Layer via Cut', () => {
      created = e.add_layer(nextName('Layer'), id);
      e.put_rgba8(created, c.x, c.y, c.w, c.h, c.rgba);
      e.clear(id, 'pixels');
    });
    return { ...changed(), created };
  },

  // Edit > Paste / Paste in Place / Paste Into / Paste Outside: a new layer above `above`. `bytes` is a system clipboard
  // image; one sized like the internal clipboard is taken as that (it keeps the origin). `pasted`: false = nothing to paste.
  // Into and Outside center on the selection and mask the layer to it (Outside: inverted), then deselect.
  async paste(above: number, mode: 'paste' | 'inPlace' | 'into' | 'outside', bytes: Uint8Array | null) {
    const e = need();
    let src: { x: number; y: number; w: number; h: number; rgba: Uint8Array; icc?: Uint8Array } | null = clipboard;
    if (bytes) {
      const d = await decodeSource(bytes);
      if (!src || src.w !== d.w || src.h !== d.h) src = { x: NaN, y: NaN, ...d };
    }
    if (!src) return { ...info()!, created: 0, pasted: false };
    // With color management on, pasted numbers convert from the copied document's profile.
    const s = colorSettings;
    const c = s && src.icc?.length
      ? { ...src, rgba: e.convert_rgba8(src.rgba, src.icc, JSON.stringify({ intent: s.intent, blackPointCompensation: s.bpc, dither: false })) }
      : src;
    const masked = mode === 'into' || mode === 'outside';
    if (mode === 'into' && !e.has_selection()) throw new Error('Paste Into needs a selection.');
    if (mode === 'outside' && !e.has_selection()) throw new Error('Paste Outside needs a selection.');
    const sb = e.selection_bounds() as Int32Array | null;
    const at = masked && sb ? Array.from(sb) : [0, 0, e.width(), e.height()];
    const inPlace = mode === 'inPlace' && Number.isFinite(c.x);
    const x = inPlace ? c.x : at[0] + Math.floor((at[2] - c.w) / 2), y = inPlace ? c.y : at[1] + Math.floor((at[3] - c.h) / 2);
    let created = 0;
    const inverted = mode === 'outside';
    history.run(mode === 'into' ? 'Paste Into' : inverted ? 'Paste Outside' : 'Paste', () => {
      created = e.add_layer(nextName('Layer'), above);
      e.put_rgba8(created, x, y, c.w, c.h, c.rgba);
      if (!masked) return;
      const sel = JSON.parse(e.channels_json()).selection as { default: number };
      e.add_mask(created, (sel.default > 0) !== inverted);
      tileLoop(e.width(), e.height(), (tx, ty) => {
        const t = e.selection_tile(0, tx, ty) as Uint8Array | null;
        if (t) e.set_mask_tile8(created, tx, ty, inverted ? t.map(v => 255 - v) : t);
      });
      e.deselect();
    });
    if (masked) selGen++;
    return { ...changed(), created, pasted: true };
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
  bucket(id: number, target: 'pixels' | 'selection', x: number, y: number, rgba: [number, number, number, number], mode: string, opacity: number, tolerance: number, antialias: boolean, contiguous: boolean, allLayers: boolean, label = 'Paint Bucket') {
    const e = need();
    history.run(label, () => e.bucket(id, target, Math.floor(x), Math.floor(y), ...rgba, mode, opacity, tolerance, antialias, contiguous, allLayers));
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

  // Select > Subject from the layer's pixels; no step and the selection unchanged when no subject is found.
  selectSubject(id: number) {
    const e = need();
    selGen++;
    return stepIfChanged('Select Subject', () => e.select_subject(id));
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
    const ch = JSON.parse(e.channels_json()) as { selection: { default: number } | null };
    return maskAt(e, level, ch.selection?.default ?? null, (tx, ty) => e.selection_tile(level, tx, ty));
  },

  // A saved channel assembled like selectionMask (data is never null).
  channelMask(id: number, level: number) {
    const e = need();
    const ch = (JSON.parse(e.channels_json()) as { channels: { id: number; default: number }[] }).channels.find(c => c.id === id);
    if (!ch) throw new Error(`unknown channel ${id}`);
    return maskAt(e, level, ch.default, (tx, ty) => e.channel_tile(id, level, tx, ty));
  },

  // Layer `id`'s mask assembled like selectionMask (data is never null).
  layerMask(id: number, level: number) {
    const e = need();
    const n = findNode(e, id);
    if (!n?.mask) throw new Error(`layer ${id} has no mask`);
    return maskAt(e, level, n.mask.default, (tx, ty) => e.layer_mask_tile(id, level, tx, ty));
  },

  // One CMYK or Lab channel of the composite at pyramid `level`, as the Channels panel shows it alone;
  // transparent areas show white.
  colorChannelMask(mode: 'cmyk' | 'lab', ch: number, level: number) {
    const e = need();
    const sep = mode === 'cmyk' ? e.cmyk_separation(SEPARATION_GRID) : e.lab_table(SEPARATION_GRID);
    return maskAt(e, level, 255, (tx, ty) => {
      const t = e.display_tile(level, tx, ty) as Uint8Array | undefined;
      if (!t) return null;
      const out = new Uint8Array(t.length / 4);
      for (let i = 0; i < out.length; i++) {
        const a = t[i * 4 + 3];
        const s = (v: number) => (a ? Math.min(255, Math.round((v * 255) / a)) : 255);
        const g = inkGray(mode, ch, s(t[i * 4]), s(t[i * 4 + 1]), s(t[i * 4 + 2]), sep);
        out[i] = Math.round(g * a / 255 + 255 - a);
      }
      return out;
    });
  },

  // The CMYK document's separation table for the Channels panel; null without a CMYK profile.
  cmykSeparation(): Float32Array | null {
    const sep = need().cmyk_separation(SEPARATION_GRID);
    return sep.length ? sep : null;
  },

  // The Lab document's ICC Lab table for the Channels panel; null unless the document is Lab.
  labTable(): Float32Array | null {
    const t = need().lab_table(SEPARATION_GRID);
    return t.length ? t : null;
  },

  // Image > Apply Image on pixel layer `id`; `preview` reruns inside the dialog's session.
  applyImage(id: number, src: ImageSource, opts: CalcOpts & { preserve: boolean }, preview = false) {
    const e = need();
    return edit('Apply Image', preview, () => {
      const s = readSource(e, src);
      try {
        e.apply_image(id, s, opts.mask && readSource(e, opts.mask), opts.mode, opts.opacity, opts.scale, opts.offset / 255, opts.preserve);
      } finally {
        s.free();
      }
    });
  },

  // Image > Calculations into a new channel, the selection (the channel is then dropped), or a new
  // grayscale document.
  calculations(src1: ImageSource, src2: ImageSource, opts: CalcOpts, result: 'channel' | 'selection' | 'document') {
    const e = need();
    const a = readSource(e, src1), b = readSource(e, src2);
    const run = <T>(f: (mask: ImageTiles | null) => T) => f(opts.mask && readSource(e, opts.mask));
    try {
      if (result === 'document') {
        return adopt(run(m => e.calculations_document(a, b, m, opts.mode, opts.opacity, opts.scale, opts.offset / 255)), 'Calculations');
      }
      const names = new Set((JSON.parse(e.channels_json()) as { channels: { name: string }[] }).channels.map(c => c.name));
      let n = 1;
      while (names.has(`Alpha ${n}`)) n++;
      history.run('Calculations', () => {
        const ch = run(m => e.calculations(a, b, m, opts.mode, opts.opacity, opts.scale, opts.offset / 255, `Alpha ${n}`));
        if (result === 'selection') { e.load_selection(ch, false, 'new'); e.delete_channel(ch); }
      });
    } finally {
      a.free();
      b.free();
    }
    if (result === 'selection') selGen++;
    return changed();
  },

  // Image > Mode: bit depth, or a color mode with its dialog options; no step when nothing changes.
  // Bitmap and Indexed Color flatten a document of several layers first, in the same step.
  // From 32-bit, `toning` runs HDR Toning on every pixel layer first (`merge` flattens before), in
  // the same step; `preview` keeps the step open for the HDR Toning dialog (see `previewEnd`).
  convertDepth(depth: 8 | 16 | 32, toning?: { merge: boolean; params: Extract<DestructiveAdjustment, { kind: 'hdr_toning' }>['params'] }, preview = false) {
    const e = need();
    if (e.depth() === depth) return info();
    return edit(`${depth} Bits/Channel`, preview, () => {
      if (toning && e.depth() === 32) {
        const tree = JSON.parse(e.layers_json()) as LayerNode[];
        if (toning.merge && (tree.length > 1 || (tree[0] && tree[0].kind !== 'pixel'))) flattenImage(e, tree);
        const tone = (list: LayerNode[]): void => list.forEach(n => n.kind === 'pixel' ? e.tone_layer(n.id, JSON.stringify({ kind: 'hdr_toning', params: toning.params })) : tone(n.children ?? []));
        tone(JSON.parse(e.layers_json()) as LayerNode[]);
      }
      e.convert_depth(depth);
    });
  },

  setColorMode(spec: ModeSpec) {
    const e = need();
    if (spec.mode === 'indexed' && spec.palette === 'previous') {
      if (!previousTable) throw new Error('There is no previous Indexed Color palette.');
      spec = { ...spec, palette: 'custom', table: previousTable };
    }
    const label = { rgb: 'RGB Color', gray: 'Grayscale', bitmap: 'Bitmap', duotone: 'Duotone', indexed: 'Indexed Color', cmyk: 'CMYK Color', lab: 'Lab Color', multichannel: 'Multichannel' }[spec.mode];
    const tree = JSON.parse(e.layers_json()) as LayerNode[];
    const flatten = (spec.mode === 'bitmap' || spec.mode === 'indexed') && (tree.length > 1 || (tree[0] && tree[0].kind !== 'pixel'));
    // With color management on, CMYK separates through the working CMYK, Grayscale from RGB or CMYK
    // through the working Gray, and RGB from CMYK or Grayscale converts to the working RGB; other modes
    // are flags over RGB storage, so they go to RGB first. Lab holds sRGB numbers, so Lab from RGB,
    // Grayscale or CMYK converts to sRGB and RGB from Lab converts sRGB to the working RGB. Bitmap,
    // Duotone and Multichannel have no profile; Grayscale from them tags the working Gray. 32-bit
    // documents keep the flag conversions. With color management off CMYK still separates through
    // the default CMYK, and the document stays untagged.
    const vec = JSON.parse(e.vector_json()) as { mode?: ColorMode; gray?: boolean };
    const cur = vec.mode?.kind;
    const s = colorSettings;
    const convert = (name: string) => e.convert_to_profile(name, profileBytes(name), JSON.stringify(s ? { intent: s.intent, blackPointCompensation: s.bpc, dither: s.dither } : { intent: 'relativeColorimetric', blackPointCompensation: true }));
    // A Bitmap output resolution resamples the canvas, so the selection cache resets as with Image Size.
    const step = spec.mode === 'bitmap' && spec.resolution != null && spec.resolution !== resolution(e) ? canvasEdit : stepIfChanged;
    return step(label, () => {
      if (spec.mode === 'cmyk' && cur !== 'cmyk' && cur !== 'bitmap' && e.depth() !== 32) {
        if (cur) e.set_color_mode(JSON.stringify({ mode: 'rgb' }));
        const changed = convert(s?.cmyk ?? CMYK_SPACES[0]) || !!cur;
        if (!s) e.assign_profile('', new Uint8Array());
        return changed;
      }
      if (s && spec.mode === 'gray' && cur === 'lab' && e.depth() !== 32) {
        e.set_color_mode(JSON.stringify({ mode: 'rgb' }));
        e.assign_profile(RGB_SPACES[0], new Uint8Array());
        return convert(s.gray) || true;
      }
      if (s && spec.mode === 'gray' && !vec.gray && (!cur || cur === 'cmyk') && e.depth() !== 32) return convert(s.gray);
      if (s && spec.mode === 'rgb' && (cur === 'cmyk' || (!cur && vec.gray && e.depth() !== 32))) return convert(s.rgb) || e.set_color_mode(JSON.stringify(spec));
      if (s && spec.mode === 'lab' && (!cur || cur === 'cmyk') && e.depth() !== 32) {
        convert(RGB_SPACES[0]);
        return e.set_color_mode(JSON.stringify(spec));
      }
      if (s && spec.mode === 'rgb' && cur === 'lab') {
        e.set_color_mode(JSON.stringify(spec));
        e.assign_profile(RGB_SPACES[0], new Uint8Array());
        convert(s.rgb);
        return true;
      }
      if (flatten) flattenImage(e, tree);
      const changed = e.set_color_mode(JSON.stringify(spec)) || flatten;
      if (s && spec.mode === 'gray' && (cur === 'bitmap' || cur === 'duotone' || cur === 'multichannel')) e.assign_profile(s.gray, profileBytes(s.gray));
      const mode = (JSON.parse(e.vector_json()) as { mode?: ColorMode }).mode;
      if (spec.mode === 'indexed' && mode?.kind === 'indexed') previousTable = mode.table;
      return changed;
    });
  },

  previousColorTable() {
    return previousTable;
  },

  // The table Indexed Color `spec` converts with now (Custom starts from it).
  indexedTable(spec: ModeSpec): [number, number, number][] {
    return JSON.parse(need().indexed_table(JSON.stringify(spec)));
  },

  setColorTable(table: [number, number, number][]) {
    const e = need();
    return stepIfChanged('Color Table', () => e.set_color_table(JSON.stringify(table)));
  },

  // Edit > Assign Profile (null: Don't Color Manage) and Convert to Profile; built-in names or a
  // loaded profile. Convert flattens first when asked or when non-pixel layers exist.
  async iccProfiles(): Promise<IccProfile[]> {
    await readStoredProfiles();
    const builtin = (JSON.parse(icc_builtins()) as { name: string; space: string }[]).filter((p): p is IccProfile => p.space !== 'lab');
    return [...builtin, ...[...loadedProfiles.values()].map(p => p.info)];
  },

  // A profile file loaded by the user, kept for later sessions where storage allows.
  async loadProfile(bytes: Uint8Array): Promise<IccProfile> {
    await readStoredProfiles();
    const info = addProfile(bytes);
    await profileStore?.put({ name: info.name, space: info.space as 'rgb' | 'cmyk' | 'gray', bytes }).catch(() => {});
    return info;
  },

  // Assign Profile's live preview: tags the document with `name` (null: untagged) with no history
  // step; `end` puts back the document as it was when the preview started.
  previewAssign(name: string | null, end: boolean) {
    const e = need();
    if (assignPreview && assignPreview.e !== e) assignPreview = null;
    if (end) {
      if (assignPreview) {
        e.restore(assignPreview.snap);
        e.drop_snapshot(assignPreview.snap);
        assignPreview = null;
      }
    } else {
      assignPreview ??= { e, snap: e.snapshot() };
      e.assign_profile(name ?? '', profileBytes(name ?? ''));
    }
    version++;
    return info()!;
  },

  assignProfile(name: string | null) {
    const e = need();
    return stepIfChanged('Assign Profile', () => e.assign_profile(name ?? '', profileBytes(name ?? '')));
  },

  convertToProfile(name: string, opts: { intent: string; blackPointCompensation: boolean; dither: boolean; flatten: boolean }) {
    const e = need();
    const tree = JSON.parse(e.layers_json()) as LayerNode[];
    const nonPixel = (ns: LayerNode[]): boolean => ns.some(n => n.kind === 'group' ? nonPixel(n.children ?? []) : n.kind !== 'pixel');
    const flatten = (opts.flatten && (tree.length > 1 || tree[0]?.kind !== 'pixel')) || nonPixel(tree);
    const o = { intent: opts.intent, blackPointCompensation: opts.blackPointCompensation, dither: opts.dither };
    return stepIfChanged('Convert to Profile', () => {
      if (flatten) flattenImage(e, tree);
      return e.convert_to_profile(name, profileBytes(name), JSON.stringify(o)) || flatten;
    });
  },

  newChannel() {
    const e = need();
    const names = new Set((JSON.parse(e.channels_json()) as { channels: { name: string }[] }).channels.map(c => c.name));
    let n = 1;
    while (names.has(`Alpha ${n}`)) n++;
    let created = 0;
    history.run('New Channel', () => { created = e.new_channel(`Alpha ${n}`); });
    return { ...changed(), created };
  },

  // A spot channel with no ink, named Spot Color n unless `name` is given.
  newSpotChannel(spot: Spot, name?: string) {
    const e = need();
    const names = new Set((JSON.parse(e.channels_json()) as { channels: { name: string }[] }).channels.map(c => c.name));
    let n = 1;
    while (names.has(`Spot Color ${n}`)) n++;
    let created = 0;
    history.run('New Spot Channel', () => { created = e.new_spot_channel(name || `Spot Color ${n}`, Uint8Array.from(spot.color), spot.solidity); });
    return { ...changed(), created };
  },

  spotChannelOptions(id: number, name: string, spot: Spot) {
    const e = need();
    history.run('Channel Options', () => e.set_spot(id, name, Uint8Array.from(spot.color), spot.solidity));
    return changed();
  },

  renameChannel(id: number, name: string) {
    const e = need();
    history.run('Rename Channel', () => e.rename_channel(id, name));
    return changed();
  },

  duplicateChannel(id: number) {
    const e = need();
    const src = (JSON.parse(e.channels_json()) as { channels: { id: number; name: string }[] }).channels.find(c => c.id === id);
    if (!src) throw new Error(`unknown channel ${id}`);
    let created = 0;
    history.run('Duplicate Channel', () => { created = e.duplicate_channel(id, `${src.name} copy`); });
    return { ...changed(), created };
  },

  deleteChannel(id: number) {
    const e = need();
    history.run('Delete Channel', () => e.delete_channel(id));
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

  // Layer > Delete > Hidden Layers: every node whose own visibility is off (its subtree goes with it), one step; none if no node is hidden.
  deleteHiddenLayers() {
    const e = need();
    const hidden: number[] = [];
    const walk = (nodes: LayerNode[]) => { for (const n of nodes) { if (!n.visible) hidden.push(n.id); else if (n.children) walk(n.children); } };
    walk(JSON.parse(e.layers_json()));
    if (!hidden.length) return info();
    history.run('Delete Hidden Layers', () => { for (const id of hidden) e.delete_node(id); });
    return changed();
  },

  // File > Scripts > Delete All Empty Layers: pixel layers without pixels and groups with nothing else left, one step.
  deleteEmptyLayers() {
    const e = need();
    const doomed: number[] = [];
    const empty = (n: LayerNode): boolean => n.kind === 'group'
      ? !n.artboard && (n.children ?? []).map(empty).every(Boolean)
      : n.kind === 'pixel' && !(e.layer_bounds(n.id) as number[] | null)?.slice(2).every(v => v > 0);
    const walk = (nodes: LayerNode[]) => { for (const n of nodes) { if (empty(n)) doomed.push(n.id); else if (n.children) walk(n.children); } };
    walk(JSON.parse(e.layers_json()));
    if (!doomed.length) throw new Error('There were no empty layers.');
    history.run('Delete All Empty Layers', () => { for (const id of doomed) e.delete_node(id); });
    return changed();
  },

  // File > Scripts > Flatten All Layer Effects: each styled layer becomes pixels of itself with its effects
  // (and mask) baked in; name, visibility, opacity, blend mode, clipping, locks and blending options stay.
  flattenAllLayerEffects() {
    const e = need();
    const styled = flatNodes(JSON.parse(e.layers_json()) as LayerNode[])
      .filter(n => n.kind !== 'group' && n.style?.enabled && effectRows(n.style).some(r => r.enabled));
    if (!styled.length) throw new Error('No layer has an effect to flatten.');
    history.run('Flatten All Layer Effects', () => { for (const n of styled) bakeLayer(e, n, false); });
    return changed();
  },

  // File > Scripts > Flatten All Masks: the layer and vector masks of every pixel layer are applied to its
  // pixels; the layer style stays and follows the new edges.
  flattenAllMasks() {
    const e = need();
    const masked = flatNodes(JSON.parse(e.layers_json()) as LayerNode[]).filter(n => n.kind === 'pixel' && (n.mask || n.vector_mask));
    if (!masked.length) throw new Error('No layer has a mask to apply.');
    history.run('Flatten All Masks', () => {
      for (const n of masked) {
        if (n.vector_mask) e.rasterize_vector_mask(n.id);
        bakeLayer(e, n, true);
      }
    });
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

  // Layer > Arrange: the selected siblings of each parent move as a block, one history step; none if nothing moves.
  // Reverse flips the order of the selected siblings within the slots they occupy.
  arrangeNodes(ids: number[], mode: 'front' | 'forward' | 'backward' | 'back' | 'reverse') {
    const e = need();
    const tree = JSON.parse(e.layers_json()) as LayerNode[];
    const moves: [number, number, number][] = [];
    for (const parent of new Set(ids.map(id => locate(tree, id)?.parent))) {
      if (parent === undefined) continue;
      const cur = (parent ? nodeById(tree, parent)!.children! : tree).map(n => n.id);
      const sel = cur.map(id => ids.includes(id));
      const next = cur.slice();
      if (mode === 'reverse') {
        const slots = cur.flatMap((_, i) => (sel[i] ? [i] : [])), picked = slots.map(i => cur[i]).reverse();
        slots.forEach((i, k) => { next[i] = picked[k]; });
      } else if (mode === 'front' || mode === 'back') {
        const picked = cur.filter((_, i) => sel[i]), rest = cur.filter((_, i) => !sel[i]);
        next.splice(0, next.length, ...(mode === 'front' ? [...rest, ...picked] : [...picked, ...rest]));
      } else {
        const up = mode === 'forward', flags = sel.slice();
        for (let n = 0; n < cur.length - 1; n++) {
          const i = up ? cur.length - 2 - n : n + 1, j = up ? i + 1 : i - 1;
          if (flags[i] && !flags[j]) { [next[i], next[j]] = [next[j], next[i]]; [flags[i], flags[j]] = [flags[j], flags[i]]; }
        }
      }
      next.forEach((id, i) => { if (cur[i] !== id) { moves.push([id, parent!, i]); cur.splice(cur.indexOf(id), 1); cur.splice(i, 0, id); } });
    }
    if (!moves.length) return changed();
    const label = { front: 'Bring to Front', forward: 'Bring Forward', backward: 'Send Backward', back: 'Send to Back', reverse: 'Reverse' }[mode];
    history.run(label, () => { for (const [id, parent, index] of moves) e.move_node(id, parent, index); });
    return changed();
  },

  // Layer > Merge Down (ids[0] and the sibling below; a group alone: Merge Group), Merge Layers, Merge Visible, Stamp Visible, Flatten Image:
  // one pixel layer of the composite, named after the bottom-most merged node, in one history step.
  mergeNodes(ids: number[], mode: 'down' | 'layers' | 'visible' | 'stamp' | 'flatten') {
    const e = need();
    const tree = JSON.parse(e.layers_json()) as LayerNode[];
    const label = { down: 'Merge Down', layers: 'Merge Layers', visible: 'Merge Visible', stamp: 'Stamp Visible', flatten: 'Flatten Image' }[mode];
    const visible = drawnRoots(tree);
    if (mode === 'down') {
      const at = locate(tree, ids[0]);
      if (at?.list[at.index].kind === 'group') ids = [ids[0]];
      else if (!at || at.index === 0) throw new Error('Could not merge down: there is no layer below in the same group.');
      else ids = [at.list[at.index - 1].id, ids[0]];
    } else if (mode === 'layers') {
      if (ids.length < 2) throw new Error('Could not merge layers: select at least two layers.');
      if (new Set(ids.map(id => locate(tree, id)?.parent)).size > 1) throw new Error('Could not merge layers: the layers must be in the same group.');
    } else if ((mode === 'visible' || mode === 'stamp') && !visible.length) throw new Error(`Could not ${label.toLowerCase()}: no layers are visible.`);
    const name = nextName('Layer');
    history.run(label, () => {
      if (mode === 'down' || mode === 'layers' || mode === 'visible') e.merge_nodes(Uint32Array.from(mode === 'visible' ? visible : ids), false, false);
      else if (mode === 'stamp') {
        const id = e.merge_nodes(Uint32Array.from(visible), true, false);
        e.set_props(id, JSON.stringify({ name }));
        e.move_node(id, 0, tree.length);
      } else flattenImage(e, tree);
    });
    return changed();
  },

  // Layer > Align / Distribute: align to the selection, else the union of the layers (one layer: the canvas);
  // distribute needs three layers and keeps the outer two. Each layer's subtree moves by an integer offset,
  // position-locked layers (or under a locked group) are skipped. One history step, none when nothing moves.
  alignLayers(ids: number[], mode: AlignMode) {
    const e = need();
    const tree = JSON.parse(e.layers_json()) as LayerNode[];
    const locked = new Set<number>();
    const mark = (ns: LayerNode[], under: boolean) => { for (const n of ns) { if (under || n.locks.position) locked.add(n.id); if (n.children) mark(n.children, under || n.locks.position); } };
    mark(tree, false);
    const items: { id: number; b: number[] }[] = [];
    for (const id of new Set(ids)) {
      if (locked.has(id)) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const pid of collectPixelIds(tree, id)) {
        const b = e.layer_bounds(pid) as [number, number, number, number] | null;
        if (!b || b[2] <= 0 || b[3] <= 0) continue;
        x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[0] + b[2]); y1 = Math.max(y1, b[1] + b[3]);
      }
      if (x0 !== Infinity) items.push({ id, b: [x0, y0, x1, y1] });
    }
    const [kind, edge] = mode.split('-') as ['align' | 'distribute', 'top' | 'vcenter' | 'bottom' | 'left' | 'hcenter' | 'right'];
    const vertical = edge === 'top' || edge === 'vcenter' || edge === 'bottom';
    const o = vertical ? 1 : 0; // index of the min edge in b: x 0 / y 1; the max edge is o + 2
    const pos = (b: number[]) => (edge === 'top' || edge === 'left' ? b[o] : edge === 'bottom' || edge === 'right' ? b[o + 2] : (b[o] + b[o + 2]) / 2);
    const offsets = new Map<number, number>();
    if (kind === 'align') {
      if (!items.length) return changed();
      const sb = e.selection_bounds() as Int32Array | null;
      const t = sb ? [sb[0], sb[1], sb[0] + sb[2], sb[1] + sb[3]]
        : items.length === 1 ? [0, 0, e.width(), e.height()]
          : [0, 1, 2, 3].map(i => (i < 2 ? Math.min : Math.max)(...items.map(it => it.b[i])));
      for (const it of items) offsets.set(it.id, Math.round(pos(t) - pos(it.b)));
    } else if (items.length >= 3) {
      items.sort((p, q) => pos(p.b) - pos(q.b));
      const first = pos(items[0].b), last = pos(items[items.length - 1].b);
      items.forEach((it, i) => offsets.set(it.id, Math.round(first + (last - first) * i / (items.length - 1) - pos(it.b))));
    }
    const moves = [...offsets].filter(([, d]) => d !== 0);
    if (!moves.length) return changed();
    const names: Record<string, string> = { top: 'Top Edges', vcenter: 'Vertical Centers', bottom: 'Bottom Edges', left: 'Left Edges', hcenter: 'Horizontal Centers', right: 'Right Edges' };
    history.run(`${kind === 'align' ? 'Align' : 'Distribute'} ${names[edge]}`, () => {
      for (const [id, d] of moves) {
        const [dx, dy] = vertical ? [0, d] : [d, 0];
        for (const pid of collectPixelIds(tree, id)) e.offset_layer(pid, dx, dy);
        if (findNode(e, id)?.artboard) e.offset_artboard(id, dx, dy);
        e.reparent_to_artboard(id);
      }
    });
    return changed();
  },

  setLocks(ids: number[], locks: { transparency: boolean; pixels: boolean; position: boolean }, label = 'Lock All Layers in Group') {
    const e = need();
    history.run(label, () => { for (const id of ids) e.set_props(id, JSON.stringify({ locks })); });
    return changed();
  },

  // Layer > Hide Layers / Show Layers: every listed layer in one history step.
  setVisibility(ids: number[], visible: boolean) {
    const e = need();
    history.run(visible ? 'Show Layers' : 'Hide Layers', () => { for (const id of ids) e.set_props(id, JSON.stringify({ visible })); });
    return changed();
  },

  // ---------- guides and grid (docs/M4.md section 12) ----------

  // `artboard` 0 = a canvas guide; `pos` is already document px, offset by the caller.
  addGuide(axis: 'x' | 'y', pos: number, artboard = 0) {
    const e = need();
    let created = 0;
    history.run('New Guide', () => { created = e.add_guide(axis, pos, artboard); });
    return { ...changed(), created };
  },

  moveGuide(id: number, pos: number) {
    const e = need();
    history.run('Move Guide', () => e.move_guide(id, pos));
    return changed();
  },

  deleteGuide(id: number) {
    const e = need();
    history.run('Delete Guide', () => e.delete_guide(id));
    return changed();
  },

  clearGuides(scope: 'all' | 'canvas' | 'artboard', artboard = 0) {
    const e = need();
    history.run('Clear Guides', () => e.clear_guides(scope, artboard));
    return changed();
  },

  // `params` field names match the engine's `new_guide_layout` JSON verbatim.
  newGuideLayout(params: {
    rect: [number, number, number, number]; columns: number; columnGutter: number; rows: number; rowGutter: number;
    margins: [number, number, number, number] | null; clearExisting: boolean; artboard?: number;
  }) {
    const e = need();
    let created: number[] = [];
    history.run('New Guide Layout', () => { created = Array.from(e.new_guide_layout(JSON.stringify({ artboard: 0, ...params }))); });
    return { ...changed(), created };
  },

  newGuidesFromShape(ids: number[]) {
    const e = need();
    let created: number[] = [];
    history.run('New Guide', () => { created = Array.from(e.new_guides_from_shape(Uint32Array.from(ids))); });
    return { ...changed(), created };
  },

  setGridSpacing(spacingX: number, spacingY: number) {
    const e = need();
    history.run('Grid Spacing', () => e.set_grid_and_locks(JSON.stringify({ grid: { spacing_x: spacingX, spacing_y: spacingY } })));
    return changed();
  },

  setGuidesLocked(locked: boolean) {
    const e = need();
    history.run(locked ? 'Lock Guides' : 'Unlock Guides', () => e.set_grid_and_locks(JSON.stringify({ guidesLocked: locked })));
    return changed();
  },

  // ---------- paths (docs/M4.md section 4) ----------

  // Replaces a role's path; ('document', 0) sets the work path. Returns the edited id.
  setPath(role: PathRole, id: number, path: VectorPath, label: string) {
    const e = need();
    let edited = 0;
    history.run(label, () => { edited = e.set_path(role, id, JSON.stringify(path)); });
    return { ...changed(), edited };
  },

  // ---------- artboards (docs/M4.md section 11) ----------

  // `after` = a selected artboard (placed to its right) or 0.
  newArtboard(name: string, w: number, h: number, background: ArtboardBackground, after = 0) {
    const e = need();
    let created = 0;
    history.run('New Artboard', () => { created = e.new_artboard(name, w, h, JSON.stringify(background), after); });
    return { ...changed(), created };
  },

  artboardFromGroup(id: number, name: string) {
    const e = need();
    history.run('Artboard from Group', () => e.artboard_from_group(id, name));
    return { ...changed(), created: id };
  },

  artboardFromLayers(ids: number[], name: string) {
    const e = need();
    let created = 0;
    history.run('Artboard from Layers', () => { created = e.artboard_from_layers(Uint32Array.from(ids), name); });
    return { ...changed(), created };
  },

  // Properties Artboard section: X/Y move the artboard with its layers and guides, W/H resize it.
  editArtboard(id: number, rect: [number, number, number, number], background: ArtboardBackground, label: string) {
    const e = need();
    history.run(label, () => {
      const node = findNode(e, id);
      const old = node?.artboard;
      if (!old) throw new Error(`node ${id} is not an artboard`);
      const dx = Math.round(rect[0] - old.rect[0]), dy = Math.round(rect[1] - old.rect[1]);
      if (dx || dy) {
        for (const pid of collectPixelIds(JSON.parse(e.layers_json()) as LayerNode[], id)) e.offset_layer(pid, dx, dy);
        e.offset_artboard(id, dx, dy);
      }
      const moved = findNode(e, id)!.artboard!;
      const [x, y] = moved.rect;
      e.set_artboard(id, JSON.stringify({ ...moved, rect: [x, y, x + Math.max(1, rect[2] - rect[0]), y + Math.max(1, rect[3] - rect[1])], background }));
    });
    return changed();
  },

  // A layer's vector mask (manifest v5 `vector_mask`), or null to remove it.
  setVectorMask(id: number, mask: object | null) {
    const e = need();
    history.run('Vector Mask', () => e.set_vector_mask(id, JSON.stringify(mask)));
    return changed();
  },

  newPath() {
    const e = need();
    let created = 0;
    history.run('New Path', () => { created = e.new_path(); });
    return { ...changed(), created };
  },

  savePath(id: number) {
    const e = need();
    history.run('Save Path', () => e.save_path(id));
    return changed();
  },

  renamePath(id: number, name: string) {
    const e = need();
    history.run('Rename Path', () => e.rename_path(id, name));
    return changed();
  },

  deletePath(id: number) {
    const e = need();
    history.run('Delete Path', () => e.delete_path(id));
    return changed();
  },

  fillPath(role: PathRole, id: number, layer: number, rgb: [number, number, number]) {
    const e = need();
    history.run('Fill Path', () => e.fill_path(role, id, layer, rgb[0], rgb[1], rgb[2], 255));
    return changed();
  },

  strokePath(role: PathRole, id: number, layer: number, rgb: [number, number, number], width = 1) {
    const e = need();
    history.run('Stroke Path', () => e.stroke_path(role, id, layer, width, rgb[0], rgb[1], rgb[2], 255));
    return changed();
  },

  makeSelectionFromPath(role: PathRole, id: number, mode: 'new' | 'add' | 'subtract' | 'intersect', label = 'Make Selection from Path') {
    const e = need();
    history.run(label, () => e.make_selection_from_path(role, id, mode));
    selGen++;
    return changed();
  },

  makeWorkPath(tolerance = 2) {
    const e = need();
    let created = 0;
    history.run('Make Work Path from Selection', () => { created = e.make_work_path(tolerance); });
    return { ...changed(), created };
  },

  convertPathToShape(role: PathRole, id: number, rgb: [number, number, number]) {
    const e = need();
    let created = 0;
    history.run('Convert Path to Shape', () => { created = e.convert_path_to_shape(role, id, rgb[0], rgb[1], rgb[2]); });
    return { ...changed(), created };
  },

  // Shape tools (docs/M4.md section 5): Shape mode adds a layer on top, Path mode replaces the
  // work path, Pixels mode paints on a pixel layer. `live` is the engine `Live` JSON; the pen
  // tools pass a drawn `path` instead.
  newShape(shape: { name: string; live?: object; path?: VectorPath; fill: FillContent | null; stroke: object | null }, label = 'Shape Layer') {
    const e = need();
    let created = 0;
    history.run(label, () => { created = e.new_shape(JSON.stringify(shape)); });
    return { ...changed(), created };
  },

  // Freeform pen: samples [[x, y], ...] fit to one subpath (tolerance 0.5..10 px).
  fitPath(points: [number, number][], tolerance: number, closed: boolean): VectorPath['subpaths'][number] {
    return JSON.parse(fit_path(JSON.stringify(points), tolerance, closed));
  },

  // Magnetic freeform pen: 0.3 R + 0.59 G + 0.11 B of a layer's pixel at each rounded point
  // [x, y, ...]; 0 outside the canvas or on a missing tile.
  luminance(layerId: number, points: number[]): number[] {
    const e = need(), ids = nodeTiles(e, layerId), tiles = new Map<number, Uint8Array | null>(), out: number[] = [];
    for (let k = 0; k < points.length; k += 2) {
      const x = Math.round(points[k]), y = Math.round(points[k + 1]);
      if (!(x >= 0 && y >= 0 && x < e.width() && y < e.height())) { out.push(0); continue; }
      const tx = Math.floor(x / 256), ty = Math.floor(y / 256), key = ty * 65536 + tx;
      if (!tiles.has(key)) tiles.set(key, layerTile(e, ids, tx, ty));
      const b = tiles.get(key), o = ((y - ty * 256) * 256 + (x - tx * 256)) * 4;
      out.push(b ? 0.3 * b[o] + 0.59 * b[o + 1] + 0.11 * b[o + 2] : 0);
    }
    return out;
  },

  shapePath(live: object) {
    const e = need();
    history.run('Shape Path', () => e.set_path('document', 0, live_path(JSON.stringify(live))));
    return changed();
  },

  fillShape(layer: number, shape: { live?: object; path?: VectorPath; fill: number[] | null; stroke: { width: number; color: number[] } | null }) {
    const e = need();
    history.run('Fill Shape', () => e.fill_shape(layer, JSON.stringify(shape)));
    return changed();
  },

  // Properties Appearance: one step over every edited shape layer, `{ live, fill, stroke }` each.
  setShapes(edits: { id: number; shape: object }[], label: string) {
    const e = need();
    history.run(label, () => { for (const x of edits) e.set_shape(x.id, JSON.stringify(x.shape)); });
    return changed();
  },

  // Layer > Combine Shapes and the Properties Pathfinder over several layers: the bottom shape
  // layer keeps its fill and stroke, the others are removed. Returns the kept id as `created`.
  combineShapes(ids: number[], op: BoolOp) {
    const e = need();
    let created = 0;
    history.run(BOOL_LABEL[op].message!, () => { created = e.combine_shapes(Uint32Array.from(ids), op); });
    return { ...changed(), created };
  },

  // Properties Pathfinder on one shape layer: its subpaths folded in order.
  pathfinder(id: number, op: BoolOp) {
    const e = need();
    history.run(BOOL_LABEL[op].message!, () => e.pathfinder(id, op));
    return changed();
  },

  mergeShapeComponents(ids: number[]) {
    const e = need();
    history.run('Merge Shape Components', () => e.merge_shape_components(Uint32Array.from(ids)));
    return changed();
  },

  // Layer > Rasterize > Type / Shape / Vector Mask over the selected layers, one step.
  rasterizeLayers(what: 'type' | 'shape' | 'vectorMask', ids: number[], name?: string) {
    const e = need();
    const label = name ?? { type: 'Rasterize Type', shape: 'Rasterize Shape', vectorMask: 'Rasterize Vector Mask' }[what];
    history.run(label, () => {
      for (const id of ids) {
        if (what === 'type') e.rasterize_type(id);
        else if (what === 'shape') e.rasterize_shape(id);
        else e.rasterize_vector_mask(id);
      }
    });
    return changed();
  },

  // Vector Mask menu and Properties edits: each layer's new mask (null removes it) as one step.
  vectorMaskEdit(edits: { id: number; mask: VectorMaskInfo | null }[], label: string) {
    const e = need();
    history.run(label, () => { for (const x of edits) e.set_vector_mask(x.id, JSON.stringify(x.mask)); });
    return changed();
  },

  // Copy SVG / Copy CSS: a plain shape layer at the root as one path, anything else as its
  // rendered pixels (trimmed) in an embedded PNG. The rect is the layer bounds, else the canvas.
  async layerCode(id: number, format: 'svg' | 'css') {
    const e = need();
    const tree = JSON.parse(e.layers_json()) as LayerNode[];
    const node = findNode(e, id);
    if (!node) throw new Error(`Layer not found: ${id}`);
    const lb = e.layer_bounds(id) as [number, number, number, number] | null;
    const rect: [number, number, number, number] = lb && lb[2] > 0 && lb[3] > 0 ? lb : [0, 0, e.width(), e.height()];
    let svg = tree.some(n => n.id === id) ? shapeSvg(node, rect) : null;
    const rasterFallback = !svg;
    if (!svg) {
      const png = await layerPng(e, id);
      if (!png) throw new Error('Layer has no exportable pixels.');
      svg = pngSvg(png.w, png.h, png.base64);
    }
    return { text: format === 'svg' ? svg : layerCss(svg, rect), rasterFallback };
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

  // Move tool: the union of the document bounds, guides, artboard rects and every visible layer's
  // content bounds (shape/vector-mask layers use their path bounds) except `excludeId`'s own
  // subtree, as [start, center, end] anchors per axis for snapping (docs/M4.md section 12). Each
  // category is gated by `categories` (View > Snap To); omitted categories default to on.
  snapTargets(excludeId: number, categories?: { guides?: boolean; layers?: boolean; documentBounds?: boolean; artboards?: boolean }) {
    const e = need();
    const cat = { guides: true, layers: true, documentBounds: true, artboards: true, ...categories };
    const rects: [number, number, number, number][] = [];
    if (cat.documentBounds) rects.push([0, 0, e.width(), e.height()]);
    const walk = (nodes: LayerNode[], excluded: boolean) => {
      for (const n of nodes) {
        const skip = excluded || n.id === excludeId;
        if (!skip && n.visible) {
          if (cat.artboards && n.artboard) {
            const [l, t, r, b] = n.artboard.rect;
            rects.push([l, t, r - l, b - t]);
          }
          if (cat.layers) {
            const pathBounds = n.shape?.path ?? n.vector_mask?.path;
            const pb = pathBounds ? vectorPathBounds(pathBounds) : null;
            if (pb) rects.push(pb);
            else if (n.kind === 'pixel' || n.kind === 'smart') {
              const b = e.layer_bounds(n.id) as [number, number, number, number] | null;
              if (b) rects.push(b);
            }
          }
        }
        if (n.children) walk(n.children, skip || !n.visible);
      }
    };
    walk(JSON.parse(e.layers_json()) as LayerNode[], false);
    const x: number[] = [], y: number[] = [];
    for (const [rx, ry, rw, rh] of rects) { x.push(rx, rx + rw / 2, rx + rw); y.push(ry, ry + rh / 2, ry + rh); }
    if (cat.guides) {
      const vec = JSON.parse(e.vector_json()) as { guides: Guide[] };
      for (const g of vec.guides) (g.axis === 'x' ? x : y).push(g.pos);
    }
    return { x, y };
  },

  // Union of the content bounds of every pixel layer under `id` (itself included), or null when
  // none has any pixels. The moving rect for snapping and for the union offset bounding box.
  movingBounds(id: number) {
    return unionBounds(need(), [id]);
  },

  // Union of the content bounds of the layers `ids` (groups by their pixel layers), or null when none
  // has any pixels (View > Fit Layer(s) on Screen, Show > Layer Edges).
  layersBounds(ids: number[]) {
    return unionBounds(need(), ids);
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

  // Type session: `typeBegin` edits layer `id`, or creates one from `text` above `above` ("New Type Layer"
  // first; a mask layer lives only inside the session). Returns the layer id and its text_layout JSON.
  typeBegin(o: { id?: number; text?: TextJson; above?: number; mask?: boolean }) {
    const e = need(), mask = !!o.mask;
    if (typeSession) api.typeCommit();
    let id = o.id ?? 0;
    const create = () => {
      id = e.add_special(o.above ?? 0, JSON.stringify({ name: layerName(''), text: o.text }));
      e.render_text(id, fontReg(), resolution(e));
    };
    if (o.id !== undefined) history.begin('Edit Type Layer');
    else if (!mask) { history.run('New Type Layer', create); history.begin('Edit Type Layer'); }
    else {
      history.begin('Type Mask');
      try { create(); } catch (err) { history.restoreOpen(); history.abort(); throw err; }
    }
    typeSession = { id, isNew: o.id === undefined, mask, changed: false, empty: (findNode(e, id)?.text?.text ?? '') === '' };
    version++;
    return { id, layout: e.text_layout(id, fontReg(), resolution(e)), doc: info()! };
  },

  // `changed`: the text differs from the session's start (an edit undone back to it records no step).
  typeUpdate(text: TextJson, name: string, changed = true) {
    const e = need(), s = typeSession;
    if (!s) throw new Error('No type edit is open.');
    e.set_text(s.id, JSON.stringify(text));
    if (!s.mask) e.set_props(s.id, JSON.stringify({ name }));
    e.render_text(s.id, fontReg(), resolution(e));
    s.changed = changed;
    s.empty = text.text === '';
    version++;
    return { layout: e.text_layout(s.id, fontReg(), resolution(e)), doc: info()! };
  },

  // The topmost visible type layer whose outline is within 2 px of (x, y); fully locked layers are skipped.
  typeHit(x: number, y: number): number | null {
    const e = need();
    for (const n of visibleTopDown(JSON.parse(e.layers_json()) as LayerNode[])) {
      if (n.kind !== 'text' || (n.locks.transparency && n.locks.pixels && n.locks.position)) continue;
      if (e.text_hit(n.id, fontReg(), resolution(e), x, y)) return n.id;
    }
    return null;
  },

  typeLayout(id: number): string {
    const e = need();
    return e.text_layout(id, fontReg(), resolution(e));
  },

  // A whole-layer model change outside a session (options bar, panels): one step.
  typeSet(id: number, text: TextJson, label: string) {
    const e = need();
    history.run(label, () => { e.set_text(id, JSON.stringify(text)); e.render_text(id, fontReg(), resolution(e)); });
    return changed();
  },

  // Several layers' new text models (panels, Type menu, Properties) as one step.
  typeSetMany(edits: [number, TextJson][], label: string) {
    const e = need();
    history.run(label, () => { for (const [id, t] of edits) { e.set_text(id, JSON.stringify(t)); e.render_text(id, fontReg(), resolution(e)); } });
    return changed();
  },

  // Type > Convert to Point Text / Convert to Paragraph Text; layers already of that kind are skipped.
  typeConvert(ids: number[], to: 'point' | 'paragraph') {
    const e = need(), res = resolution(e);
    const edits = ids.flatMap(id => {
      const t = findNode(e, id)?.text as TextJson | undefined;
      const layout = t && JSON.parse(e.text_layout(id, fontReg(), res));
      const n = t && (to === 'point' ? toPointText(t, layout) : toParagraphText(t, layout));
      return n ? [[id, n] as [number, TextJson]] : [];
    });
    return edits.length ? api.typeSetMany(edits, to === 'point' ? 'Convert to Point Text' : 'Convert to Paragraph Text') : info()!;
  },

  // Type > Create Work Path from the layer's outlines; refused on empty text.
  typeWorkPath(id: number) {
    const e = need();
    if (!findNode(e, id)?.text?.text) throw new Error('The type layer has no text.');
    history.run('Create Work Path', () => e.text_work_path(id, fontReg(), resolution(e)));
    return changed();
  },

  typeToShape(ids: number[]) {
    const e = need();
    history.run('Convert to Shape', () => { for (const id of ids) e.convert_text_to_shape(id, fontReg(), resolution(e)); });
    return changed();
  },

  typeRenderAll() {
    const e = need();
    const ids: number[] = [];
    const walk = (ns: LayerNode[]) => { for (const n of ns) { if (n.kind === 'text') ids.push(n.id); if (n.children) walk(n.children); } };
    walk(JSON.parse(e.layers_json()) as LayerNode[]);
    history.run('Update All Text Layers', () => { for (const id of ids) e.render_text(id, fontReg(), resolution(e)); });
    return changed();
  },

  // Commit: empty text deletes the layer; a mask's outline becomes the selection; an unchanged
  // existing layer records nothing.
  typeCommit() {
    const e = need(), s = typeSession;
    if (!s) return info()!;
    typeSession = null;
    if (s.mask || (!s.changed && !s.isNew)) {
      // Mask text without an outline (spaces only) ends like empty text.
      let outlined = false;
      if (s.mask && !s.empty) {
        try { e.select_text(s.id, fontReg(), resolution(e), 'new'); outlined = true; } catch { /* no outline */ }
      }
      if (outlined) {
        e.delete_node(s.id);
        history.commit();
        selGen++;
        return changed();
      }
      history.restoreOpen();
      history.abort();
      version++;
      return info()!;
    }
    if (s.empty) e.delete_node(s.id);
    history.commit();
    return changed();
  },

  // Cancel: back to the session's start; a new layer is removed ("Cancel Type Edit").
  typeCancel() {
    const e = need(), s = typeSession;
    if (!s) return info()!;
    typeSession = null;
    history.restoreOpen();
    history.abort();
    if (s.isNew && !s.mask) history.run('Cancel Type Edit', () => e.delete_node(s.id));
    return changed();
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
    moveSession = { liveBase: e.snapshot(), targetId, duplicated: duplicate, lastDx: 0, lastDy: 0, pixels: false, floating: false };
    return { ...changed(), activeId: targetId };
  },

  moveLayerStep(dx: number, dy: number) {
    const e = need(), s = moveSession;
    if (!s) return info();
    e.restore(s.liveBase);
    s.floating = false;
    const tree = JSON.parse(e.layers_json()) as LayerNode[];
    for (const pid of collectPixelIds(tree, s.targetId)) e.offset_layer(pid, dx, dy);
    if (findNode(e, s.targetId)?.artboard) e.offset_artboard(s.targetId, dx, dy);
    s.lastDx = dx;
    s.lastDy = dy;
    version++;
    return info()!;
  },

  moveLayerCommit() {
    const e = need(), s = moveSession;
    if (!s) return info();
    if (s.floating) e.restore(s.liveBase);
    e.drop_snapshot(s.liveBase);
    moveSession = null;
    if (s.lastDx || s.lastDy) e.reparent_to_artboard(s.targetId);
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
    moveSession = { liveBase: e.snapshot(), targetId: id, duplicated: copy, lastDx: 0, lastDy: 0, pixels: true, floating: false };
    return changed();
  },

  movePixelsStep(dx: number, dy: number) {
    const e = need(), s = moveSession;
    if (!s) return info();
    e.restore(s.liveBase);
    s.floating = false;
    e.move_selected_pixels(s.targetId, dx, dy, s.duplicated);
    s.lastDx = dx;
    s.lastDy = dy;
    version++;
    selGen++;
    return info()!;
  },

  movePixelsCommit() {
    const e = need(), s = moveSession;
    if (!s) return info();
    if (s.floating) e.restore(s.liveBase);
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

  // Right after a move begin: when the moved pixels look the same drawn as a plain image on top (a
  // top-level pixel layer, normal blend, full opacity and fill, no mask, style or clipping, nothing
  // visible above), returns that image like transformBegin and shows the document without them
  // until the next step; otherwise null and nothing changes. `scale` is image px per document px
  // (the view's device scale), at most 1. The image is capped at 2 MP; when that makes it softer
  // than `scale`, `over` is a sharp image of the visible rect `view` plus half a view around it.
  moveFloat(scale = 1, view: Box | null = null) {
    const e = need(), s = moveSession;
    if (!s || s.lastDx || s.lastDy) return null;
    const tree = JSON.parse(e.layers_json()) as LayerNode[];
    const i = tree.findIndex(n => n.id === s.targetId), n = tree[i];
    if (!n || !n.visible) return null;
    if (n.kind !== 'pixel' || n.blend !== 'normal' || n.opacity !== 1 || n.fill !== 1 || n.clipping || n.mask || n.vector_mask || n.style || visibleTopDown(tree.slice(i + 1)).length) {
      return s.pixels ? null : moveSplit(e, s, tree, i, scale, view);
    }
    const sel = s.pixels ? (JSON.parse(e.channels_json()) as { selection: { bounds: Box | null } | null }).selection?.bounds ?? null : null;
    const found = s.pixels ? intersect(sel, e.layer_bounds(s.targetId) as Box | null) : e.layer_bounds(s.targetId) as Box | null;
    if (!found) return null;
    const sharp = Math.min(1, scale), f = Math.min(sharp, Math.sqrt((1 << 21) / (found[2] * found[3])));
    const { image, data } = liftPreview(e, s.targetId, Array.from(found) as Box, s.pixels, Math.max(64, Math.ceil(Math.max(found[2], found[3]) * f)));
    const near = view && f < 0.9 * sharp ? intersect(found, [view[0] - view[2] / 2, view[1] - view[3] / 2, view[2] * 2, view[3] * 2]) : null;
    const over = near && liftPreview(e, s.targetId, near.map(Math.round) as Box, s.pixels, Math.ceil(Math.max(near[2], near[3]) * sharp));
    if (s.pixels) { if (!s.duplicated) e.clear(s.targetId, 'pixels'); }
    else {
      e.set_props(s.targetId, JSON.stringify({ visible: false }));
      s.reveal = () => { e.set_props(s.targetId, JSON.stringify({ visible: true })); return () => e.set_props(s.targetId, JSON.stringify({ visible: false })); };
    }
    if (!s.pixels && near) s.patch = mr => {
      const b = intersect(found, mr);
      return { moved: b && liftPreview(e, s.targetId, b.map(Math.round) as Box, false, Math.ceil(Math.max(b[2], b[3]) * sharp)), above: null };
    };
    s.floating = true;
    version++;
    return { ...info()!, image, data, over, above: null, pending: false };
  },

  // Sharp images of the open float over doc rects `moved` (the moved pixels where they started) and
  // `above` (the layers above), for a drag that reaches past the sharp images moveFloat returned.
  // `base`: the whole-layer images instead, after a moveFloat reply marked `pending`.
  moveFloatPatch(moved: Box | null, above: Box | null, base = false) {
    const s = moveSession;
    if (!s?.floating) return null;
    if (base) return s.base?.() ?? null;
    return s.patch ? s.patch(moved, above) : null;
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
      if (kind === 'layer') e.clear_lifted(id, 'pixels');
      else if (kind === 'pixels') e.clear(id, 'pixels');
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
      e.clear_lifted(s.id, 'pixels');
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

  // Edit > Auto-Align Layers (onto the bottom selected layer) and Auto-Blend Layers.
  autoAlign(ids: number[], reposition: boolean) {
    const e = need();
    history.run('Auto-Align Layers', () => e.auto_align(new Uint32Array(ids), reposition));
    return changed();
  },

  autoBlend(ids: number[], stack: boolean, seamless: boolean) {
    const e = need();
    history.run('Auto-Blend Layers', () => e.auto_blend(new Uint32Array(ids), stack, seamless));
    return changed();
  },

  // File > Automate > Photomerge: aligns (and blends) every pixel layer of the active document.
  photomerge(blend: boolean) {
    const e = need();
    history.run('Photomerge', () => e.photomerge(blend));
    return changed();
  },

  // File > Automate > Merge to HDR Pro: the open documents in tab order are the exposures, each
  // `stops` brighter than the one before; the 32-bit result opens as a new tab.
  mergeHdr(stops: number) {
    if (docs.length < 2) throw new Error('Merge to HDR Pro needs at least two open documents, one per exposure.');
    const srcs = docs.map((_, i) => outerEng(i));
    const m = new HdrMerge(srcs[0].width(), srcs[0].height());
    try {
      tileLoop(srcs[0].width(), srcs[0].height(), (tx, ty) => {
        srcs.forEach((src, i) => m.add(src, tx, ty, i * stops));
        m.write(tx, ty);
      });
    } catch (err) {
      m.free();
      throw err;
    }
    return adopt(m.finish(), `${tabName(0)} HDR`);
  },

  trim(basedOn: 'transparent' | 'topLeftPixel' | 'bottomRightPixel', top: boolean, bottom: boolean, left: boolean, right: boolean) {
    const e = need();
    return canvasEdit('Trim', () => e.trim(basedOn, top, bottom, left, right));
  },

  revealAll() {
    const e = need();
    return canvasEdit('Reveal All', () => e.reveal_all());
  },

  canvasSize(w: number, h: number, ax: number, ay: number, fill: [number, number, number, number] | null) {
    const e = need();
    return canvasEdit('Canvas Size', () => e.canvas_size(w, h, ax, ay, fill && Float32Array.from(fill)));
  },

  // The engine only resamples text caches; they are re-rendered here (a layer whose font is missing
  // keeps the resampled cache). A ppi change rescales the pt lengths so pixel sizes follow the resample only.
  imageSize(w: number, h: number, interp: string, scaleStyles: boolean, res: number | null) {
    const e = need();
    return canvasEdit('Image Size', () => {
      let done = e.image_size(w, h, interp, scaleStyles);
      const old = resolution(e), k = res != null && res !== old ? old / res : 1;
      if (k !== 1) {
        e.set_document_vector(JSON.stringify({ ...JSON.parse(e.vector_json()), resolution: res }));
        done = true;
      }
      if (!done) return false;
      const texts: LayerNode[] = [];
      const walk = (ns: LayerNode[]) => { for (const n of ns) { if (n.kind === 'text') texts.push(n); if (n.children) walk(n.children); } };
      walk(JSON.parse(e.layers_json()) as LayerNode[]);
      for (const n of texts) {
        try {
          if (k !== 1 && n.text) e.set_text(n.id, JSON.stringify(scaleTextPt(n.text, k)));
          e.render_text(n.id, fontReg(), resolution(e));
        } catch { /* keep the resampled cache */ }
      }
      return true;
    });
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

  // Layer > Layer Mask > Reveal/Hide Selection: the mask is the selection (inverted to hide); deselects.
  addMaskFromSelection(id: number, hide: boolean) {
    const e = need();
    history.run('Add Layer Mask', () => e.add_mask_from_selection(id, hide));
    selGen++;
    return changed();
  },

  // Layer > Layer Mask > From Transparency: the layer's alpha moves into a new mask; the pixels turn opaque.
  maskFromTransparency(id: number) {
    const e = need();
    history.run('From Transparency', () => e.mask_from_transparency(id));
    return changed();
  },

  // Layer > Layer Mask > Apply: the mask multiplies into the alpha and is removed (a disabled mask too).
  applyMask(id: number) {
    const e = need();
    history.run('Apply Layer Mask', () => e.apply_mask(id));
    return changed();
  },

  // Layer > Matting > Defringe: `width` 1..200 px.
  defringe(id: number, width: number) {
    const e = need();
    history.run('Defringe', () => e.defringe(id, width));
    return changed();
  },

  // Layer > Matting > Remove White Matte (`white`) or Remove Black Matte.
  removeMatte(id: number, white: boolean) {
    const e = need();
    history.run(white ? 'Remove White Matte' : 'Remove Black Matte', () => e.remove_matte(id, white));
    return changed();
  },

  // Layer > Matting > Color Decontaminate: `percent` 0..100; the layer needs a layer mask.
  colorDecontaminate(id: number, percent: number) {
    const e = need();
    history.run('Color Decontaminate', () => e.color_decontaminate(id, percent / 100));
    return changed();
  },

  // Layer > New Fill Layer: `label` is the per-type menu label ("Solid Color"/"Gradient"/"Pattern"),
  // `name` the layer's name ("Color Fill"/"Gradient Fill"/"Pattern Fill"). One engine call masks the
  // new layer to the selection (or reveals all) and drops the selection, so this is one undo step.
  newFillLayer(above: number, content: FillContent, name: string, label: string) {
    const e = need();
    let created = 0;
    history.run(label, () => { ensurePatterns(e, patternRefs(content)); created = e.add_fill_layer(above, JSON.stringify({ name, content })); });
    selGen++;
    return { ...changed(), created };
  },

  // Layer > Layer Content Options: replaces every selected fill layer's content as one undo step.
  setFillContent(ids: number[], content: FillContent) {
    const e = need();
    history.run('Layer Content Options', () => { ensurePatterns(e, patternRefs(content)); for (const id of ids) e.set_content(id, JSON.stringify(content)); });
    return changed();
  },

  // A preset pattern picked in a pattern picker: copied into the document once, outside history (D3).
  addDocumentPattern(p: PatternRecord) {
    const e = need();
    const { width: w, height: h, channels: c, data } = p;
    if (typeof p.id !== 'string' || !p.id || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || (c !== 1 && c !== 4) || !(data instanceof Uint8Array) || data.length !== w * h * c) {
      throw new Error(`pattern ${String(p.id)}: size ${w}x${h}x${c} does not match ${data?.length} bytes`);
    }
    const rgba = c === 4 ? data.slice() : new Uint8Array(w * h * 4);
    if (c === 1) for (let i = 0; i < w * h; i++) rgba.set([data[i], data[i], data[i], 255], i * 4);
    presetPatterns.set(p.id, { name: p.name, width: w, height: h, rgba });
    ensurePatterns(e, [p.id]);
    if (previewOpen) { version++; return info()!; }
    return changed();
  },

  // RGBA pixels of a document pattern (picker thumbnails).
  patternPixels(id: string) {
    const e = need();
    const p = docPatterns(e).find(x => x.id === id);
    if (!p) throw new Error(`unknown pattern ${id}`);
    return { width: p.width, height: p.height, data: e.tile_bytes(BigInt(p.blob)).buffer as ArrayBuffer };
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
      ensurePatterns(e, patternRefs(style));
      e.paste_style(Uint32Array.of(id), JSON.stringify(style));
      e.set_blending(id, JSON.stringify(blending));
      e.set_props(id, JSON.stringify({ fill }));
      if (light) e.set_document_m3(JSON.stringify({ global_light: normLight(light) }));
    });
  },

  // Layers panel eyes and fx-badge drags: one step under `label` replacing `id`'s style.
  editLayerStyle(id: number, style: LayerStyle, label: string) {
    const e = need();
    history.run(label, () => { ensurePatterns(e, patternRefs(style)); e.paste_style(Uint32Array.of(id), JSON.stringify(style)); });
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

  documentHistogram(key: string, layerId: number | null) {
    const i = docs.findIndex(d => d.key === key);
    if (i < 0) throw new Error('The source document is no longer open.');
    const e = i === active ? need() : docs[i].eng;
    if (layerId !== null && findNode(e, layerId)?.kind !== 'pixel') throw new Error('The histogram source must be a pixel layer.');
    return { key, version: i === active ? version : docs[i].version, histogram: unfloated(e, () => e.histogram(layerId ?? 0) as Uint32Array) };
  },

  // Layers panel thumbnails: each layer over the whole canvas, longest side `size` px (never upscaled).
  // `key` is the layer's manifest node (tile ids, text, smart placement) plus canvas size; an unchanged key reuses the render.
  layerThumbs(ids: number[], size: number) {
    const e = need();
    if (thumbDoc !== docId) { thumbs.clear(); thumbDoc = docId; }
    const W = e.width(), H = e.height(), f = Math.min(1, size / Math.max(W, H));
    const w = Math.max(1, Math.floor(W * f)), h = Math.max(1, Math.floor(H * f));
    type MNode = { id: number; children?: MNode[] };
    const nodes = new Map<number, string>();
    const walk = (ns: MNode[]) => { for (const { children, ...n } of ns) { nodes.set(n.id, JSON.stringify(n)); if (children) walk(children); } };
    walk((JSON.parse(e.manifest()) as { layers: MNode[] }).layers);
    const out: { id: number; key: string; w: number; h: number; data: ArrayBuffer }[] = [];
    for (const id of ids) {
      const node = nodes.get(id);
      if (node === undefined) continue;
      const key = `${W}x${H}@${w}x${h}|${node}`, hit = thumbs.get(id);
      if (hit?.key === key) { out.push(hit.thumb); continue; }
      let data = new ArrayBuffer(0);
      if (e.layer_bounds(id)) {
        try { data = e.transform_preview(id, Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1), f, false, 0, 0, w, h).buffer as ArrayBuffer; } catch { data = tileThumb(e, nodeTiles(e, id), W, H, w, h); }
      }
      const thumb = { id, key, w, h, data };
      thumbs.set(id, { key, thumb });
      out.push(thumb);
    }
    return out;
  },

  // Window > Navigator: the flattened composite, longest side `size` px (never upscaled), straight RGBA.
  // Built from the coarsest pyramid level that still has at least `size` px on its long side.
  navigatorThumb(size: number) {
    const e = need();
    const W = e.width(), H = e.height(), [w, h] = thumbSize(W, H, size);
    let L = 0;
    while (L < e.max_level() && Math.max(W, H) >> (L + 1) >= size) L++;
    const lw = Math.ceil(W / 2 ** L), lh = Math.ceil(H / 2 ** L), src = new Uint8Array(lw * lh * 4);
    unfloated(e, () => {
      for (let ty = 0; ty * TILE < lh; ty++) for (let tx = 0; tx * TILE < lw; tx++) {
        const t = e.display_tile(L, tx, ty) as Uint8Array | undefined;
        if (!t) continue;
        const cw = Math.min(TILE, lw - tx * TILE);
        for (let y = 0; y < Math.min(TILE, lh - ty * TILE); y++) src.set(t.subarray(y * TILE * 4, (y * TILE + cw) * 4), ((ty * TILE + y) * lw + tx * TILE) * 4);
      }
    });
    return { docId, version, w, h, data: boxScale(src, lw, lh, w, h).buffer as ArrayBuffer };
  },

  // Mean RGBA over an odd-sized box centered on (x, y), clamped to the canvas; layerId null
  // samples the flattened composite of all layers, else that layer's own pixels.
  sample(x: number, y: number, size: number, layerId: number | null): [number, number, number, number] {
    return sampleDocument(need(), x, y, size, layerId);
  },

  documentSample(key: string, x: number, y: number, size: number, layerId: number | null) {
    const i = docs.findIndex(d => d.key === key);
    if (i < 0) throw new Error('The source document is no longer open.');
    const e = i === active ? need() : docs[i].eng;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= e.width() || y >= e.height()) throw new Error('The sample coordinate is outside the document.');
    if (size !== 1 && size !== 3 && size !== 5) throw new Error('The sample size must be 1, 3, or 5.');
    if (layerId !== null && findNode(e, layerId)?.kind !== 'pixel') throw new Error('The sample source must be a pixel layer.');
    return { key, version: i === active ? version : docs[i].version, color: sampleDocument(e, x, y, size, layerId) };
  },

  // Opens a stroke (docs/M2.md section 4) as one undo step spanning every strokeTo until strokeEnd.
  // Brush presets send the full engine StrokeIn shape (brushes/preset.ts toStrokeParams).
  strokeBegin(layerId: number, target: 'pixels' | 'selection', params: StrokeParams | Record<string, unknown>, label: string) {
    const e = need();
    const { eraseToHistory, historySource, ...rest } = params as StrokeParams;
    const p: Record<string, unknown> = rest;
    const src = p.source as { kind: string; patternId?: unknown } | undefined;
    if (src?.kind === 'pattern') p.source = { ...src, patternId: engineAsset(e, src.patternId, 'pattern') };
    if (eraseToHistory) {
      const snap = history.oldestSnapshot();
      if (snap !== null) p.eraseToHistory = snap;
    }
    // The history brushes paint from the oldest history state, like Erase to History.
    if (historySource) {
      const snap = history.oldestSnapshot();
      if (snap === null) throw new Error('Set a history state as the source in the History panel.');
      p.source = { kind: 'history', snapshotId: snap };
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
    const name = nodes.length === 1 ? nodes[0]!.name : used.has(baseName('Group')) ? nextName('Group') : baseName('Group');
    let created = 0;
    history.run('Convert to Smart Object', () => { created = toSmart(e, ids, name); });
    return { ...changed(), created };
  },

  // File > Scripts > Load Files into Stack: a new document as large as the largest file, one layer per
  // file at the top left (the first file at the bottom), optionally auto-aligned and turned into one smart object.
  async loadStack(files: File[], align: boolean, smart: boolean): Promise<OpenResult> {
    const srcs = [];
    for (const f of files) srcs.push({ name: f.name.replace(/\.[^.]+$/, ''), ...await decodeSource(new Uint8Array(await f.arrayBuffer())) });
    if (!srcs.length) throw new Error('Choose at least one file.');
    const e = new Engine(Math.max(...srcs.map(s => s.w)), Math.max(...srcs.map(s => s.h)), 8);
    const warnings: string[] = [];
    try {
      const ids: number[] = [];
      for (const s of srcs) {
        ids.push(e.add_layer(s.name, ids.at(-1) ?? BACKGROUND));
        putRgba(e, ids.at(-1)!, s.w, s.h, s.rgba);
      }
      e.delete_node(BACKGROUND);
      if (align && ids.length > 1) {
        try { e.auto_align(Uint32Array.from(ids), false); } catch (err) { warnings.push(`The layers were not aligned: ${(err as Error).message}`); }
      }
      if (smart) toSmart(e, ids, srcs[0].name);
      if (colorSettings && colorSettings.rgbPolicy !== 'off') e.assign_profile(colorSettings.rgb, profileBytes(colorSettings.rgb));
    } catch (err) {
      e.free();
      throw err;
    }
    return { ...adopt(e, 'Untitled'), warnings };
  },

  // Filter > Convert for Smart Filters: one pixel layer in place (same id); its source is a PSB of the
  // layer's pixels alone.
  convertForSmartFilters(id: number) {
    const e = need();
    const sub = e.extract_layer(id);
    let bytes: Uint8Array | null = null;
    try { bytes = exportPsd(sub, { psb: true }).bytes; } catch { bytes = null; } finally { sub.free(); }
    history.run('Convert for Smart Filters', () => {
      const blob = bytes ? Number(e.blob_add(bytes)) : null;
      e.convert_for_smart_filters(id, JSON.stringify({ link_id: uuid(), source_blob: blob }));
    });
    return changed();
  },

  // The filter registry (docs/M5.md section 1) the Filter menu and dialog are built from.
  filterSchema() {
    return JSON.parse(filter_schema()) as unknown[];
  },

  // A registry filter on `target`; a preview limits it to `view` [x, y, w, h] at proxy `scale`.
  applyFilter(id: number, target: 'pixels' | 'mask' | 'selection', filter: SmartFilterKind, label: string, preview = false, view: number[] = [], scale = 1) {
    const e = need();
    return edit(label, preview, () => e.apply_filter(id, target, JSON.stringify(filter), Int32Array.from(view), scale));
  },

  // Edit > Puppet Warp: the mesh over layer `id`'s opaque pixels, and a rig's deformed mesh for the overlay.
  puppetMesh(id: number, density: Density, expansion: number) {
    return JSON.parse(need().puppet_mesh(id, density, expansion)) as Grid;
  },

  puppetGeometry(rig: Rig) {
    return JSON.parse(puppet_geometry(JSON.stringify(rig))) as Geometry;
  },

  // Filter > Liquify: a session on layer `id`'s pixels, or on its Liquify smart filter `filterId`'s mesh.
  liquifyBegin(id: number, maxSide: number, spacing: number, filterId: number | null) {
    const e = need();
    liquify?.free();
    liquify = null;
    liquify = e.liquify_begin(id, maxSide, spacing, filterId ?? undefined);
    return liquifyView(true);
  },

  // Applies dialog edits in order and returns the new view; `overlays` adds the mesh and the frozen mask.
  liquifyEdit(id: number, ops: LiquifyOp[], overlays: boolean) {
    const e = need(), l = liquify;
    if (!l) throw new Error('No Liquify session is open.');
    for (const o of ops) {
      if (o.op === 'begin') l.stroke_begin(JSON.stringify(o.brush), o.x, o.y);
      else if (o.op === 'to') l.stroke_to(o.x, o.y);
      else if (o.op === 'hold') l.stroke_hold();
      else if (o.op === 'end') l.stroke_end();
      else if (o.op === 'mask') { if (o.source) e.liquify_mask(l, id, o.source, o.mode); else l.mask_preset(o.mode); }
      else if (o.op === 'reconstruct') l.reconstruct(o.amount);
      else if (o.op === 'restore') l.restore_all();
      else if (o.op === 'spacing') l.set_spacing(o.spacing);
      else l.set_pin_edges(o.on);
    }
    return liquifyView(overlays);
  },

  // OK: the mesh becomes a document blob and one "Liquify" step (a smart filter on a smart object).
  liquifyCommit(id: number, filterId: number | null) {
    const e = need(), l = liquify;
    if (!l) throw new Error('No Liquify session is open.');
    liquify = null;
    try {
      if (filterId === null && l.identity()) return info()!;
      const filter = { kind: 'liquify', params: { mesh: Number(e.blob_add(l.bytes())), reach: Math.min(65535, e.width(), e.height(), Math.ceil(l.max_shift())) } };
      return filterId === null ? api.applyFilter(id, 'pixels', filter, 'Liquify') : api.setSmartFilter(id, filterId, { filter }, 'Liquify');
    } finally {
      l.free();
    }
  },

  // The Show Backdrop image over the document rect: the composite (`id` null) or one layer's pixels.
  liquifyBackdrop(id: number | null, maxSide: number) {
    if (id === null) return api.navigatorThumb(maxSide);
    const l = need().liquify_begin(id, maxSide, 16, undefined);
    try {
      return { data: l.render().buffer as ArrayBuffer, w: l.proxy_width(), h: l.proxy_height() };
    } finally {
      l.free();
    }
  },

  liquifyEnd() {
    liquify?.free();
    liquify = null;
  },

  // Filter > Vanishing Point: the proxy of layer `id` (or of the input below smart filter `filterId`),
  // the document planes and, when re-editing, the filter's state.
  vpBegin(id: number, maxSide: number, filterId: number | null) {
    const e = need();
    const l = e.liquify_begin(id, maxSide, 16, filterId ?? undefined);
    try {
      vp = { data: l.render(), w: l.proxy_width(), h: l.proxy_height(), scale: l.scale() };
    } finally {
      l.free();
    }
    const planes = (JSON.parse(e.vector_json()) as { vanishing_planes?: VanishingPlane[] }).vanishing_planes ?? [];
    let state: VanishingState | null = null;
    if (filterId !== null) {
      const find = (ns: LayerNode[]): LayerNode | undefined => ns.map(n => (n.id === id ? n : n.children && find(n.children))).find(Boolean);
      const f = find(JSON.parse(e.layers_json()) as LayerNode[])?.smart?.filters.find(f => f.id === filterId)?.filter as { params?: { state?: VanishingState } } | undefined;
      state = f?.params?.state ?? null;
    }
    return { data: vp.data.slice().buffer, w: vp.w, h: vp.h, scale: vp.scale, planes, state };
  },

  // The proxy with `state`'s dabs, every dab sampling the proxy as opened.
  vpPreview(state: VanishingState) {
    if (!vp) throw new Error('No Vanishing Point session is open.');
    return vanishing_render(vp.data, vp.w, vp.h, vp.scale, JSON.stringify(state)).buffer as ArrayBuffer;
  },

  vpConnected(parent: VanishingPlane, edge: string, angle: number, id: string) {
    return JSON.parse(vanishing_connected(JSON.stringify(parent), edge, angle, id)) as VanishingPlane;
  },

  // OK: with dabs (or re-editing a filter) one "Vanishing Point" step that also saves the planes,
  // without dabs one "Vanishing Point Planes" step.
  vpCommit(id: number, filterId: number | null, state: VanishingState) {
    const e = need();
    vp = null;
    const planes = JSON.stringify(state.planes);
    if (!state.stamps.length && filterId === null) {
      history.run('Vanishing Point Planes', () => e.set_vanishing_planes(planes));
      return changed();
    }
    const filter = { kind: 'vanishing_point', params: { state } };
    history.run('Vanishing Point', () => {
      e.set_vanishing_planes(planes);
      if (filterId === null) e.apply_filter(id, 'pixels', JSON.stringify(filter), new Int32Array(), 1);
      else e.set_smart_filter(id, filterId, JSON.stringify({ filter }));
    });
    return changed();
  },

  vpEnd() {
    vp = null;
  },

  // Edit > Fade: mixes layer `id` back toward the state before the last step.
  fade(id: number, params: { opacity: number; mode: string }, preview = false) {
    const e = need();
    const snap = history.lastSnapshot();
    if (snap === null) throw new Error('There is nothing to fade.');
    return edit('Fade', preview, () => e.fade(id, snap, JSON.stringify(params)));
  },

  // Appends a smart filter (Filter > Blur > Gaussian Blur); `preview` reruns inside the dialog's session.
  addSmartFilter(id: number, filter: SmartFilterKind, label: string, preview = false) {
    const e = need();
    return edit(label, preview, () => { e.add_smart_filter(id, JSON.stringify(filter)); });
  },

  // Edits one filter: `patch` holds any of filter (params), enabled, opacity, blend.
  setSmartFilter(id: number, filterId: number, patch: Partial<Omit<SmartFilterInfo, 'id' | 'mask'>>, label: string, preview = false) {
    const e = need();
    return edit(label, preview, () => e.set_smart_filter(id, filterId, JSON.stringify(patch)));
  },

  // Layer > Smart Filter: Disable/Enable Smart Filters, Clear Smart Filters, Delete/Disable Filter Mask.
  smartFilterCommand(id: number, op: 'toggle' | 'clear' | 'deleteMasks' | 'toggleMasks', label: string) {
    const e = need();
    history.run(label, () => {
      if (op === 'toggle') e.toggle_smart_filters(id);
      else if (op === 'clear') e.clear_smart_filters(id);
      else if (op === 'deleteMasks') e.delete_filter_masks(id);
      else e.toggle_filter_masks(id);
    });
    return changed();
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
    let sub: Engine, warnings: string[] = [];
    if (bytes && isPsdBytes(bytes)) {
      const r = importPsd(bytes, { psb: true });
      sub = r.engine;
      warnings = r.warnings;
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
    return { ...info()!, warnings };
  },

  // Writes the open contents back to every smart object in the parent sharing the source, as one parent step.
  // PSD export warnings (what the source file cannot store) block the write until `accept`; `written` tells.
  async smartEditSave(accept = false): Promise<DocInfo & { warnings: string[]; written: boolean }> {
    const p = parents.at(-1);
    if (!p) throw new Error('No smart object contents are open.');
    const sub = need();
    const node = findNode(p.eng, p.id);
    if (!node?.smart) throw new Error('The original Smart Object was removed or replaced. Use Save As to keep these contents.');
    const link = node.smart.link;
    let bytes: Uint8Array, warnings: string[] = [];
    const ext = link.type === 'embedded' ? 'psb' : (link.name.split('.').pop() ?? '').toLowerCase();
    if (link.type === 'embedded' || ext === 'psd' || ext === 'psb') ({ bytes, warnings } = exportPsd(sub, { psb: ext === 'psb' }));
    else if (RASTER[ext]) bytes = new Uint8Array(await (await encodeFlattened(sub, RASTER[ext])).arrayBuffer());
    else throw new Error(`Cannot save linked .${ext} contents. Use Save As to keep your edits.`);
    if (warnings.length && !accept) return { ...info()!, warnings, written: false };
    if (link.type === 'linked') {
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
    return { ...info()!, warnings, written: true };
  },

  // Writes back unsaved changes ('discard' skips that), then the parent returns with its history.
  // Export warnings without 'accept', or a failed write, keep the contents open and are returned.
  async smartEditClose(mode: 'save' | 'accept' | 'discard' = 'save'): Promise<DocInfo & { warnings: string[]; closed: boolean; error?: string }> {
    const p = parents.at(-1);
    if (!p) throw new Error('No smart object contents are open.');
    if (version !== p.saved && mode !== 'discard') {
      try {
        const r = await api.smartEditSave(mode === 'accept');
        if (!r.written) return { ...info()!, warnings: r.warnings, closed: false };
      } catch (err) {
        return { ...info()!, warnings: [], closed: false, error: (err as Error).message };
      }
    }
    parents.pop();
    history.clear();
    eng!.free();
    eng = p.eng;
    history = p.history;
    name = p.name;
    docId++;
    selGen++;
    return { ...changed(), warnings: [], closed: true };
  },

  undo() { if (history.undo()) { selGen++; return changed(); } return info(); },
  // Edit > Toggle Last State: redoes right after its own undo (nothing changed since), else undoes.
  toggleLastState() {
    need();
    const redo = toggleRedo();
    const moved = redo ? history.redo() : history.undo();
    toggled = moved && !redo ? { h: history, serial: history.serial } : null;
    if (!moved) return info();
    selGen++;
    return changed();
  },
  // Edit > Purge: the copy buffer, the active document's undo and redo steps, or both. The dirty state stays.
  purge(what: 'clipboard' | 'histories' | 'all') {
    need();
    if (what !== 'histories') clipboard = null;
    if (what === 'clipboard') return info();
    if (history.isOpen) throw new Error('Finish the current edit before purging the history.');
    const clean = !isDirty(active);
    history.clear();
    if (clean && !parents.length) saved = history.top;
    return changed();
  },
  redo() { if (history.redo()) { selGen++; return changed(); } return info(); },
  historyGoto(n: number) { need(); if (history.goto(n)) { selGen++; return changed(); } return info(); },

  displayTile(level: number, tx: number, ty: number) {
    const e = need();
    const px = e.display_tile(level, tx, ty) as Uint8Array | undefined;
    return { docId, version, data: px ? px.buffer as ArrayBuffer : null };
  },

  documentDisplayTile(key: string, level: number, tx: number, ty: number) {
    const i = docs.findIndex(d => d.key === key);
    if (i < 0) throw new Error('The source document is no longer open.');
    const e = i === active ? need() : docs[i].eng;
    const sourceVersion = i === active ? version : docs[i].version;
    const px = e.display_tile(level, tx, ty) as Uint8Array | undefined;
    return {
      key, version: sourceVersion, width: e.width(), height: e.height(), depth: e.depth(), maxLevel: e.max_level(),
      data: px ? px.buffer as ArrayBuffer : null,
    };
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

  // File > Export: Quick Export, Export As, Save for Web, Layers and Artboards to Files.
  exportAsset(o: ExportOptions) {
    return exportAsset(need(), o);
  },

  // File > Export > Artboards to PDF: each root artboard on the canvas as one JPEG page at the document resolution.
  async artboardsPdf(quality: number) {
    const e = need(), res = resolution(e) || 72;
    const pages: PdfPage[] = [];
    for (const n of (JSON.parse(e.layers_json()) as LayerNode[]).filter(n => n.artboard)) {
      const a = await exportAsset(e, { format: 'jpeg', quality, scale: 1, colors: 256, dither: 'none', icc: false, artboard: n.id, reveal: true }).catch(() => null);
      if (!a) continue;
      pages.push({ jpeg: new Uint8Array(await a.blob.arrayBuffer()), width: a.width, height: a.height, ptW: a.width * 72 / res, ptH: a.height * 72 / res });
    }
    if (!pages.length) throw new Error('No artboard lies on the canvas.');
    return new Blob([makePdf(pages)], { type: 'application/pdf' });
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

  // Marks the outermost document saved (an open Edit Contents saves the nested one, which is not the tab's file).
  // Call saveEnd(false) when the user then cancels the file picker.
  savePsd(): { blob: Blob; warnings: string[] } {
    const r = psdFile(need());
    markSaved();
    return r;
  },

  // File > Package: a PSD copy with every linked Smart Object embedded; the document is unchanged.
  async packagePsd(): Promise<{ blob: Blob; warnings: string[]; embedded: number }> {
    const e = need();
    const c = loadEngine(e.manifest(), t => e.tile_bytes(BigInt(t)));
    try {
      let embedded = 0;
      for (const n of flatNodes(JSON.parse(c.layers_json()) as LayerNode[])) {
        if (n.smart?.link.type !== 'linked') continue;
        const bytes = await readLinked(n.smart.link);
        c.set_smart_link(n.id, JSON.stringify({ link: { type: 'embedded', id: uuid() }, source_blob: Number(c.blob_add(bytes)) }));
        embedded++;
      }
      return { ...psdFile(c), embedded };
    } finally {
      c.free();
    }
  },

  // File > File Info.
  fileInfo(): FileInfo | null { return docInfo(need()); },
  setFileInfo(i: FileInfo) {
    const e = need();
    const v = JSON.parse(e.vector_json());
    const before = JSON.stringify(v.info ?? null);
    if (hasInfo(i)) v.info = i; else delete v.info;
    if (JSON.stringify(v.info ?? null) === before) return info();
    history.run('File Info', () => e.set_document_vector(JSON.stringify(v)));
    return changed();
  },

  // Image > Variables.
  variables(): Variables { return JSON.parse(need().vector_json()).variables ?? emptyVariables(); },
  setVariables(m: Variables, label: string) {
    const e = need();
    const v = JSON.parse(e.vector_json());
    if (JSON.stringify(v.variables ?? emptyVariables()) === JSON.stringify(m)) return info();
    const keep = m.variables.length || m.data_sets.length;
    history.run(label, () => e.set_document_vector(JSON.stringify({ ...v, variables: keep ? m : undefined })));
    return changed();
  },
  // Notes, slices, count marks and color samplers (M9 tools); one step, none when unchanged.
  setAnnotations(a: Annotations, label: string) {
    const e = need();
    const v = JSON.parse(e.vector_json());
    if (JSON.stringify(v.annotations ?? emptyAnnotations()) === JSON.stringify(a)) return info();
    const keep = a.notes.length || a.slices.length || a.counts.length || a.samplers.length || a.scale;
    history.run(label, () => e.set_document_vector(JSON.stringify({ ...v, annotations: keep ? a : undefined })));
    return changed();
  },
  // Image > Analysis > Place Scale Marker: a group holding the bar shape and, when given, its type layer; one step.
  placeScaleMarker(rect: { x: number; y: number; w: number; h: number }, color: [number, number, number], text: TextJson | null) {
    const e = need();
    let created = 0;
    history.run('Place Scale Marker', () => {
      created = e.add_group(nextName('Measurement Scale Marker'), 0);
      const bar = e.new_shape(JSON.stringify({ name: 'Scale Bar', path: framePath(rect, 'rectangle'), fill: { type: 'solid', color }, stroke: null }));
      e.move_node(bar, created, 0);
      if (!text) return;
      const t = e.add_special(0, JSON.stringify({ name: layerName(text.text), text }));
      e.render_text(t, fontReg(), resolution(e));
      e.move_node(t, created, 1);
    });
    return { ...changed(), created };
  },
  // Ruler > Straighten Layer: rotates the layer `deg` clockwise about the canvas center.
  straightenLayer(id: number, deg: number) {
    const e = need();
    if (!Number.isFinite(deg)) throw new Error('The straighten angle must be a number.');
    history.run('Straighten Layer', () => e.transform_layer(id, Float64Array.from(rotationAbout(deg, e.width() / 2, e.height() / 2)), 'bicubic', true));
    return changed();
  },
  // Frame tool: a group above `above` whose vector mask is the drawn rectangle or ellipse;
  // with `content` the layer `above` moves into it.
  newFrame(rect: { x: number; y: number; w: number; h: number }, shape: 'rectangle' | 'ellipse', above: number, content = false) {
    const e = need();
    let created = 0;
    history.run('New Frame', () => {
      created = e.add_group(nextName('Frame'), above);
      e.set_vector_mask(created, JSON.stringify({ path: framePath(rect, shape), enabled: true, linked: true, inverted: false, density: 1, feather: 0 }));
      if (content) e.move_node(above, created, 0);
    });
    return { ...changed(), created };
  },
  // Artboard tool: a new artboard at `rect` [l, t, r, b]; the canvas grows to hold it.
  newArtboardAt(name: string, rect: [number, number, number, number], background: ArtboardBackground) {
    const e = need();
    let created = 0;
    history.run('New Artboard', () => {
      created = e.new_artboard(name, rect[2] - rect[0], rect[3] - rect[1], JSON.stringify(background), 0);
      const at = findNode(e, created)!.artboard!.rect;
      e.offset_artboard(created, rect[0] - at[0], rect[1] - at[1]);
    });
    return { ...changed(), created };
  },
  // Image > Apply Data Set; the errors name bindings that could not be applied.
  applyDataSet(name: string) {
    const e = need();
    let errors: string[] = [];
    history.run('Apply Data Set', () => { errors = applyDataSet(e, name); });
    return { doc: changed(), errors };
  },
  // File > Export > Data Sets as Files: each set applied to a clone, which is then encoded and discarded.
  async exportDataSets(format: 'psd' | 'png' | 'jpeg', quality: number) {
    const e = need();
    const manifest = e.manifest();
    const files: { name: string; blob: Blob }[] = [];
    for (const d of (JSON.parse(e.vector_json()).variables as Variables | undefined)?.data_sets ?? []) {
      const c = loadEngine(manifest, id => e.tile_bytes(BigInt(id)));
      try {
        applyDataSet(c, d.name);
        files.push({ name: d.name, blob: format === 'psd' ? psdFile(c).blob : await encodeFlattened(c, `image/${format}`, quality) });
      } finally {
        c.free();
      }
    }
    if (!files.length) throw new Error('The document has no data sets.');
    return files;
  },

  // File > Generate > Image Assets: every layer named like "200% icon.png, photo.jpg80", trimmed and
  // shown even when hidden; a repeated file name is reported, the first one is kept.
  async imageAssets(icc: boolean): Promise<{ files: { name: string; blob: Blob }[]; errors: string[] }> {
    const e = need(), files: { name: string; blob: Blob }[] = [], errors: string[] = [];
    for (const n of flatNodes(JSON.parse(e.layers_json()) as LayerNode[])) {
      for (const a of assetSpecs(n.name)) {
        if (files.some(f => f.name.toLowerCase() === a.file.toLowerCase())) { errors.push(`${a.file}: the name is used twice`); continue; }
        try {
          const r = await exportAsset(e, { format: a.format, quality: a.quality, scale: a.scale, colors: 256, dither: 'diffusion', icc, layer: n.id, trim: true, reveal: true });
          files.push({ name: a.file, blob: r.blob });
        } catch (err) {
          errors.push(`${a.file}: ${(err as Error).message}`);
        }
      }
    }
    return { files, errors };
  },

  // Actions panel recording; steps arrive as actionStep events.
  recordStart() {
    rec = eng ? { doc: docId, last: layersOf(eng), created: [], buf: [] } : null;
    if (!rec) throw new Error('Open a document to record an action.');
  },
  recordStop() { rec = null; },

  // Plays recorded steps on the active document; `active` stands in for layers named in the action that
  // the document lacks. `resume` continues the layer references of the previous call (after a stop step).
  async playAction(steps: ActionStep[], active: number | null, resume = false) {
    const e = need();
    const state = resume && playState ? playState : { created: [], last: layersOf(e) };
    playState = state;
    playing = true;
    let at = 0;
    try {
      for (const s of steps) {
        at++;
        for (const c of s.calls) {
          // Loaded action files are untrusted: only edit calls run.
          const fn = (api as unknown as Record<string, unknown>)[c.op];
          if (NO_RECORD.has(c.op) || !Object.hasOwn(api, c.op) || typeof fn !== 'function') throw new Error(`"${c.op}" cannot run in an action.`);
          const call = decodeCall(c, state.last, state.created, active);
          settle(call.op);
          await (fn as (...a: unknown[]) => unknown)(...call.args);
          if (!hot(call.op)) { const now = layersOf(need()); state.created.push(...newIds(state.last, now)); state.last = now; }
        }
      }
    } catch (err) {
      throw new Error(`${steps[at - 1]?.label ?? 'Step'}: ${(err as Error).message}`);
    } finally {
      playing = false;
      // Sessions the action left open are committed (or cancelled) as the next call would.
      settle('playAction');
    }
    return info();
  },

  // Save As by extension. PSB marks the document saved like savePsd; EXR, HDR and ICO are
  // flattened copies, so the document keeps its dirty state.
  async saveFormat(format: 'psb' | 'exr' | 'hdr' | 'ico'): Promise<{ blob: Blob; warnings: string[] }> {
    const e = need();
    if (format === 'psb') {
      const r = psdFile(e, true);
      markSaved();
      return r;
    }
    if (format === 'ico') {
      return { blob: new Blob([encodeIco(await icoEntries(e))], { type: 'image/x-icon' }), warnings: [] };
    }
    const img = floatImage(e);
    return { blob: new Blob([format === 'exr' ? await encodeExr(img) : encodeHdr(img)], { type: format === 'exr' ? 'image/x-exr' : 'image/vnd.radiance' }), warnings: [] };
  },

  // Ends a save: `ok` false (cancelled or failed write) restores the dirty state from before it.
  saveEnd(ok: boolean) {
    const p = pendingSave;
    pendingSave = null;
    if (!ok && p) {
      if (docs[active]?.key === p.key) saved = p.prev;
      else { const d = docs.find(x => x.key === p.key); if (d) d.saved = p.prev; }
    }
    return info();
  },

  // Activates tab `key` under a new document id (D1); the autosave records the new active key.
  switchDoc(key: string) {
    const i = docs.findIndex(d => d.key === key);
    if (i < 0) throw new Error('That document is not open.');
    stash();
    activate(i);
    scheduleSave(0);
    return info()!;
  },

  // Moves tab `key` to index `to` (tab bar drag); the active document stays active.
  moveDoc(key: string, to: number) {
    const i = docs.findIndex(d => d.key === key);
    if (i < 0) throw new Error('That document is not open.');
    const cur = docs[active];
    docs.splice(Math.max(0, Math.min(to, docs.length - 1)), 0, docs.splice(i, 1)[0]);
    active = docs.indexOf(cur);
    scheduleSave(0);
    return info()!;
  },

  // Closes tab `key` (default: the active one, where an open Edit Contents closes first, writing back).
  // The active tab's right neighbour becomes active, else its left one; another tab keeps the active document.
  async closeDoc(key?: string) {
    if (key === undefined && parents.length) {
      const r = await api.smartEditClose();
      if (!r.closed) throw new Error(r.error ?? `The contents were not saved: ${r.warnings.join('; ')}`);
      return r;
    }
    const i = key === undefined ? active : docs.findIndex(d => d.key === key);
    if (key !== undefined && i < 0) throw new Error('That document is not open.');
    if (i !== active) {
      freeDoc(docs.splice(i, 1)[0]);
      if (i < active) active--;
      scheduleSave(0);
      return info();
    }
    if (eng) {
      dropParents();
      history.clear();
      eng.free();
      docs.splice(active, 1);
    }
    eng = null;
    if (docs.length) {
      activate(Math.min(active, docs.length - 1));
      scheduleSave(0);
      return info();
    }
    active = -1;
    docId++;
    clearTimeout(timer);
    await saving;
    await autosave?.clear();
    if (autosave) emit('idle');
    return null;
  },

  // Font registry (app scope, FONT_OPS): faces from bundled, local and uploaded files.
  fontAdd(bytes: ArrayBuffer | Uint8Array, source: 'bundled' | 'local' | 'upload'): FaceInfo[] {
    // Checked before the copy into wasm memory, which never shrinks (the engine checks again).
    if (bytes.byteLength > 64 << 20) throw new Error('Font files over 64 MB are not supported.');
    return JSON.parse(fontReg().add(new Uint8Array(bytes), source));
  },
  // Parsed before storing, so a file that is not a font is never kept.
  async fontUpload(name: string, bytes: ArrayBuffer | Uint8Array): Promise<FaceInfo[]> {
    const faces = api.fontAdd(bytes, 'upload');
    await (await (fontStore ??= FontStore.open()))?.put(name, new Uint8Array(bytes));
    return faces;
  },
  // Registers every stored upload (boot); unreadable files are skipped.
  async fontRestore(): Promise<FaceInfo[]> {
    const out: FaceInfo[] = [];
    for (const u of await (await (fontStore ??= FontStore.open()))?.all() ?? []) {
      try { out.push(...api.fontAdd(u.bytes, 'upload')); } catch { /* not a font any more: skipped */ }
    }
    return out;
  },
  fontFaces(): FaceInfo[] { return JSON.parse(fontReg().faces_json()); },
  fontFamilies(): string[] { return JSON.parse(fontReg().families_json()); },
  fontMissing(pairs: [string, string][]): [string, string][] { return JSON.parse(fontReg().missing_json(JSON.stringify(pairs))); },
  // Glyphs panel: rasterized cells (30x30 8-bit coverage per glyph) and GSUB alternates.
  glyphCells(family: string, style: string, sel: { from: number; to: number } | { gids: number[] }):
    { missing: boolean; size: 30; cells: { gid: number; cp: number | null; name: string }[]; data: ArrayBuffer } {
    const reg = fontReg();
    const selJson = JSON.stringify(sel);
    const meta = JSON.parse(reg.glyph_cells_json(family, style, selJson)) as
      { missing: boolean; size: 30; cells: { gid: number; cp: number | null; name: string }[] };
    return { ...meta, data: reg.glyph_cells_alpha(family, style, selJson).buffer as ArrayBuffer };
  },
  glyphAlternates(family: string, style: string, gid: number): number[] { return Array.from(fontReg().glyph_alternates(family, style, gid)); },
  fontCovers(family: string, style: string, text: string): boolean { return fontReg().font_covers(family, style, text); },
};

export type Api = typeof api;

// The Liquify proxy as RGBA8 (transferred) with its mesh layout; mesh offsets are document px.
function liquifyView(overlays: boolean) {
  const l = liquify!;
  return {
    data: l.render().buffer as ArrayBuffer, w: l.proxy_width(), h: l.proxy_height(), scale: l.scale(), cols: l.cols(), rows: l.rows(), spacing: l.spacing(),
    disp: overlays ? l.displacement() : null, frozen: overlays ? l.frozen() : null,
  };
}

async function handle(id: number, op: keyof Api, args: unknown[]) {
  try {
    const result = await (api[op] as (...a: unknown[]) => unknown)(...args);
    type Img = { data?: unknown; over?: { data?: unknown } | null };
    const r = result as (Img & { above?: Img | null; moved?: Img | null }) | null;
    postMessage({ id, result, docId }, { transfer: [r?.data, r?.over?.data, r?.above?.data, r?.above?.over?.data, r?.moved?.data].filter(d => d instanceof ArrayBuffer) });
  } catch (err) {
    postMessage({ id, error: err instanceof Error ? err.message : String(err), docId });
  }
}

// Ops that may run while a stroke is open without committing it (they never touch the document or history).
const STROKE_OPS = new Set<keyof Api>(['layersBounds', 'cloneSample', 'strokeBegin', 'strokeTo', 'strokeEnd', 'strokeCancel', 'brushPreview', 'tipAdd', 'tipRemove', 'patternAdd', 'patternRemove', 'patternPixels']);
const PREVIEW_OPS = new Set<keyof Api>(['layersBounds', 'applyImage', 'cloneSample', 'fillEx', 'strokeSelection', 'adjust', 'setAdjustment', 'setLayerStyle', 'previewEnd', 'sample', 'brushPreview', 'tipAdd', 'patternAdd', 'addDocumentPattern', 'patternPixels',
  'layerThumbs', 'navigatorThumb', 'histogram', 'documentHistogram', 'documentSample', 'channelMask', 'layerMask']);
// An open move session commits before any other op, so history never sees a half move; panel refreshes only read.
const MOVE_OPS = new Set<keyof Api>(['layersBounds', 'cloneSample', 'moveFloat', 'moveFloatPatch', 'moveLayerStep', 'moveLayerCommit', 'moveLayerCancel', 'movePixelsStep', 'movePixelsCommit', 'movePixelsCancel', 'sample', 'snapTargets', 'movingBounds', 'patternPixels',
  'layerThumbs', 'navigatorThumb', 'histogram']);
// App-scope font calls: never refused for a stale document id and never close an open session.
const FONT_OPS = new Set<keyof Api>(['fontAdd', 'fontUpload', 'fontRestore', 'fontFaces', 'fontFamilies', 'fontMissing', 'glyphCells', 'glyphAlternates', 'fontCovers']);
// An open type session commits before any other op; the UI hears it as typeCommitted.
const TYPE_OPS = new Set<keyof Api>(['layersBounds', 'typeBegin', 'typeUpdate', 'typeCommit', 'typeCancel', 'typeHit', 'typeLayout', 'sample', 'snapTargets', 'patternPixels']);
// An open transform session is cancelled by any other op: only the UI knows its current matrix.
const TRANSFORM_OPS = new Set<keyof Api>(['layersBounds', 'transformRefine', 'transformUnrefine', 'transformCommit', 'transformCancel', 'transformWarp', 'sample', 'snapTargets', 'movingBounds', 'selectionAt', 'patternPixels']);

// Before `op`: commits or cancels the sessions it may not run inside.
function settle(op: string) {
  const o = op as keyof Api;
  // Any other op queued while a stroke is open first commits it, so undo/save never see a half stroke.
  if (strokeOpen && !STROKE_OPS.has(o) && eng) { eng.stroke_end(); strokeOpen = false; history.commit(); changed(); }
  // Anything but a preview rerun, its end or a read cancels an open preview.
  if (previewOpen && !PREVIEW_OPS.has(o) && eng) { try { endPreview(false); } catch { /* cancel never throws */ } version++; }
  if (moveSession && !MOVE_OPS.has(o) && eng) api.moveLayerCommit();
  if (typeSession && !TYPE_OPS.has(o) && eng) postMessage({ event: 'typeCommitted', doc: api.typeCommit() } satisfies WorkerEvent);
  if (transformSession && !TRANSFORM_OPS.has(o) && eng) postMessage({ event: 'transformCancelled', doc: api.transformCancel() } satisfies WorkerEvent);
}

// Calls run one at a time, so an async call (open, close, export) never interleaves with the next one.
// Display reads and selectionMask are synchronous and read-only, so they skip the
// queue and the viewer keeps drawing.
let queue = Promise.resolve();
// `doc` is the document id the UI saw when it issued the call; a call issued before an open, close or
// Edit Contents switched documents would hit the new document with the old one's node ids, so it is refused.
onmessage = (ev: MessageEvent<{ id: number; op: keyof Api; args: unknown[]; doc?: number }>) => {
  const { id, op, args, doc } = ev.data;
  if (op === 'displayTile' || op === 'documentDisplayTile' || op === 'documentHistogram' || op === 'documentSample' || op === 'displayProgram' || op === 'selectionMask' || op === 'channelMask' || op === 'colorRangePreview') { void handle(id, op, args); return; }
  queue = queue.then(() => {
    if (FONT_OPS.has(op)) return handle(id, op, args);
    if (doc !== undefined && doc !== docId) { postMessage({ id, error: 'The document changed before this command ran, so it was not applied.', docId }); return; }
    return recorded(op, args, () => handle(id, op, args));
  }).catch(err => postMessage({ id, error: err instanceof Error ? err.message : String(err), docId }));
};
