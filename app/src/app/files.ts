// File > Open / Save / Save As / Revert / Open Recent on the File System Access API (Chromium).
// Without it (Firefox, Safari) Open uses the file input and saving downloads.
import { svgAtSize, svgSize } from './rasterSize.ts';
type Kind = 'psd' | 'image';
type SaveFormat = 'psd' | 'psb' | 'exr' | 'hdr' | 'ico';
// The file a tab was opened from or saved as; `warned`: the open reported content the PSD writer cannot store.
interface Origin { handle: FileSystemFileHandle; kind: Kind; warned: boolean }
interface Recent { name: string; kind: Kind; handle: FileSystemFileHandle; time: number }
type Mode = { mode: 'read' | 'readwrite' };
type PermHandle = FileSystemFileHandle & { queryPermission?(m: Mode): Promise<PermissionState>; requestPermission?(m: Mode): Promise<PermissionState> };
type Pickers = { showOpenFilePicker?: (o: object) => Promise<FileSystemFileHandle[]>; showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle> };

const RECENT_MAX = 10;
const OPEN_TYPES = [{
  description: 'Images and PSD',
  accept: {
    'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'], 'image/gif': ['.gif'], 'image/bmp': ['.bmp'], 'image/avif': ['.avif'],
    'image/vnd.adobe.photoshop': ['.psd', '.psb'], 'image/x-exr': ['.exr'], 'image/vnd.radiance': ['.hdr'], 'image/svg+xml': ['.svg'], 'image/x-icon': ['.ico'], 'application/pdf': ['.pdf'],
  },
}];
const SAVE_TYPES = [
  { description: 'Photoshop', accept: { 'image/vnd.adobe.photoshop': ['.psd'] } },
  { description: 'Large Document Format', accept: { 'application/octet-stream': ['.psb'] } },
  { description: 'OpenEXR (flattened copy)', accept: { 'image/x-exr': ['.exr'] } },
  { description: 'Radiance HDR (flattened copy)', accept: { 'image/vnd.radiance': ['.hdr'] } },
  { description: 'Windows Icon (flattened copy)', accept: { 'image/x-icon': ['.ico'] } },
];

const kindOf = (name: string): Kind => /\.ps[db]$/i.test(name) ? 'psd' : 'image';
// The format Save As writes, by extension; null for any other name.
const saveFormat = (name: string): SaveFormat | null => (/\.(psd|psb|exr|hdr|ico)$/i.exec(name)?.[1].toLowerCase() as SaveFormat | undefined) ?? null;
const baseName = (name: string) => name.replace(/\.[^.]+$/, '');

// Ctrl+S writes back only to a .psd that opened without warnings (D3); Edit Contents
// shows a nested document, which is not the tab's file.
function saveRoute(o: Pick<Origin, 'kind' | 'warned'> | undefined, nested: boolean): 'write' | 'saveAs' {
  return !nested && o?.kind === 'psd' && !o.warned ? 'write' : 'saveAs';
}

// `r` first, any entry for the same file dropped, at most RECENT_MAX. A handle that cannot compare counts as another file.
async function addRecent(list: Recent[], r: Recent): Promise<Recent[]> {
  const out = [r];
  for (const x of list) if (!await x.handle.isSameEntry(r.handle).catch(() => false)) out.push(x);
  return out.slice(0, RECENT_MAX);
}

const pickers = () => (typeof window === 'undefined' ? {} : window) as Pickers;
const fsAccess = () => !!pickers().showOpenFilePicker && !!pickers().showSaveFilePicker;

// Null when the user cancels the picker.
async function cancellable<T>(p: () => Promise<T>): Promise<T | null> {
  try {
    return await p();
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null;
    throw e;
  }
}
const pickOpen = () => cancellable(() => pickers().showOpenFilePicker!({ multiple: true, types: OPEN_TYPES }));
const pickSave = (name: string, startIn?: FileSystemFileHandle) =>
  cancellable(() => pickers().showSaveFilePicker!({ suggestedName: name, types: SAVE_TYPES, excludeAcceptAllOption: true, ...(startIn && { startIn }) }));

// True when `h` may be read (or written); asks only when not granted yet (needs a user gesture).
async function permit(h: FileSystemFileHandle, mode: Mode['mode']) {
  const p = h as PermHandle;
  if (!p.queryPermission || await p.queryPermission({ mode }) === 'granted') return true;
  return await p.requestPermission?.({ mode }) === 'granted';
}

// createWritable writes a swap file that replaces the target only on close(); abort() discards it.
async function writeFile(h: FileSystemFileHandle, blob: Blob) {
  const w = await (h as unknown as { createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> }).createWritable();
  try {
    await w.write(blob);
  } catch (e) {
    await w.abort().catch(() => {});
    throw e;
  }
  await w.close();
}

// An SVG file as a PNG File of the same name, rasterized at `size` px or its own size (workers cannot decode SVG).
async function rasterSvg(f: File, size?: [number, number]): Promise<File> {
  if (!/\.svg$/i.test(f.name) && f.type !== 'image/svg+xml') return f;
  const text = await f.text(), [w, h] = size ?? svgSize(text).map(v => Math.max(1, Math.round(v)));
  const url = URL.createObjectURL(new Blob([svgAtSize(text, w, h)], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => { throw new Error(`${f.name} is not a valid SVG file.`); });
    const c = document.createElement('canvas');
    if (w > 32767 || h > 32767 || w * h > 268435456) throw new Error(`${f.name} at ${w} x ${h} px is too large for the browser canvas.`);
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const png = await new Promise<Blob | null>(r => c.toBlob(r, 'image/png'));
    if (!png) throw new Error(`${f.name} could not be rasterized.`);
    return new File([png], f.name, { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Open Recent list in IndexedDB (one record); empty without IndexedDB.
const DB = 'photobaer-recent', STORE = 'recent', KEY = 'files';
function recentStore<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined as T);
  return new Promise((res, rej) => {
    const o = indexedDB.open(DB, 1);
    o.onupgradeneeded = () => o.result.createObjectStore(STORE);
    o.onerror = () => rej(o.error);
    o.onsuccess = () => {
      const d = o.result, r = f(d.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => { res(r.result as T); d.close(); };
      r.onerror = () => { rej(r.error); d.close(); };
    };
  });
}
const loadRecent = async () => (await recentStore<Recent[] | undefined>('readonly', s => s.get(KEY))) ?? [];
const storeRecent = (list: Recent[]) => recentStore<unknown>('readwrite', s => s.put(list, KEY));

export { addRecent, baseName, fsAccess, kindOf, loadRecent, permit, pickOpen, pickSave, rasterSvg, saveFormat, saveRoute, storeRecent, writeFile };
export type { Kind, Origin, Recent, SaveFormat };
