// Ruler, Count, Color Sampler, Note, Slice, Slice Select, Artboard and Frame tools, plus the
// Measurement Log's Record Measurements. Marks live in the document (DocInfo.annotations) except
// the ruler line, which is kept per tab for this session only.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { client } from '../client.ts';
import type { Active } from '../LayersPanel.tsx';
import { nodeById } from '../layers.ts';
import { hexToRgb } from '../shell/color.ts';
import type { MarksOverlay } from '../shell/marksOverlay.ts';
import type { ToolOptions } from '../shell/OptionsBar.tsx';
import type { SelectionOverlay } from '../shell/SelectionOverlay.ts';
import { marqueeRect, snap45Length } from '../shell/selecttools.ts';
import type { ToolPointerEvent, Viewer } from '../viewer.ts';
import type { DocInfo, LayerNode } from '../worker/types.ts';
import { DEFAULT_SCALE, parsePoints, POINTS_KEY, scaleMeasurement } from './analysis.ts';
import { selectCreated, type Run } from './helpers.ts';
import {
  handlePoint, MAX_SAMPLERS, measureRow, measureSelection, nearestMark, resizeRect, rulerMeasure, sliceAt, sliceHandle, slicesFromGuides,
  straightenAngle, type Annotations, type Bounds, type Handle, type MeasureRow, type Measurement, type Pt,
} from './measure.ts';

export const MEASURE_TOOLS = new Set(['ruler', 'count', 'colorSampler', 'note', 'slice', 'sliceSelect', 'artboard', 'frame']);
const COUNT_COLORS: [number, number, number][] = [[255, 64, 64], [64, 160, 255], [64, 200, 96], [255, 176, 0], [200, 96, 255], [0, 200, 200]];
const AUTHOR_KEY = 'photobaer.noteAuthor';

export interface MeasureCtx {
  viewer: RefObject<Viewer | null>; tool: string; doc: DocInfo | null; docRef: RefObject<DocInfo | null>; active: Active | null;
  overlayRef: RefObject<SelectionOverlay | null>; redrawOverlay: () => void; toolOptions: ToolOptions; toolOptionsRef: RefObject<ToolOptions>;
  run: Run; setError: (m: string | null) => void; openNotes: () => void;
}

const fmt = (v: number) => (Math.round(v * 10) / 10).toString();
const readAuthor = () => { try { return localStorage.getItem(AUTHOR_KEY) ?? ''; } catch { return ''; } };
const artboards = (layers: LayerNode[]) => layers.filter(n => n.artboard).map(n => ({ id: n.id, rect: n.artboard!.rect as Bounds }));

