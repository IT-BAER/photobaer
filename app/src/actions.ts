// Actions: recorded worker calls per history step, replayed on any document. Layer ids in the
// calls become references: a layer the action created (by creation order) or one that existed (by name).
import type { DocInfo } from './worker/types.ts';
import { nodeById } from './layers.ts';

export type LayerRef = { c: number } | { n: string };
export interface Call { op: string; args: unknown[] }
// Insert Conditional: If Current, Then/Else Play Action (names of actions in the same set; null = None).
export const CONDITIONS = ['landscape', 'square', 'rgb', 'cmyk', 'gray', 'lab', 'layers', 'selection', 'background', 'visible', 'pixelMask',
  'vectorMask', 'effects', 'pixel', 'text', 'shape', 'smart', 'adjustment', 'fill', 'group'] as const;
export type Condition = typeof CONDITIONS[number];
export interface Conditional { if: Condition; then: string | null; else: string | null }
// Steps without calls: `stop` pauses with a message, `menu` runs a menu item by its English id path, `cond` plays
// another action. `dialog` steps show their dialog values before they run.
export interface ActionStep {
  id: string; label: string; enabled: boolean; calls: Call[];
  stop?: { message: string; allowContinue: boolean }; dialog?: boolean; menu?: { path: string[] }; cond?: Conditional;
}
export interface Action { id: string; name: string; steps: ActionStep[]; key?: string }
export interface ActionSet { id: string; name: string; actions: Action[] }
// Flat layer list of a document, in layers_json order.
export interface Layers { ids: number[]; names: Map<number, string> }

