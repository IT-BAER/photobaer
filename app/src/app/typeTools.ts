import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { client } from '../client.ts';
import type { Active } from '../LayersPanel.tsx';
import { nodeById } from '../layers.ts';
import type { TextJson } from '../psd/text.ts';
import { hexToRgb, type Rgb } from '../shell/color.ts';
import type { ToolOptions } from '../shell/OptionsBar.tsx';
import type { SelectionOverlay } from '../shell/SelectionOverlay.ts';
import {
  boxDrag, caretX, indexAt, layerName, lineEndAt, lineHome, lineMove, lineOf, newText, nextBoundary, nextWord, prevBoundary, prevWord,
  selectionRects, TypeSession, type SpanAttrs, type TextLayout,
} from '../shell/typesession.ts';
import type { ToolPointerEvent, Viewer } from '../viewer.ts';
import type { DocInfo } from '../worker/types.ts';
import type { SelectAfter } from './helpers.ts';

export const TYPE_TOOLS = ['horizontalType', 'verticalType', 'horizontalTypeMask', 'verticalTypeMask'];
const BLINK_MS = 500;
const DOUBLE_MS = 500;
const RUN_KEYS: Record<string, string> = { family: 'family', style: 'style', size: 'size', color: 'color' };

type Mat = number[];
type XY = [number, number];
const apply = (m: Mat, [x, y]: XY): XY => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function invert(m: Mat, [x, y]: XY): XY {
  const det = m[0] * m[3] - m[1] * m[2] || 1, dx = x - m[4], dy = y - m[5];
  return [(m[3] * dx - m[2] * dy) / det, (-m[1] * dx + m[0] * dy) / det];
}

// The host's controls: Commit/Cancel buttons and the worker's auto-commit notice.
export interface TypeApi {
  editing: () => boolean; commit: () => void; cancel: () => void; ended: (doc: DocInfo) => void;
  // The open session for panels and the Type menu: its model and selection, and edits on it.
  session: () => { text: TextJson; range: [number, number] } | null;
  applyRun: (a: SpanAttrs) => void; applyParagraph: (a: Record<string, unknown>) => void;
  replace: (f: (t: TextJson) => TextJson) => void; insert: (str: string) => void;
}

export interface TypeToolsCtx {
  viewer: RefObject<Viewer | null>; tool: string; doc: DocInfo | null; docRef: RefObject<DocInfo | null>; activeRef: RefObject<Active | null>;
  overlayRef: RefObject<SelectionOverlay | null>; redrawOverlay: () => void; toolOptions: ToolOptions; toolOptionsRef: RefObject<ToolOptions>;
  fgRef: RefObject<Rgb>; show: (d: DocInfo | null, selectAfter?: SelectAfter) => void; setError: Dispatch<SetStateAction<string | null>>;
  typeKeysRef: RefObject<((e: KeyboardEvent) => boolean) | null>; typeRef: RefObject<TypeApi | null>; setEditing: (b: boolean) => void;
  // Called with a new key whenever the session or its selection changes (panels re-read it).
  setTypeSel: (key: string) => void;
}

interface Edit {
  id: number; s: TypeSession; layout: TextLayout; vertical: boolean; mask: boolean; locked: boolean;
}

