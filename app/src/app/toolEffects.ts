import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { client } from '../client.ts';
import type { Active } from '../LayersPanel.tsx';
import { nodeById } from '../layers.ts';
import { engineStops, type Method } from '../gradients/gradient.ts';
import { BUILTIN_GRADIENTS, resolvePreset, type GradientLibrary } from '../gradients/presets.ts';
import { dragResize, showCrosshair } from '../shell/brushKeys.ts';
import type { Rgb } from '../shell/color.ts';
import type { ToolOptions } from '../shell/OptionsBar.tsx';
import type { SelectionOverlay } from '../shell/SelectionOverlay.ts';
import { marqueeRect, MagneticLasso, PolygonLasso, selectMode, snap45, snap45Length, type SelectMode } from '../shell/selecttools.ts';
import { constrainedSnap, snapGrid, snapSettings, type Rect, type SnapAxes } from '../shell/snapping.ts';
import { TOOLS } from '../shell/tools.ts';
import type { ToolPointerEvent, Viewer } from '../viewer.ts';
import type { DocInfo, GradientParams } from '../worker/types.ts';
import { PAINT_TOOLS, SAMPLE_SIZES, SELECT_TOOLS, makeLatch, type Run, type Show } from './helpers.ts';

type PolygonActions = { active: () => boolean; commit: () => void; cancel: () => void; removeLast: () => void };

export interface SelectionToolsCtx {
  viewer: RefObject<Viewer | null>; dragRef: RefObject<Record<string, unknown> | null>; polygonRef: RefObject<PolygonLasso | null>;
  lastPolyDownRef: RefObject<{ t: number; x: number; y: number } | null>; overlayRef: RefObject<SelectionOverlay | null>;
  magneticRef: RefObject<{ lasso: MagneticLasso; handle: number | null; mode: SelectMode } | null>; tool: string;
  polygonActionsRef: RefObject<PolygonActions | null>; toolOptionsRef: RefObject<ToolOptions>; polygonModeRef: RefObject<SelectMode>;
  show: Show; docRef: RefObject<DocInfo | null>; activeRef: RefObject<Active | null>; doc: DocInfo | null;
}

