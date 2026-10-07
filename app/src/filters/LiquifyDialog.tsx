// Filter > Liquify (docs/M5.md section 6): a modal dialog with its own preview canvas. The mesh
// lives in the worker session; this side sends brush points and draws the returned proxy.
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { client } from '../client.ts';
import { i18n } from '../i18n/index.ts';
import type { DocInfo, Guide, LiquifyOp } from '../worker/types.ts';
import { NumberInput } from '../shell/NumberInput.tsx';

type View = { data: ArrayBuffer; w: number; h: number; scale: number; cols: number; rows: number; spacing: number; disp: Float32Array | null; frozen: Float32Array | null };
export type LiquifyRequest = { id: number; filterId: number | null; width: number; height: number; guides: Guide[]; layers: { id: number; name: string }[] };
export interface LiquifyDialogHandle { open(r: LiquifyRequest): void }

const TOOLS = [
  ['forwardWarp', msg`Forward Warp`, 'W'], ['reconstruct', msg`Reconstruct`, 'R'], ['smooth', msg`Smooth`, 'E'],
  ['twirlClockwise', msg`Twirl Clockwise`, 'C'], ['twirlCounterClockwise', msg`Twirl Counter-Clockwise`, 'Alt+C'], ['pucker', msg`Pucker`, 'S'],
  ['bloat', msg`Bloat`, 'B'], ['pushLeft', msg`Push Left`, 'O'], ['freeze', msg`Freeze Mask`, 'F'], ['thaw', msg`Thaw Mask`, 'D'],
  ['face', msg`Face Tool (Face-Aware Liquify comes with M7)`, 'A'], ['hand', msg`Hand`, 'H'], ['zoom', msg`Zoom`, 'Z'],
] as const;
type Tool = typeof TOOLS[number][0];
const KEYS: Record<string, Tool> = { w: 'forwardWarp', r: 'reconstruct', e: 'smooth', c: 'twirlClockwise', s: 'pucker', b: 'bloat', o: 'pushLeft', f: 'freeze', d: 'thaw', h: 'hand', z: 'zoom' };
const RATED = new Set<Tool>(['reconstruct', 'smooth', 'twirlClockwise', 'twirlCounterClockwise', 'pucker', 'bloat']);
const MODES: [string, MessageDescriptor][] = [['revert', msg`Revert`], ['rigid', msg`Rigid`], ['stiff', msg`Stiff`], ['smooth', msg`Smooth`], ['loose', msg`Loose`]];
const MESH_SIZES: [MessageDescriptor, number][] = [[msg`Fine`, 4], [msg`Medium`, 8], [msg`Coarse`, 16]];
const MASK_COLORS: [MessageDescriptor, string][] = [[msg`Red`, '#ff0000'], [msg`Green`, '#00ff00'], [msg`Blue`, '#0000ff'], [msg`Gray`, '#808080'], [msg`Black`, '#000000'], [msg`White`, '#ffffff']];
const MESH_COLORS: [MessageDescriptor, string][] = [[msg`Gray`, '#808080'], [msg`Red`, '#ff0000'], [msg`Green`, '#00ff00'], [msg`Blue`, '#0000ff'], [msg`Black`, '#000000'], [msg`White`, '#ffffff']];
const MASK_OPS: [string, MessageDescriptor, MessageDescriptor][] = [
  ['replace', msg`Replace Selection`, msg`Replace`], ['add', msg`Add to Selection`, msg`Add`], ['subtract', msg`Subtract from Selection`, msg`Subtract`],
  ['intersect', msg`Intersect with Selection`, msg`Intersect`], ['invertSelection', msg`Invert Selection`, msg`Invert`],
];
const PREFS = 'photobaer.liquify';
const MAX_SIDE = 1600;

const DEFAULTS = {
  size: 100, density: 50, pressure: 100, rate: 80, mode: 'revert', pinEdges: false,
  showImage: true, showMesh: false, meshSize: 8, meshColor: '#808080', showMask: true, maskColor: '#ff0000', showGuides: false,
  showBackdrop: false, backdrop: 'all', backdropMode: 'behind', backdropOpacity: 50,
};
type Prefs = typeof DEFAULTS;

function loadPrefs(): Prefs {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') }; } catch { return DEFAULTS; }
}