// Argument paths that hold layer ids, per worker op: `0` an id, `0[]` an id list, `0.id`, `0[].id` nested.
export const LAYER_ARGS: Record<string, string[]> = {
  command: ['1'], fillEx: ['0'], redEye: ['0'], patch: ['0'], contentAwareMove: ['0'], cloneSample: ['0'], contentAwareFill: ['0'],
  strokeSelection: ['0'], gradient: ['0'], clearSelected: ['0'], copy: ['0'], selectedPixels: ['0'], layerViaCopy: ['0'], layerViaCut: ['0'],
  paste: ['0'], magicWand: ['0'], quickSelect: ['0'], magneticBegin: ['0'], bucket: ['0'], grow: ['0'], similar: ['0'], selectSubject: ['0'], aiSample: ['0'], selectFromMask: ['0'], colorRange: ['0'],
  focusAuto: ['0'], focusImage: ['0'], focusPreview: ['0'], focusArea: ['0'], focusToDocument: ['0'], removeBackground: ['0'],
  refineImage: ['0'], refinePreview: ['0'], selectAndMask: ['0'], colorRangePreview: ['1'], layerMask: ['0'], applyImage: ['0'], addLayer: ['0'], addGroup: ['0'], groupNodes: ['0[]'], ungroup: ['0'],
  deleteNode: ['0'], duplicateNode: ['0'], moveNode: ['0', '1'], arrangeNodes: ['0[]'], mergeNodes: ['0[]'], alignLayers: ['0[]'],
  setLocks: ['0[]'], setVisibility: ['0[]'], newGuidesFromShape: ['0[]'], artboardFromGroup: ['0'], artboardFromLayers: ['0[]'], editArtboard: ['0'],
  setVectorMask: ['0'], fillPath: ['2'], strokePath: ['2'], luminance: ['0'], fillShape: ['0'], setShapes: ['0[].id'], combineShapes: ['0[]'],
  pathfinder: ['0'], mergeShapeComponents: ['0[]'], rasterizeLayers: ['1[]'], vectorMaskEdit: ['0[].id'], layerCode: ['0'],
  snapTargets: ['0'], movingBounds: ['0'], layersBounds: ['0[]'], typeBegin: ['0.id', '0.above'], typeLayout: ['0'], typeSet: ['0'], typeConvert: ['0[]'],
  typeWorkPath: ['0'], typeToShape: ['0[]'], typeReplace: ['0[].id'], setPropsMany: ['0[].0'], moveLayerBegin: ['0'], movePixelsBegin: ['0'], transformBegin: ['0'], transformAgain: ['0'],
  rotateExact: ['0'], autoAlign: ['0[]'], autoBlend: ['0[]'], setProps: ['0'], addMask: ['0'], deleteMask: ['0'], addMaskFromSelection: ['0'], maskFromTransparency: ['0'], applyMask: ['0'], defringe: ['0'], removeMatte: ['0'], trap: ['0'], colorDecontaminate: ['0'], newFillLayer: ['0'],
  setFillContent: ['0[]'], newAdjustmentLayer: ['0'], setAdjustment: ['0'], adjust: ['0'], rasterizeFill: ['0'], setLayerStyle: ['0'],
  editLayerStyle: ['0'], copyLayerStyle: ['0'], pasteLayerStyle: ['0[]'], clearLayerStyle: ['0[]'], dragLayerStyle: ['0', '1'],
  createLayersFromStyle: ['0'], scaleEffects: ['0'], histogram: ['0'], documentHistogram: ['1'], layerThumbs: ['0[]'], sample: ['3'], documentSample: ['4'], strokeBegin: ['0'], straightenLayer: ['0'], newFrame: ['2'],
  placeSmart: ['0'], convertToSmart: ['0[]'], convertForSmartFilters: ['0'], applyFilter: ['0'], puppetMesh: ['0'], liquifyBegin: ['0'],
  liquifyEdit: ['0'], liquifyCommit: ['0'], liquifyBackdrop: ['0'], vpBegin: ['0'], vpCommit: ['0'], fade: ['0'], addSmartFilter: ['0'],
  setSmartFilter: ['0'], smartFilterCommand: ['0'], smartViaCopy: ['0'], rasterizeSmart: ['0'], replaceContents: ['0'], exportContents: ['0'],
  convertToLinked: ['0'], convertToEmbedded: ['0'], relinkToFile: ['0'], updateModified: ['0'], setStackMode: ['0'], editContents: ['0'],
};
// `op.param` names that look like layer ids but are not (paths, guides, channels, comps, assets, glyphs, tabs).
export const NOT_LAYER_PARAMS = new Set([
  'channelMask.id', 'spotChannelOptions.id', 'renameChannel.id', 'duplicateChannel.id', 'deleteChannel.id', 'moveGuide.id', 'deleteGuide.id',
  'setPath.id', 'savePath.id', 'renamePath.id', 'deletePath.id', 'fillPath.id', 'strokePath.id', 'makeSelectionFromPath.id',
  'convertPathToShape.id', 'applyLayerComp.id', 'deleteLayerComp.id', 'updateLayerComp.id', 'tipRemove.id', 'patternRemove.id',
  'moveDoc.to', 'glyphCells.from', 'glyphCells.to',
]);

// Ops never recorded: documents, files, saving, history navigation, view and app state.
export const NO_RECORD = new Set([
  'init', 'newDoc', 'setColorSettings', 'setView', 'openProfileQuestion', 'openFile', 'revertDoc', 'setDocName', 'undo', 'redo', 'historyGoto', 'toggleLastState', 'purge', 'brushTipSample', 'patternSample',
  'displayTile', 'documentDisplayTile', 'documentHistogram', 'documentSample', 'displayProgram', 'exportImage', 'exportLayerCompsToFiles', 'savePsd', 'saveFormat', 'saveEnd', 'switchDoc', 'moveDoc',
  'closeDoc', 'editContents', 'smartEditSave', 'smartEditClose', 'iccProfiles', 'loadProfile', 'photomerge', 'mergeHdr', 'loadStack', 'calculations',
  'tipAdd', 'tipRemove', 'patternAdd', 'patternRemove', 'recordStart', 'recordStop', 'playAction',
  'fontAdd', 'fontUpload', 'fontRestore', 'fontFaces', 'fontFamilies', 'fontMissing', 'glyphCells', 'glyphAlternates', 'fontCovers',
  // Model features record their menu item instead (the model runs outside the engine worker).
  'aiSample', 'selectFromMask', 'focusToDocument', 'removeBackground',
]);
// Many-call ops (stroke points, drags, live edits): the layer list is not diffed after them.
export const hot = (op: string) => /(To|Step|Edit|Update|Refine|Preview|Warp)$/.test(op);