export function useSelectionTools(c: SelectionToolsCtx) {
  const { viewer, dragRef, polygonRef, lastPolyDownRef, overlayRef, magneticRef, tool, polygonActionsRef, toolOptionsRef, polygonModeRef, show, docRef, activeRef, doc } = c;
  // Rectangular/elliptical marquees, row/column marquees, freehand lasso, the polygonal lasso,
  // the magnetic lasso, quick selection and the magic wand all drive the viewer's raw pointer
  // events and the overlay preview; everything else forwards through onPointer as a no-op.
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    const cancelAll = () => {
      dragRef.current = null;
      polygonRef.current = null;
      lastPolyDownRef.current = null;
      overlayRef.current?.setPreview(null);
      if (magneticRef.current) {
        if (magneticRef.current.handle !== null) client.call('magneticEnd', magneticRef.current.handle);
        magneticRef.current = null;
      }
    };
    cancelAll();
    if (!SELECT_TOOLS.includes(tool)) {
      v.onPointer = () => {};
      polygonActionsRef.current = null;
      return cancelAll;
    }

    const shapeKind = () => (tool === 'marqueeEllipse' ? 'ellipse' as const : 'rect' as const);
    const marqueeOpts = () => {
      const o = toolOptionsRef.current;
      return { style: o.style as 'normal' | 'fixed ratio' | 'fixed size', ratioW: Number(o.ratioW), ratioH: Number(o.ratioH), fixedW: Number(o.fixedW), fixedH: Number(o.fixedH) };
    };

    function commitPolygon() {
      const lasso = polygonRef.current;
      polygonRef.current = null;
      lastPolyDownRef.current = null;
      overlayRef.current?.setPreview(null);
      if (!lasso) return;
      const o = toolOptionsRef.current;
      client.call('select', { kind: 'polygon', points: lasso.flat() }, polygonModeRef.current, !!o.antiAlias, Number(o.feather), 'Polygonal Lasso').then(show);
    }

    if (tool === 'marqueeRect' || tool === 'marqueeEllipse') {
      v.onPointer = e => {
        if (e.type === 'down') {
          dragRef.current = { start: [e.x, e.y], mode: selectMode(toolOptionsRef.current.mode as string, e.shiftKey, e.altKey), shiftLatch: makeLatch(e.shiftKey), altLatch: makeLatch(e.altKey) };
        } else {
          const d = dragRef.current as { start: [number, number]; mode: SelectMode; shiftLatch: (b: boolean) => boolean; altLatch: (b: boolean) => boolean } | null;
          if (!d) return;
          const r = marqueeRect(d.start, [e.x, e.y], { ...marqueeOpts(), constrain: d.shiftLatch(e.shiftKey), fromCenter: d.altLatch(e.altKey) });
          if (e.type === 'move') { overlayRef.current?.setPreview({ kind: shapeKind(), ...r }); return; }
          dragRef.current = null;
          overlayRef.current?.setPreview(null);
          if (e.type === 'cancel') return;
          const o = toolOptionsRef.current;
          client.call('select', { kind: shapeKind(), ...r }, d.mode, tool === 'marqueeEllipse' && !!o.antiAlias, Number(o.feather), TOOLS[tool].label).then(show);
        }
      };
    } else if (tool === 'marqueeRow' || tool === 'marqueeColumn') {
      v.onPointer = e => {
        if (e.type !== 'down') return;
        const d = docRef.current;
        if (!d) return;
        const mode = selectMode(toolOptionsRef.current.mode as string, e.shiftKey, e.altKey);
        const shape = tool === 'marqueeRow'
          ? { kind: 'rect' as const, x: 0, y: Math.floor(e.y), w: d.width, h: 1 }
          : { kind: 'rect' as const, x: Math.floor(e.x), y: 0, w: 1, h: d.height };
        client.call('select', shape, mode, false, 0, TOOLS[tool].label).then(show);
      };
    } else if (tool === 'lasso') {
      v.onPointer = e => {
        if (e.type === 'down') {
          dragRef.current = { points: [e.x, e.y], mode: selectMode(toolOptionsRef.current.mode as string, e.shiftKey, e.altKey), altLatch: makeLatch(e.altKey), straight: null };
          return;
        }
        const d = dragRef.current as { points: number[]; mode: SelectMode; altLatch: (b: boolean) => boolean; straight: [number, number] | null } | null;
        if (!d) return;
        if (e.type === 'move') {
          if (d.altLatch(e.altKey)) { d.straight = [e.x, e.y]; } else {
            if (d.straight) { d.points.push(d.straight[0], d.straight[1]); d.straight = null; }
            const lx = d.points[d.points.length - 2], ly = d.points[d.points.length - 1];
            if (Math.hypot(e.x - lx, e.y - ly) >= 0.5) d.points.push(e.x, e.y);
          }
          const pts = d.straight ? [...d.points, d.straight[0], d.straight[1]] : d.points;
          overlayRef.current?.setPreview({ kind: 'path', points: pts, closed: false });
          return;
        }
        dragRef.current = null;
        overlayRef.current?.setPreview(null);
        if (e.type === 'cancel') return;
        if (d.straight) d.points.push(d.straight[0], d.straight[1]);
        const o = toolOptionsRef.current;
        client.call('select', { kind: 'polygon', points: d.points }, d.mode, !!o.antiAlias, Number(o.feather), 'Lasso').then(show);
      };
    } else if (tool === 'polygonalLasso') {
      v.onPointer = e => {
        if (e.type === 'move') {
          const lasso = polygonRef.current;
          if (lasso && lasso.points.length) overlayRef.current?.setPreview({ kind: 'path', points: [...lasso.flat(), e.x, e.y], closed: false });
          return;
        }
        if (e.type !== 'down') return;
        const zoom = v.view.zoom;
        const lasso = polygonRef.current ?? (polygonRef.current = new PolygonLasso());
        if (lasso.points.length === 0) polygonModeRef.current = selectMode(toolOptionsRef.current.mode as string, e.shiftKey, e.altKey);
        const now = performance.now();
        const last = lastPolyDownRef.current;
        const dbl = !!last && now - last.t < 300 && Math.hypot(e.x - last.x, e.y - last.y) <= 3 / zoom;
        lastPolyDownRef.current = { t: now, x: e.x, y: e.y };
        if (lasso.points.length && (lasso.closesAt([e.x, e.y], 6 / zoom) || dbl)) { commitPolygon(); return; }
        const prev = lasso.points.at(-1);
        lasso.add(e.shiftKey && prev ? snap45(prev, [e.x, e.y]) : [e.x, e.y]);
        overlayRef.current?.setPreview({ kind: 'path', points: lasso.flat(), closed: false });
      };
    } else if (tool === 'magneticLasso') {
      const finish = (points: number[], mode: SelectMode, handle: number) => {
        const o = toolOptionsRef.current;
        client.call('select', { kind: 'polygon', points }, mode, !!o.antiAlias, Number(o.feather), 'Magnetic Lasso').then(show);
        client.call('magneticEnd', handle);
        magneticRef.current = null;
        overlayRef.current?.setPreview(null);
      };
      v.onPointer = e => {
        const o = toolOptionsRef.current;
        if (e.type === 'move') {
          const st = magneticRef.current;
          if (!st || st.handle === null) return;
          const [lx, ly] = st.lasso.last();
          client.call('magneticPath', st.handle, lx, ly, e.x, e.y, Number(o.width), Number(o.contrast)).then(path => {
            if (magneticRef.current !== st) return;
            client.call('magneticSuggestAnchor', path, Number(o.frequency)).then(idx => {
              if (magneticRef.current !== st) return;
              const split = idx > 0 && idx * 2 < path.length;
              if (split) st.lasso.addAnchor(Array.from(path.subarray(2, idx * 2)), path[idx * 2], path[idx * 2 + 1]);
              const tail = split ? path.subarray(idx * 2) : path;
              overlayRef.current?.setPreview({ kind: 'path', points: [...st.lasso.committed, ...tail], closed: false });
            });
          });
          return;
        }
        if (e.type !== 'down' || !activeRef.current) return;
        const st = magneticRef.current;
        if (!st) {
          const lasso = new MagneticLasso();
          lasso.start(e.x, e.y);
          magneticRef.current = { lasso, handle: null, mode: selectMode(o.mode as string, e.shiftKey, e.altKey) };
          client.call('magneticBegin', activeRef.current.id, false).then(handle => {
            if (magneticRef.current) magneticRef.current.handle = handle;
          });
          overlayRef.current?.setPreview({ kind: 'path', points: lasso.committed, closed: false });
          return;
        }
        const zoom = v.view.zoom;
        if (st.lasso.closesAt(e.x, e.y, 6 / zoom) && st.handle !== null) { finish(st.lasso.committed, st.mode, st.handle); return; }
        if (st.handle === null) return;
        client.call('magneticPath', st.handle, ...st.lasso.last(), e.x, e.y, Number(o.width), Number(o.contrast)).then(path => {
          if (magneticRef.current !== st) return;
          st.lasso.addAnchor(Array.from(path.subarray(2, -2)), e.x, e.y);
          overlayRef.current?.setPreview({ kind: 'path', points: st.lasso.committed, closed: false });
        });
      };
      polygonActionsRef.current = {
        active: () => !!magneticRef.current?.lasso.anchors.length,
        commit: () => { const st = magneticRef.current; if (st?.handle !== null && st) finish(st.lasso.committed, st.mode, st.handle); },
        cancel: cancelAll,
        removeLast: () => {
          const st = magneticRef.current;
          st?.lasso.removeLast();
          overlayRef.current?.setPreview(st?.lasso.anchors.length ? { kind: 'path', points: st.lasso.committed, closed: false } : null);
        },
      };
      return cancelAll;
    } else if (tool === 'quickSelection') {
      const circle = (x: number, y: number, r: number) => ({ kind: 'ellipse' as const, x: x - r, y: y - r, w: r * 2, h: r * 2 });
      v.onPointer = e => {
        const o = toolOptionsRef.current;
        const r = Number(o.size) / 2;
        if (e.type === 'down') {
          dragRef.current = { points: [e.x, e.y], mode: e.altKey ? 'subtract' : (o.mode as string) };
          overlayRef.current?.setPreview(circle(e.x, e.y, r));
          return;
        }
        const d = dragRef.current as { points: number[]; mode: string } | null;
        if (e.type === 'move') {
          if (d) {
            const lx = d.points[d.points.length - 2], ly = d.points[d.points.length - 1];
            if (Math.hypot(e.x - lx, e.y - ly) >= 1) d.points.push(e.x, e.y);
          }
          overlayRef.current?.setPreview(circle(e.x, e.y, r));
          return;
        }
        dragRef.current = null;
        overlayRef.current?.setPreview(null);
        if (e.type === 'cancel' || !d || !activeRef.current) return;
        client.call('quickSelect', activeRef.current.id, d.points, r, !!o.sampleAllLayers, d.mode, !!o.autoEnhance).then(show);
      };
    } else if (tool === 'magicWand') {
      v.onPointer = e => {
        if (e.type !== 'down' || !activeRef.current) return;
        const o = toolOptionsRef.current;
        const mode = selectMode('new', e.shiftKey, e.altKey);
        client.call('magicWand', activeRef.current.id, e.x, e.y, Number(o.tolerance), !!o.antiAlias, !!o.contiguous, !!o.sampleAllLayers, mode).then(show);
      };
    }

    polygonActionsRef.current = {
      active: () => !!polygonRef.current?.points.length,
      commit: commitPolygon,
      cancel: cancelAll,
      removeLast: () => {
        polygonRef.current?.removeLast();
        overlayRef.current?.setPreview(polygonRef.current?.points.length ? { kind: 'path', points: polygonRef.current.flat(), closed: false } : null);
      },
    };
    return cancelAll;
  }, [tool, doc?.docId]);
}