export function useMeasureTools(c: MeasureCtx) {
  const { viewer, tool, doc, docRef, active, overlayRef, redrawOverlay, toolOptions, toolOptionsRef, run, setError } = c;
  const rulers = useRef(new Map<string, [Pt, Pt]>());
  const [ruler, setRuler] = useState<[Pt, Pt] | null>(null);
  const [drag, setDrag] = useState<MarksOverlay['drag']>(null);
  const [selectedNote, setSelectedNote] = useState<number | null>(null);
  const [selectedSlice, setSelectedSlice] = useState<number | null>(null);
  const selectedSliceRef = useRef(selectedSlice);
  selectedSliceRef.current = selectedSlice;
  const [preview, setPreview] = useState<Annotations | null>(null);
  const [author, setAuthor] = useState(readAuthor);
  const [log, setLog] = useState<MeasureRow[]>([]);
  const [points, setPointsState] = useState(() => { try { return parsePoints(localStorage.getItem(POINTS_KEY)); } catch { return parsePoints(null); } });
  const setPoints = (p: (keyof MeasureRow)[]) => {
    setPointsState(p);
    try { localStorage.setItem(POINTS_KEY, JSON.stringify(p)); } catch { /* the choice is only remembered when storage works */ }
  };
  const ctxRef = useRef(c);
  ctxRef.current = c;
  const key = doc?.key ?? '';

  useEffect(() => { setRuler(rulers.current.get(key) ?? null); setSelectedNote(null); setSelectedSlice(null); setPreview(null); }, [key]);

  const ann = preview ?? doc?.annotations ?? null;
  const commit = (a: Annotations, label: string) => run(null, () => client.call('setAnnotations', a, label));
  const tol = () => 8 / (viewer.current?.view.zoom ?? 1);

  // Overlay: the ruler only with its tool, samplers with the eyedropper family, slices with the slice tools.
  useEffect(() => {
    const o = overlayRef.current;
    if (!o) return;
    if (!doc || !ann) { o.setMarks(null); redrawOverlay(); return; }
    const sampling = tool === 'eyedropper' || tool === 'colorSampler';
    o.setMarks({
      ruler: tool === 'ruler' ? ruler : null,
      counts: ann.counts, markerSize: Number(toolOptions.markerSize ?? 3), labelSize: Number(toolOptions.labelSize ?? 12),
      samplers: sampling ? ann.samplers : [],
      notes: ann.notes, selectedNote,
      slices: tool === 'slice' || tool === 'sliceSelect' ? ann.slices : null, selectedSlice,
      drag,
    });
    redrawOverlay();
  }, [doc, ann, tool, ruler, drag, selectedNote, selectedSlice, toolOptions.markerSize, toolOptions.labelSize]);
  useEffect(() => () => { overlayRef.current?.setMarks(null); }, []);

  useEffect(() => {
    const v = viewer.current;
    if (!v || !MEASURE_TOOLS.has(tool)) return;
    let gesture: ((e: ToolPointerEvent) => void) | null = null;
    v.onPointer = e => {
      const d = docRef.current;
      if (!d) return;
      if (e.type === 'down') gesture = start(d, e);
      else gesture?.(e);
      if (e.type === 'up' || e.type === 'cancel') gesture = null;
    };
    return () => { v.onPointer = () => {}; setDrag(null); setPreview(null); };

    // Returns the move/up handler of the gesture this pointer-down starts, or null.
    function start(d: DocInfo, e: ToolPointerEvent): ((e: ToolPointerEvent) => void) | null {
      const a = d.annotations, o = toolOptionsRef.current, p: Pt = [e.x, e.y];
      const boxOf = (from: Pt, to: Pt, ev: ToolPointerEvent, opts = { style: 'normal', ratioW: 1, ratioH: 1, fixedW: 100, fixedH: 100 }): Bounds => {
        const r = marqueeRect(from, to, { constrain: ev.shiftKey, fromCenter: ev.altKey, style: opts.style as 'normal', ratioW: opts.ratioW, ratioH: opts.ratioH, fixedW: opts.fixedW, fixedH: opts.fixedH });
        return [Math.round(r.x), Math.round(r.y), Math.round(r.x + r.w), Math.round(r.y + r.h)];
      };
      switch (tool) {
        case 'ruler': {
          const cur = rulers.current.get(d.key);
          const end = cur ? cur.findIndex(q => Math.hypot(q[0] - e.x, q[1] - e.y) <= tol()) : -1;
          const fixed: Pt = end >= 0 ? cur![1 - end] : p;
          const set = (line: [Pt, Pt] | null) => { if (line) rulers.current.set(d.key, line); else rulers.current.delete(d.key); setRuler(line); };
          set([fixed, end >= 0 ? cur![end] : p]);
          return ev => {
            const q: Pt = ev.shiftKey ? snap45Length(fixed, [ev.x, ev.y]) : [ev.x, ev.y];
            if (ev.type === 'up' && end < 0 && Math.hypot(q[0] - fixed[0], q[1] - fixed[1]) < tol() / 4) { set(null); return; }
            if (ev.type !== 'cancel') set([fixed, q]);
          };
        }
        case 'count': {
          const gi = Math.max(0, Math.min(98, Number(o.group) - 1));
          const counts = a.counts.map(g => ({ ...g, marks: [...g.marks] }));
          while (counts.length <= gi) counts.push({ name: `Group ${counts.length + 1}`, color: COUNT_COLORS[counts.length % COUNT_COLORS.length], visible: true, marks: [] });
          const g = counts[gi];
          if (e.altKey) {
            const i = nearestMark(g.marks, e.x, e.y, tol());
            if (i < 0) return null;
            g.marks.splice(i, 1);
          } else g.marks.push([Math.round(e.x * 10) / 10, Math.round(e.y * 10) / 10]);
          void commit({ ...a, counts }, 'Count');
          return null;
        }
        case 'colorSampler': {
          const i = nearestMark(a.samplers, e.x, e.y, tol());
          if (i >= 0 && e.altKey) { void commit({ ...a, samplers: a.samplers.filter((_, j) => j !== i) }, 'Delete Color Sampler'); return null; }
          if (i < 0) {
            if (e.altKey) return null;
            if (a.samplers.length >= MAX_SAMPLERS) { setError(`A document can have at most ${MAX_SAMPLERS} color samplers.`); return null; }
            if (e.x < 0 || e.y < 0 || e.x >= d.width || e.y >= d.height) return null;
            void commit({ ...a, samplers: [...a.samplers, [Math.floor(e.x), Math.floor(e.y)]] }, 'Color Sampler');
            return null;
          }
          return moveMark(d, a, ev => {
            const s0 = a.samplers[i], q: Pt = [Math.max(0, Math.min(d.width - 1, Math.round(s0[0] + ev.x - e.x))), Math.max(0, Math.min(d.height - 1, Math.round(s0[1] + ev.y - e.y)))];
            return { ...a, samplers: a.samplers.map((s, j) => (j === i ? q : s)) };
          }, 'Move Color Sampler');
        }
        case 'note': {
          const z = viewer.current?.view.zoom ?? 1;
          const hit = [...a.notes].reverse().find(n => e.x >= n.x && e.x <= n.x + 14 / z && e.y >= n.y && e.y <= n.y + 16 / z);
          if (!hit) {
            const id = Math.max(0, ...a.notes.map(n => n.id)) + 1;
            const color = hexToRgb(String(o.noteColor || '#f2c94c')) ?? [242, 201, 76];
            setSelectedNote(id);
            void commit({ ...a, notes: [...a.notes, { id, x: Math.round(e.x), y: Math.round(e.y), author: readAuthor(), color, text: '' }] }, 'New Note');
            ctxRef.current.openNotes();
            return null;
          }
          setSelectedNote(hit.id);
          ctxRef.current.openNotes();
          return moveMark(d, a, ev => ({ ...a, notes: a.notes.map(n => (n.id === hit.id ? { ...n, x: Math.round(hit.x + ev.x - e.x), y: Math.round(hit.y + ev.y - e.y) } : n)) }), 'Move Note');
        }
        case 'slice': {
          return ev => {
            const r = boxOf(p, [ev.x, ev.y], ev, { style: String(o.style), ratioW: Number(o.ratioW), ratioH: Number(o.ratioH), fixedW: Number(o.fixedW), fixedH: Number(o.fixedH) });
            const clamped: Bounds = [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(d.width, r[2]), Math.min(d.height, r[3])];
            if (ev.type === 'move') { setDrag({ rect: clamped, shape: 'rectangle' }); return; }
            setDrag(null);
            if (ev.type === 'cancel' || clamped[2] - clamped[0] < 1 || clamped[3] - clamped[1] < 1) return;
            const id = Math.max(0, ...a.slices.map(s => s.id)) + 1;
            setSelectedSlice(id);
            void commit({ ...a, slices: [...a.slices, { id, name: `${d.name.replace(/\.[^.]+$/, '')}_${String(id).padStart(2, '0')}`, rect: clamped }] }, 'New Slice');
          };
        }
        case 'sliceSelect': {
          const sel = a.slices.find(s => s.id === selectedSliceRef.current);
          const handle: Handle | null = sel ? sliceHandle(sel.rect, e.x, e.y, tol()) : null;
          const target = handle ? sel! : sliceAt(a.slices, e.x, e.y);
          setSelectedSlice(target?.id ?? null);
          if (!target) return null;
          const r0 = target.rect, hp = handle ? handlePoint(r0, handle) : [0, 0];
          return moveMark(d, a, ev => {
            const dx = Math.round(ev.x - e.x), dy = Math.round(ev.y - e.y);
            const rect: Bounds = handle ? resizeRect(r0, handle, Math.round(hp[0] + ev.x - e.x), Math.round(hp[1] + ev.y - e.y)) : [r0[0] + dx, r0[1] + dy, r0[2] + dx, r0[3] + dy];
            return { ...a, slices: a.slices.map(s => (s.id === target.id ? { ...s, rect } : s)) };
          }, handle ? 'Resize Slice' : 'Move Slice');
        }
        case 'artboard': {
          const boards = artboards(d.layers);
          const hit = [...boards].reverse().find(b => e.x >= b.rect[0] && e.x < b.rect[2] && e.y >= b.rect[1] && e.y < b.rect[3]);
          if (hit) {
            const r0 = hit.rect;
            return ev => {
              const dx = Math.round(ev.x - e.x), dy = Math.round(ev.y - e.y);
              const rect: Bounds = [Math.max(0, r0[0] + dx), Math.max(0, r0[1] + dy), 0, 0];
              rect[2] = rect[0] + r0[2] - r0[0]; rect[3] = rect[1] + r0[3] - r0[1];
              if (ev.type === 'move') { setDrag({ rect, shape: 'rectangle' }); return; }
              setDrag(null);
              if (ev.type === 'cancel' || (rect[0] === r0[0] && rect[1] === r0[1])) return;
              const node = d.layers.find(n => n.id === hit.id)!;
              void run(null, () => client.call('editArtboard', hit.id, rect, node.artboard!.background, 'Move Artboard'));
            };
          }
          return ev => {
            let r = boxOf(p, [ev.x, ev.y], ev);
            const z = viewer.current?.view.zoom ?? 1;
            if (Math.max(r[2] - r[0], r[3] - r[1]) * z < 3) r = [Math.round(e.x), Math.round(e.y), Math.round(e.x) + Number(o.width), Math.round(e.y) + Number(o.height)];
            const rect: Bounds = [Math.max(0, r[0]), Math.max(0, r[1]), Math.max(0, r[0]) + r[2] - r[0], Math.max(0, r[1]) + r[3] - r[1]];
            if (ev.type === 'move') { setDrag({ rect, shape: 'rectangle' }); return; }
            setDrag(null);
            if (ev.type === 'cancel' || rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1) return;
            const bg = String(o.background) as 'white' | 'black' | 'transparent';
            void run(null, () => client.call('newArtboardAt', `Artboard ${boards.length + 1}`, rect, { type: bg }), selectCreated);
          };
        }
        case 'frame': {
          const shape = o.shape === 'ellipse' ? 'ellipse' : 'rectangle';
          return ev => {
            const r = boxOf(p, [ev.x, ev.y], ev);
            if (ev.type === 'move') { setDrag({ rect: r, shape }); return; }
            setDrag(null);
            if (ev.type === 'cancel' || r[2] - r[0] < 1 || r[3] - r[1] < 1) return;
            // A placed image or a pixel layer that is not the bottom one becomes the frame content.
            const act = ctxRef.current.active, node = act && nodeById(d.layers, act.id);
            const content = !!node && (node.kind === 'smart' || (node.kind === 'pixel' && d.layers[0]?.id !== node.id));
            void run(null, () => client.call('newFrame', { x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1] }, shape, act?.id ?? 0, content), selectCreated);
          };
        }
      }
      return null;
    }

    // A drag that previews `next` on the overlay and commits it once on release when it changed.
    function moveMark(d: DocInfo, a: Annotations, next: (ev: ToolPointerEvent) => Annotations, label: string) {
      return (ev: ToolPointerEvent) => {
        if (ev.type === 'move') { setPreview(next(ev)); return; }
        setPreview(null);
        if (ev.type === 'cancel' || docRef.current?.key !== d.key) return;
        const n = next(ev);
        if (JSON.stringify(n) !== JSON.stringify(a)) void commit(n, label);
      };
    }
  }, [tool]);

  // Measurement Log > Record Measurements: the ruler line, the counts, else the selection.
  async function record() {
    const d = docRef.current;
    if (!d) return;
    let m: Measurement | null = null;
    const line = rulers.current.get(d.key);
    if (tool === 'ruler' && line) {
      const r = rulerMeasure(...line);
      m = { source: 'Ruler', length: r.length, angle: r.angle, width: Math.abs(r.w), height: Math.abs(r.h) };
    } else if (tool === 'count' && d.annotations.counts.some(g => g.marks.length)) {
      m = { source: 'Count', count: d.annotations.counts.reduce((n, g) => n + g.marks.length, 0) };
    } else if (d.selection) {
      const r = await client.call('selectionMask', 0);
      const mask = r.data ? new Uint8Array(r.data) : new Uint8Array(r.w * r.h).fill(255);
      const s = measureSelection(mask, r.w, r.h);
      m = { source: 'Selection', area: s.area, perimeter: s.perimeter, width: s.bounds[2] - s.bounds[0], height: s.bounds[3] - s.bounds[1] };
    }
    if (!m) { setError('Draw a ruler line, place counts or make a selection first.'); return; }
    const row = scaleMeasurement(m, d.annotations.scale ?? DEFAULT_SCALE);
    setLog(rows => [...rows, measureRow(rows.length + 1, d.name, row)]);
  }

  const a = doc?.annotations;
  const button = (label: string, onClick: () => void, off = false) => <button type="button" disabled={off} onClick={onClick}>{label}</button>;
  let bar: ReactNode = null;
  if (doc && a) {
    if (tool === 'ruler') {
      const r = ruler && rulerMeasure(...ruler);
      bar = <span className="measure-bar">
        <span>X: {r ? fmt(r.x) : '–'} Y: {r ? fmt(r.y) : '–'} W: {r ? fmt(r.w) : '–'} H: {r ? fmt(-r.h) : '–'} A: {r ? `${fmt(r.angle)}°` : '–'} L1: {r ? fmt(r.length) : '–'}</span>
        {button('Straighten Layer', () => {
          if (!r || !active) return;
          const deg = straightenAngle(r.angle);
          if (Math.abs(deg) < 0.01) { setError('The measured line is already straight.'); return; }
          rulers.current.delete(key); setRuler(null);
          void run(null, () => client.call('straightenLayer', active.id, deg));
        }, !r || !active)}
        {button('Clear', () => { rulers.current.delete(key); setRuler(null); }, !r)}
      </span>;
    } else if (tool === 'count') {
      const gi = Math.max(0, Number(toolOptions.group) - 1), g = a.counts[gi];
      bar = <span className="measure-bar">
        <span>Count: {g?.marks.length ?? 0}</span>
        <label><input type="checkbox" checked={g?.visible ?? true} disabled={!g} onChange={ev => void commit({ ...a, counts: a.counts.map((x, i) => (i === gi ? { ...x, visible: ev.currentTarget.checked } : x)) }, 'Count Group Visibility')} /> Visible</label>
        {button('Clear', () => void commit({ ...a, counts: a.counts.map((x, i) => (i === gi ? { ...x, marks: [] } : x)) }, 'Clear Count'), !g?.marks.length)}
      </span>;
    } else if (tool === 'colorSampler') {
      bar = <span className="measure-bar">
        <span>{a.samplers.length} of {MAX_SAMPLERS}</span>
        {button('Clear All', () => void commit({ ...a, samplers: [] }, 'Clear Color Samplers'), !a.samplers.length)}
      </span>;
    } else if (tool === 'note') {
      bar = <span className="measure-bar">
        <label>Author <input type="text" value={author} maxLength={1024} onChange={ev => {
          const v = ev.currentTarget.value;
          setAuthor(v);
          try { localStorage.setItem(AUTHOR_KEY, v); } catch { /* the author is only remembered when storage works */ }
        }} /></label>
        {button('Clear All', () => void commit({ ...a, notes: [] }, 'Delete All Notes'), !a.notes.length)}
      </span>;
    } else if (tool === 'slice') {
      bar = <span className="measure-bar">
        <span>{a.slices.length} slices</span>
        {button('Slices From Guides', () => {
          const rects = slicesFromGuides(doc.guides, doc.width, doc.height);
          if (rects.length < 2) { setError('Add guides inside the canvas first.'); return; }
          const stem = doc.name.replace(/\.[^.]+$/, '');
          void commit({ ...a, slices: rects.map((rect, i) => ({ id: i + 1, name: `${stem}_${String(i + 1).padStart(2, '0')}`, rect })) }, 'Slices From Guides');
        })}
      </span>;
    } else if (tool === 'sliceSelect') {
      const s = a.slices.find(x => x.id === selectedSlice);
      bar = <span className="measure-bar">
        {s ? <label>Name <input key={s.id} type="text" defaultValue={s.name} maxLength={1024} onBlur={ev => {
          const name = ev.currentTarget.value.trim();
          if (name && name !== s.name) void commit({ ...a, slices: a.slices.map(x => (x.id === s.id ? { ...x, name } : x)) }, 'Slice Options');
        }} /></label> : <span>No slice selected</span>}
        {s && <span>{fmt(s.rect[2] - s.rect[0])} × {fmt(s.rect[3] - s.rect[1])}</span>}
        {button('Delete Slice', () => { setSelectedSlice(null); void commit({ ...a, slices: a.slices.filter(x => x.id !== selectedSlice) }, 'Delete Slice'); }, !s)}
      </span>;
    }
  }

  const rulerLength = ruler ? rulerMeasure(...ruler).length : null;
  return { bar, selectedNote, setSelectedNote, log, setLog, record, commit, points, setPoints, rulerLength };
}
