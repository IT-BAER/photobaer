import { useEffect, type RefObject } from 'react';
import { client } from '../client.ts';
import {
  HANDLES, cropActive, cropBox, cropCancel, cropCommit, cropDown, cropMove, cropPointerCancel, cropRatio, cropUp, croppedSize, hitCrop,
  newCropState, newPerspState, overlayLines, perspDown, perspMove, perspSize, perspUp, type CropCtx,
} from '../crop/geometry.ts';
import type { ToolOptions } from '../shell/OptionsBar.tsx';
import { HANDLE_CURSORS, type SelectionOverlay } from '../shell/SelectionOverlay.ts';
import type { Pt } from '../transform/matrix.ts';
import type { Viewer } from '../viewer.ts';
import type { DocInfo } from '../worker/types.ts';
import type { Run } from './helpers.ts';
import type { TSession } from './transform.ts';

type CropSession = { active: () => boolean; commit: () => void; cancel: () => void; draw: () => void };
type SetOptionsOf = (toolId: 'crop' | 'perspectiveCrop', patch: Record<string, number | boolean>) => void;

export interface CropToolCtx {
  viewer: RefObject<Viewer | null>; canvas: RefObject<HTMLCanvasElement | null>; tool: string; doc: DocInfo | null; docRef: RefObject<DocInfo | null>;
  cropOptionsRef: RefObject<ToolOptions>; overlayRef: RefObject<SelectionOverlay | null>; redrawOverlay: () => void; run: Run;
  setOptionsOf: SetOptionsOf; transformRef: RefObject<TSession | null>; cropSession: RefObject<CropSession | null>; toolRef: RefObject<string>;
}