// Applies `f` to every value at `path` in `args` (a copy; the input is not changed).
export function mapPath(args: unknown[], path: string, f: (v: unknown) => unknown): unknown[] {
  const out = structuredClone(args) as unknown[];
  const segs = path.split('.');
  const head = segs[0], list = head.endsWith('[]'), i = +head.replace('[]', '');
  const walk = (v: unknown, rest: string[]): unknown => {
    if (!rest.length) return f(v);
    if (v === null || typeof v !== 'object') return v;
    const [k, ...more] = rest, arr = k.endsWith('[]'), key = k.replace('[]', '');
    const o = v as Record<string, unknown>;
    if (!(key in o)) return v;
    o[key] = arr && Array.isArray(o[key]) ? (o[key] as unknown[]).map(x => walk(x, more)) : walk(o[key], more);
    return o;
  };
  if (i >= out.length) return out;
  out[i] = list && Array.isArray(out[i]) ? (out[i] as unknown[]).map(x => walk(x, segs.slice(1))) : walk(out[i], segs.slice(1));
  return out;
}

const isRef = (v: unknown): v is { $L: LayerRef } => typeof v === 'object' && v !== null && '$L' in v;

// Record side: layer ids in `call` become references. `before` is the document before the step,
// `created` the recorded ids of layers the action made, in creation order.
export function encodeCall(call: Call, before: Layers, created: number[]): Call {
  let args = call.args;
  for (const p of LAYER_ARGS[call.op] ?? []) {
    args = mapPath(args, p, v => {
      if (typeof v !== 'number') return v;
      const c = created.indexOf(v);
      if (c >= 0) return { $L: { c } };
      const n = before.names.get(v);
      return n === undefined ? v : { $L: { n } };
    });
  }
  return { op: call.op, args };
}

// Replay side: references back to ids of the target document; a name not found falls back to `active`.
export function decodeCall(call: Call, now: Layers, created: number[], active: number | null): Call {
  let args = call.args;
  for (const p of LAYER_ARGS[call.op] ?? []) {
    args = mapPath(args, p, v => {
      if (!isRef(v)) return v;
      const r = v.$L;
      // Playing from a later step: a layer the skipped steps would have made is the target layer.
      if ('c' in r) {
        const id = created[r.c] ?? active;
        if (id === null) throw new Error('The layer this step uses was not created during playback.');
        return id;
      }
      const id = now.ids.find(i => now.names.get(i) === r.n) ?? active;
      if (id === null) throw new Error(`There is no layer named "${r.n}" and no target layer.`);
      return id;
    });
  }
  return { op: call.op, args };
}

// Ids in `after` and not in `before`, in list order: the layers a call created.
export const newIds = (before: Layers, after: Layers) => after.ids.filter(i => !before.names.has(i));

// JSON with typed arrays kept ({ $t, b } with base64 bytes).
const TYPED = { Uint8Array, Uint16Array, Uint32Array, Int32Array, Float32Array, Float64Array, Uint8ClampedArray } as const;
export function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => {
    if (ArrayBuffer.isView(x) && !(x instanceof DataView)) {
      const b = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
      let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return { $t: x.constructor.name, b: btoa(s) };
    }
    return x;
  });
}
export function fromJson<T>(s: string): T {
  return JSON.parse(s, (_k, x) => {
    if (x && typeof x === 'object' && typeof x.$t === 'string' && typeof x.b === 'string' && x.$t in TYPED) {
      const bin = atob(x.b), u = Uint8Array.from(bin, c => c.charCodeAt(0));
      const T = TYPED[x.$t as keyof typeof TYPED];
      return new T(u.buffer, 0, u.byteLength / T.BYTES_PER_ELEMENT);
    }
    return x;
  }) as T;
}

