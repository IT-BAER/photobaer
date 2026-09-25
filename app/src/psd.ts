// PSD open/save (M1.md section 6). Runs in the engine worker (no DOM) and in Node test/corpus code.
import { initializeCanvas, readPsd, writePsd, type BlendMode, type Layer, type PixelData, type Psd } from 'ag-psd';
import { Engine } from './engine-pkg/photobaer_engine.js';

let canvasReady = false;
function ensureCanvas() {
  if (canvasReady) return;
  canvasReady = true;
  initializeCanvas(
    () => { throw new Error('canvas not available'); },
    (w, h) => (typeof ImageData !== 'undefined'
      ? new ImageData(w, h)
      : ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } as ImageData)),
  );
}

// Manifest tree shape from Engine.manifest() (M1.md section 2).
interface ManifestNode {
  id: number; name: string; kind: 'pixel' | 'group';
  visible: boolean; opacity: number; fill: number; blend: string; clipping: boolean;
  locks: { transparency: boolean; pixels: boolean; position: boolean };
  mask: { enabled: boolean; default: number; tiles?: number[] } | null;
  tiles?: number[];
  children?: ManifestNode[];
}

// A layer's straight RGBA8 tile, cropped to the document, written into `id`'s tiles.
export function place(e: Engine, id: number, l: { imageData?: PixelData; left?: number; top?: number }, w: number, h: number) {
  const img = l.imageData;
  if (!img || img.width === 0 || img.height === 0) return;
  const left = l.left ?? 0, top = l.top ?? 0;
  const x0 = Math.max(0, left), x1 = Math.min(w, left + img.width);
  const y0 = Math.max(0, top), y1 = Math.min(h, top + img.height);
  if (x0 >= x1 || y0 >= y1) return;
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y1 - 1) / 256); ty++) {
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x1 - 1) / 256); tx++) {
      const buf = new Uint8Array(256 * 256 * 4);
      const cx0 = Math.max(x0, tx * 256), cx1 = Math.min(x1, tx * 256 + 256);
      for (let y = Math.max(y0, ty * 256); y < Math.min(y1, ty * 256 + 256); y++) {
        const s = ((y - top) * img.width + (cx0 - left)) * 4;
        buf.set(img.data.subarray(s, s + (cx1 - cx0) * 4), ((y - ty * 256) * 256 + (cx0 - tx * 256)) * 4);
      }
      e.set_tile_rgba8(id, tx, ty, buf);
    }
  }
}

// Mask pixels (red channel) cropped to the document; tiles outside the mask rect keep the node's default.
function placeMask(e: Engine, id: number, m: NonNullable<Layer['mask']>, w: number, h: number) {
  const img = m.imageData;
  if (!img || img.width === 0 || img.height === 0) return;
  const def = m.defaultColor ?? 0;
  const left = m.left ?? 0, top = m.top ?? 0;
  const x0 = Math.max(0, left), x1 = Math.min(w, left + img.width);
  const y0 = Math.max(0, top), y1 = Math.min(h, top + img.height);
  if (x0 >= x1 || y0 >= y1) return;
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y1 - 1) / 256); ty++) {
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x1 - 1) / 256); tx++) {
      const buf = new Uint8Array(256 * 256).fill(def);
      const cx0 = Math.max(x0, tx * 256), cx1 = Math.min(x1, tx * 256 + 256);
      for (let y = Math.max(y0, ty * 256); y < Math.min(y1, ty * 256 + 256); y++) {
        for (let x = cx0; x < cx1; x++) {
          buf[(y - ty * 256) * 256 + (x - tx * 256)] = img.data[((y - top) * img.width + (x - left)) * 4];
        }
      }
      e.set_mask_tile8(id, tx, ty, buf);
    }
  }
}

function locksOf(l: Layer) {
  const p = l.protected;
  return { transparency: !!p?.transparency, pixels: !!p?.composite, position: !!p?.position };
}

function addMaskIfAny(e: Engine, id: number, l: Layer, w: number, h: number) {
  const m = l.mask;
  if (!m) return;
  e.add_mask(id, (m.defaultColor ?? 0) !== 0);
  if (m.disabled) e.set_props(id, JSON.stringify({ mask_enabled: false }));
  placeMask(e, id, m, w, h);
}

