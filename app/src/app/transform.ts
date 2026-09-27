import type { Dispatch, RefObject, SetStateAction } from 'react';
import { client } from '../client.ts';
import type { Active } from '../LayersPanel.tsx';
import { nodeById } from '../layers.ts';
import type { PerfProbe } from '../render/perf.ts';
import type { SelectionOverlay, TransformImage } from '../shell/SelectionOverlay.ts';
import { snapGrid, snapOffset, snapSettings, type Rect, type SnapAxes } from '../shell/snapping.ts';
import { TransformBarStore, type WarpBarState, type WarpSplit } from '../shell/TransformBar.tsx';
import { IDENTITY, isIdentity, normalize, type Mat3, type Pt } from '../transform/matrix.ts';
import {
  commandState, drag as dragState, handlePoints, hitTest, initialState, matrixOf, numericValues, opFor, refPoint, setReference,
  type Command, type Hit, type Mode, type Mods, type TState,
} from '../transform/session.ts';
import {
  defaultPreset, dragPoint, dragSurface, engineMesh, evaluate, gridOf, hitPoint, identityMesh, meshModified, removeSplitAt, splitAt,
  surfaceWeights, type Mesh, type Warp,
} from '../transform/warp.ts';
import type { ToolPointerEvent, Viewer } from '../viewer.ts';
import type { DocInfo } from '../worker/types.ts';
import type { Run, Show } from './helpers.ts';

// Warp editing inside a transform session; `initial` is the unmodified mesh over the source bounds,
// `last` the last pointer-down point (where the menu split commands act).
type WState = {
  w: Warp; initial: Mesh; undo: Warp[]; split: WarpSplit | null; last: Pt | null;
  drag: { start: Warp; from: Pt; index: number | null; weights: number[] | null } | null;
};
type TSession = {
  warp: WState | null; switching: boolean;
  s: TState; mode: Mode; linked: boolean; snap: boolean; kind: 'layer' | 'pixels' | 'selection'; img: TransformImage | null;
  // Earlier states for Ctrl+Z inside the session.
  undo: TState[];
  gen: number; refine: 'none' | 'pending' | 'done'; timer: ReturnType<typeof setTimeout> | undefined; frame: number;
  drag: { hit: Exclude<Hit, null>; start: TState; from: Pt; to: Pt; mods: Mods } | null;
  tx: number[]; ty: number[]; lock: SnapAxes; store: TransformBarStore; off: () => void;
};

export interface TransformCtx {
  overlayRef: RefObject<SelectionOverlay | null>; perfRef: RefObject<PerfProbe | null>; transformRef: RefObject<TSession | null>;
  show: Show; setError: Dispatch<SetStateAction<string | null>>; viewer: RefObject<Viewer | null>; setMenu: Dispatch<SetStateAction<string | null>>;
  activeRef: RefObject<Active | null>; run: Run; againRef: RefObject<{ n: Mat3; interp: string } | null>; docRef: RefObject<DocInfo | null>;
  canvas: RefObject<HTMLCanvasElement | null>; setTransformMenu: Dispatch<SetStateAction<[number, number] | null>>;
  setTransformStore: Dispatch<SetStateAction<TransformBarStore | null>>; redrawOverlay: () => void;
}