// Dialog commands: per worker op, the arguments that hold the dialog's values and their names ('' = the object's own keys).
export const DIALOG_ARGS: Record<string, Record<number, string>> = {
  fillEx: { 2: '' }, strokeSelection: { 1: '' }, applyImage: { 2: '' }, convertDepth: { 0: 'depth', 1: '' }, setAdjustment: { 1: '' },
  adjust: { 1: '' }, newAdjustmentLayer: { 1: '' }, applyFilter: { 2: '' }, fade: { 1: '' }, addSmartFilter: { 1: '' }, setSmartFilter: { 2: '' },
  canvasSize: { 0: 'width', 1: 'height', 2: 'anchor x', 3: 'anchor y', 4: 'color' },
  imageSize: { 0: 'width', 1: 'height', 2: 'resample', 3: 'scale styles', 4: 'resolution' },
  rotateCanvasArbitrary: { 0: 'angle', 1: 'interpolation' }, modifySelection: { 1: 'radius', 2: 'apply effect at canvas bounds' },
  selectCommand: { 1: 'radius' }, colorRange: { 1: 'sample all', 2: 'select', 4: 'fuzziness', 5: 'range', 7: 'localized', 8: 'invert' },
  trim: { 0: 'based on', 1: 'top', 2: 'bottom', 3: 'left', 4: 'right' }, defringe: { 1: 'width' }, colorDecontaminate: { 1: 'amount' },
  scaleEffects: { 1: 'scale' }, newGuideLayout: { 0: '' }, setColorMode: { 0: '' },
  focusArea: { 1: 'in-focus range', 2: 'image noise level', 4: 'soften edge' },
  selectAndMask: { 2: '', 5: 'output to', 6: 'decontaminate colors', 7: 'amount' },
};
// Keys that pick a variant rather than set a value.
const FIXED_KEYS = new Set(['kind', 'type', 'mode_kind', 'id']);
export interface Field { arg: number; path: (string | number)[]; label: string; value: number | string | boolean }

// The editable values of a step's last dialog call: numbers, strings and booleans, and short number lists one value each;
// layer references, typed arrays and longer lists are left out.
export function stepFields(step: ActionStep): Field[] {
  const call = step.calls.findLast(c => c.op in DIALOG_ARGS);
  if (!call) return [];
  const out: Field[] = [];
  for (const [i, name] of Object.entries(DIALOG_ARGS[call.op])) {
    const walk = (v: unknown, path: (string | number)[]) => {
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
        const segs = [...(name ? [name] : []), ...path.filter(p => p !== 'params').map(p => typeof p === 'number' ? String(p + 1) : p.replace(/_/g, ' '))];
        out.push({ arg: +i, path, label: segs.join(' › '), value: v });
      } else if (Array.isArray(v)) {
        if (v.length <= 4 && v.every(x => typeof x === 'number')) v.forEach((x, j) => walk(x, [...path, j]));
      } else if (v && typeof v === 'object' && !ArrayBuffer.isView(v) && !isRef(v)) {
        for (const [k, x] of Object.entries(v)) if (!FIXED_KEYS.has(k)) walk(x, [...path, k]);
      }
    };
    walk(call.args[+i], []);
  }
  return out;
}

// A copy of `step` whose last dialog call carries `values`, in stepFields order.
export function withFields(step: ActionStep, values: Field['value'][]): ActionStep {
  const out = structuredClone(step);
  const call = out.calls.findLast(c => c.op in DIALOG_ARGS);
  if (!call) return out;
  stepFields(step).forEach((f, n) => {
    if (n >= values.length) return;
    if (!f.path.length) { call.args[f.arg] = values[n]; return; }
    let o = call.args[f.arg] as Record<string | number, unknown>;
    for (const p of f.path.slice(0, -1)) o = o[p] as Record<string | number, unknown>;
    o[f.path.at(-1)!] = values[n];
  });
  return out;
}