function warnKinds(l: Layer, warn: (m: string) => void) {
  if (l.text) warn('text layers were imported as pixels');
  if (l.adjustment) warn('adjustment layers were imported as pixels');
  if (l.placedLayer) warn('smart object layers were imported as pixels');
  if (l.effects) warn('layers with effects were imported as pixels');
  if (l.vectorMask || l.realMask) warn('vector mask layers were imported as pixels');
}

function addNode(e: Engine, l: Layer, w: number, h: number, warn: (m: string) => void): number {
  if (l.children) {
    const id = e.add_group(l.name ?? '', 0);
    e.set_props(id, JSON.stringify({
      visible: !l.hidden, opacity: l.opacity ?? 1, fill: l.fillOpacity ?? 1, blend: l.blendMode ?? 'pass through',
      clipping: !!l.clipping, locks: locksOf(l),
    }));
    let idx = 0;
    for (const child of l.children) e.move_node(addNode(e, child, w, h, warn), id, idx++);
    addMaskIfAny(e, id, l, w, h);
    return id;
  }
  const id = e.add_layer(l.name ?? '', 0);
  e.set_props(id, JSON.stringify({
    visible: !l.hidden, opacity: l.opacity ?? 1, fill: l.fillOpacity ?? 1,
    blend: !l.blendMode || l.blendMode === 'pass through' ? 'normal' : l.blendMode,
    clipping: !!l.clipping, locks: locksOf(l),
  }));
  place(e, id, l, w, h);
  addMaskIfAny(e, id, l, w, h);
  warnKinds(l, warn);
  return id;
}

function isEmptyPlaceholder(l: Layer): boolean {
  return !l.children && !l.name && (!l.imageData || l.imageData.width === 0 || l.imageData.height === 0);
}

export function importPsd(bytes: Uint8Array): { engine: Engine; warnings: string[] } {
  ensureCanvas();
  if (bytes.length >= 6 && bytes[4] === 0 && bytes[5] === 2) throw new Error('PSB files are not supported yet');
  // Header depth (offset 22) is checked before decoding, so a large 16-bit file is rejected cheaply.
  if (bytes.length >= 24 && [16, 32].includes(bytes[22] << 8 | bytes[23])) throw new Error('16-bit and 32-bit PSD files are not supported yet');
  const psd = readPsd(bytes, { useImageData: true, skipThumbnail: true });
  if ((psd.bitsPerChannel ?? 8) !== 8) throw new Error('16-bit and 32-bit PSD files are not supported yet');
  if (psd.colorMode !== undefined && psd.colorMode !== 3 && !psd.imageData) throw new Error('Only RGB PSD files are supported');
  const { width: w, height: h } = psd;
  const e = new Engine(w, h, 8);
  try {
    const warnings: string[] = [];
    const warn = (m: string) => { if (!warnings.includes(m)) warnings.push(m); };
    const children = psd.children ?? [];
    // A flat PSD (no real layer records) reads back as [] or, via ag-psd's own writer, as one nameless
    // 0x0 placeholder layer; either way there is nothing to build, so the composite becomes the Background.
    const flat = children.length === 0 || (children.length === 1 && isEmptyPlaceholder(children[0]));
    if (flat) {
      place(e, 1, psd, w, h);
    } else {
      for (const l of children) addNode(e, l, w, h, warn);
      e.delete_node(1);
    }
    return { engine: e, warnings };
  } catch (err) {
    e.free();
    throw err;
  }
}

interface Rect { left: number; top: number; right: number; bottom: number }
const fullCanvas = (w: number, h: number): Rect => ({ left: 0, top: 0, right: w, bottom: h });

// Assembles a rect (document pixel space) from 256x256 tiles, cropping edge tiles to the rect.
function assembleImage(tile: (tx: number, ty: number) => Uint8Array | null, rect: Rect, channels: number, fill: number): Uint8Array {
  const rw = rect.right - rect.left, rh = rect.bottom - rect.top;
  const out = new Uint8Array(Math.max(0, rw) * Math.max(0, rh) * channels).fill(fill);
  for (let ty = Math.floor(rect.top / 256); ty * 256 < rect.bottom; ty++) {
    for (let tx = Math.floor(rect.left / 256); tx * 256 < rect.right; tx++) {
      const buf = tile(tx, ty);
      if (!buf) continue;
      const cx0 = Math.max(rect.left, tx * 256), cx1 = Math.min(rect.right, tx * 256 + 256);
      const cy0 = Math.max(rect.top, ty * 256), cy1 = Math.min(rect.bottom, ty * 256 + 256);
      for (let y = cy0; y < cy1; y++) {
        const s = ((y - ty * 256) * 256 + (cx0 - tx * 256)) * channels;
        const d = ((y - rect.top) * rw + (cx0 - rect.left)) * channels;
        out.set(buf.subarray(s, s + (cx1 - cx0) * channels), d);
      }
    }
  }
  return out;
}

