// Patch, Content-Aware Move and Red Eye pointer handling, and the Clone Stamp / Healing Brush
// source overlay (docs/M5.md section 9).
import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { client } from '../client.ts';
import type { Active } from '../LayersPanel.tsx';
import { cloneOverlaySource, cloneSources, redEyeRect, tintOverlay } from '../shell/retouch.ts';
import type { ToolOptions } from '../shell/OptionsBar.tsx';
import type { BoxRect, SelectionOverlay, TransformImage } from '../shell/SelectionOverlay.ts';
import { sourceImage } from './transform.ts';
import { hitCrop, resizeCrop, type CropHit } from '../crop/geometry.ts';
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
  // Red Eye takes a click box or a dragged box. Content-Aware Move with Transform On Drop keeps the
  // dropped box with 8 handles: Enter or a click outside applies the scaled move, Escape cancels,
  // a tool change applies.
  useEffect(() => {
    const v = viewer.current;
    if (!v || !(tool === 'patch' || tool === 'contentAwareMove' || tool === 'redEye')) return;
    let start: [number, number] | null = null;
    let drop: { id: number; base: BoxRect; box: BoxRect; hit: CropHit | null; from: [number, number]; startBox: BoxRect; img?: TransformImage | null } | null = null;
    const preview = (r: Rect | null) => {
      overlayRef.current?.setPreview(r && { kind: 'rect', x: r[0], y: r[1], w: r[2], h: r[3] });
      redrawOverlay();
    };
    // The moved pixels drawn scaled from the selection bounds into the dropped box.
    const showDrop = () => {
      const o = overlayRef.current, d = drop;
      o?.setBox(d?.box ?? null);
      if (d?.img) {
        const sx = d.box.w / d.base.w, sy = d.box.h / d.base.h;
        const doc = docRef.current;
        o?.setImage({ ...d.img, ...(doc ? { clip: [0, 0, doc.width, doc.height] } : {}), m: [sx, 0, d.box.x - d.base.x * sx, 0, sy, d.box.y - d.base.y * sy, 0, 0, 1] });
      } else o?.setImage(null);
      redrawOverlay();
    };
    const endDrop = (apply: boolean) => {
      const d = drop;
      drop = null;
      showDrop();
      if (!apply || !d || d.box.w < 1 || d.box.h < 1) return;
      const o = toolOptionsRef.current;
      const dx = Math.round(d.box.x + d.box.w / 2 - (d.base.x + d.base.w / 2)), dy = Math.round(d.box.y + d.box.h / 2 - (d.base.y + d.base.h / 2));
      const scale = [d.box.w / d.base.w, d.box.h / d.base.h];
      run('Moving…', () => client.call('contentAwareMove', d.id, dx, dy, { extend: o.mode === 'extend', structure: Number(o.structure), color: Number(o.color), scale }));
    };
    const onKey = (e: KeyboardEvent) => {
      if (!drop || (e.key !== 'Enter' && e.key !== 'Escape')) return;
      e.preventDefault();
      e.stopPropagation();
      endDrop(e.key === 'Enter');
    };
    window.addEventListener('keydown', onKey, true);
    v.onPointer = e => {
      if (drop) {
        const d = drop;
        if (e.type === 'down') {
          d.hit = hitCrop(d.box, [e.x, e.y], 8 / v.view.zoom);
          if (!d.hit) { endDrop(true); return; }
          d.from = [e.x, e.y];
          d.startBox = d.box;
        } else if (d.hit) {
          // Shift keeps the dropped box's aspect.
          d.box = resizeCrop(d.startBox, d.hit, e.x - d.from[0], e.y - d.from[1], e.shiftKey ? d.base.w / d.base.h : null);
          if (e.type !== 'move') d.hit = null;
          showDrop();
        }
        return;
      }
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
        const before = JSON.stringify(docRef.current?.history);
        run('Patching…', async () => {
          const d = await client.call('patch', id, dx, dy, { mode, contentAware: o.patchMode === 'contentAware', transparent: !!o.transparent, ...base });
          // A patch that changes no pixel adds no history step; say why instead of doing nothing.
          if (d && JSON.stringify(d.history) === before) {
            setError(o.transparent && o.patchMode !== 'contentAware'
              ? 'Patch changed nothing: with Transparent on, the target keeps its own detail where it is stronger than the source. Turn Transparent off to replace it.'
              : 'Patch changed nothing.');
          }
          return d;
        });
      } else if (o.transformOnDrop && b) {
        const base = { x: b[0], y: b[1], w: b[2], h: b[3] }, box = { ...base, x: b[0] + dx, y: b[1] + dy };
        const d = drop = { id, base, box, hit: null, from: [0, 0] as [number, number], startBox: box, img: null as TransformImage | null };
        showDrop();
        client.call('selectedPixels', id).then(r => { if (drop === d) { d.img = sourceImage(r); showDrop(); } }, () => {});
      } else {
        run('Moving…', () => client.call('contentAwareMove', id, dx, dy, { extend: o.mode === 'extend', ...base }));
      }
    };
    return () => { window.removeEventListener('keydown', onKey, true); endDrop(true); v.onPointer = () => {}; preview(null); };
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
      const sampled = !(tool === 'healingBrush' && o.source === 'pattern');
      const found = pointer && doc && !alt && sampled ? cloneOverlaySource(cloneSources, pointer, doc.key, !!o.aligned || painting) : null;
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