// Type tools and edit session (docs/M4.md section 10). The session model lives here; every change
// is sent to the worker (typeUpdate), which renders and answers with the new layout.
export function useTypeTools(c: TypeToolsCtx) {
  const { viewer, tool, doc, docRef, activeRef, overlayRef, redrawOverlay, toolOptions, toolOptionsRef, fgRef, show, setError, typeKeysRef, typeRef, setEditing, setTypeSel } = c;
  const optionsRef = useRef<{ tool: string; o: ToolOptions } | null>(null);
  const applyOptionsRef = useRef<((prev: ToolOptions, next: ToolOptions) => void) | null>(null);

  useEffect(() => {
    const v = viewer.current;
    if (!v || !TYPE_TOOLS.includes(tool)) return;
    const docId = docRef.current?.docId;
    const mask = tool.endsWith('Mask'), vertical = tool.startsWith('vertical');
    let cur: Edit | null = null;
    let caretOn = true;
    let flushing: Promise<void> = Promise.resolve();
    let dirty = false;
    type Drag =
      | { kind: 'box'; start: XY; cur: XY }
      | { kind: 'select' }
      | { kind: 'move'; start: XY; t0: Mat }
      | { kind: 'resize'; handle: number; box0: number[] };
    let drag: Drag | null = null;
    let lastDown = { t: -Infinity, x: 0, y: 0 };

    const setCur = (e: Edit | null) => { cur = e; setEditing(!!e); };
    const tol = () => 4 / v.view.zoom;

    // ---- overlay ----
    const lineQuad = (l: TextLayout['lines'][number], from: number, to: number, vert: boolean): [number, number][] => (vert
      ? [[l.x - (l.ascent + l.descent) / 2, from], [l.x + (l.ascent + l.descent) / 2, from], [l.x + (l.ascent + l.descent) / 2, to], [l.x - (l.ascent + l.descent) / 2, to]]
      : [[from, l.y - l.ascent], [to, l.y - l.ascent], [to, l.y + l.descent], [from, l.y + l.descent]]);
    const textBox = (t: TextJson, layout: TextLayout, vert: boolean): number[] => {
      if (t.shape?.type === 'paragraph') return t.shape.box;
      let l = Infinity, tp = Infinity, r = -Infinity, b = -Infinity;
      for (const n of layout.lines) {
        const q = lineQuad(n, vert ? n.y : n.x, vert ? n.y + n.width : n.x + n.width, vert);
        for (const [x, y] of q) { l = Math.min(l, x); tp = Math.min(tp, y); r = Math.max(r, x); b = Math.max(b, y); }
      }
      return l === Infinity ? [0, 0, 0, 0] : [l, tp, r, b];
    };
    const corners = (b: number[]): XY[] => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
    let selKey = '';
    const draw = () => {
      const key = cur ? `${cur.id}:${cur.s.range}:${cur.s.steps}` : '';
      if (key !== selKey) { selKey = key; setTypeSel(key); }
      const o = overlayRef.current;
      if (!o) return;
      if (!cur) { o.setTypeEdit(null); redrawOverlay(); return; }
      const { s, layout } = cur, m = s.text.transform as Mat, text = s.value, vert = cur.vertical;
      const [a, b] = s.range;
      const quads = selectionRects(layout, a, b, vert).map(r => lineQuad(layout.lines[r.line], r.from, r.to, vert).map(p => apply(m, p)));
      const line = layout.lines[lineOf(layout, s.caret)];
      let caret: [number, number, number, number] | null = null;
      if (line && a === b) {
        const x = caretX(layout, text, s.caret, vert);
        const [p, q] = lineQuad(line, x, x, vert).filter((_, i) => i === 0 || i === 3);
        const [p1, q1] = [apply(m, p), apply(m, q)];
        caret = [p1[0], p1[1], q1[0], q1[1]];
      }
      const para = s.text.shape?.type === 'paragraph';
      o.setTypeEdit({ quads, caret, caretOn, frame: para ? corners(s.text.shape.box).map(p => apply(m, p)) : null, handles: para });
      redrawOverlay();
    };
    const blink = setInterval(() => { if (cur) { caretOn = !caretOn; draw(); } }, BLINK_MS);
    const wake = () => { caretOn = true; };

    // ---- worker sync ----
    const flush = (e: Edit) => {
      dirty = true;
      flushing = flushing.then(async () => {
        // A session the worker already committed (another op ran first) takes no more updates.
        if (!dirty || cur !== e) return;
        dirty = false;
        try {
          const r = await client.call('typeUpdate', e.s.text, layerName(e.s.value), e.s.changed);
          e.layout = JSON.parse(r.layout);
          show(r.doc);
        } catch (err) { if (cur === e) setError((err as Error).message); }
        draw();
      });
    };
    const changed = () => { wake(); draw(); if (cur) flush(cur); };

    const finish = async (how: 'typeCommit' | 'typeCancel') => {
      const e = cur;
      if (!e) return;
      setCur(null);
      draw();
      await flushing;
      try { show(await client.call(how)); } catch (err) { setError((err as Error).message); }
    };

    const begin = async (p: { id?: number; text?: TextJson }, caret: (e: Edit) => number) => {
      const r = await client.call('typeBegin', { ...p, mask, above: activeRef.current?.id ?? 0 });
      const d = r.doc, n = nodeById(d.layers, r.id);
      show(d, () => ({ id: r.id, target: 'pixels' }));
      if (!n?.text) return;
      const layout = JSON.parse(r.layout) as TextLayout;
      const e: Edit = { id: r.id, s: new TypeSession(n.text), layout, vertical: n.text.orientation === 'vertical', mask, locked: n.locks.position };
      e.s.move(caret(e), false);
      setCur(e);
      wake();
      draw();
    };

    // New text at the click (point) or in the dragged box (paragraph); refused when the font is missing.
    const create = async (a: XY, b: XY) => {
      const o = toolOptionsRef.current, family = String(o.family), style = String(o.style);
      const missing = await client.call('fontMissing', [[family, style]]);
      if (missing.length) { setError(`The font ${family} ${style} is not available.`); return; }
      const para = boxDrag(b[0] - a[0], b[1] - a[1]);
      const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
      const shape = para ? { type: 'paragraph', box: [0, 0, Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])] } : { type: 'point' };
      const color = hexToRgb(String(o.color)) ?? fgRef.current;
      const t = newText({
        family, style, size: Number(o.size), color, alignment: String(o.alignment) as 'left' | 'center' | 'right',
        orientation: vertical ? 'vertical' : 'horizontal',
      }, shape, para ? [x0, y0] : a);
      await begin({ text: t }, () => 0);
    };

    // ---- pointer ----
    const handleAt = (e: Edit, p: XY) => {
      if (e.s.text.shape?.type !== 'paragraph') return -1;
      const m = e.s.text.transform as Mat, cs = corners(e.s.text.shape.box);
      const pts = [...cs, ...cs.map((q, i) => { const r = cs[(i + 1) % 4]; return [(q[0] + r[0]) / 2, (q[1] + r[1]) / 2] as XY; })].map(q => apply(m, q));
      return pts.findIndex(q => Math.hypot(q[0] - p[0], q[1] - p[1]) <= tol() * 2);
    };
    const inside = (e: Edit, p: XY) => {
      const [x, y] = invert(e.s.text.transform as Mat, p), b = textBox(e.s.text, e.layout, e.vertical), t = tol();
      return x >= b[0] - t && x <= b[2] + t && y >= b[1] - t && y <= b[3] + t;
    };
    const indexFor = (e: Edit, p: XY) => { const q = invert(e.s.text.transform as Mat, p); return indexAt(e.layout, e.s.value, q[0], q[1], e.vertical); };

    // Events run in order: a down awaits the worker (hit test, commit) before its move/up are handled.
    // `starting`: from a press until its release is handled; keys typed meanwhile wait for the new session.
    let events = Promise.resolve(), starting = false;
    v.onPointer = ev => {
      if (ev.type === 'down') starting = true;
      events = events.then(() => pointer(ev)).catch(err => setError((err as Error).message))
        .finally(() => { if (ev.type === 'up' || ev.type === 'cancel') starting = false; });
    };
    const pointer = async (ev: ToolPointerEvent) => {
      await flushing;
      const p: XY = [ev.x, ev.y], ctrl = ev.ctrlKey || ev.metaKey;
      if (ev.type === 'down') {
        const dbl = ev.timeStamp - lastDown.t < DOUBLE_MS && Math.hypot(ev.x - lastDown.x, ev.y - lastDown.y) <= tol();
        lastDown = { t: ev.timeStamp, x: ev.x, y: ev.y };
        const e = cur;
        if (e) {
          const h = handleAt(e, p);
          if (ctrl || h >= 0) {
            if (e.locked) return;
            drag = h >= 0 && !ctrl ? { kind: 'resize', handle: h, box0: [...e.s.text.shape.box] } : { kind: 'move', start: p, t0: [...e.s.text.transform] };
            return;
          }
          if (inside(e, p)) {
            if (dbl) e.s.selectAll(); else e.s.move(indexFor(e, p), ev.shiftKey);
            drag = { kind: 'select' };
            wake();
            draw();
            return;
          }
          await finish('typeCommit');
        }
        const hit = await client.call('typeHit', ev.x, ev.y);
        if (hit !== null && !mask) {
          await begin({ id: hit }, ed => indexFor(ed, p));
          drag = cur ? { kind: 'select' } : null;
          return;
        }
        drag = { kind: 'box', start: p, cur: p };
        return;
      }
      const g = drag, e = cur;
      if (!g) return;
      if (g.kind === 'box') {
        g.cur = p;
        const [a, b] = [g.start, p];
        if (ev.type === 'move') {
          overlayRef.current?.setPreview(boxDrag(b[0] - a[0], b[1] - a[1]) ? { kind: 'rect', x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) } : null);
          redrawOverlay();
          return;
        }
        drag = null;
        overlayRef.current?.setPreview(null);
        redrawOverlay();
        if (ev.type === 'up') await create(a, b);
        return;
      }
      if (!e) { drag = null; return; }
      if (g.kind === 'select') {
        if (ev.type === 'move') { e.s.move(indexFor(e, p), true); wake(); draw(); } else drag = null;
        return;
      }
      if (g.kind === 'move') {
        let dx = p[0] - g.start[0], dy = p[1] - g.start[1];
        if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        const t = ev.type === 'cancel' ? g.t0 : [g.t0[0], g.t0[1], g.t0[2], g.t0[3], g.t0[4] + dx, g.t0[5] + dy];
        e.s.text = { ...e.s.text, transform: t };
        if (ev.type !== 'move') drag = null;
        changed();
        return;
      }
      // Resize: handles clockwise from the top-left corner, then edge midpoints (top, right, bottom, left).
      const q = invert(e.s.text.transform as Mat, p), b = [...g.box0];
      const side = [[0, 1], [2, 1], [2, 3], [0, 3], [-1, 1], [2, -1], [-1, 3], [0, -1]][g.handle];
      if (side[0] >= 0) b[side[0]] = q[0];
      if (side[1] >= 0) b[side[1]] = q[1];
      const box = [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
      if (box[2] - box[0] < 1) box[2] = box[0] + 1;
      if (box[3] - box[1] < 1) box[3] = box[1] + 1;
      e.s.text = { ...e.s.text, shape: { type: 'paragraph', box: ev.type === 'cancel' ? g.box0 : box } };
      if (ev.type !== 'move') drag = null;
      changed();
    };

    // ---- keys (checked before the app's shortcuts while a session is open) ----
    // A key is claimed at once (preventDefault) and run in the event queue; steps that read the
    // layout first wait for the pending update, so Up/Down/Home/End never use a stale one.
    const keyAction = (e: Edit, ev: KeyboardEvent): (() => void | Promise<void>) | null => {
      const ctrl = ev.ctrlKey || ev.metaKey, k = ev.key, s = e.s, now = ev.timeStamp;
      const altGr = ev.ctrlKey && ev.altKey;
      const edit = (f: () => void) => () => { f(); changed(); };
      const nav = (to: () => number) => () => { s.move(to(), ev.shiftKey); wake(); draw(); };
      const laid = (f: () => void) => async () => { await flushing; f(); };
      const collapse = (dir: -1 | 1) => { const [a, b] = s.range; return a !== b && !ev.shiftKey ? (dir < 0 ? a : b) : null; };
      if (k === 'Escape' || (k === 'Enter' && (ctrl || ev.code === 'NumpadEnter'))) return () => finish('typeCommit');
      if (k === 'Enter') return edit(() => s.insert('\n', now));
      if (k === 'Tab' && !ctrl) return edit(() => s.insert('\t', now));
      if (k === 'Backspace' && !ctrl) return edit(() => s.backspace(now));
      if (k === 'Delete' && !ctrl) return edit(() => s.deleteForward(now));
      if (k === 'ArrowLeft') return nav(() => collapse(-1) ?? (ev.altKey ? prevWord(s.value, s.caret) : prevBoundary(s.value, s.caret)));
      if (k === 'ArrowRight') return nav(() => collapse(1) ?? (ev.altKey ? nextWord(s.value, s.caret) : nextBoundary(s.value, s.caret)));
      if (k === 'ArrowUp' || k === 'ArrowDown') {
        return laid(() => {
          const r = lineMove(e.layout, s.value, s.caret, k === 'ArrowUp' ? -1 : 1, s.goal, e.vertical);
          s.move(r.index, ev.shiftKey);
          s.goal = r.goal;
          wake();
          draw();
        });
      }
      if (k === 'Home') return laid(nav(() => lineHome(e.layout, s.caret)));
      if (k === 'End') return laid(nav(() => lineEndAt(e.layout, s.value, s.caret)));
      if (ctrl && !ev.altKey) {
        const key = k.toLowerCase();
        if (key === 'a') return () => { s.selectAll(); wake(); draw(); };
        if (key === 'z' || key === 'y') return edit(() => { if (key === 'y' || ev.shiftKey) s.redo(); else s.undo(); });
        if ((key === 'c' || key === 'x') && s.range[0] !== s.range[1]) {
          return () => {
            const [a, b] = s.range;
            void navigator.clipboard?.writeText(s.value.slice(a, b));
            if (key === 'x') edit(() => s.insert('', now))();
          };
        }
        if (key === 'v') {
          return async () => {
            const txt = await navigator.clipboard?.readText().catch(() => '');
            if (cur === e && txt) edit(() => s.insert(txt.replace(/\r\n?/g, '\n'), performance.now()))();
          };
        }
        return null;
      }
      if ([...k].length === 1 && (!ctrl || altGr)) return edit(() => s.insert(k, now));
      return null;
    };
    typeKeysRef.current = ev => {
      if (cur ? !keyAction(cur, ev) : !starting || ev.ctrlKey || ev.metaKey) return false;
      ev.preventDefault();
      events = events.then(async () => {
        const e = cur, act = e && keyAction(e, ev);
        if (act) await act();
        // The session ended before the key ran: hand it back to the app shortcuts.
        else if (!e) dispatchEvent(new KeyboardEvent('keydown', { key: ev.key, code: ev.code, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, altKey: ev.altKey, metaKey: ev.metaKey, repeat: ev.repeat }));
      }).catch(err => setError((err as Error).message));
      return true;
    };

    // ---- option changes: the session selection or caret paragraph, else every run of the selected type layer ----
    applyOptionsRef.current = (prev, next) => {
      const changedKeys = Object.keys(next).filter(key => next[key] !== prev[key]);
      const run: Record<string, unknown> = {}, para: Record<string, unknown> = {};
      for (const key of changedKeys) {
        if (key === 'alignment') para.alignment = next[key];
        else if (key === 'color') run.color = hexToRgb(String(next.color)) ?? fgRef.current;
        else if (key === 'family') Object.assign(run, { family: next.family, postscript_name: '' });
        else if (key in RUN_KEYS) run[RUN_KEYS[key]] = next[key];
      }
      if (!Object.keys(run).length && !Object.keys(para).length) return;
      const e = cur;
      if (e) {
        if (Object.keys(run).length) e.s.applyRun(run, performance.now());
        if (Object.keys(para).length) e.s.applyParagraph(para, performance.now());
        changed();
        return;
      }
      const d = docRef.current, a = activeRef.current, n = a && d ? nodeById(d.layers, a.id) : null;
      if (!n || n.kind !== 'text' || !n.text) return;
      const t = n.text;
      const text = { ...t, runs: t.runs.map((r: object) => ({ ...r, ...run })), paragraphs: t.paragraphs.map((p: object) => ({ ...p, ...para })) };
      void client.call('typeSet', n.id, text, Object.keys(run).length ? 'Character Formatting' : 'Paragraph Formatting')
        .then(dd => show(dd), err => setError((err as Error).message));
    };

    typeRef.current = {
      editing: () => !!cur,
      commit: () => void finish('typeCommit'),
      cancel: () => void finish('typeCancel'),
      ended: d => { if (cur) { setCur(null); show(d); draw(); } },
      session: () => cur && { text: cur.s.text, range: cur.s.range },
      applyRun: a => { if (cur) { cur.s.applyRun(a, performance.now()); changed(); } },
      applyParagraph: a => { if (cur) { cur.s.applyParagraph(a, performance.now()); changed(); } },
      replace: f => { if (cur) { cur.s.replace(f(cur.s.text)); changed(); } },
      insert: str => { if (cur) { cur.s.insert(str, performance.now()); changed(); } },
    };
    return () => {
      clearInterval(blink);
      v.onPointer = () => {};
      typeKeysRef.current = null;
      typeRef.current = null;
      applyOptionsRef.current = null;
      // Switching tools commits an open session; a document switch drops it.
      if (cur && docRef.current?.docId === docId) void finish('typeCommit');
      else setCur(null);
      overlayRef.current?.setTypeEdit(null);
      overlayRef.current?.setPreview(null);
      redrawOverlay();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, doc?.docId]);

  // Selection bounds follow the active layer and document changes when no session is open.
  useEffect(() => {
    if (!TYPE_TOOLS.includes(tool) || typeRef.current?.editing()) return;
    const n = doc && activeRef.current ? nodeById(doc.layers, activeRef.current.id) : null;
    if (!n || n.kind !== 'text') { overlayRef.current?.setTypeEdit(null); redrawOverlay(); return; }
    void client.call('typeLayout', n.id).then(l => {
      if (typeRef.current?.editing() || !n.text) return;
      const layout = JSON.parse(l) as TextLayout, vert = n.text.orientation === 'vertical', t = n.text;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const ln of layout.lines) {
        const [a, b] = vert ? [ln.x - (ln.ascent + ln.descent) / 2, ln.y] : [ln.x, ln.y - ln.ascent];
        const [cc, dd] = vert ? [ln.x + (ln.ascent + ln.descent) / 2, ln.y + ln.width] : [ln.x + ln.width, ln.y + ln.descent];
        x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, cc); y1 = Math.max(y1, dd);
      }
      const box = t.shape?.type === 'paragraph' ? t.shape.box : [x0, y0, x1, y1];
      if (!Number.isFinite(box[0])) return;
      const frame = ([[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]] as XY[]).map(p => apply(t.transform, p));
      overlayRef.current?.setTypeEdit({ quads: [], caret: null, caretOn: false, frame, handles: false });
      redrawOverlay();
    }, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, doc]);

  // Options bar edits reach the session or the selected layer; a tool switch only resets the baseline.
  useEffect(() => {
    const prev = optionsRef.current;
    optionsRef.current = { tool, o: toolOptions };
    if (prev && prev.tool === tool && prev.o !== toolOptions) applyOptionsRef.current?.(prev.o, toolOptions);
  }, [tool, toolOptions]);
}
