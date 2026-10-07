// Filter > Vanishing Point (docs/M5.md section 7): perspective planes drawn over a layer proxy in an
// SVG overlay (document px); clone dabs live in plane UV and the worker renders them through the engine.
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { client } from '../client.ts';
import { i18n } from '../i18n/index.ts';
import { apply, homography, invert, type Mat3, type Pt, type Quad } from '../transform/matrix.ts';
import { convex } from '../transform/pwarp.ts';
import type { DocInfo, VanishingDab, VanishingPlane, VanishingState } from '../worker/types.ts';
import { NumberInput } from '../shell/NumberInput.tsx';

export type VanishingPointRequest = { id: number; filterId: number | null; width: number; height: number };
export interface VanishingPointDialogHandle { open(r: VanishingPointRequest): void }

type Tool = 'create' | 'edit' | 'stamp' | 'hand';
type Edge = 'top' | 'right' | 'bottom' | 'left';
type Snap = { planes: VanishingPlane[]; stamps: VanishingDab[] };
type Drag = { kind: 'corner' | 'body'; plane: string; corner: number; at: Pt; before: Snap } | { kind: 'stamp'; before: Snap; plane: string; local: Pt; source: Pt; radius: number; last: Pt }
  | { kind: 'pan'; x: number; y: number };

const TOOLS: [Tool, MessageDescriptor][] = [['create', msg`Create Plane`], ['edit', msg`Edit Plane`], ['stamp', msg({ message: 'Stamp', context: 'Vanishing Point tool' })], ['hand', msg`Hand`]];
const HINTS: Record<Tool, MessageDescriptor> = {
  create: msg`Click four corners to define a perspective plane.`,
  edit: msg`Drag a corner to adjust the plane, or drag inside a plane to move it.`,
  stamp: msg`Alt-click to set the clone source, then paint inside a plane.`,
  hand: msg`Drag to scroll the preview.`,
};
const EDGES: Record<Edge, MessageDescriptor> = { top: msg`Top`, right: msg`Right`, bottom: msg`Bottom`, left: msg`Left` };
const UNIT: Quad = [[0, 0], [1, 0], [1, 1], [0, 1]];
const MAX_SIDE = 2048, DEPTH = 40;