export function transformSession(c: TransformCtx) {
  const { overlayRef, perfRef, transformRef, show, setError, viewer, setMenu, activeRef, run, againRef, docRef, canvas, setTransformMenu, setTransformStore, redrawOverlay } = c;
  // Free transform session (Ctrl+T): pointer, keys, options bar and context menu edit a TState; the
  // overlay previews the lifted pixels and 500 ms after the last change the worker renders the result.
  function transformDraw(t: TSession) {
    t.frame = 0;
    const t0 = performance.now(), m = matrixOf(t.s), o = overlayRef.current!, g = t.drag;
    if (t.warp) {
      const mesh = t.warp.w.mesh, b = mesh.bounds;
      o.setImage(t.img && t.refine !== 'done' ? { ...t.img, m: IDENTITY, map: (x, y) => evaluate(mesh, (x - b.x) / b.w, (y - b.y) / b.h) } : null);
      o.setAntsMatrix(null);
      o.setTransform(null);
      o.setWarp(mesh);
      redrawOverlay();
      perfRef.current?.recordPreview(performance.now() - t0);
      return;
    }
    o.setImage(t.img && t.refine !== 'done' ? { ...t.img, m } : null);
    o.setAntsMatrix(t.kind !== 'layer' ? m : null);
    const b = t.s.bounds, scaling = g?.hit.kind === 'handle' && g.hit.i % 2 === 0 && opFor(g.hit, g.mods, t.mode) === 'scale';
    const dims = scaling ? { text: `${Math.round(Math.abs(t.s.p.sx) * b.w)} × ${Math.round(Math.abs(t.s.p.sy) * b.h)} px`, at: g!.to } : null;
    o.setTransform({ handles: handlePoints(t.s), ref: refPoint(t.s), dims });
    redrawOverlay();
    perfRef.current?.recordPreview(performance.now() - t0);
  }
  function transformRefine(t: TSession) {
    if (transformRef.current !== t) return;
    const gen = t.gen;
    t.refine = 'pending';
    client.call('transformRefine', t.warp ? engineMesh(t.warp.w.mesh) : matrixOf(t.s)).then(d => {
      if (transformRef.current !== t || t.gen !== gen) return;
      t.refine = 'done';
      show(d);
      transformDraw(t);
    }, err => {
      if (t.gen === gen) t.refine = 'none';
      setError((err as Error).message);
    });
  }
  function transformChange(t: TSession, s: TState, checkpoint: boolean) {
    if (checkpoint) t.undo.push(t.s);
    t.s = s;
    t.store.set({ values: numericValues(s) });
    transformTouched(t);
  }
  // Drops a refined result and schedules the preview frame and the next refine.
  function transformTouched(t: TSession) {
    t.gen++;
    if (t.refine !== 'none') {
      t.refine = 'none';
      client.call('transformUnrefine').then(d => { if (transformRef.current === t) show(d); }, err => setError((err as Error).message));
    }
    t.frame ||= requestAnimationFrame(() => transformDraw(t));
    clearTimeout(t.timer);
    t.timer = setTimeout(() => transformRefine(t), 500);
  }
  const warpBar = (ws: WState): WarpBarState => ({ preset: ws.w.preset, grid: gridOf(ws.w.mesh), split: ws.split });
  function warpChange(t: TSession, w: Warp, checkpoint: boolean) {
    const ws = t.warp!;
    if (w === ws.w) return;
    if (checkpoint) ws.undo.push(ws.w);
    ws.w = w;
    t.store.set({ warp: warpBar(ws) });
    transformTouched(t);
  }
  // An armed split mode places (or removes) a split at the click; otherwise a control point within
  // 8 screen px or the surface within 2 screen px is dragged. A click elsewhere does nothing.
  function warpPointer(t: TSession, ws: WState, e: ToolPointerEvent) {
    const v = viewer.current!;
    if (e.type === 'down') {
      ws.last = [e.x, e.y];
      if (ws.split) {
        const mode = ws.split, mesh = ws.w.mesh;
        ws.split = null;
        const next = mode === 'remove' ? removeSplitAt(mesh, e.x, e.y) : splitAt(mesh, e.x, e.y, mode);
        if (next && next !== mesh) warpChange(t, { ...ws.w, mesh: next }, true);
        else t.store.set({ warp: warpBar(ws) });
        return;
      }
      const toScreen = (p: Pt) => v.docToScreen(p[0], p[1]);
      const index = hitPoint(ws.w.mesh, toScreen, toScreen([e.x, e.y]), 8);
      const weights = index === null ? surfaceWeights(ws.w.mesh, e.x, e.y, 2 / v.view.zoom) : null;
      if (index !== null || weights) ws.drag = { start: ws.w, from: [e.x, e.y], index, weights };
      return;
    }
    const g = ws.drag;
    if (!g) return;
    const dx = e.x - g.from[0], dy = e.y - g.from[1];
    const next = e.type === 'cancel' || (!dx && !dy) ? g.start : g.index !== null ? dragPoint(g.start, g.index, dx, dy) : dragSurface(g.start, g.weights!, dx, dy);
    warpChange(t, next, false);
    if (e.type === 'move') return;
    ws.drag = null;
    if (e.type === 'up' && ws.w !== g.start) ws.undo.push(g.start);
  }
  // Edit > Transform > Split Warp / Remove Warp Split: at the last click, else the source centre.
  function warpMenuSplit(mode: WarpSplit) {
    setMenu(null);
    const t = transformRef.current, ws = t?.warp;
    if (!t || !ws) { setError('Splits belong to a warp: open one with Edit > Transform > Warp.'); return; }
    const b = ws.w.mesh.bounds, [x, y] = ws.last ?? [b.x + b.w / 2, b.y + b.h / 2];
    const next = mode === 'remove' ? removeSplitAt(ws.w.mesh, x, y) : splitAt(ws.w.mesh, x, y, mode);
    if (!next) { setError('This warp has no split to remove.'); return; }
    warpChange(t, { ...ws.w, mesh: next }, true);
  }
  // A smart object's warp starts from its current look (`start`, over the source parameter box `b`).
  const newWarp = (b: Rect, start?: Omit<Mesh, 'bounds'> | null): WState => {
    const mesh = start ? { ...start, bounds: b } : identityMesh(b);
    return { w: { mesh, preset: defaultPreset('custom') }, initial: mesh, undo: [], split: null, last: null, drag: null };
  };
  // Free transform -> warp: the worker renders the pending matrix and lifts the result as the warp source.
  async function warpSwitch(t: TSession) {
    const m = isIdentity(matrixOf(t.s)) ? null : matrixOf(t.s);
    t.switching = true;
    t.drag = null;
    clearTimeout(t.timer);
    t.gen++;
    let r;
    try {
      r = await client.call('transformWarp', m);
    } catch (err) {
      t.switching = false;
      setError((err as Error).message);
      if (transformRef.current === t) { t.refine = 'done'; transformTouched(t); }
      return;
    }
    t.switching = false;
    if (transformRef.current !== t) return;
    t.img = sourceImage(r);
    t.refine = 'none';
    t.warp = newWarp({ x: r.bounds[0], y: r.bounds[1], w: r.bounds[2], h: r.bounds[3] }, r.mesh);
    t.mode = 'warp';
    t.store.set({ mode: 'warp', warp: warpBar(t.warp) });
    show(r);
    transformDraw(t);
  }
  function transformDragStep(t: TSession) {
    const g = t.drag!, zoom = viewer.current!.view.zoom, snap = t.snap && snapSettings().enabled, [gx, gy] = snapGrid(docRef.current?.grid);
    const next = dragState(g.start, g.hit, opFor(g.hit, g.mods, t.mode), g.mods, g.from, g.to, {
      linked: t.linked,
      snapMove: snap ? (box, dx, dy) => { const r = snapOffset(box, t.tx, t.ty, dx, dy, t.lock, zoom, 6, 10, gx, gy); t.lock = r.lock; return [r.dx, r.dy]; } : undefined,
      snapPoint: snap ? p => { const r = snapOffset({ x: p[0], y: p[1], w: 0, h: 0 }, t.tx, t.ty, 0, 0, { x: null, y: null }, zoom, 6, 10, gx, gy); return [p[0] + r.dx, p[1] + r.dy]; } : undefined,
    });
    if (next) transformChange(t, next, false);
  }
  const eventMods = (e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): Mods => ({ shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey });
  function transformPointer(t: TSession, e: ToolPointerEvent) {
    if (t.switching) return;
    if (t.warp) { warpPointer(t, t.warp, e); return; }
    if (e.type === 'down') {
      const v = viewer.current!, toScreen = (p: Pt) => v.docToScreen(p[0], p[1]);
      const hit = hitTest(t.s, toScreen, toScreen([e.x, e.y]));
      if (!hit) { endTransform(true); return; }
      t.lock = { x: null, y: null };
      t.drag = { hit, start: t.s, from: [e.x, e.y], to: [e.x, e.y], mods: eventMods(e) };
      return;
    }
    const g = t.drag;
    if (!g) return;
    g.to = [e.x, e.y];
    g.mods = eventMods(e);
    if (e.type === 'cancel') transformChange(t, g.start, false);
    else transformDragStep(t);
    if (e.type === 'move') return;
    t.drag = null;
    if (e.type === 'up' && t.s !== g.start) t.undo.push(g.start);
    t.frame ||= requestAnimationFrame(() => transformDraw(t));
  }
  // A modifier pressed or released mid-drag re-evaluates the operation.
  function transformModifier(e: KeyboardEvent) {
    const t = transformRef.current;
    if (!t?.drag || !/^(Shift|Alt|Control|Meta)$/.test(e.key)) return false;
    e.preventDefault();
    t.drag.mods = eventMods(e);
    transformDragStep(t);
    return true;
  }
  function transformKey(e: KeyboardEvent, k: string, ctrl: boolean): boolean {
    const t = transformRef.current;
    if (!t) return false;
    if (transformModifier(e)) return true;
    if (k === 'enter') { e.preventDefault(); endTransform(true); }
    else if (k === 'escape') { e.preventDefault(); endTransform(false); }
    else if (ctrl && !e.shiftKey && k === 'z') {
      e.preventDefault();
      if (t.warp) {
        const prev = t.warp.drag ? undefined : t.warp.undo.pop();
        if (prev) warpChange(t, prev, false);
        return true;
      }
      const prev = t.drag ? undefined : t.undo.pop();
      if (prev) transformChange(t, prev, false);
    } else if (!ctrl && k.startsWith('arrow')) {
      e.preventDefault();
      if (t.warp || t.switching) return true;
      const n = e.shiftKey ? 10 : 1, [x, y] = refPoint(t.s);
      transformChange(t, setReference(t.s, [x + (k === 'arrowleft' ? -n : k === 'arrowright' ? n : 0), y + (k === 'arrowup' ? -n : k === 'arrowdown' ? n : 0)]), true);
    } else if (k === ' ' || (ctrl && ['+', '=', '-', '0', '1'].includes(k))) return false;
    // Any other shortcut could reach the worker, which cancels the session behind the UI's back.
    else if (ctrl || e.altKey) e.preventDefault();
    return true;
  }
  function withTransform(f: (t: TSession) => void) {
    const t = transformRef.current;
    setTransformMenu(null);
    if (t) f(t);
  }
  const transformCommand = (c: Command) => withTransform(t => { if (!t.warp && !t.switching) transformChange(t, commandState(t.s, c), true); });
  // A warp session stays a warp.
  const setTransformMode = (t: TSession, m: Mode) => {
    if (t.warp || t.switching) return;
    if (m === 'warp') void warpSwitch(t);
    else { t.mode = m; t.store.set({ mode: m }); }
  };
  // The session preview source as a canvas.
  function sourceImage(r: { image: { x: number; y: number; w: number; h: number; f: number } | null; data: ArrayBuffer | null }): TransformImage | null {
    if (!r.image || !r.data) return null;
    const src = document.createElement('canvas');
    src.width = r.image.w;
    src.height = r.image.h;
    src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.image.w, r.image.h), 0, 0);
    return { source: src, ...r.image, m: IDENTITY };
  }
  // Edit > Transform: inside a session these change it, outside they start one or act directly.
  function transformMode(m: Mode) {
    if (transformRef.current) withTransform(t => setTransformMode(t, m));
    else void startTransform(m);
  }
  function transformRemap(c: Command, label: string) {
    setMenu(null);
    const a = activeRef.current;
    if (transformRef.current) transformCommand(c);
    else if (a) void run(null, () => client.call('rotateExact', a.id, c, label));
  }
  function transformAgain() {
    const g = againRef.current, a = activeRef.current;
    if (!g) { setMenu(null); setError('There is no transform to repeat.'); return; }
    if (a) void run(null, () => client.call('transformAgain', a.id, g.n, g.interp));
  }

  async function startTransform(mode: Mode = 'free', selection = false) {
    setMenu(null);
    const d = docRef.current, a = activeRef.current, v = viewer.current, c = canvas.current;
    if (!d || !a || !v || !c || transformRef.current) return;
    const n = nodeById(d.layers, a.id);
    if (!n) return;
    const kind = selection ? 'selection' : d.selection ? 'pixels' : 'layer';
    if (mode === 'warp') {
      if (n.kind !== 'pixel' && n.kind !== 'smart') { setError('Only pixel layers and smart objects can be warped.'); return; }
      if (kind !== 'layer') { setError('Warp bends a whole layer; deselect to warp it.'); return; }
      if (n.locks.pixels) { setError('Could not use the layer because it is locked.'); return; }
    }
    if (kind === 'pixels' && n.locks.pixels) { setError('Could not use the layer because it is locked.'); return; }
    if (kind === 'layer' && n.locks.position) { setError(`${n.name} is locked and can't be moved.`); return; }
    let r;
    try {
      r = await client.call('transformBegin', a.id, kind, selection ? 'Transform Selection' : mode === 'warp' ? 'Warp' : 'Free Transform', 2048, mode === 'warp');
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    const img = sourceImage(r), b = { x: r.bounds[0], y: r.bounds[1], w: r.bounds[2], h: r.bounds[3] };
    const s = initialState(b), warp = mode === 'warp' ? newWarp(b, r.mesh) : null;
    const store = new TransformBarStore({ mode, values: numericValues(s), linked: true, snap: true, warp: warp && warpBar(warp) });
    const dbl = () => endTransform(true);
    const ctx = (e: MouseEvent) => { e.preventDefault(); setTransformMenu([e.clientX, e.clientY]); };
    const keyUp = (e: KeyboardEvent) => { transformModifier(e); };
    c.addEventListener('dblclick', dbl);
    c.addEventListener('contextmenu', ctx);
    addEventListener('keyup', keyUp);
    const t: TSession = {
      warp, switching: false, s, mode, linked: true, snap: true, kind, img, undo: [], gen: 0, refine: 'none', timer: undefined, frame: 0, drag: null,
      tx: [], ty: [], lock: { x: null, y: null }, store,
      off: () => { c.removeEventListener('dblclick', dbl); c.removeEventListener('contextmenu', ctx); removeEventListener('keyup', keyUp); },
    };
    transformRef.current = t;
    v.intercept = e => transformPointer(t, e);
    setTransformStore(store);
    show(r);
    transformDraw(t);
    client.call('snapTargets', a.id, snapSettings()).then(g => { t.tx = g.x; t.ty = g.y; }, () => {});
  }
  // Tears down the session UI only; the caller settles the worker side.
  function closeTransform() {
    const t = transformRef.current;
    if (!t) return null;
    transformRef.current = null;
    clearTimeout(t.timer);
    cancelAnimationFrame(t.frame);
    t.off();
    if (viewer.current) viewer.current.intercept = null;
    const o = overlayRef.current;
    o?.setImage(null);
    o?.setTransform(null);
    o?.setWarp(null);
    o?.setAntsMatrix(null);
    redrawOverlay();
    setTransformStore(null);
    setTransformMenu(null);
    return t;
  }
  // Commits (one undo step, nothing when unmodified) or cancels the open session.
  function endTransform(commit: boolean) {
    // A commit waits until a switch to warp has landed.
    if (commit && transformRef.current?.switching) return;
    const t = closeTransform();
    if (!t) return;
    const m = t.warp || isIdentity(matrixOf(t.s)) ? null : matrixOf(t.s);
    const op = t.warp ? meshModified(t.warp.w.mesh, t.warp.initial) ? engineMesh(t.warp.w.mesh) : null : m;
    void run(null, async () => {
      if (!commit) return client.call('transformCancel');
      const d = await client.call('transformCommit', op);
      if (m) againRef.current = { n: normalize(m, t.s.bounds), interp: 'bicubic' };
      return d;
    });
  }
  return {
    transformChange, warpChange, warpBar, withTransform, transformCommand, setTransformMode, endTransform, closeTransform, transformKey,
    warpMenuSplit, transformMode, transformRemap, transformAgain, startTransform,
  };
}
export type { WState, TSession };
