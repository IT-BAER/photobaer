// Main-thread font sources: the bundled OFL set, user uploads and (Chromium) Local Font Access.
// Every source ends in the worker's app-scope registry; fonts never enter documents (M4 D4).
import type { EngineClient } from '../client.ts';
import type { FaceInfo } from '../worker/types.ts';

// Served from app/public/fonts and precached by the service worker, so they work offline.
export const BUNDLED = ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'NotoSerif-Regular.ttf', 'NotoSansMono-Regular.ttf'];

// Registers the bundled set, then every stored upload. Returns all registered faces.
export async function loadFonts(client: EngineClient, base = document.baseURI): Promise<FaceInfo[]> {
  await Promise.all(BUNDLED.map(async f => {
    const r = await fetch(new URL(`fonts/${f}`, base));
    if (!r.ok) throw new Error(`Bundled font ${f} failed to load (${r.status})`);
    await client.call('fontAdd', await r.arrayBuffer(), 'bundled');
  }));
  await client.call('fontRestore');
  return client.call('fontFaces');
}

// Stores the file once in OPFS (by content hash) and registers its faces; rejects files that are not fonts.
export async function uploadFont(client: EngineClient, file: File): Promise<FaceInfo[]> {
  return client.call('fontUpload', file.name, await file.arrayBuffer());
}

export interface LocalFont { family: string; style: string; postscriptName: string; fullName: string; blob(): Promise<Blob> }

// Local Font Access exists on Chromium only; elsewhere pickers show bundled and uploaded fonts.
export const localFontsSupported = () => typeof window !== 'undefined' && 'queryLocalFonts' in window;

// Lists system fonts without their bytes; needs a user gesture (the browser asks for permission).
export async function queryLocalFonts(): Promise<LocalFont[]> {
  if (!localFontsSupported()) return [];
  return (window as unknown as { queryLocalFonts(): Promise<LocalFont[]> }).queryLocalFonts();
}

// Loads one local family's faces into the registry on demand (when it is picked or a document needs it).
export async function loadLocalFamily(client: EngineClient, fonts: LocalFont[], family: string): Promise<FaceInfo[]> {
  const out: FaceInfo[] = [];
  for (const f of fonts.filter(f => f.family === family)) {
    try { out.push(...await client.call('fontAdd', await (await f.blob()).arrayBuffer(), 'local')); } catch { /* unreadable or unsupported face: skipped */ }
  }
  return out;
}