export function LiquifyDialog({ ref, show, setError }: { ref: Ref<LiquifyDialogHandle>; show: (d: DocInfo | null) => void; setError: (msg: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [req, setReq] = useState<LiquifyRequest | null>(null);
  const [tool, setTool] = useState<Tool>('forwardWarp');
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [maskSource, setMaskSource] = useState<'selection' | 'transparency'>('selection');
  const [amount, setAmount] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  // Mutable state the canvas handlers read: the last view, its bitmap, the transform, queued edits.
  const st = useRef({
    view: null as View | null, img: null as ImageBitmap | null, backdrop: null as ImageBitmap | null, z: 1, ox: 0, oy: 0,
    queue: [] as LiquifyOp[], want: false, busy: false, space: false, down: null as null | { kind: 'stroke' | 'pan'; x: number; y: number }, hold: 0 as ReturnType<typeof setInterval> | 0,
    cursor: null as null | [number, number], prefs, req: null as LiquifyRequest | null, closing: false,
  });
  st.current.prefs = prefs;
  st.current.req = req;

  const setPrefs = (patch: Partial<Prefs>) => setPrefsState(p => {
    const n = { ...p, ...patch };
    try { localStorage.setItem(PREFS, JSON.stringify(n)); } catch { /* session-only */ }
    st.current.prefs = n;
    requestAnimationFrame(draw);
    return n;
  });

  const overlays = () => st.current.prefs.showMesh || st.current.prefs.showMask;

  async function accept(v: View) {
    const s = st.current;
    s.view = v;
    s.img?.close();
    s.img = await createImageBitmap(new ImageData(new Uint8ClampedArray(v.data), v.w, v.h));
    draw();
  }

  // Sends every queued edit in one worker call, then again while more arrived meanwhile; `send()`
  // without edits only refetches the view (with the overlays just switched on).
  function pump() {
    const s = st.current;
    if (s.busy || !s.want || !s.req) return;
    s.busy = true;
    s.want = false;
    const ops = s.queue.splice(0);
    client.call('liquifyEdit', s.req.id, ops, overlays()).then(v => accept(v as View)).catch(e => setError((e as Error).message))
      .finally(() => { s.busy = false; pump(); });
  }
  const send = (...ops: LiquifyOp[]) => { st.current.queue.push(...ops); st.current.want = true; pump(); };

  function fit() {
    const s = st.current, c = canvas.current, r = s.req;
    if (!c || !r) return;
    s.z = Math.min(c.width / r.width, c.height / r.height) * 0.95;
    s.ox = (c.width - r.width * s.z) / 2;
    s.oy = (c.height - r.height * s.z) / 2;
    setZoom(s.z);
    draw();
  }

  // Zooms by `f` keeping the document point under screen (sx, sy) in place.
  function zoomAt(f: number, sx: number, sy: number) {
    const s = st.current, z = Math.min(32, Math.max(0.02, s.z * f));
    s.ox = sx - (sx - s.ox) * (z / s.z);
    s.oy = sy - (sy - s.oy) * (z / s.z);
    s.z = z;
    setZoom(z);
    draw();
  }
  const zoomCenter = (f: number) => { const c = canvas.current; if (c) zoomAt(f, c.width / 2, c.height / 2); };

  function draw() {
    const s = st.current, c = canvas.current, v = s.view, r = s.req, p = s.prefs;
    const g = c?.getContext('2d');
    if (!c || !g || !v || !r) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.imageSmoothingEnabled = s.z < 1 / v.scale;
    const [w, h] = [r.width * s.z, r.height * s.z];
    const backdrop = (front: boolean) => {
      if (!p.showBackdrop || !s.backdrop || (p.backdropMode === 'behind') === front) return;
      g.globalAlpha = p.backdropOpacity / 100;
      g.drawImage(s.backdrop, s.ox, s.oy, w, h);
      g.globalAlpha = 1;
    };
    backdrop(false);
    if (p.showImage && s.img) g.drawImage(s.img, s.ox, s.oy, w, h);
    backdrop(true);
    if (p.showMask && v.frozen) {
      const m = new OffscreenCanvas(v.cols, v.rows), mg = m.getContext('2d')!, id = mg.createImageData(v.cols, v.rows);
      const rgb = [1, 3, 5].map(i => parseInt(p.maskColor.slice(i, i + 2), 16));
      v.frozen.forEach((f, i) => { id.data.set([rgb[0], rgb[1], rgb[2], Math.round(f * 128)], i * 4); });
      mg.putImageData(id, 0, 0);
      g.imageSmoothingEnabled = true;
      const sp = v.spacing * s.z;
      g.drawImage(m, s.ox - sp / 2, s.oy - sp / 2, v.cols * sp, v.rows * sp);
    }
    if (p.showMesh && v.disp) {
      // Every k-th line so lines stay at least 6 px apart on screen.
      const k = Math.max(1, Math.ceil(6 / (v.spacing * s.z))), d = v.disp, sp = v.spacing;
      const at = (u: number, q: number): [number, number] => { const i = (q * v.cols + u) * 2; return [s.ox + (u * sp - d[i]) * s.z, s.oy + (q * sp - d[i + 1]) * s.z]; };
      g.strokeStyle = p.meshColor;
      g.lineWidth = 1;
      g.beginPath();
      for (let q = 0; q < v.rows; q += k) for (let u = 0; u < v.cols; u++) g[u ? 'lineTo' : 'moveTo'](...at(u, q));
      for (let u = 0; u < v.cols; u += k) for (let q = 0; q < v.rows; q++) g[q ? 'lineTo' : 'moveTo'](...at(u, q));
      g.stroke();
    }
    if (p.showGuides) {
      g.strokeStyle = '#00c8ff';
      g.beginPath();
      for (const gd of r.guides) {
        if (gd.axis === 'x') { g.moveTo(s.ox + gd.pos * s.z, s.oy); g.lineTo(s.ox + gd.pos * s.z, s.oy + h); }
        else { g.moveTo(s.ox, s.oy + gd.pos * s.z); g.lineTo(s.ox + w, s.oy + gd.pos * s.z); }
      }
      g.stroke();
    }
    if (s.cursor && TOOLS.findIndex(t => t[0] === tool) < 10) {
      g.strokeStyle = '#fff';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.arc(s.cursor[0], s.cursor[1], (p.size / 2) * s.z, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
  }

  useImperativeHandle(ref, () => ({
    open(r) {
      const s = st.current;
      Object.assign(s, { req: r, view: null, queue: [], want: false, busy: false, down: null, closing: false });
      s.backdrop?.close();
      s.backdrop = null;
      setReq(r);
      setAmount(null);
      dialog.current?.showModal();
      client.call('liquifyBegin', r.id, MAX_SIDE, st.current.prefs.meshSize, r.filterId)
        .then(async v => {
          const c = canvas.current;
          if (c) { c.width = c.clientWidth; c.height = c.clientHeight; }
          s.view = v as View;
          if (s.prefs.pinEdges) send({ op: 'pin', on: true });
          await accept(v as View);
          fit();
          if (s.prefs.showBackdrop) loadBackdrop(s.prefs.backdrop);
        })
        .catch(e => { setError((e as Error).message); dialog.current?.close(); });
    },
  }), []);

  function loadBackdrop(which: string) {
    const s = st.current;
    client.call('liquifyBackdrop', which === 'all' ? null : Number(which), MAX_SIDE)
      .then(async b => {
        const v = b as { data: ArrayBuffer; w: number; h: number };
        s.backdrop?.close();
        s.backdrop = await createImageBitmap(new ImageData(new Uint8ClampedArray(v.data), v.w, v.h));
        draw();
      })
      .catch(e => setError((e as Error).message));
  }

  const toDoc = (e: { clientX: number; clientY: number }) => {
    const s = st.current, b = canvas.current!.getBoundingClientRect();
    const sx = e.clientX - b.left, sy = e.clientY - b.top;
    return { sx, sy, x: (sx - s.ox) / s.z, y: (sy - s.oy) / s.z };
  };

  function brush() {
    const p = st.current.prefs;
    return { tool, size: p.size, density: p.density, pressure: p.pressure, rate: p.rate, mode: p.mode };
  }

  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0 && e.button !== 1) return;
    const s = st.current, q = toDoc(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === 'zoom') { zoomAt(e.altKey ? 0.5 : 2, q.sx, q.sy); return; }
    if (tool === 'hand' || tool === 'face' || e.button === 1 || s.space) { s.down = { kind: 'pan', x: q.sx, y: q.sy }; return; }
    s.down = { kind: 'stroke', x: q.x, y: q.y };
    send({ op: 'begin', brush: brush(), x: q.x, y: q.y });
    if (RATED.has(tool)) s.hold = setInterval(() => send({ op: 'hold' }), 60);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    const s = st.current, q = toDoc(e);
    s.cursor = [q.sx, q.sy];
    if (s.down?.kind === 'pan') { s.ox += q.sx - s.down.x; s.oy += q.sy - s.down.y; s.down = { ...s.down, x: q.sx, y: q.sy }; }
    else if (s.down?.kind === 'stroke') send({ op: 'to', x: q.x, y: q.y });
    requestAnimationFrame(draw);
  }

  function up() {
    const s = st.current;
    if (s.hold) clearInterval(s.hold);
    s.hold = 0;
    if (s.down?.kind === 'stroke') send({ op: 'end' });
    s.down = null;
  }

  function keyDown(e: React.KeyboardEvent) {
    if ((e.target as HTMLElement).closest('input, select')) return;
    const k = e.key.toLowerCase(), p = st.current.prefs;
    if (k === ' ') { e.preventDefault(); st.current.space = true; return; }
    if ((e.ctrlKey || e.metaKey) && k === '0') { e.preventDefault(); fit(); return; }
    if (e.ctrlKey || e.metaKey) return;
    if (k === '[' || k === ']') { e.preventDefault(); const d = e.shiftKey ? 50 : 10; setPrefs({ size: Math.min(15000, Math.max(1, p.size + (k === ']' ? d : -d))) }); return; }
    if (k === 'c' && e.altKey) { e.preventDefault(); setTool('twirlCounterClockwise'); return; }
    if (KEYS[k]) { e.preventDefault(); setTool(KEYS[k]); }
  }

  function close(commit: boolean) {
    const s = st.current, r = s.req;
    if (!r || s.closing) return;
    s.closing = true;
    up();
    dialog.current?.close();
    // Queued edits run before the commit: the worker queue keeps call order.
    const ops = s.queue.splice(0);
    const flush = ops.length ? client.call('liquifyEdit', r.id, ops, false) : Promise.resolve();
    flush.then(() => (commit ? client.call('liquifyCommit', r.id, r.filterId).then(d => show(d as DocInfo)) : client.call('liquifyEnd')))
      .catch(e => { setError((e as Error).message); return client.call('liquifyEnd'); })
      .finally(() => { s.img?.close(); s.img = null; s.view = null; setReq(null); });
  }

  const num = (label: string, key: 'size' | 'density' | 'pressure' | 'rate', min: number, max: number) => (
    <label>{label}<NumberInput min={min} max={max} step={1} value={prefs[key]}
      onValue={v => setPrefs({ [key]: Math.min(max, Math.max(min, Math.round(v))) })} /></label>
  );
  const check = (label: string, key: 'showImage' | 'showMesh' | 'showMask' | 'showGuides' | 'showBackdrop', after?: (on: boolean) => void) => (
    <label className="adjustment-check"><input type="checkbox" checked={prefs[key]} onChange={e => { const on = e.currentTarget.checked; setPrefs({ [key]: on }); after?.(on); }} /> {label}</label>
  );

  return (
    <dialog ref={dialog} className="liquify-dialog" aria-label={t`Liquify`} onClose={() => close(false)} onKeyDown={keyDown}
      onKeyUp={e => { if (e.key === ' ') st.current.space = false; }}>
      <form onSubmit={e => { e.preventDefault(); close(true); }}>
        <h2><Trans>Liquify</Trans></h2>
        <div className="liquify-body">
          <div className="liquify-tools" role="toolbar" aria-label={t`Liquify tools`}>
            {TOOLS.map(([id, d, key]) => {
              const label = i18n._(d);
              return (
              <button key={id} type="button" title={`${label} (${key})`} aria-label={label} aria-pressed={tool === id} disabled={id === 'face'}
                onClick={() => setTool(id)}>{key.replace('Alt+', '⌥')}</button>
            );
            })}
          </div>
          <div className="liquify-stage">
            <canvas ref={canvas} className="liquify-canvas" data-tool={tool} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
              onPointerLeave={() => { st.current.cursor = null; requestAnimationFrame(draw); }}
              onWheel={e => { const q = toDoc(e); zoomAt(e.deltaY < 0 ? 1.25 : 0.8, q.sx, q.sy); }} />
            <div className="liquify-zoom">
              <button type="button" aria-label={t`Zoom out`} onClick={() => zoomCenter(0.5)}>−</button>
              <span>{Math.round(zoom * 100)}%</span>
              <button type="button" aria-label={t`Zoom in`} onClick={() => zoomCenter(2)}>+</button>
              <button type="button" onClick={fit}><Trans>Fit</Trans></button>
            </div>
          </div>
          <div className="liquify-options">
            <h3><Trans>Brush Tool Options</Trans></h3>
            {num(t`Size`, 'size', 1, 15000)}
            {num(t`Density`, 'density', 0, 100)}
            {num(t`Pressure`, 'pressure', 0, 100)}
            {num(t`Rate`, 'rate', 0, 100)}
            <label className="adjustment-check" title={t`Pressure from a stylus is not available yet.`}><input type="checkbox" disabled /> <Trans>Stylus Pressure</Trans></label>
            <label className="adjustment-check"><input type="checkbox" checked={prefs.pinEdges}
              onChange={e => { const on = e.currentTarget.checked; setPrefs({ pinEdges: on }); send({ op: 'pin', on }); }} /> <Trans>Pin Edges</Trans></label>
            <h3><Trans>Brush Reconstruct Options</Trans></h3>
            <label><Trans>Mode</Trans><select value={prefs.mode} onChange={e => setPrefs({ mode: e.currentTarget.value })}>
              {MODES.map(([m, d]) => <option key={m} value={m}>{i18n._(d)}</option>)}
            </select></label>
            <div className="liquify-row">
              <button type="button" onClick={() => setAmount(a => (a === null ? 100 : null))}><Trans>Reconstruct…</Trans></button>
              <button type="button" onClick={() => send({ op: 'restore' })}><Trans>Restore All</Trans></button>
            </div>
            {amount !== null && (
              <div className="liquify-row">
                <label><Trans>Amount</Trans><NumberInput min={0} max={100} value={amount} onValue={v => setAmount(Math.min(100, Math.max(0, v || 0)))} /></label>
                <button type="button" onClick={() => { send({ op: 'reconstruct', amount }); setAmount(null); }}><Trans>Apply</Trans></button>
              </div>
            )}
            <h3><Trans>Mask Options</Trans></h3>
            <label><Trans>From</Trans><select value={maskSource} onChange={e => setMaskSource(e.currentTarget.value as 'selection' | 'transparency')}>
              <option value="selection">{t`Selection`}</option><option value="transparency">{t`Transparency`}</option>
            </select></label>
            <div className="liquify-row">
              {MASK_OPS.map(([op, d, short]) => <button key={op} type="button" title={i18n._(d)} aria-label={i18n._(d)} onClick={() => send({ op: 'mask', source: maskSource, mode: op })}>{i18n._(short)}</button>)}
            </div>
            <div className="liquify-row">
              <button type="button" onClick={() => send({ op: 'mask', source: null, mode: 'none' })}>{t({ message: 'None', context: 'liquify mask' })}</button>
              <button type="button" onClick={() => send({ op: 'mask', source: null, mode: 'all' })}><Trans>Mask All</Trans></button>
              <button type="button" onClick={() => send({ op: 'mask', source: null, mode: 'invert' })}><Trans>Invert All</Trans></button>
            </div>
            <h3><Trans>View Options</Trans></h3>
            {check(t`Show Guides`, 'showGuides')}
            {check(t`Show Image`, 'showImage')}
            {check(t`Show Mesh`, 'showMesh', on => on && send())}
            <label><Trans>Mesh Size</Trans><select value={prefs.meshSize} onChange={e => { const n = Number(e.currentTarget.value); setPrefs({ meshSize: n }); send({ op: 'spacing', spacing: n }); }}>
              {MESH_SIZES.map(([l, n]) => <option key={n} value={n}>{i18n._(l)}</option>)}
            </select></label>
            <label><Trans>Mesh Colour</Trans><select value={prefs.meshColor} onChange={e => setPrefs({ meshColor: e.currentTarget.value })}>
              {MESH_COLORS.map(([l, c]) => <option key={c} value={c}>{i18n._(l)}</option>)}
            </select></label>
            {check(t`Show Mask`, 'showMask', on => on && send())}
            <label><Trans>Mask Colour</Trans><select value={prefs.maskColor} onChange={e => setPrefs({ maskColor: e.currentTarget.value })}>
              {MASK_COLORS.map(([l, c]) => <option key={c} value={c}>{i18n._(l)}</option>)}
            </select></label>
            {check(t`Show Backdrop`, 'showBackdrop', on => on && loadBackdrop(prefs.backdrop))}
            <label><Trans>Use</Trans><select value={prefs.backdrop} onChange={e => { const b = e.currentTarget.value; setPrefs({ backdrop: b }); if (prefs.showBackdrop) loadBackdrop(b); }}>
              <option value="all">{t`All Layers`}</option>
              {req?.layers.filter(l => l.id !== req.id).map(l => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
            </select></label>
            <label><Trans>Mode</Trans><select value={prefs.backdropMode} onChange={e => setPrefs({ backdropMode: e.currentTarget.value })}>
              <option value="front">{t`In Front`}</option><option value="behind">{t`Behind`}</option>
            </select></label>
            <label><Trans>Opacity</Trans><NumberInput min={0} max={100} value={prefs.backdropOpacity}
              onValue={v => setPrefs({ backdropOpacity: Math.min(100, Math.max(0, v || 0)) })} /></label>
          </div>
        </div>
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}
