import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { client } from '../client.ts';
import type { Active } from '../LayersPanel.tsx';
import { nodeById } from '../layers.ts';
import { hexToRgb, type Rgb } from '../shell/color.ts';
import type { ToolOptions } from '../shell/OptionsBar.tsx';
import {
  anchorsIn, arrowDelta, convertDrag, convertToCorner, CurvatureDraft, deleteAnchors, deleteSubs, directDrag, editOverlay, hasHandles, hitTest,
  magneticPick, magneticProbes, nudgeAnchors, onePath, PenDraft, penAutoEdit, penTarget, subsIn, translateSubs,
  type Hit, type Mods, type Ref, type Sub, type Target, type XY,
} from '../shell/pentools.ts';
import { namedCursor, type Badge } from '../shell/cursors.ts';
import type { SelectionOverlay } from '../shell/SelectionOverlay.ts';
import { newStroke } from '../shell/shapetools.ts';
import type { ToolPointerEvent, Viewer } from '../viewer.ts';
import type { DocInfo, VectorPath } from '../worker/types.ts';
import { selectCreated, type Run } from './helpers.ts';

export const PEN_TOOLS = ['pen', 'freeformPen', 'curvaturePen', 'addAnchor', 'deleteAnchor', 'convertPoint'];
const PATH_TOOLS = [...PEN_TOOLS, 'pathSelection', 'directSelection'];
const OPS: Record<string, string> = { new: 'combine', add: 'combine', subtract: 'subtract', intersect: 'intersect', exclude: 'exclude' };

// The Paths panel selection; `cleared` = the user cleared it, so the work path is no fallback target.
export interface PathSel { selected: number | null; cleared: boolean }

export interface PenToolsCtx {
  viewer: RefObject<Viewer | null>; canvas: RefObject<HTMLCanvasElement | null>; tool: string; doc: DocInfo | null;
  docRef: RefObject<DocInfo | null>; activeRef: RefObject<Active | null>; overlayRef: RefObject<SelectionOverlay | null>;
  redrawOverlay: () => void; toolOptionsRef: RefObject<ToolOptions>; fgRef: RefObject<Rgb>; bgRef: RefObject<Rgb>; run: Run;
  pathSelRef: RefObject<PathSel>; selectPath: (id: number) => void; setError: Dispatch<SetStateAction<string | null>>;
  penKeysRef: RefObject<((e: KeyboardEvent) => boolean) | null>; redrawRef: RefObject<(() => void) | null>;
}

const mods = (e: ToolPointerEvent | KeyboardEvent): Mods => ({ shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey });

