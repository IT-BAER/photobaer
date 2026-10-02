// Patch, Content-Aware Move and Red Eye pointer handling, and the Clone Stamp / Healing Brush
// source overlay (docs/M5.md section 9).
import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { client } from '../client.ts';
import type { Active } from '../LayersPanel.tsx';
import { cloneOverlaySource, cloneSources, redEyeRect, tintOverlay } from '../shell/retouch.ts';
import type { ToolOptions } from '../shell/OptionsBar.tsx';
import type { SelectionOverlay } from '../shell/SelectionOverlay.ts';
import type { Viewer } from '../viewer.ts';
import type { DocInfo } from '../worker/types.ts';
import type { Run } from './helpers.ts';

type Rect = [number, number, number, number];

export interface RetouchCtx {
  viewer: RefObject<Viewer | null>; canvas: RefObject<HTMLCanvasElement | null>; overlayRef: RefObject<SelectionOverlay | null>;
  redrawOverlay: () => void; tool: string; active: Active | null; docRef: RefObject<DocInfo | null>; toolOptionsRef: RefObject<ToolOptions>;
  run: Run; setError: Dispatch<SetStateAction<string | null>>;
}

export function useRetouchTools(c: RetouchCtx) {
  const { viewer, overlayRef, redrawOverlay, tool, active, docRef, toolOptionsRef, run, setError } = c;
  // Patch and Content-Aware Move drag the selection's bounds (dashed box) and apply on release;
  // Red Eye takes a click box or a dragged box.
  useEffect(() => {
    const v = viewer.current;
    if (!v || !(tool === 'patch' || tool === 'contentAwareMove' || tool === 'redEye')) return;
    let start: [number, number] | null = null;
    const preview = (r: Rect | null) => {
      overlayRef.current?.setPreview(r && { kind: 'rect', x: r[0], y: r[1], w: r[2], h: r[3] });
      redrawOverlay();
    };
    v.onPointer = e => {
      if (e.type === 'down') {
        if (!active) return;
        if (tool !== 'redEye' && !docRef.current?.selection?.bounds) { setError('Make a selection first.'); return; }
        start = [e.x, e.y];
        return;
      }
      if (!start || !active) return;
      const s = start, b = docRef.current?.selection?.bounds;
      const dx = Math.round(e.x - s[0]), dy = Math.round(e.y - s[1]);
      if (e.type === 'move') {
        if (tool === 'redEye') preview([Math.min(s[0], e.x), Math.min(s[1], e.y), Math.abs(e.x - s[0]), Math.abs(e.y - s[1])]);
        else if (b) preview([b[0] + dx, b[1] + dy, b[2], b[3]]);
        return;
      }
      start = null;
      preview(null);
      if (e.type === 'cancel') return;
      const o = toolOptionsRef.current, id = active.id;
      if (tool === 'redEye') {
        const r = redEyeRect(s, [e.x, e.y]);
        run(null, () => client.call('redEye', id, r, Number(o.pupilSize) / 100, Number(o.darken) / 100));
        return;
      }
      if (!dx && !dy) return;
      const base = { structure: Number(o.structure), color: Number(o.color) };
      if (tool === 'patch') {
        const mode = o.mode === 'destination' ? 'destination' : 'source';
        run('Patching…', () => client.call('patch', id, dx, dy, { mode, contentAware: o.patchMode === 'contentAware', ...base }));
      } else {
        run('Moving…', () => client.call('contentAwareMove', id, dx, dy, { extend: o.mode === 'extend', ...base }));
      }
    };
    return () => { v.onPointer = () => {}; preview(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, active]);
}

// Clone Stamp / Healing Brush: a crosshair on the source point and, with Show Overlay, the source
// pixels under the tip (hidden while painting with Auto Hide). One overlay request is in flight.
export function useCloneOverlay(c: RetouchCtx) {
  const { viewer, canvas, overlayRef, redrawOverlay, tool, active, docRef, toolOptionsRef } = c;
  useEffect(() => {
    const v = viewer.current, el = canvas.current;
    if (!v || !el || !(tool === 'cloneStamp' || tool === 'healingBrush')) return;
    let pointer: [number, number] | null = null, painting = false, busy = false, again = false, alt = false;
    const img = document.createElement('canvas');
    const clear = () => { overlayRef.current?.setClone(null); redrawOverlay(); };
    const update = async () => {
      if (busy) { again = true; return; }
      const doc = docRef.current, o = toolOptionsRef.current;
      const found = pointer && doc && !alt ? cloneOverlaySource(cloneSources, pointer, doc.key, !!o.aligned || painting) : null;
      if (!found || !pointer || !doc) { clear(); return; }
      const slot = cloneSources.slot();
      const size = Math.max(1, Number(o.size)), zoom = v.view.zoom;
      const showPixels = slot.showOverlay && !(painting && slot.overlayAutoHide) && active;
      let image = null;
      if (showPixels) {
        const out = Math.max(1, Math.min(256, Math.round(size * zoom)));
        const rect: Rect = [pointer[0] - size / 2, pointer[1] - size / 2, size, size];
        const sample = tool === 'cloneStamp' ? o.sample : o.allLayers ? 'allLayers' : 'currentLayer';
        const source = { kind: 'clone', ...found.map, sample, ignoreAdjustments: !!o.ignoreAdjustments, ...(slot.layerId !== null ? { layerId: slot.layerId } : {}) };
        busy = true;
        try {
          const r = await client.call('cloneSample', active!.id, source, rect, out, out);
          const px = new Uint8ClampedArray(r.data);
          const mode = slot.overlayMode;
          const here = { kind: 'clone', anchor: [0, 0], origin: [0, 0], m: [1, 0, 0, 1], sample: 'allLayers', ignoreAdjustments: false };
          const dest = mode === 'normal' ? undefined : new Uint8ClampedArray((await client.call('cloneSample', active!.id, here, rect, out, out)).data);
          const opacity = slot.overlayOpacity * (slot.overlayClipped ? Number(o.opacity ?? 100) / 100 : 1);
          tintOverlay(px, out, out, { clipped: slot.overlayClipped, opacity, inverted: slot.overlayInverted, mode, dest });
          img.width = out; img.height = out;
          img.getContext('2d')!.putImageData(new ImageData(px, out, out), 0, 0);
          image = { canvas: img, x: rect[0], y: rect[1], w: size, h: size };
        } catch { /* a closed document or a busy engine: crosshair only */ } finally { busy = false; }
      }
      overlayRef.current?.setClone({ src: found.src, image });
      redrawOverlay();
      if (again) { again = false; void update(); }
    };
    const local = (e: PointerEvent): [number, number] => {
      const r = el.getBoundingClientRect();
      return v.screenToDoc(e.clientX - r.left, e.clientY - r.top) as [number, number];
    };
    const move = (e: PointerEvent) => { pointer = local(e); alt = e.altKey; painting = (e.buttons & 1) === 1; void update(); };
    const down = (e: PointerEvent) => { alt = e.altKey; painting = e.button === 0 && !e.altKey; void update(); };
    const up = () => { painting = false; void update(); };
    const leave = () => { pointer = null; clear(); };
    const unsub = cloneSources.subscribe(() => void update());
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointerleave', leave);
    return () => {
      unsub();
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointerleave', leave);
      clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, active]);
}
