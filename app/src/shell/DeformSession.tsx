// Edit > Puppet Warp / Perspective Warp: an on-canvas session on layer `id`. The options bar takes
// the tool options' place; the overlay over the stage takes the pointer and keys. Previews render
// the whole document (proxy first); Enter commits one step, Esc cancels.
import { useEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { client } from '../client.ts';
import { i18n } from '../i18n/index.ts';
import { previewScale } from '../filters/schema.ts';
import { PuppetSession, type Density, type Geometry, type Grid, type Options, type PuppetMode } from '../transform/puppet.ts';
import { PerspectiveSession, engineState } from '../transform/pwarp.ts';
import type { Pt, Rect } from '../transform/matrix.ts';
import type { Viewer } from '../viewer.ts';
import type { DocInfo, SmartFilterKind } from '../worker/types.ts';
import { NumberInput } from './NumberInput.tsx';

export type DeformRequest = { id: number; width: number; height: number } & ({ kind: 'puppet'; mesh: Grid } | { kind: 'perspective'; bounds: Rect });
type Session = PuppetSession | PerspectiveSession;

const HIT = 9;
const LABEL = { puppet: 'Puppet Warp', perspective: 'Perspective Warp' };
const LABEL_MSG = { puppet: msg`Puppet Warp`, perspective: msg`Perspective Warp` };
const PLACE = msg`Place pins inside the mesh, away from existing pins.`;
const HINT = { layout: msg`Draw planes over the image. Join corners to link planes.`, warp: msg`Drag pins. Shift-click an edge to straighten and lock it.` };
const deg = (r: number) => Math.round(r * 180 / Math.PI * 10) / 10;

export function DeformSession({ req, viewer, show, setError, onEnd }: {
  req: DeformRequest; viewer: RefObject<Viewer | null>; show: (d: DocInfo | null) => void; setError: (m: string) => void; onEnd: () => void;
}) {
  const s: Session = useMemo(() => (req.kind === 'puppet' ? new PuppetSession(req.mesh) : new PerspectiveSession(req.bounds)), [req]);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [note, setNote] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // `gen` drops scheduled renders after a newer change; `open`: a worker preview session is open.
  const st = useRef({ gen: 0, open: false, done: false, alt: false, chain: Promise.resolve() as Promise<unknown>, timers: [] as ReturnType<typeof setTimeout>[] });
  const stage = document.querySelector('.stage');

  const enqueue = (fn: () => Promise<unknown>) => { st.current.chain = st.current.chain.then(fn).catch(e => setError((e as Error).message)); };
  const stop = () => { st.current.gen++; st.current.timers.forEach(clearTimeout); st.current.timers = []; };
  const filter = (): SmartFilterKind | null => {
    if (s instanceof PuppetSession) return { kind: 'puppet_warp', params: { rig: s.rig() } } as unknown as SmartFilterKind;
    return s.state.quads.length ? { kind: 'perspective_warp', params: { state: engineState(s.state) } } as unknown as SmartFilterKind : null;
  };
  const endSession = async (commit: boolean) => {
    if (!st.current.open) return;
    st.current.open = false;
    show(await client.call('previewEnd', commit));
  };
  const render = async (scale: number) => {
    const f = filter();
    if (!f) return endSession(false);
    st.current.open = true;
    show(await client.call('applyFilter', req.id, 'pixels', f, LABEL[req.kind], true, [], scale));
  };
  const geometry = async () => {
    if (s instanceof PuppetSession) { s.geometry = await client.call('puppetGeometry', s.rig()) as Geometry; bump(); }
  };

  // Each change: the deformed mesh, then a proxy render 16 ms later and full resolution once idle.
  const changed = () => {
    bump();
    stop();
    const g = st.current.gen;
    st.current.timers.push(setTimeout(() => enqueue(async () => {
      if (g !== st.current.gen) return;
      await geometry();
      const scale = previewScale(req.width, req.height);
      await render(scale);
      if (scale < 1) st.current.timers.push(setTimeout(() => enqueue(async () => { if (g === st.current.gen) await render(1); }), 350));
    }), 16));
  };

  const finish = (commit: boolean) => {
    if (st.current.done) return;
    st.current.done = true;
    stop();
    const modified = s instanceof PuppetSession ? s.isModified() : s.state.quads.length > 0 && s.state.mode === 'warp' && s.isModified();
    enqueue(async () => {
      try {
        if (commit && modified) { await render(1); await endSession(true); } else await endSession(false);
      } catch (e) {
        await endSession(false).catch(() => {});
        throw e;
      } finally { onEnd(); }
    });
  };

  useEffect(() => {
    canvas.current?.focus();
    enqueue(geometry);
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s]);

  // Density or expansion rebuild the mesh from the layer pixels, so the open preview ends first.
  const setOptions = (o: Partial<Options>) => {
    if (!(s instanceof PuppetSession)) return;
    if (o.density === undefined && o.expansion === undefined) { s.updateOptions(o); if (o.mode) changed(); else bump(); return; }
    stop();
    enqueue(async () => {
      await endSession(false);
      const next = { ...s.options, ...o };
      s.updateOptions(o, await client.call('puppetMesh', req.id, next.density, next.expansion) as Grid);
      changed();
    });
  };

  // Repainted every frame: the view can pan or zoom under the session.
  useEffect(() => {
    let raf = 0;
    const paint = () => {
      raf = requestAnimationFrame(paint);
      const c = canvas.current, g = c?.getContext('2d'), v = viewer.current;
      if (!c || !g || !v) return;
      const dpr = v.dpr, w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, c.clientWidth, c.clientHeight);
      const at = (x: number, y: number) => v.docToScreen(x, y);
      const handle = ([x, y]: Pt, selected: boolean) => {
        g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fillStyle = selected ? '#f4d34e' : '#f3f3f3'; g.fill();
        g.lineWidth = 1.5; g.strokeStyle = '#242424'; g.stroke();
        g.beginPath(); g.arc(x, y, 1.5, 0, Math.PI * 2); g.fillStyle = '#242424'; g.fill();
      };
      if (s instanceof PerspectiveSession) {
        const line = (a: Pt, b: Pt, color = 'rgba(255,255,255,.8)') => {
          g.beginPath(); g.moveTo(...at(...a)); g.lineTo(...at(...b));
          g.lineWidth = 2.5; g.strokeStyle = 'rgba(0,0,0,.65)'; g.stroke(); g.lineWidth = 1; g.strokeStyle = color; g.stroke();
        };
        for (const [a, b] of s.gridLines()) line(a, b);
        const pts = s.state.mode === 'layout' ? s.state.layout : s.state.current;
        if (s.state.mode === 'warp') for (const e of s.state.straightEdges) line(pts[e.a], pts[e.b], '#f4d34e');
        for (const p of pts) handle(at(...p), false);
        return;
      }
      const geo = s.geometry;
      if (s.options.showMesh && geo) {
        const d = geo.deformed, t = geo.triangles;
        g.beginPath();
        for (let k = 0; k < t.length; k += 3) {
          [t[k], t[k + 1], t[k + 2]].forEach((i, n) => { const [x, y] = at(d[2 * i], d[2 * i + 1]); if (n) g.lineTo(x, y); else g.moveTo(x, y); });
          g.closePath();
        }
        g.lineWidth = 0.6; g.strokeStyle = 'rgba(255,255,255,.65)'; g.stroke();
      }
      for (const p of s.pins) {
        const sp = at(p.tx, p.ty);
        handle(sp, s.selected.has(p.id));
        if (st.current.alt && s.selected.has(p.id)) { g.beginPath(); g.arc(sp[0], sp[1], 40, 0, Math.PI * 2); g.strokeStyle = '#e0c652'; g.lineWidth = 1; g.stroke(); }
      }
    };
    paint();
    return () => cancelAnimationFrame(raf);
  });

  const local = (e: React.PointerEvent): Pt => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const doc = (e: React.PointerEvent): Pt => { const [x, y] = local(e); return viewer.current?.screenToDoc(x, y) ?? [x, y]; };
  // The hit radius in document px: HIT screen px at the current zoom.
  const radius = () => {
    const v = viewer.current;
    if (!v) return HIT;
    const [ax, ay] = v.docToScreen(0, 0), [bx, by] = v.docToScreen(1, 0);
    return HIT / (Math.hypot(bx - ax, by - ay) || 1);
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.focus();
    const [x, y] = doc(e), r = radius();
    setNote(null);
    if (s instanceof PerspectiveSession) {
      const edge = s.hitEdge(x, y, r);
      if (e.shiftKey && s.state.mode === 'warp' && edge) { s.straighten(...edge); changed(); return; }
      s.begin(x, y, r);
    } else {
      const hit = s.hitPin(x, y, r);
      if (e.altKey && hit) { s.selected = new Set([hit.id]); s.removeSelected(); changed(); return; }
      if (e.altKey) {
        const pivot = s.pins.filter(p => s.selected.has(p.id)).reduce<typeof s.pins[number] | null>((b, p) => (!b || Math.hypot(p.tx - x, p.ty - y) < Math.hypot(b.tx - x, b.ty - y) ? p : b), null);
        if (pivot) s.begin(pivot, x, y, true);
      } else {
        const pin = hit ?? s.add(x, y, r);
        if (pin) { s.begin(pin, x, y, false, e.shiftKey); if (!hit) changed(); } else setNote(i18n._(PLACE));
      }
    }
    if (s.dragging) e.currentTarget.setPointerCapture(e.pointerId);
    bump();
  };
  const drag = (e: React.PointerEvent, end: boolean) => {
    if (!s.dragging) return;
    const [x, y] = doc(e);
    if (s instanceof PuppetSession) s.move(x, y, e.shiftKey); else s.move(x, y);
    if (end) s.end();
    changed();
  };
  const key = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (k === 'Escape') finish(false);
    else if (k === 'Enter') {
      if (s instanceof PerspectiveSession && s.state.mode === 'layout' && s.state.quads.length) { s.setMode('warp'); changed(); } else finish(true);
    } else if (k === 'Delete' || k === 'Backspace') { s.removeSelected(); changed(); }
    else if (mod && k.toLowerCase() === 'z') { s.historyStep(e.shiftKey ? 'redo' : 'undo'); changed(); }
    else if (s instanceof PerspectiveSession && !mod && (k.toLowerCase() === 'w' || k.toLowerCase() === 'l')) { s.setMode(k.toLowerCase() === 'w' ? 'warp' : 'layout'); changed(); }
    else if (s instanceof PuppetSession && !mod && k.startsWith('Arrow')) {
      const n = e.shiftKey ? 10 : 1, dx = k === 'ArrowLeft' ? -n : k === 'ArrowRight' ? n : 0, dy = k === 'ArrowUp' ? -n : k === 'ArrowDown' ? n : 0;
      s.updatePins(p => ({ ...p, tx: p.tx + dx, ty: p.ty + dy }));
      changed();
    } else return;
    e.preventDefault();
  };
  const alt = (e: React.KeyboardEvent | React.PointerEvent) => { st.current.alt = e.altKey; };

  const end = (
    <>
      <button type="button" onClick={() => finish(false)}><Trans>Cancel</Trans></button>
      <button type="button" className="primary" onClick={() => finish(true)}><Trans>Apply</Trans></button>
    </>
  );
  let bar;
  if (s instanceof PuppetSession) {
    const sel = s.pins.filter(p => s.selected.has(p.id)), first = sel[0];
    const pins = (f: Parameters<PuppetSession['updatePins']>[0]) => { s.updatePins(f); changed(); };
    bar = (
      <>
        <label><Trans>Mode</Trans>
          <select aria-label={t`Puppet mode`} value={s.options.mode} onChange={e => setOptions({ mode: e.currentTarget.value as PuppetMode })}>
            <option value="rigid">{t`Rigid`}</option><option value="normal">{t`Normal`}</option><option value="distort">{t`Distort`}</option>
          </select>
        </label>
        <label><Trans>Density</Trans>
          <select aria-label={t`Mesh density`} value={s.options.density} onChange={e => setOptions({ density: e.currentTarget.value as Density })}>
            <option value="fewerPoints">{t`Fewer Points`}</option><option value="normal">{t`Normal`}</option><option value="morePoints">{t`More Points`}</option>
          </select>
        </label>
        <label><Trans>Expansion</Trans>
          <NumberInput aria-label={t`Mesh expansion`} min={-50} max={50} step={1} value={s.options.expansion}
            onValue={v => setOptions({ expansion: Math.max(-50, Math.min(50, Math.round(v))) })} /> px
        </label>
        <label className="opt-bool"><input type="checkbox" checked={s.options.showMesh} onChange={e => setOptions({ showMesh: e.currentTarget.checked })} /><Trans>Show Mesh</Trans></label>
        <span><Trans>Pin Depth</Trans></span>
        <button type="button" disabled={!first} title={t`Move the selected pins forward`} onClick={() => pins(p => ({ ...p, depth: p.depth + 1 }))}><Trans>Forward</Trans></button>
        <button type="button" disabled={!first} title={t`Move the selected pins backward`} onClick={() => pins(p => ({ ...p, depth: p.depth - 1 }))}><Trans>Backward</Trans></button>
        <label><Trans>Rotate</Trans>
          <select aria-label={t`Pin rotation`} disabled={!first} value={first?.fixed ? 'fixed' : 'auto'}
            onChange={e => pins(p => (e.currentTarget.value === 'fixed' ? { ...p, fixed: true, rotation: s.rotationOf(p) } : { ...p, fixed: false, rotation: 0 }))}>
            <option value="auto">{t`Auto`}</option><option value="fixed">{t`Fixed`}</option>
          </select>
        </label>
        <NumberInput aria-label={t`Pin rotation angle`} disabled={!first?.fixed} step={1} value={first ? deg(s.rotationOf(first)) : 0}
          onValue={v => pins(p => ({ ...p, fixed: true, rotation: v * Math.PI / 180 }))} />°
        <button type="button" disabled={!s.pins.length} onClick={() => { s.reset(); changed(); }}><Trans>Remove All Pins</Trans></button>
        {note && <span className="deform-hint">{note}</span>}
      </>
    );
  } else {
    const warp = s.state.mode === 'warp';
    bar = (
      <>
        <button type="button" aria-pressed={!warp} onClick={() => { s.setMode('layout'); changed(); }}><Trans>Layout</Trans></button>
        <button type="button" aria-pressed={warp} disabled={!s.state.quads.length} onClick={() => { s.setMode('warp'); changed(); }}><Trans>Warp</Trans></button>
        {warp && (
          <>
            <button type="button" title={t`Automatically straighten near-vertical line segments`} onClick={() => { s.autoStraighten('vertical'); changed(); }}><Trans>Straighten Vertical</Trans></button>
            <button type="button" title={t`Automatically level near-horizontal line segments`} onClick={() => { s.autoStraighten('horizontal'); changed(); }}><Trans>Straighten Horizontal</Trans></button>
            <button type="button" title={t`Automatically straighten and level both`} onClick={() => { s.autoStraighten('both'); changed(); }}><Trans>Straighten Both</Trans></button>
            <button type="button" onClick={() => { s.reset(); changed(); }}><Trans>Reset</Trans></button>
          </>
        )}
        <span className="deform-hint">{i18n._(HINT[s.state.mode])}</span>
      </>
    );
  }

  const name = i18n._(LABEL_MSG[req.kind]);
  const optionsLabel = t`${name} options`, handlesLabel = t`${name} handles`;
  return (
    <div className="options-bar transform-bar" role="toolbar" aria-label={optionsLabel}>
      {bar}
      {end}
      {stage && createPortal(
        <canvas ref={canvas} className="overlay gallery-overlay" tabIndex={0} aria-label={handlesLabel}
          onPointerDown={e => { alt(e); down(e); }} onPointerMove={e => { if (st.current.alt !== e.altKey) alt(e); drag(e, false); }}
          onPointerUp={e => drag(e, true)} onPointerCancel={() => { s.cancelDrag(); changed(); }}
          onKeyDown={e => { alt(e); key(e); }} onKeyUp={alt}
          onWheel={e => stage.querySelector('canvas')?.dispatchEvent(new WheelEvent('wheel', e.nativeEvent))} />,
        stage,
      )}
    </div>
  );
}