const maps = (p: VanishingPlane): { h: Mat3; inv: Mat3 | null } => {
  const h = homography(UNIT, p.corners as Quad);
  return { h, inv: invert(h) };
};
const valid = (p: VanishingPlane) => p.corners.length === 4 && p.corners.flat().every(Number.isFinite) && convex(p.corners);
const uvOf = (p: VanishingPlane, x: number, y: number): Pt | null => { const { inv } = maps(p); return inv ? apply(inv, x, y) : null; };
const inside = (uv: Pt | null): uv is Pt => !!uv && uv.every(v => v >= 0 && v <= 1);
// The first plane whose inverse homography maps (x, y) into the unit square.
const hitPlane = (planes: VanishingPlane[], x: number, y: number) => planes.find(p => valid(p) && inside(uvOf(p, x, y)));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function VanishingPointDialog({ ref, show, setError }: { ref: Ref<VanishingPointDialogHandle>; show: (d: DocInfo | null) => void; setError: (msg: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [req, setReq] = useState<VanishingPointRequest | null>(null);
  const [tool, setTool] = useState<Tool>('create');
  const [snap, setSnapState] = useState<Snap>({ planes: [], stamps: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Pt[]>([]);
  const [pointer, setPointer] = useState<Pt | null>(null);
  const [source, setSource] = useState<Pt | null>(null);
  const [dragging, setDragging] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [preview, setPreview] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [grid, setGrid] = useState(10);
  const [brush, setBrush] = useState({ diameter: 50, hardness: 75, opacity: 100 });
  const [edge, setEdge] = useState<Edge>('right');
  const [angle, setAngle] = useState(90);
  const [hint, setHint] = useState<string | null>(null);
  // Mutable state the handlers read: the proxy images, the drag, dialog history and the preview pump.
  const st = useRef({
    original: null as ImageBitmap | null, painted: null as ImageBitmap | null, w: 0, h: 0, drag: null as Drag | null,
    undo: [] as Snap[], redo: [] as Snap[], snap: { planes: [], stamps: [] } as Snap, busy: false, want: false, closing: false, next: 1, preview: true,
  });
  st.current.preview = preview;

  const setSnap = (s: Snap) => { st.current.snap = s; setSnapState(s); requestPreview(); };
  const remember = (before: Snap) => {
    const s = st.current;
    s.undo = [...s.undo.slice(1 - DEPTH), before];
    s.redo = [];
  };
  const change = (next: Snap) => { remember(st.current.snap); setSnap(next); };
  const historyStep = (dir: 'undo' | 'redo') => {
    const s = st.current, [from, to] = dir === 'undo' ? [s.undo, s.redo] : [s.redo, s.undo];
    const prev = from.pop();
    if (!prev) return;
    to.push(s.snap);
    setSnap(prev);
  };

  const state = (): VanishingState => ({ ...st.current.snap, gridSize: grid, brushHardness: brush.hardness, brushOpacity: brush.opacity });

  async function paint(data: ArrayBuffer) {
    const s = st.current;
    s.painted?.close();
    s.painted = await createImageBitmap(new ImageData(new Uint8ClampedArray(data), s.w, s.h));
    draw();
  }
  // One preview render at a time; a change meanwhile renders again with the latest dabs.
  function requestPreview() {
    const s = st.current;
    s.want = true;
    if (s.busy || !s.original) return;
    s.busy = true;
    s.want = false;
    client.call('vpPreview', state()).then(d => paint(d as ArrayBuffer)).catch(e => setError((e as Error).message))
      .finally(() => { s.busy = false; if (s.want) requestPreview(); });
  }

  function draw() {
    const s = st.current, c = canvas.current, g = c?.getContext('2d');
    const img = s.preview ? s.painted ?? s.original : s.original;
    if (!c || !g || !img) return;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0);
  }

  useImperativeHandle(ref, () => ({
    open(r) {
      const s = st.current;
      Object.assign(s, { drag: null, undo: [], redo: [], busy: false, want: false, closing: false });
      setReq(r);
      setTool('create');
      setDraft([]);
      setSource(null);
      setHint(null);
      setDragging(false);
      dialog.current?.showModal();
      client.call('vpBegin', r.id, MAX_SIDE, r.filterId)
        .then(async v => {
          const o = v as { data: ArrayBuffer; w: number; h: number; scale: number; planes: VanishingPlane[]; state: VanishingState | null };
          Object.assign(s, { w: o.w, h: o.h });
          const c = canvas.current;
          if (c) { c.width = o.w; c.height = o.h; }
          s.original?.close();
          s.painted?.close();
          s.painted = null;
          s.original = await createImageBitmap(new ImageData(new Uint8ClampedArray(o.data), o.w, o.h));
          const planes = o.state?.planes ?? o.planes;
          s.next = planes.length + 1;
          if (o.state) { setGrid(o.state.gridSize); setBrush(b => ({ ...b, hardness: o.state!.brushHardness, opacity: o.state!.brushOpacity })); }
          setSnap({ planes, stamps: o.state?.stamps ?? [] });
          setSelected(planes[0]?.id ?? null);
          if (planes.length) setTool('edit');
          const b = stage.current;
          setZoom(b ? clamp(Math.min(b.clientWidth / r.width, b.clientHeight / r.height), 0.25, 4) : 1);
          draw();
        })
        .catch(e => { setError((e as Error).message); dialog.current?.close(); });
    },
  }), []);

  const toDoc = (e: { clientX: number; clientY: number }): Pt => {
    const b = canvas.current!.getBoundingClientRect();
    return [(e.clientX - b.left) / zoom, (e.clientY - b.top) / zoom];
  };
  const newId = () => {
    const used = new Set(st.current.snap.planes.map(p => p.id));
    while (used.has(`plane-${st.current.next}`)) st.current.next++;
    return `plane-${st.current.next++}`;
  };

  // Dabs every radius / 4 along the UV path from the last dab to `to`, at most 200 per move.
  function dabsTo(d: Extract<Drag, { kind: 'stamp' }>, to: Pt, first: boolean): VanishingDab[] {
    const out: VanishingDab[] = [], step = d.radius * 0.25;
    const len = Math.hypot(to[0] - d.last[0], to[1] - d.last[1]);
    const n = first ? 1 : Math.min(200, Math.floor(len / step));
    for (let k = 1; k <= n; k++) {
      const t: Pt = first ? to : [d.last[0] + ((to[0] - d.last[0]) * k * step) / len, d.last[1] + ((to[1] - d.last[1]) * k * step) / len];
      if (inside(t)) out.push({ planeId: d.plane, from: [d.source[0] + t[0] - d.local[0], d.source[1] + t[1] - d.local[1]], to: t, radius: d.radius, opacity: brush.opacity / 100, hardness: brush.hardness / 100 });
      if (!first) d.last = t;
    }
    return out;
  }

  function down(e: React.PointerEvent<SVGSVGElement>) {
    if (e.button !== 0 && e.button !== 1) return;
    const s = st.current, [x, y] = toDoc(e), planes = s.snap.planes;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === 'hand' || e.button === 1) { s.drag = { kind: 'pan', x: e.clientX, y: e.clientY }; return; }
    if (tool === 'create') {
      const pts: Pt[] = [...draft, [x, y]];
      if (pts.length < 4) { setDraft(pts); return; }
      const plane: VanishingPlane = { id: newId(), corners: pts };
      change({ ...s.snap, planes: [...planes, plane] });
      setDraft([]);
      setSelected(plane.id);
      setTool('edit');
      return;
    }
    if (tool === 'edit') {
      const sel = planes.find(p => p.id === selected);
      const corner = sel ? sel.corners.findIndex(c => Math.hypot(c[0] - x, c[1] - y) <= 12 / zoom) : -1;
      if (sel && corner >= 0) { s.drag = { kind: 'corner', plane: sel.id, corner, at: [x, y], before: s.snap }; setDragging(true); return; }
      const hit = hitPlane(planes, x, y);
      if (hit) { setSelected(hit.id); s.drag = { kind: 'body', plane: hit.id, corner: -1, at: [x, y], before: s.snap }; setDragging(true); }
      return;
    }
    // Stamp.
    if (e.altKey) { setSource([x, y]); setHint(null); return; }
    if (!source) { setHint(t`Alt-click to set a clone source, then paint inside a plane.`); return; }
    const plane = hitPlane(planes, x, y);
    const local = plane && uvOf(plane, x, y), src = plane && uvOf(plane, source[0], source[1]), edgePt = plane && uvOf(plane, x + brush.diameter / 2, y);
    if (!plane || !local || !src || !edgePt) return;
    const d: Drag = { kind: 'stamp', before: s.snap, plane: plane.id, local, source: src, radius: Math.hypot(edgePt[0] - local[0], edgePt[1] - local[1]), last: local };
    if (!(d.radius > 0)) return;
    s.drag = d;
    setDragging(true);
    setSnap({ ...s.snap, stamps: [...s.snap.stamps, ...dabsTo(d, local, true)] });
  }

  function move(e: React.PointerEvent<SVGSVGElement>) {
    const s = st.current, d = s.drag, p = toDoc(e);
    setPointer(p);
    if (!d) return;
    if (d.kind === 'pan') {
      stage.current?.scrollBy(d.x - e.clientX, d.y - e.clientY);
      s.drag = { ...d, x: e.clientX, y: e.clientY };
    } else if (d.kind === 'stamp') {
      const plane = s.snap.planes.find(q => q.id === d.plane), uv = plane && uvOf(plane, p[0], p[1]);
      if (uv) setSnap({ ...s.snap, stamps: [...s.snap.stamps, ...dabsTo(d, uv, false)] });
    } else {
      const [dx, dy] = [p[0] - d.at[0], p[1] - d.at[1]];
      const planes = d.before.planes.map(q => q.id !== d.plane ? q : {
        ...q, corners: q.corners.map((c, i): Pt => (d.kind === 'body' || i === d.corner ? [c[0] + dx, c[1] + dy] : c)),
      });
      setSnap({ ...s.snap, planes });
    }
  }

  function up() {
    const s = st.current, d = s.drag;
    s.drag = null;
    setDragging(false);
    if (d && d.kind !== 'pan' && JSON.stringify(d.before) !== JSON.stringify(s.snap)) remember(d.before);
  }

  function cancelDrag() {
    const s = st.current, d = s.drag;
    s.drag = null;
    setDragging(false);
    if (d && d.kind !== 'pan') setSnap(d.before);
  }

  function keyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape' && (st.current.drag || draft.length)) { e.preventDefault(); cancelDrag(); setDraft([]); return; }
    if ((e.target as HTMLElement).closest('input, select')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); historyStep(e.shiftKey ? 'redo' : 'undo'); }
  }

  function connect() {
    const parent = st.current.snap.planes.find(p => p.id === selected);
    if (!parent) return;
    client.call('vpConnected', parent, edge, angle, newId())
      .then(p => { const plane = p as VanishingPlane; change({ ...st.current.snap, planes: [...st.current.snap.planes, plane] }); setSelected(plane.id); })
      .catch(e => setError((e as Error).message));
  }

  function remove() {
    if (!selected) return;
    const s = st.current.snap;
    change({ planes: s.planes.filter(p => p.id !== selected), stamps: s.stamps.filter(d => d.planeId !== selected) });
    setSelected(null);
  }

  function close(commit: boolean) {
    const s = st.current, r = req;
    if (!r || s.closing) return;
    s.closing = true;
    s.drag = null;
    dialog.current?.close();
    (commit ? client.call('vpCommit', r.id, r.filterId, state()).then(d => show(d as DocInfo)) : client.call('vpEnd'))
      .catch(e => { setError((e as Error).message); return client.call('vpEnd'); })
      .finally(() => { s.original?.close(); s.painted?.close(); s.original = s.painted = null; setReq(null); });
  }

  const zoomBy = (f: number) => setZoom(z => clamp(z * f, 0.25, 4));
  const okOff = !snap.planes.length || snap.planes.some(p => !valid(p)) || dragging;
  const gridLines = (p: VanishingPlane) => {
    const { h } = maps(p), n = grid, out: string[] = [];
    for (let i = 0; i <= n; i++) for (const along of [true, false]) {
      out.push(Array.from({ length: 13 }, (_, k) => apply(h, along ? i / n : k / 12, along ? k / 12 : i / n).join(',')).join(' '));
    }
    return out;
  };
  const sw = 1 / zoom;
  const num = (label: string, value: number, min: number, max: number, set: (v: number) => void) => (
    <label>{label}<NumberInput min={min} max={max} value={value}
      onValue={v => set(clamp(Math.round(v), min, max))} /></label>
  );

  return (
    <dialog ref={dialog} className="vp-dialog" aria-label={t`Vanishing Point`} onClose={() => close(false)} onKeyDown={keyDown}>
      <form onSubmit={e => { e.preventDefault(); if (!okOff) close(true); }}>
        <h2><Trans>Vanishing Point</Trans></h2>
        <div className="vp-bar">
          <div role="toolbar" aria-label={t`Vanishing Point tools`}>
            {TOOLS.map(([id, label]) => <button key={id} type="button" aria-pressed={tool === id} onClick={() => { setTool(id); setDraft([]); }}>{i18n._(label)}</button>)}
            <button type="button" onClick={() => historyStep('undo')} title={t`Undo (Ctrl+Z)`}><Trans>Undo</Trans></button>
            <button type="button" onClick={() => historyStep('redo')} title={t`Redo (Shift+Ctrl+Z)`}><Trans>Redo</Trans></button>
          </div>
          <label className="adjustment-check"><input type="checkbox" checked={preview} onChange={e => { setPreview(st.current.preview = e.currentTarget.checked); draw(); }} /> <Trans>Preview</Trans></label>
        </div>
        <div className="vp-body">
          <div className="vp-stage" ref={stage}>
            <div className="vp-content" style={{ width: (req?.width ?? 0) * zoom, height: (req?.height ?? 0) * zoom }}>
              <canvas ref={canvas} className="vp-canvas" />
              <svg className="vp-overlay" data-tool={tool} viewBox={`0 0 ${req?.width ?? 1} ${req?.height ?? 1}`} preserveAspectRatio="none"
                onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={() => setPointer(null)}>
                {snap.planes.map(p => {
                  const ok = valid(p), on = p.id === selected;
                  return (
                    <g key={p.id} className={ok ? 'vp-plane' : 'vp-plane vp-invalid'}>
                      {ok && showGrid && gridLines(p).map((pts, i) => <polyline key={i} points={pts} fill="none" strokeWidth={sw * 0.75} />)}
                      <polygon points={p.corners.map(c => c.join(',')).join(' ')} fill="none" strokeWidth={sw * (on ? 2 : 1.25)} />
                      {on && p.corners.map((c, i) => <rect key={i} x={c[0] - 4 * sw} y={c[1] - 4 * sw} width={8 * sw} height={8 * sw} strokeWidth={sw} />)}
                    </g>
                  );
                })}
                {draft.length > 0 && <polyline className="vp-draft" fill="none" strokeWidth={sw} points={[...draft, ...(pointer ? [pointer] : [])].map(c => c.join(',')).join(' ')} />}
                {source && <path className="vp-source" strokeWidth={sw} d={`M${source[0] - 6 * sw},${source[1]}h${12 * sw}M${source[0]},${source[1] - 6 * sw}v${12 * sw}`} />}
                {tool === 'stamp' && pointer && <circle className="vp-brush" cx={pointer[0]} cy={pointer[1]} r={brush.diameter / 2} fill="none" strokeWidth={sw} />}
              </svg>
            </div>
          </div>
          <div className="vp-options">
            <h3><Trans>Planes</Trans></h3>
            <ul className="vp-planes">
              {snap.planes.map((p, i) => (
                <li key={p.id}><button type="button" className="link-button" aria-current={p.id === selected} onClick={() => setSelected(p.id)}>
                  {t`Plane ${i + 1}`} {valid(p) ? '✓' : '✗'}</button></li>
              ))}
            </ul>
            <label className="adjustment-check"><input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.currentTarget.checked)} /> <Trans>Show Grid</Trans></label>
            {num(t`Grid divisions`, grid, 2, 40, setGrid)}
            <h3><Trans context="Vanishing Point tool">Stamp</Trans></h3>
            {num(t`Diameter`, brush.diameter, 1, 300, v => setBrush(b => ({ ...b, diameter: v })))}
            {num(t`Hardness`, brush.hardness, 0, 100, v => setBrush(b => ({ ...b, hardness: v })))}
            {num(t`Opacity`, brush.opacity, 1, 100, v => setBrush(b => ({ ...b, opacity: v })))}
            <h3><Trans>Extend Plane</Trans></h3>
            <label><Trans>Edge</Trans><select value={edge} onChange={e => setEdge(e.currentTarget.value as Edge)}>
              {(['top', 'right', 'bottom', 'left'] as const).map(k => <option key={k} value={k}>{i18n._(EDGES[k])}</option>)}
            </select></label>
            {num(t`Angle`, angle, -180, 180, setAngle)}
            <div className="liquify-row">
              <button type="button" disabled={!selected} onClick={connect}><Trans>Create connected plane</Trans></button>
              <button type="button" disabled={!selected} onClick={remove}><Trans>Delete Plane</Trans></button>
            </div>
          </div>
        </div>
        <div className="vp-status">
          <span>{hint ?? i18n._(HINTS[tool])}</span>
          <span className="vp-zoom">
            <button type="button" aria-label={t`Zoom out`} onClick={() => zoomBy(0.8)}>−</button>
            <button type="button" title={t`Zoom to 100%`} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
            <button type="button" aria-label={t`Zoom in`} onClick={() => zoomBy(1.25)}>+</button>
          </span>
        </div>
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary" disabled={okOff}><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}