// Pen, freeform, curvature, add/delete/convert point, path and direct selection (docs/M4.md
// section 4). Ctrl with a pen tool is a temporary Direct Selection gesture.
export function usePenTools(c: PenToolsCtx) {
  const { viewer, canvas, tool, doc, docRef, activeRef, overlayRef, redrawOverlay, toolOptionsRef, fgRef, bgRef, run, pathSelRef, selectPath, setError, penKeysRef, redrawRef } = c;
  useEffect(() => {
    const v = viewer.current, cv = canvas.current;
    if (!v || !cv || !PATH_TOOLS.includes(tool)) return;
    const docId = docRef.current?.docId;
    const tol = () => 4 / v.view.zoom;
    const target = (): Target | null => {
      const d = docRef.current, a = activeRef.current;
      if (!d) return null;
      const n = a ? nodeById(d.layers, a.id) ?? null : null;
      return penTarget(d, n, pathSelRef.current.selected, pathSelRef.current.cleared);
    };
    const commit = (t: Target, path: VectorPath, label: string) => run(null, async () => {
      const r = await client.call('setPath', t.role, t.id, path, label);
      if (t.role === 'document') selectPath(r.edited);
      return r;
    });
    // Pen Path/Shape: Path Operation != new appends to a target of the mode's kind, else a new
    // shape layer (shape mode) or the work path is replaced.
    const finishSub = (sub: Sub, kind: 'Pen' | 'Freeform' | 'Curvature') => {
      if (sub.points.length < 2) return;
      const o = toolOptionsRef.current, shape = o.mode === 'shape', op = kind === 'Pen' ? String(o.pathOp) : 'new';
      const s = { ...sub, op: OPS[op] ?? 'combine' }, t = target();
      if (op !== 'new' && t && (shape ? t.role === 'shape' : t.role === 'document')) return void commit(t, { ...t.path, subpaths: [...t.path.subpaths, s] }, 'Add Path Component');
      if (shape) {
        const fill: Rgb = (kind === 'Pen' && hexToRgb(String(o.fill))) || fgRef.current;
        const stroke = kind === 'Pen' ? newStroke((hexToRgb(String(o.stroke)) ?? bgRef.current) as Rgb, Math.max(0, Number(o.strokeWidth))) : null;
        return void run(null, () => client.call('newShape', { name: 'Shape', path: onePath(s), fill: { type: 'solid', color: fill }, stroke }, `${kind} Shape`), selectCreated);
      }
      void run(null, async () => {
        const r = await client.call('setPath', 'document', 0, onePath(s), `${kind} Path`);
        selectPath(r.edited);
        return r;
      });
    };

    // ---- Path Selection / Direct Selection (also the pen tools' Ctrl gesture) ----
    let selA: Ref[] = [], selS: number[] = [], selKey = '';
    type SelDrag = { t: Target; hit: Hit | null; start: XY; cur: XY; direct: boolean; copy: boolean; preview: VectorPath | null; shift: boolean };
    let sd: SelDrag | null = null;
    const syncSel = (t: Target | null) => {
      const key = t ? `${t.role}:${t.id}` : '';
      if (key !== selKey) { selA = []; selS = []; selKey = key; }
    };
    const selDown = (e: ToolPointerEvent, direct: boolean) => {
      const t = target();
      syncSel(t);
      if (!t) return;
      const p: XY = [e.x, e.y], m = mods(e);
      const hit = hitTest(t.path, p[0], p[1], tol(), { handles: direct, fill: true });
      sd = { t, hit: null, start: p, cur: p, direct, copy: false, preview: null, shift: m.shift };
      if (direct) {
        if (hit?.kind === 'anchor') {
          const has = selA.some(r => r[0] === hit.s && r[1] === hit.i);
          if (m.shift) selA = has ? selA.filter(r => r[0] !== hit.s || r[1] !== hit.i) : [...selA, [hit.s, hit.i]];
          else if (!has) selA = [[hit.s, hit.i]];
          sd.hit = hit;
        } else if (hit?.kind === 'handle') sd.hit = hit;
        else if (hit?.kind === 'segment') {
          const n = t.path.subpaths[hit.s].points.length;
          selA = [[hit.s, hit.seg], [hit.s, (hit.seg + 1) % n]];
          sd.hit = hit;
        } else if (hit?.kind === 'fill' && m.alt) {
          selA = t.path.subpaths[hit.s].points.map((_, i) => [hit.s, i] as Ref);
          sd.hit = hit;
        } else if (!m.shift) selA = [];
      } else if (hit) {
        const has = selS.includes(hit.s);
        if (m.shift) selS = has ? selS.filter(s => s !== hit.s) : [...selS, hit.s];
        else if (!has) selS = [hit.s];
        sd.hit = selS.includes(hit.s) ? hit : null;
        sd.copy = m.alt;
        if (!sd.hit) sd = null;
      } else if (!m.shift) selS = [];
      draw();
    };
    const selMove = (e: ToolPointerEvent) => {
      const g = sd;
      if (!g) return;
      g.cur = [e.x, e.y];
      const m = mods(e);
      if (!g.hit) {
        overlayRef.current?.setPreview({ kind: 'rect', x: Math.min(g.start[0], e.x), y: Math.min(g.start[1], e.y), w: Math.abs(e.x - g.start[0]), h: Math.abs(e.y - g.start[1]) });
      } else if (g.direct) g.preview = directDrag(g.t.path, g.hit, selA, g.start, g.cur, m);
      else {
        let dx = e.x - g.start[0], dy = e.y - g.start[1];
        if (m.shift) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
        g.preview = translateSubs(g.t.path, selS, dx, dy, g.copy).path;
      }
      draw();
    };
    const selUp = (e: ToolPointerEvent) => {
      const g = sd;
      sd = null;
      overlayRef.current?.setPreview(null);
      if (!g || e.type === 'cancel') { draw(); return; }
      if (!g.hit) {
        if (g.cur[0] !== g.start[0] || g.cur[1] !== g.start[1]) {
          if (g.direct) selA = [...(g.shift ? selA : []), ...anchorsIn(g.t.path, g.start, g.cur)];
          else selS = [...new Set([...(g.shift ? selS : []), ...subsIn(g.t.path, g.start, g.cur)])];
        }
      } else if (g.preview && (g.cur[0] !== g.start[0] || g.cur[1] !== g.start[1])) {
        if (g.copy) selS = selS.map((_, k) => g.t.path.subpaths.length + k);
        void commit(g.t, g.preview, g.direct ? 'Edit Path' : g.copy ? 'Duplicate Path Component' : 'Move Path');
      }
      draw();
    };
    const selKeys = (e: KeyboardEvent, direct: boolean): boolean => {
      const t = target();
      syncSel(t);
      if (!t || (direct ? !selA.length : !selS.length) || e.ctrlKey || e.metaKey) return false;
      if (e.key.startsWith('Arrow')) {
        const [dx, dy] = arrowDelta(e.key, e.shiftKey);
        void commit(t, direct ? nudgeAnchors(t.path, selA, dx, dy) : translateSubs(t.path, selS, dx, dy, false).path, direct ? 'Move Anchor' : 'Move Path');
        return true;
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return false;
      void commit(t, direct ? deleteAnchors(t.path, selA) : deleteSubs(t.path, selS), direct ? 'Delete Anchor Point' : 'Delete Path Component');
      selA = [];
      selS = [];
      return true;
    };

    // ---- drafts ----
    let pen = new PenDraft(), curv = new CurvatureDraft(), hover: XY | null = null;
    let free: { pts: XY[]; chain: Promise<void>; layer: number | null } | null = null;
    let conv: { t: Target; hit: Hit; preview: VectorPath | null } | null = null;
    let tempDirect = false, ctrlHover = false;
    const align = (p: XY): XY => {
      const o = toolOptionsRef.current;
      return tool === 'pen' && o.mode === 'shape' && o.alignEdges ? [Math.round(p[0]), Math.round(p[1])] : p;
    };
    const finishPen = (closed: boolean) => {
      const s = pen.subpath();
      pen = new PenDraft();
      draw();
      finishSub({ ...s, closed }, 'Pen');
    };
    const finishCurv = (closed: boolean) => {
      const d = curv;
      curv = new CurvatureDraft();
      d.closed = closed;
      draw();
      finishSub({ closed, op: 'combine', points: d.anchors() }, 'Curvature');
    };

    function draw() {
      const ov = overlayRef.current;
      if (!ov) return;
      const t = target();
      syncSel(t);
      const o = toolOptionsRef.current;
      if (tool === 'pen' && pen.points.length) {
        const last = pen.points[pen.points.length - 1];
        const band: [number, number, number, number] | null = o.rubberBand && hover && !pen.dragging ? [last[0], last[1], hover[0], hover[1]] : null;
        ov.setPathEdit({ ...editOverlay(onePath(pen.subpath()), [[0, pen.points.length - 1]], [], 'all'), band });
      } else if (tool === 'curvaturePen' && curv.pts.length) {
        const pts = curv.anchors(hover && !curv.dragging ? hover : undefined);
        ov.setPathEdit({ ...editOverlay(onePath({ closed: false, op: 'combine', points: pts }), [], [], 'none'), band: null });
      } else if (free) {
        ov.setPathEdit({ lines: [free.pts.flat()], anchors: [], handles: [], band: null });
      } else {
        const path = sd?.preview ?? conv?.preview ?? t?.path;
        const direct = tool === 'directSelection' || tempDirect;
        ov.setPathEdit(path ? { ...editOverlay(path, direct ? selA : [], tool === 'pathSelection' ? selS : [], direct ? 'selected' : 'none'), band: null } : null);
      }
      redrawOverlay();
      hoverCursor();
    }
    redrawRef.current = draw;

    // Photoshop pen states: x starts a path, o closes it, +/- add or delete an anchor, Ctrl the white arrow.
    function hoverCursor() {
      let badge: Badge | undefined;
      if (hover && ctrlHover && PEN_TOOLS.includes(tool)) {
        cv!.style.setProperty('--hover-cursor', namedCursor('whiteArrow', window.devicePixelRatio || 1));
        return;
      }
      if (hover && tool === 'pen') {
        if (pen.points.length) badge = pen.points.length >= 2 && Math.hypot(hover[0] - pen.points[0][0], hover[1] - pen.points[0][1]) <= tol() ? 'close' : null;
        else {
          const t = toolOptionsRef.current.autoAddDelete ? target() : null;
          const h = t && hitTest(t.path, hover[0], hover[1], tol(), { handles: false, fill: false });
          badge = h?.kind === 'anchor' ? 'subtract' : h?.kind === 'segment' ? 'add' : 'start';
        }
      } else if (hover && tool === 'curvaturePen') {
        badge = !curv.pts.length ? 'start' : curv.pts.length > 2 && Math.hypot(hover[0] - curv.pts[0][0], hover[1] - curv.pts[0][1]) <= tol() ? 'close' : null;
      }
      if (badge === undefined) cv!.style.removeProperty('--hover-cursor');
      else cv!.style.setProperty('--hover-cursor', namedCursor(tool === 'pen' ? 'pen' : 'curvaturePen', window.devicePixelRatio || 1, badge));
    }

    const onHover = (e: PointerEvent) => {
      if (e.buttons) return;
      const r = cv.getBoundingClientRect();
      hover = v.screenToDoc(e.clientX - r.left, e.clientY - r.top);
      ctrlHover = e.ctrlKey || e.metaKey;
      if ((tool === 'pen' && pen.points.length) || (tool === 'curvaturePen' && curv.pts.length)) draw(); else hoverCursor();
    };
    const onKey = (e: KeyboardEvent) => { if (ctrlHover !== (e.ctrlKey || e.metaKey)) { ctrlHover = e.ctrlKey || e.metaKey; hoverCursor(); } };
    const onLeave = () => { hover = null; draw(); };
    cv.addEventListener('pointermove', onHover);
    cv.addEventListener('pointerleave', onLeave);
    addEventListener('keydown', onKey);
    addEventListener('keyup', onKey);

    v.onPointer = e => {
      const p = align([e.x, e.y]), m = mods(e);
      if (tempDirect || (e.type === 'down' && PEN_TOOLS.includes(tool) && m.ctrl && !(tool === 'pen' && pen.points.length))) {
        if (e.type === 'down') { tempDirect = true; selDown(e, true); } else if (e.type === 'move') selMove(e); else { tempDirect = false; selUp(e); }
        return;
      }
      if (tool === 'pathSelection' || tool === 'directSelection') {
        if (e.type === 'down') selDown(e, tool === 'directSelection'); else if (e.type === 'move') selMove(e); else selUp(e);
        return;
      }
      if (tool === 'pen') {
        if (e.type === 'down') {
          const t = target();
          if (!pen.points.length && toolOptionsRef.current.autoAddDelete && t) {
            const r = penAutoEdit(t.path, e.x, e.y, tol());
            if (r) { void commit(t, r.path, r.label); return; }
          }
          const how = pen.down(p, m, tol());
          if (how) finishPen(how === 'closed'); else draw();
        } else if (e.type === 'move') { pen.move(p, m); draw(); } else { pen.up(); draw(); }
        return;
      }
      if (tool === 'curvaturePen') {
        if (e.type === 'down') { if (curv.down(p, m.alt, tol()) === 'closed') finishCurv(true); else draw(); } else if (e.type === 'move') { curv.move(p); draw(); } else { curv.up(); draw(); }
        return;
      }
      if (tool === 'freeformPen') {
        const o = toolOptionsRef.current;
        if (e.type === 'down') {
          const a = activeRef.current, d = docRef.current, n = a && d ? nodeById(d.layers, a.id) : undefined;
          free = { pts: [p], chain: Promise.resolve(), layer: o.magnetic && n?.kind === 'pixel' ? n.id : null };
          return;
        }
        const f = free;
        if (!f) return;
        if (e.type === 'move') {
          const last = f.pts[f.pts.length - 1];
          if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.5) return;
          const probe = f.layer === null ? null : magneticProbes(last, p, Number(o.width));
          if (!probe) { f.pts.push(p); draw(); return; }
          f.chain = f.chain.then(async () => {
            f.pts.push(magneticPick(probe.cands, await client.call('luminance', f.layer!, probe.probes)));
            if (free === f) draw();
          });
          return;
        }
        free = null;
        draw();
        if (e.type === 'cancel') return;
        void f.chain.then(async () => {
          const closed = f.pts.length > 2 && Math.hypot(e.x - f.pts[0][0], e.y - f.pts[0][1]) <= tol();
          finishSub(await client.call('fitPath', f.pts, Number(o.curveFit), closed), 'Freeform');
        }).catch(err => setError((err as Error).message));
        return;
      }
      // Add / Delete / Convert Point.
      const t = target();
      if (tool === 'addAnchor' || tool === 'deleteAnchor') {
        if (e.type !== 'down' || !t) return;
        const r = penAutoEdit(t.path, e.x, e.y, tol());
        if (r && r.kind === (tool === 'addAnchor' ? 'add' : 'delete')) void commit(t, r.path, r.label);
        return;
      }
      if (e.type === 'down') {
        const hit = t && hitTest(t.path, e.x, e.y, tol(), { handles: true, fill: false });
        conv = t && hit && (hit.kind === 'anchor' || hit.kind === 'handle') ? { t, hit, preview: null } : null;
        return;
      }
      const g = conv;
      if (!g) return;
      if (e.type === 'move') { g.preview = convertDrag(g.t.path, g.hit, p); draw(); return; }
      conv = null;
      draw();
      if (e.type === 'cancel') return;
      if (g.preview) void commit(g.t, g.preview, 'Convert Point');
      else if (g.hit.kind === 'anchor' && hasHandles(g.t.path.subpaths[g.hit.s].points[g.hit.i])) {
        const sub = convertToCorner(g.t.path.subpaths[g.hit.s], g.hit.i);
        void commit(g.t, { ...g.t.path, subpaths: g.t.path.subpaths.map((s, k) => (k === g.hit.s ? sub : s)) }, 'Convert Point');
      }
    };

    penKeysRef.current = e => {
      const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      const draft = tool === 'pen' ? pen.points.length > 0 : tool === 'curvaturePen' ? curv.pts.length > 0 : false;
      if (draft) {
        const d = tool === 'pen' ? pen : curv;
        if (k === 'enter' && !ctrl) { if (tool === 'pen') finishPen(false); else finishCurv(false); }
        else if (k === 'escape') { pen = new PenDraft(); curv = new CurvatureDraft(); }
        else if ((k === 'backspace' || k === 'delete') && !ctrl) d.undo();
        else if (ctrl && k === 'z') { if (e.shiftKey) d.redo(); else d.undo(); }
        else return false;
        e.preventDefault();
        draw();
        return true;
      }
      if (tool !== 'pathSelection' && tool !== 'directSelection') return false;
      if (!selKeys(e, tool === 'directSelection')) return false;
      e.preventDefault();
      return true;
    };
    draw();

    return () => {
      v.onPointer = () => {};
      penKeysRef.current = null;
      redrawRef.current = null;
      cv.removeEventListener('pointermove', onHover);
      cv.removeEventListener('pointerleave', onLeave);
      removeEventListener('keydown', onKey);
      removeEventListener('keyup', onKey);
      cv.style.removeProperty('--hover-cursor');
      // Switching tools finishes an open draft; a document switch drops it.
      if (docRef.current?.docId === docId) {
        if (pen.points.length >= 2) finishSub(pen.subpath(), 'Pen');
        if (curv.pts.length >= 2) finishSub({ closed: false, op: 'combine', points: curv.anchors() }, 'Curvature');
      }
      overlayRef.current?.setPathEdit(null);
      overlayRef.current?.setPreview(null);
      redrawOverlay();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, doc?.docId]);
}
