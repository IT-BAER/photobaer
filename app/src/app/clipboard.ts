import { client } from '../client.ts';
import type { Active } from '../LayersPanel.tsx';
import { selectCreated, type Run } from './helpers.ts';

type Clip = { w: number; h: number; data: ArrayBuffer };
export type PasteMode = 'paste' | 'inPlace' | 'into' | 'outside';

// Edit > Copy / Copy Merged / Cut, then the copied pixels as PNG on the system clipboard. The write starts
// before the worker answers so the key press still counts as user activation; any failure leaves the internal clipboard.
export function copy(run: Run, active: Active, merged: boolean, cut: boolean) {
  const r = client.call('copy', active.id, merged, cut);
  const png = r.then(d => {
    const { clip } = d as { clip: Clip };
    const c = new OffscreenCanvas(clip.w, clip.h);
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(clip.data), clip.w, clip.h), 0, 0);
    return c.convertToBlob({ type: 'image/png' });
  });
  png.catch(() => {});
  try { navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).catch(() => {}); } catch { /* no async clipboard */ }
  return run(cut ? 'Cutting…' : null, () => r);
}

// The first image on the system clipboard (may prompt for permission), or null.
async function systemImage(): Promise<Uint8Array | null> {
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find(t => t.startsWith('image/'));
      if (type) return new Uint8Array(await (await item.getType(type)).arrayBuffer());
    }
  } catch { /* denied or unavailable */ }
  return null;
}

// Edit > Paste variants. `bytes`: a paste event's image (null: the event had none); otherwise the internal
// clipboard, and from the menu (undefined) the system clipboard when that is empty.
export function paste(run: Run, active: Active | null, mode: PasteMode, bytes?: Uint8Array | null) {
  return run(null, async () => {
    const r = await client.call('paste', active?.id ?? 0, mode, bytes ?? null);
    const b = !r.pasted && bytes === undefined ? await systemImage() : null;
    return b ? client.call('paste', active?.id ?? 0, mode, b) : r;
  }, d => (d as { created?: number }).created ? selectCreated(d) : active);
}