function tileAt(e: Engine, ids: number[] | undefined, tx: number, ty: number): Uint8Array | null {
  const id = ids?.[ty * e.tiles_x() + tx];
  return id ? e.tile_bytes(BigInt(id)) : null;
}

// Bounding rect (document pixel space, cropped to the canvas) of the non-empty tiles in `ids`, or null if none.
function tileBounds(e: Engine, ids: number[] | undefined, w: number, h: number): Rect | null {
  if (!ids) return null;
  const txN = e.tiles_x(), tyN = e.tiles_y();
  let minTx = Infinity, minTy = Infinity, maxTx = -1, maxTy = -1;
  for (let ty = 0; ty < tyN; ty++) {
    for (let tx = 0; tx < txN; tx++) {
      if (ids[ty * txN + tx]) {
        if (tx < minTx) minTx = tx;
        if (ty < minTy) minTy = ty;
        if (tx > maxTx) maxTx = tx;
        if (ty > maxTy) maxTy = ty;
      }
    }
  }
  if (maxTx < 0) return null;
  return { left: minTx * 256, top: minTy * 256, right: Math.min((maxTx + 1) * 256, w), bottom: Math.min((maxTy + 1) * 256, h) };
}

// ag-psd writes a zero-size rect and no channel data for a mask/layer with no imageData (psdWriter.js getLayerChannels/getMaskChannels).
function maskFields(e: Engine, n: ManifestNode, w: number, h: number) {
  if (!n.mask) return {};
  const rect = tileBounds(e, n.mask.tiles, w, h);
  const base = { defaultColor: n.mask.default, disabled: !n.mask.enabled };
  if (!rect) return { mask: { top: 0, left: 0, ...base } };
  const gray = assembleImage((tx, ty) => tileAt(e, n.mask!.tiles, tx, ty), rect, 1, n.mask.default);
  const rw = rect.right - rect.left, rh = rect.bottom - rect.top;
  const rgba = new Uint8ClampedArray(rw * rh * 4);
  for (let i = 0; i < rw * rh; i++) {
    const v = gray[i];
    rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
  }
  return { mask: { top: rect.top, left: rect.left, ...base, imageData: { width: rw, height: rh, data: rgba } } };
}

function exportNode(e: Engine, n: ManifestNode, w: number, h: number): Layer {
  const common = {
    name: n.name, hidden: !n.visible, opacity: n.opacity, fillOpacity: n.fill, blendMode: n.blend as BlendMode, clipping: n.clipping,
    protected: { transparency: n.locks.transparency, composite: n.locks.pixels, position: n.locks.position },
    ...maskFields(e, n, w, h),
  };
  if (n.kind === 'group') return { ...common, children: (n.children ?? []).map(c => exportNode(e, c, w, h)) };
  const rect = tileBounds(e, n.tiles, w, h);
  if (!rect) return { ...common, top: 0, left: 0 };
  const data = assembleImage((tx, ty) => tileAt(e, n.tiles, tx, ty), rect, 4, 0);
  const rw = rect.right - rect.left, rh = rect.bottom - rect.top;
  return { ...common, top: rect.top, left: rect.left, imageData: { width: rw, height: rh, data: new Uint8ClampedArray(data.buffer) } };
}

export function exportPsd(e: Engine): Uint8Array<ArrayBuffer> {
  ensureCanvas();
  if (e.depth() !== 8) throw new Error('16-bit PSD export is not supported yet');
  const w = e.width(), h = e.height();
  const manifest = JSON.parse(e.manifest()) as { layers: ManifestNode[] };
  const composite = assembleImage((tx, ty) => e.flatten_tile_rgba8(tx, ty), fullCanvas(w, h), 4, 0);
  const psd: Psd = {
    width: w, height: h, colorMode: 3, bitsPerChannel: 8,
    children: manifest.layers.map(n => exportNode(e, n, w, h)),
    imageData: { width: w, height: h, data: new Uint8ClampedArray(composite.buffer) },
  };
  return new Uint8Array(writePsd(psd, { generateThumbnail: false }));
}