export interface PlayHooks {
  // Plays steps that only hold calls; false when they failed.
  play(seg: ActionStep[], resume: boolean): Promise<boolean>;
  // A stop step: true continues playback.
  stop(s: ActionStep): boolean | Promise<boolean>;
  // A step with its dialog on: the step to play, null cancels playback. Without it, dialog steps play as recorded.
  ask?(s: ActionStep): Promise<ActionStep | null>;
  // A menu item step: runs the item and waits for its dialog; false ends playback.
  menu?(s: ActionStep): Promise<boolean>;
  // Conditional steps: the condition on the current document, and the enabled steps of an action of the same set.
  holds?(c: Condition): boolean;
  action?(name: string): ActionStep[] | undefined;
}
const pauses = (s: ActionStep, h: PlayHooks) => !!(s.stop || s.menu || s.cond) || (!!s.dialog && !!h.ask && stepFields(s).length > 0);

// Plays `steps` in segments split at the steps that pause; `resume` keeps the layer references of earlier segments
// (an action played by a conditional step starts its own). False when a segment failed or playback was ended.
export async function playSteps(steps: ActionStep[], h: PlayHooks, playing: string[] = []): Promise<boolean> {
  let resume = false;
  for (let i = 0; i < steps.length;) {
    let s = steps[i];
    if (s.stop) {
      if (!await h.stop(s)) return false;
      i++;
      continue;
    }
    if (s.menu) {
      if (!h.menu || !await h.menu(s)) return false;
      i++;
      continue;
    }
    if (s.cond) {
      const name = h.holds?.(s.cond.if) ? s.cond.then : s.cond.else;
      if (name !== null) {
        if (playing.includes(name)) throw new Error(`The action "${name}" plays itself through a conditional step.`);
        const sub = h.action?.(name);
        if (!sub) throw new Error(`There is no action named "${name}" in this set.`);
        if (!await playSteps(sub, h, [...playing, name])) return false;
        resume = false;
      }
      i++;
      continue;
    }
    if (pauses(s, h)) {
      const edited = await h.ask!(s);
      if (!edited) return false;
      s = edited;
    }
    const end = steps.findIndex((x, j) => j > i && pauses(x, h));
    const seg = [s, ...steps.slice(i + 1, end < 0 ? steps.length : end)];
    if (!await h.play(seg, resume)) return false;
    resume = true;
    i += seg.length;
  }
  return true;
}

// A Background layer is the bottom root pixel layer named "Background".
export function conditionHolds(c: Condition, d: DocInfo, active: number | null): boolean {
  const mode = d.mode?.kind ?? (d.gray ? 'gray' : 'rgb');
  const bottom = d.layers[0], isBg = (n: DocInfo['layers'][number] | undefined) => !!n && n === bottom && n.kind === 'pixel' && n.name === 'Background';
  switch (c) {
    case 'landscape': return d.width > d.height;
    case 'square': return d.width === d.height;
    case 'rgb': case 'cmyk': case 'gray': case 'lab': return mode === c;
    case 'layers': return d.layers.length > 1 || (!!bottom && !isBg(bottom));
    case 'selection': return !!d.selection;
  }
  const n = active === null ? undefined : nodeById(d.layers, active);
  if (!n) return false;
  switch (c) {
    case 'background': return isBg(n);
    case 'visible': return n.visible;
    case 'pixelMask': return !!n.mask;
    case 'vectorMask': return !!n.vector_mask;
    case 'effects': return !!n.style;
    default: return n.kind === c;
  }
}

// Action shortcuts: F2 to F12 with optional Shift and Ctrl (Cmd), written "Shift+Ctrl+F2".
export const ACTION_FKEYS = Array.from({ length: 11 }, (_, i) => `F${i + 2}`);
export const ACTION_KEY = /^(Shift\+)?(Ctrl\+)?F([2-9]|1[0-2])$/;
export function actionKeyOf(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): string | null {
  if (e.altKey || !ACTION_FKEYS.includes(e.key)) return null;
  return `${e.shiftKey ? 'Shift+' : ''}${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${e.key}`;
}

// False when `args` carry something a saved action cannot hold (a file or a file handle).
export function recordable(args: unknown[]) {
  try {
    JSON.stringify(args, (_k, x) => {
      if ((typeof Blob !== 'undefined' && x instanceof Blob) || (x && typeof x === 'object' && 'getFile' in x)) throw new Error('file');
      return x;
    });
    return true;
  } catch {
    return false;
  }
}