export interface MoveToolCtx {
  viewer: RefObject<Viewer | null>; tool: string; docRef: RefObject<DocInfo | null>; activeRef: RefObject<Active | null>;
  toolOptionsRef: RefObject<ToolOptions>; setActive: Dispatch<SetStateAction<Active | null>>; setError: Dispatch<SetStateAction<string | null>>;
  show: Show; overlayRef: RefObject<SelectionOverlay | null>; redrawOverlay: () => void; run: Run;
  moveKeysRef: RefObject<{ nudge: (dx: number, dy: number, alt: boolean) => void } | null>; doc: DocInfo | null;
}

export function useMoveTool(c: MoveToolCtx) {
  const { viewer, tool, docRef, activeRef, toolOptionsRef, setActive, setError, show, overlayRef, redrawOverlay, run, moveKeysRef, doc } = c;
  // Move tool: drags or arrow-nudges the active (or auto-selected) layer, or the selected pixels
  // under the pointer, as one undo step; the worker previews every offset from the gesture start.
  useEffect(() => {
    const v = viewer.current;
    if (!v || tool !== 'move') return;
    type Plan = { pixels: boolean; id: number; alt: boolean };
    type Drag = {
      origin: [number, number]; pos: [number, number]; shift: boolean; plan: Plan | null; ready: boolean; busy: boolean; failed: boolean;
      want: [number, number]; sent: [number, number]; end: 'up' | 'cancel' | null; moving: Rect; tx: number[]; ty: number[]; lock: SnapAxes; grid: [number | undefined, number | undefined];
    };
    let drag: Drag | null = null;

    // What a gesture moves, or null (after a message) when it cannot start. Nudges pass no point.
    async function plan(pt: [number, number] | null, alt: boolean, auto: boolean): Promise<Plan | null> {
      const d = docRef.current, a = activeRef.current;
      if (!d || !a) return null;
      let id = a.id;
      let pixels = !!d.selection && (!pt || await client.call('selectionAt', pt[0], pt[1]) >= 128);
      if (!pixels && auto && pt) {
        const hit = await client.call('hitTestLayer', pt[0], pt[1], toolOptionsRef.current.autoSelectTarget === 'group');
        if (hit !== null && hit !== a.id) { id = hit; setActive({ id: hit, target: 'pixels' }); }
      }
      const n = nodeById(d.layers, id);
      if (!n) return null;
      if (n.kind !== 'pixel') pixels = false;
      if (pixels && n.locks.pixels) { setError('Could not use the layer because it is locked.'); return null; }
      if (!pixels && n.locks.position) { setError(`${n.name} is locked and can't be moved.`); return null; }
      return { pixels, id, alt };
    }
    function begin(p: Plan) {
      return p.pixels ? client.call('movePixelsBegin', p.id, p.alt ? 'Move Selection Copy' : 'Move Selection', p.alt) : client.call('moveLayerBegin', p.id, p.alt, p.alt ? 'Move Copy' : 'Move');
    }
    const step = (p: Plan, dx: number, dy: number) => (p.pixels ? client.call('movePixelsStep', dx, dy) : client.call('moveLayerStep', dx, dy));
    const commit = (p: Plan) => (p.pixels ? client.call('movePixelsCommit') : client.call('moveLayerCommit'));
    const cancel = (p: Plan) => (p.pixels ? client.call('movePixelsCancel') : client.call('moveLayerCancel'));
    const movedId = (d: DocInfo, p: Plan) => ('activeId' in d ? (d as { activeId: number }).activeId : p.id);
    const afterBegin = (d: DocInfo, p: Plan) => show(d, p.alt ? () => ({ id: movedId(d, p), target: 'pixels' }) : undefined);

    function aim(g: Drag) {
      const r = constrainedSnap(g.moving, g.tx, g.ty, Math.round(g.pos[0] - g.origin[0]), Math.round(g.pos[1] - g.origin[1]), g.lock, v!.view.zoom, g.shift, ...g.grid);
      g.lock = r.lock;
      g.want = [Math.round(r.dx), Math.round(r.dy)];
      const d = docRef.current!;
      const lines: [number, number, number, number][] = [];
      if (r.lock.x) lines.push([r.lock.x.target, 0, r.lock.x.target, d.height]);
      if (r.lock.y) lines.push([0, r.lock.y.target, d.width, r.lock.y.target]);
      overlayRef.current?.setGuides(snapSettings().smartGuides ? lines : []);
      redrawOverlay();
    }
    // One step in flight at a time, always the latest offset; the end commits after the last step.
    function pump(g: Drag) {
      if (!g.ready || g.busy) return;
      if (!g.failed && (g.want[0] !== g.sent[0] || g.want[1] !== g.sent[1])) {
        g.busy = true;
        g.sent = g.want;
        step(g.plan!, ...g.want).then(show, err => { g.failed = true; setError((err as Error).message); }).finally(() => { g.busy = false; pump(g); });
        return;
      }
      if (!g.end && !g.failed) return;
      if (drag === g) drag = null;
      overlayRef.current?.setGuides([]);
      redrawOverlay();
      const p = g.plan!;
      run(null, () => (g.failed || g.end === 'cancel' ? cancel(p) : commit(p)));
    }
    async function start(g: Drag, e: ToolPointerEvent) {
      const o = toolOptionsRef.current;
      const p = await plan(g.origin, e.altKey, !!o.autoSelect !== (e.ctrlKey || e.metaKey));
      if (!p) { if (drag === g) drag = null; return; }
      g.plan = p;
      try {
        const d = await begin(p);
        afterBegin(d, p);
        if (o.snap && snapSettings().enabled) {
          const id = movedId(d, p);
          const [t, b] = await Promise.all([client.call('snapTargets', id, snapSettings()), p.pixels ? docRef.current?.selection?.bounds ?? null : client.call('movingBounds', id)]);
          g.tx = t.x;
          g.ty = t.y;
          g.grid = snapGrid(docRef.current?.grid);
          if (b) g.moving = { x: b[0], y: b[1], w: b[2], h: b[3] };
        }
      } catch (err) {
        setError((err as Error).message);
        g.failed = true;
      }
      g.ready = true;
      if (!g.failed) aim(g);
      pump(g);
    }

    v.onPointer = e => {
      if (e.type === 'down') {
        if (drag) return;
        const g: Drag = {
          origin: [e.x, e.y], pos: [e.x, e.y], shift: e.shiftKey, plan: null, ready: false, busy: false, failed: false,
          want: [0, 0], sent: [0, 0], end: null, moving: { x: 0, y: 0, w: 0, h: 0 }, tx: [], ty: [], lock: { x: null, y: null }, grid: [undefined, undefined],
        };
        drag = g;
        void start(g, e);
        return;
      }
      const g = drag;
      if (!g) return;
      g.pos = [e.x, e.y];
      g.shift = e.shiftKey;
      if (g.ready && !g.failed) aim(g);
      if (e.type !== 'move') g.end = e.type === 'cancel' ? 'cancel' : 'up';
      pump(g);
    };
    moveKeysRef.current = {
      nudge(dx, dy, alt) {
        if (drag) return;
        void plan(null, alt, false).then(p => {
          if (!p) return;
          // Sent back to back so no other move call can land inside this one.
          const b = begin(p), s = step(p, dx, dy), c = commit(p);
          return run(null, async () => { afterBegin(await b, p); await s.catch(() => {}); return c; });
        });
      },
    };
    return () => {
      v.onPointer = () => {};
      moveKeysRef.current = null;
      const g = drag;
      drag = null;
      if (g) { g.end = 'cancel'; pump(g); }
      overlayRef.current?.setGuides([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, doc?.docId]);
}

export interface BrushCursorCtx {
  viewer: RefObject<Viewer | null>; canvas: RefObject<HTMLCanvasElement | null>; overlayRef: RefObject<SelectionOverlay | null>; tool: string;
  redrawOverlay: () => void; toolOptionsRef: RefObject<ToolOptions>; capsLockRef: RefObject<boolean>;
  patchToolOptions: (toolId: string, patch: Record<string, number | string | boolean>) => void;
}

export function useBrushCursor(c: BrushCursorCtx) {
  const { viewer, canvas, overlayRef, tool, redrawOverlay, toolOptionsRef, capsLockRef, patchToolOptions } = c;
  // Brush cursor outline (tracks the pointer independent of any drag) and Ctrl+Alt+right-drag
  // resize/hardness, with the outline doubling as the drag's live preview.
  useEffect(() => {
    const v = viewer.current, c = canvas.current;
    overlayRef.current?.setCursor(null);
    if (!v || !c || !PAINT_TOOLS.has(tool)) { redrawOverlay(); return; }
    let pos: [number, number] | null = null;
    let drag: { x: number; y: number; size: number; hardness: number } | null = null;
    const local = (e: PointerEvent): [number, number] => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const cursorFor = () => {
      if (!pos) return null;
      const [x, y] = v.screenToDoc(pos[0], pos[1]);
      const o = toolOptionsRef.current;
      const zoom = v.view.zoom;
      const block = tool === 'eraser' && o.mode === 'block';
      const sizeDoc = block ? 16 / zoom : Number(o.size);
      return { x, y, sizeDoc, shape: block ? 'square' as const : 'round' as const, crosshair: showCrosshair(sizeDoc * zoom, capsLockRef.current) };
    };
    const update = () => { overlayRef.current?.setCursor(cursorFor()); redrawOverlay(); };
    const move = (e: PointerEvent) => {
      pos = local(e);
      if (drag) {
        const r = dragResize(drag.size, drag.hardness, e.clientX - drag.x, e.clientY - drag.y);
        const patch: Record<string, number> = { size: r.size };
        if (toolOptionsRef.current.hardness !== undefined) patch.hardness = r.hardness;
        patchToolOptions(tool, patch);
      }
      update();
    };
    const leave = () => { if (!drag) { pos = null; update(); } };
    const down = (e: PointerEvent) => {
      if (e.button !== 2 || !e.ctrlKey || !e.altKey) return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const o = toolOptionsRef.current;
      drag = { x: e.clientX, y: e.clientY, size: Number(o.size), hardness: Number(o.hardness ?? 100) };
    };
    const up = () => { drag = null; };
    const context = (e: MouseEvent) => { if (e.ctrlKey && e.altKey) e.preventDefault(); };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerleave', leave);
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('contextmenu', context);
    return () => {
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerleave', leave);
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointercancel', up);
      c.removeEventListener('contextmenu', context);
      overlayRef.current?.setCursor(null);
      redrawOverlay();
    };
  }, [tool]);
}

export interface EyedropperCtx {
  viewer: RefObject<Viewer | null>; tool: string; toolOptions: ToolOptions; active: Active | null;
  setBg: Dispatch<SetStateAction<Rgb>>; setFg: Dispatch<SetStateAction<Rgb>>;
}

export function useEyedropper(c: EyedropperCtx) {
  const { viewer, tool, toolOptions, active, setBg, setFg } = c;
  useEffect(() => {
    const v = viewer.current;
    if (!v || tool !== 'eyedropper') return;
    v.onPointer = (e: ToolPointerEvent) => {
      if (e.type !== 'down') return;
      const size = SAMPLE_SIZES[toolOptions.sampleSize as string] ?? 1;
      const layerId = toolOptions.sample === 'current layer' ? active?.id ?? null : null;
      client.call('sample', e.x, e.y, size, layerId).then(([r, g, b]) => {
        if (e.altKey) setBg([r, g, b]); else setFg([r, g, b]);
      });
    };
    return () => { v.onPointer = () => {}; };
  }, [tool, toolOptions.sampleSize, toolOptions.sample, active]);
}

export interface BucketCtx {
  viewer: RefObject<Viewer | null>; tool: string; active: Active | null; setFg: Dispatch<SetStateAction<Rgb>>;
  toolOptionsRef: RefObject<ToolOptions>; bg: Rgb; fg: Rgb; quickMask: boolean; show: Show;
}

export function useBucket(c: BucketCtx) {
  const { viewer, tool, active, setFg, toolOptionsRef, bg, fg, quickMask, show } = c;
  // Paint bucket: click fills; Alt springs to the eyedropper (sets the foreground color) instead.
  // Runs after the selection effect above so it is not left as a no-op by that effect's early return.
  useEffect(() => {
    const v = viewer.current;
    if (!v || tool !== 'bucket') return;
    v.onPointer = e => {
      if (e.type !== 'down' || !active) return;
      if (e.altKey) {
        client.call('sample', e.x, e.y, 1, null).then(([r, g, b]) => setFg([r, g, b]));
        return;
      }
      const o = toolOptionsRef.current;
      const rgb = o.source === 'background' ? bg : fg;
      client.call('bucket', active.id, quickMask ? 'selection' : 'pixels', e.x, e.y, [...rgb, 255], o.mode as string, Number(o.opacity) / 100, Number(o.tolerance), !!o.antiAlias, !!o.contiguous, !!o.allLayers).then(show);
    };
    return () => { v.onPointer = () => {}; };
  }, [tool, active, fg, bg, quickMask]);
}

export interface GradientToolCtx {
  viewer: RefObject<Viewer | null>; tool: string; active: Active | null; overlayRef: RefObject<SelectionOverlay | null>;
  toolOptionsRef: RefObject<ToolOptions>; gradLib: RefObject<GradientLibrary | null>; fgRef: RefObject<Rgb>; bgRef: RefObject<Rgb>;
  run: Run; editTarget: (a: Active) => 'selection' | Active['target']; quickMask: boolean;
}

export function useGradientTool(c: GradientToolCtx) {
  const { viewer, tool, active, overlayRef, toolOptionsRef, gradLib, fgRef, bgRef, run, editTarget, quickMask } = c;
  // Gradient: drag from start to end with a live line; Shift snaps to 45 degrees keeping the length.
  useEffect(() => {
    const v = viewer.current;
    if (!v || tool !== 'gradient') return;
    let start: [number, number] | null = null;
    const endOf = (e: ToolPointerEvent) => (e.shiftKey ? snap45Length(start!, [e.x, e.y]) : [e.x, e.y] as [number, number]);
    v.onPointer = e => {
      if (e.type === 'down') { start = active ? [e.x, e.y] : null; return; }
      if (!start) return;
      const end = endOf(e);
      if (e.type === 'move') { overlayRef.current?.setPreview({ kind: 'path', points: [...start, ...end], closed: false }); return; }
      const from = start;
      start = null;
      overlayRef.current?.setPreview(null);
      if (e.type === 'cancel' || !active || Math.hypot(end[0] - from[0], end[1] - from[1]) < 1e-6) return;
      const o = toolOptionsRef.current;
      const g = resolvePreset(gradLib.current!.get(String(o.gradient)) ?? BUILTIN_GRADIENTS[0], fgRef.current, bgRef.current);
      run(null, () => client.call('gradient', active.id, editTarget(active), {
        ...engineStops(g), method: o.method as Method, style: o.style as GradientParams['style'], start: { x: from[0], y: from[1] }, end: { x: end[0], y: end[1] },
        reverse: !!o.reverse, dither: !!o.dither, transparency: !!o.transparency, opacity: Number(o.opacity) / 100,
      }));
    };
    return () => { v.onPointer = () => {}; overlayRef.current?.setPreview(null); };
  }, [tool, active, quickMask]);
}
