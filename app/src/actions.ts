// Actions: recorded worker calls per history step, replayed on any document. Layer ids in the
// calls become references: a layer the action created (by creation order) or one that existed (by name).

export type LayerRef = { c: number } | { n: string };
export interface Call { op: string; args: unknown[] }
// `stop` steps pause playback with a message instead of running calls.
export interface ActionStep { id: string; label: string; enabled: boolean; calls: Call[]; stop?: { message: string; allowContinue: boolean } }
export interface Action { id: string; name: string; steps: ActionStep[]; key?: string }
export interface ActionSet { id: string; name: string; actions: Action[] }
// Flat layer list of a document, in layers_json order.
export interface Layers { ids: number[]; names: Map<number, string> }

// Argument paths that hold layer ids, per worker op: `0` an id, `0[]` an id list, `0.id`, `0[].id` nested.
export const LAYER_ARGS: Record<string, string[]> = {
  command: ['1'], fillEx: ['0'], redEye: ['0'], patch: ['0'], contentAwareMove: ['0'], cloneSample: ['0'], contentAwareFill: ['0'],
  strokeSelection: ['0'], gradient: ['0'], clearSelected: ['0'], copy: ['0'], selectedPixels: ['0'], layerViaCopy: ['0'], layerViaCut: ['0'],
  paste: ['0'], magicWand: ['0'], quickSelect: ['0'], magneticBegin: ['0'], bucket: ['0'], grow: ['0'], similar: ['0'], selectSubject: ['0'], colorRange: ['0'],
  colorRangePreview: ['1'], layerMask: ['0'], applyImage: ['0'], addLayer: ['0'], addGroup: ['0'], groupNodes: ['0[]'], ungroup: ['0'],
  deleteNode: ['0'], duplicateNode: ['0'], moveNode: ['0', '1'], arrangeNodes: ['0[]'], mergeNodes: ['0[]'], alignLayers: ['0[]'],
  setLocks: ['0[]'], setVisibility: ['0[]'], newGuidesFromShape: ['0[]'], artboardFromGroup: ['0'], artboardFromLayers: ['0[]'], editArtboard: ['0'],
  setVectorMask: ['0'], fillPath: ['2'], strokePath: ['2'], luminance: ['0'], fillShape: ['0'], setShapes: ['0[].id'], combineShapes: ['0[]'],
  pathfinder: ['0'], mergeShapeComponents: ['0[]'], rasterizeLayers: ['1[]'], vectorMaskEdit: ['0[].id'], layerCode: ['0'],
  snapTargets: ['0'], movingBounds: ['0'], layersBounds: ['0[]'], typeBegin: ['0.id', '0.above'], typeLayout: ['0'], typeSet: ['0'], typeConvert: ['0[]'],
  typeWorkPath: ['0'], typeToShape: ['0[]'], moveLayerBegin: ['0'], movePixelsBegin: ['0'], transformBegin: ['0'], transformAgain: ['0'],
  rotateExact: ['0'], autoAlign: ['0[]'], autoBlend: ['0[]'], setProps: ['0'], addMask: ['0'], deleteMask: ['0'], addMaskFromSelection: ['0'], maskFromTransparency: ['0'], applyMask: ['0'], defringe: ['0'], removeMatte: ['0'], colorDecontaminate: ['0'], newFillLayer: ['0'],
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