export function useCropTool(c: CropToolCtx) {
  const { viewer, canvas, tool, doc, docRef, cropOptionsRef, overlayRef, redrawOverlay, run, setOptionsOf, transformRef, cropSession, toolRef } = c;
  useEffect(() => {
    const v = viewer.current, c = canvas.current;
    if (!v || !c || tool !== 'crop' || !doc) return;
    const s = newCropState();
    const ctx = (): CropCtx => {
      const d = docRef.current!, o = cropOptionsRef.current;
      return { docW: d.width, docH: d.height, zoom: v.view.zoom, ratio: cropRatio(o, d.width, d.height), straighten: !!o.straighten };
    };
    const draw = () => {
      const d = docRef.current, o = overlayRef.current;
      if (!d || !o) return;
      const rect = cropBox(s, d.width, d.height), [w, h] = croppedSize(rect, s.angle, d.width, d.height);
      o.setCrop(rect.w > 0 && rect.h > 0 ? {
        rect, canvas: { x: 0, y: 0, w: d.width, h: d.height }, lines: overlayLines(rect, String(cropOptionsRef.current.overlay)),
        dims: `${w} × ${h} px`, line: s.line && [...s.line[0], ...s.line[1]],
      } : null);
      redrawOverlay();
    };
    const commit = () => {
      const d = docRef.current;
      if (!d) return;
      const r = cropCommit(s, d.width, d.height);
      draw();
      if (!r) return;
      const del = !!cropOptionsRef.current.deleteCroppedPixels;
      void run('Cropping…', () => client.call('cropTool', r.rect.x, r.rect.y, r.rect.w, r.rect.h, r.angle, del));
    };
    const cancel = () => { cropCancel(s); setOptionsOf('crop', { straighten: false }); draw(); };
    v.onPointer = e => {
      const p: Pt = [e.x, e.y], mods = { shift: e.shiftKey, alt: e.altKey };
      if (e.type === 'down') cropDown(s, p, ctx());
      else if (e.type === 'move') cropMove(s, p, mods, ctx());
      else if (e.type === 'cancel') cropPointerCancel(s);
      else if (cropUp(s, p, mods, ctx()) !== null) setOptionsOf('crop', { straighten: false });
      draw();
    };
    const hover = (e: PointerEvent) => {
      const d = docRef.current;
      if (!d || s.active) return;
      const r = c.getBoundingClientRect(), p = v.screenToDoc(e.clientX - r.left, e.clientY - r.top);
      const hit = cropOptionsRef.current.straighten ? null : hitCrop(cropBox(s, d.width, d.height), p, 11 / v.view.zoom);
      c.style.cursor = hit === 'body' ? 'move' : hit ? HANDLE_CURSORS[HANDLES.indexOf(hit)] : 'crosshair';
    };
    const dbl = () => { if (!transformRef.current) commit(); };
    c.addEventListener('pointermove', hover);
    c.addEventListener('dblclick', dbl);
    cropSession.current = { active: () => cropActive(s), commit, cancel, draw };
    draw();
    return () => {
      v.onPointer = () => {};
      c.removeEventListener('pointermove', hover);
      c.removeEventListener('dblclick', dbl);
      c.style.cursor = '';
      cropSession.current = null;
      // Leaving the tool applies a pending crop (a new document drops it).
      if (toolRef.current !== 'crop' && cropActive(s)) commit();
      overlayRef.current?.setCrop(null);
      redrawOverlay();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, doc?.docId]);
}

export interface PerspectiveCropToolCtx {
  viewer: RefObject<Viewer | null>; tool: string; doc: DocInfo | null; docRef: RefObject<DocInfo | null>; overlayRef: RefObject<SelectionOverlay | null>;
  redrawOverlay: () => void; perspOptionsRef: RefObject<ToolOptions>; run: Run; setOptionsOf: SetOptionsOf;
  cropSession: RefObject<CropSession | null>; toolRef: RefObject<string>;
}

export function usePerspectiveCropTool(c: PerspectiveCropToolCtx) {
  const { viewer, tool, doc, docRef, overlayRef, redrawOverlay, perspOptionsRef, run, setOptionsOf, cropSession, toolRef } = c;
  useEffect(() => {
    const v = viewer.current;
    if (!v || tool !== 'perspectiveCrop' || !doc) return;
    const s = newPerspState();
    const ctx = () => ({ docW: docRef.current!.width, docH: docRef.current!.height, zoom: v.view.zoom });
    const draw = () => { overlayRef.current?.setCorners(s.corners.length ? [...s.corners] : null); redrawOverlay(); };
    const commit = () => {
      if (s.corners.length !== 4) return;
      const o = perspOptionsRef.current, corners = s.corners, [w, h] = perspSize(corners, Number(o.outputWidth), Number(o.outputHeight));
      // Cleared before the call so a second commit cannot resend the quad; a refused (degenerate)
      // quad gets its corners back for another try.
      s.corners = [];
      draw();
      void run('Cropping…', async () => {
        try {
          return await client.call('perspectiveCrop', corners.flat(), w, h);
        } catch (e) {
          if (!s.corners.length) { s.corners = corners; draw(); }
          throw e;
        }
      });
    };
    const cancel = () => { s.corners = []; s.active = false; s.dragging = -1; draw(); };
    v.onPointer = e => {
      const p: Pt = [e.x, e.y];
      if (e.type === 'down') perspDown(s, p, ctx());
      else if (e.type === 'move') perspMove(s, p, ctx());
      else if (e.type === 'cancel') { s.active = false; s.dragging = -1; }
      else {
        const o = perspOptionsRef.current, size = perspUp(s, p, ctx(), Number(o.outputWidth), Number(o.outputHeight));
        if (size) setOptionsOf('perspectiveCrop', { outputWidth: size[0], outputHeight: size[1] });
      }
      draw();
    };
    cropSession.current = { active: () => s.active || s.corners.length > 0, commit, cancel, draw };
    return () => {
      v.onPointer = () => {};
      cropSession.current = null;
      if (toolRef.current !== 'perspectiveCrop') commit();
      overlayRef.current?.setCorners(null);
      redrawOverlay();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, doc?.docId]);
}
