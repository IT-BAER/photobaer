import { FLOATS_PER_INSTANCE, type Renderer } from './render/renderer.ts';
import { TILE, clipMatrix, docToScreen, fit, invalidateEntries, levelFor, panBy, screenToDoc, visibleRect, visibleTiles, tweenView, zoomAt, type View } from './view.ts';

// hand/zoom/rotate drive the viewer itself; any other tool id gets raw pointer events via onPointer.
export type ViewerTool = 'hand' | 'zoom' | 'zoomOut' | 'rotate' | null;
export interface ToolPointerEvent {
  type: 'down' | 'move' | 'up' | 'cancel';
  x: number; y: number; // document space
  pressure: number; tiltX: number; tiltY: number; twist: number;
  pointerType: string; buttons: number; timeStamp: number;
  shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean;
}

export interface ViewDoc { docId: number; version: number; width: number; height: number; maxLevel: number }
// `fill` writes the tile into a renderer slot (CPU upload or GPU compositing); null is a fully
// transparent tile, which needs no slot at all.
export interface TileResult { docId: number; version: number; fill: ((slot: number) => boolean | void) | null }
export type TileSource = (level: number, tx: number, ty: number) => Promise<TileResult>;

// `next` is a newer version staged while the viewer holds (see `hold`).
interface Entry { slot: number; version: number; used: number; next?: { slot: number; version: number } }

const MAX_INFLIGHT = 4;

// Draws the document from a GPU tile cache. Missing tiles fall back to the nearest cached coarser level,
// so panning never waits for the engine worker.
export class Viewer {
  view: View = { zoom: 1, rot: 0, cx: 0, cy: 0 };
  onView: (v: View) => void = () => {};
  onPointer: (e: ToolPointerEvent) => void = () => {};
  // A modal session (free transform) takes the pointer from any tool; Space and the middle button still pan.
  intercept: ((e: ToolPointerEvent) => void) | null = null;
  // Checked on a left-button pointerdown before any tool dispatch (docs/M4.md section 12: dragging an
  // existing guide works regardless of the active tool); returning true means it already took over via
  // `intercept`, so the normal tool/hand/zoom dispatch for this pointer is skipped entirely.
  guideHit: ((sx: number, sy: number) => boolean) | null = null;
  // Fires once per version, the first time a drawn frame has every visible-level tile it needs
  // (ignoring the coarse top-level fallback, which a live stroke's dirty rect always keeps stale).
  // `readyAt` is when the last tile the frame needed was stored (performance.now()).
  onVersionDrawn: (version: number, readyAt: number) => void = () => {};
  #storedAt = 0;
  #hold = false;
  #waiters: { version: number; done: () => void }[] = [];

  #tool: ViewerTool = null;
  #spring: ViewerTool = null;

  #canvas: HTMLCanvasElement;
  #r: Renderer;
  #src: TileSource;
  #doc: ViewDoc | null = null;
  #cache = new Map<string, Entry>();
  #free: number[] = [];
  #inflight = new Set<string>();
  #frame = 0;
  #anim: { from: View; to: View; sx: number; sy: number; t0: number; ms: number } | null = null;
  #raf = 0;
  #inst = new Float32Array(1024 * FLOATS_PER_INSTANCE);
  #w = 1;
  #h = 1;
  #resizeObserver: ResizeObserver;
  #inputAbort = new AbortController();
  #destroyed = false;

  constructor(canvas: HTMLCanvasElement, r: Renderer, src: TileSource) {
    this.#canvas = canvas;
    this.#r = r;
    this.#src = src;
    this.#resetCache();
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(canvas);
    this.#resize();
    this.#bindInput();
  }

  get dpr() { return window.devicePixelRatio || 1; }
  get size() { return [this.#w, this.#h] as const; }

  // While held, a new version reaches the screen only once every visible tile has it, so a frame
  // never mixes versions. Only for whole-version updates (a move drag): a stroke's per-frame
  // dirty tiles would never all be current.
  hold(on: boolean) {
    this.#hold = on;
    if (!on) this.#promote();
    this.redraw();
  }

  // Resolves once `version` (or a newer one) is fully drawn, or after `ms` at the latest.
  drawn(version: number, ms = 1000): Promise<void> {
    if (this.#destroyed) return Promise.resolve();
    return new Promise(res => {
      const w = { version, done: () => { clearTimeout(t); res(); } };
      const t = setTimeout(() => { this.#waiters = this.#waiters.filter(x => x !== w); res(); }, ms);
      this.#waiters.push(w);
      this.redraw();
    });
  }

  // `view` restores a tab's saved view instead of the refit when the document is new to the viewer.
  setDoc(d: ViewDoc | null, view?: View) {
    // A canvas size change (crop, trim, rotation, their undo) refits like a new document.
    const fresh = !d || !this.#doc || d.docId !== this.#doc.docId || d.width !== this.#doc.width || d.height !== this.#doc.height;
    this.#doc = d;
    if (fresh) {
      this.#resetCache();
      for (const w of this.#waiters.splice(0)) w.done();
      if (d) this.setView(view ?? fit(d.width, d.height, this.#w, this.#h));
    }
    this.redraw();
  }

  // A live stroke frame: only the tiles the dirty rect overlaps get refetched, every other cache
  // entry (any level) is kept and just moves to the new version. Used instead of setDoc so a
  // stroke's per-frame update never pays for a full-cache refetch.
  invalidate(version: number, rect: readonly number[]) {
    if (!this.#doc) return;
    this.#doc = { ...this.#doc, version };
    invalidateEntries(this.#cache, version, rect);
    // Fetch the stale visible tiles now, so they are drawn in the next frame, not the one after.
    const { level, tiles } = this.#visible(this.#doc);
    this.#pump(tiles.filter(([tx, ty]) => this.#cache.get(`${level}/${tx}/${ty}`)?.version !== version).map(([tx, ty]) => [level, tx, ty]));
    this.redraw();
  }

  setView(v: View) {
    this.#anim = null;
    this.view = v;
    this.onView(v);
    this.redraw();
  }

  // Eases to v (ease-out, zoom in log space) keeping screen point (sx, sy) anchored; a new call
  // retargets from wherever the running ease is, so input never waits for it.
  animateView(v: View, sx = this.#w / 2, sy = this.#h / 2, ms = 180) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return this.setView(v);
    this.#anim = { from: this.view, to: v, sx, sy, t0: performance.now(), ms };
    this.redraw();
  }

  #step() {
    const a = this.#anim;
    if (!a) return;
    const t = Math.min(1, (performance.now() - a.t0) / a.ms);
    this.view = tweenView(a.from, a.to, 1 - (1 - t) ** 3, a.sx, a.sy, this.#w, this.#h);
    if (t === 1) this.#anim = null;
    this.onView(this.view);
    if (this.#anim) this.redraw();
  }

  fit() { if (this.#doc) this.animateView(fit(this.#doc.width, this.#doc.height, this.#w, this.#h)); }
  // Frames a document rect `[x, y, w, h]` (View > Fit Artboard on Screen).
  fitRect(x: number, y: number, w: number, h: number) { this.animateView({ ...fit(w, h, this.#w, this.#h), cx: x + w / 2, cy: y + h / 2 }); }
  actualPixels() { this.animateView({ ...this.view, zoom: 1 / this.dpr }); }
  // The active tool (hand/zoom/rotate drive the viewer; anything else forwards through onPointer).
  setTool(t: ViewerTool) { this.#tool = t; }
  // A spring-loaded key override, e.g. held Space; null restores the active tool's own behavior.
  setSpring(t: ViewerTool) { this.#spring = t; }
  screenToDoc(sx: number, sy: number): [number, number] { return screenToDoc(this.view, sx, sy, this.#w, this.#h); }
  docToScreen(dx: number, dy: number): [number, number] { return docToScreen(this.view, dx, dy, this.#w, this.#h); }
  // The document rect on screen (a filter's live preview renders only this).
  docRect() { return this.#doc ? ([0, 0, this.#doc.width, this.#doc.height] as const) : null; }
  visibleRect() { return this.#doc ? visibleRect(this.view, this.#w, this.#h, this.#doc.width, this.#doc.height) : null; }
  zoomBy(f: number) { this.animateView(zoomAt(this.#anim?.to ?? this.view, f, this.#w / 2, this.#h / 2, this.#w, this.#h)); }
  resetRotation() { this.animateView({ ...(this.#anim?.to ?? this.view), rot: 0 }); }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#resizeObserver.disconnect();
    this.#inputAbort.abort();
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#anim = null;
    this.#doc = null;
    this.#cache.clear();
    this.#inflight.clear();
    this.#free = [];
    for (const waiter of this.#waiters.splice(0)) waiter.done();
  }

  redraw() {
    if (!this.#destroyed && !this.#raf) this.#raf = requestAnimationFrame(() => { this.#raf = 0; this.#step(); this.#draw(); });
  }

  #resetCache() {
    this.#cache.clear();
    this.#inflight.clear();
    this.#free = Array.from({ length: this.#r.slots }, (_, i) => this.#r.slots - 1 - i);
  }

  #resize() {
    if (this.#destroyed) return;
    const r = this.#canvas.getBoundingClientRect();
    this.#w = Math.max(1, r.width);
    this.#h = Math.max(1, r.height);
    this.#canvas.width = Math.round(this.#w * this.dpr);
    this.#canvas.height = Math.round(this.#h * this.dpr);
    this.redraw();
  }

  #draw() {
    if (this.#destroyed) return;
    const d = this.#doc;
    const dpr = this.dpr;
    const frame = { instances: this.#inst, count: 0, matrix: clipMatrix(this.view, this.#w, this.#h), checker: 8 * dpr, nearest: this.view.zoom * dpr >= 2 };
    if (!d) return this.#r.draw(frame);
    this.#frame++;
    const { level, tiles } = this.#visible(d);
    const at = (tx: number, ty: number) => this.#cache.get(`${level}/${tx}/${ty}`);
    if (this.#hold && tiles.every(([tx, ty]) => { const e = at(tx, ty); return e && (e.version === d.version || e.next?.version === d.version); })) this.#promote();
    if (this.#inst.length < tiles.length * FLOATS_PER_INSTANCE) this.#inst = frame.instances = new Float32Array(tiles.length * 2 * FLOATS_PER_INSTANCE);
    const want: [number, number, number][] = [];
    let freshVisible = true;
    for (const [tx, ty] of tiles) {
      const e = this.#touch(level, tx, ty);
      if (!e || e.version !== d.version) freshVisible = false;
      if (!e || (e.version !== d.version && e.next?.version !== d.version)) want.push([level, tx, ty]);
      const size = TILE << level;
      const x0 = tx * size, y0 = ty * size;
      const x1 = Math.min(x0 + size, d.width), y1 = Math.min(y0 + size, d.height);
      let src: [number, number, number, number] = [level, tx, ty, e ? e.slot : -1];
      if (!e) {
        for (let p = level + 1; p <= d.maxLevel; p++) {
          const pe = this.#touch(p, tx >> (p - level), ty >> (p - level));
          if (pe) { src = [p, tx >> (p - level), ty >> (p - level), pe.slot]; break; }
        }
      }
      this.#push(frame, x0, y0, x1, y1, src);
    }
    // The single top-level tile is the fallback of last resort; fetch it after the visible tiles.
    const top = this.#touch(d.maxLevel, 0, 0);
    if (!top || top.version !== d.version) want.push([d.maxLevel, 0, 0]);
    this.#r.draw(frame);
    this.#pump(want);
    if (freshVisible) {
      this.onVersionDrawn(d.version, this.#storedAt);
      this.#waiters = this.#waiters.filter(w => w.version > d.version || (w.done(), false));
    }
  }

  #visible(d: ViewDoc) {
    let level = levelFor(this.view.zoom, this.dpr, d.maxLevel);
    let tiles = visibleTiles(this.view, this.#w, this.#h, level, d.width, d.height);
    // Keep half the cache free for fallbacks and prefetch; very large screens drop one level.
    while (tiles.length > this.#r.slots / 2 && level < d.maxLevel) {
      level++;
      tiles = visibleTiles(this.view, this.#w, this.#h, level, d.width, d.height);
    }
    return { level, tiles };
  }

  #touch(level: number, tx: number, ty: number) {
    const e = this.#cache.get(`${level}/${tx}/${ty}`);
    if (e) e.used = this.#frame;
    return e;
  }

  #push(f: { instances: Float32Array; count: number }, x0: number, y0: number, x1: number, y1: number, [level, tx, ty, slot]: [number, number, number, number]) {
    const size = TILE << level;
    const ox = tx * size, oy = ty * size;
    f.instances.set([x0, y0, x1, y1, (x0 - ox) / size, (y0 - oy) / size, (x1 - ox) / size, (y1 - oy) / size, slot], f.count * FLOATS_PER_INSTANCE);
    f.count++;
  }

  #pump(want: [number, number, number][]) {
    const d = this.#doc!;
    for (const [level, tx, ty] of want) {
      if (this.#inflight.size >= MAX_INFLIGHT) return;
      const key = `${level}/${tx}/${ty}`;
      if (this.#inflight.has(key)) continue;
      this.#inflight.add(key);
      this.#src(level, tx, ty).then(r => {
        if (this.#destroyed) return;
        this.#inflight.delete(key);
        if (this.#doc?.docId !== r.docId || r.docId !== d.docId) return;
        this.#store(key, r);
        this.redraw();
      }, err => {
        if (this.#destroyed) return;
        this.#inflight.delete(key);
        console.error('tile', key, err);
      });
    }
  }

  #store(key: string, r: TileResult) {
    this.#storedAt = performance.now();
    let e = this.#cache.get(key);
    if (e && e.version > r.version) return;
    if (this.#hold && e && e.version < r.version) return this.#stage(e, r);
    if (!r.fill) {
      if (e && e.slot >= 0) this.#free.push(e.slot);
      this.#cache.set(key, { slot: -1, version: r.version, used: e?.used ?? this.#frame });
      return;
    }
    const slot = e && e.slot >= 0 ? e.slot : this.#free.pop() ?? this.#evict();
    if (slot === undefined) return;
    if (r.fill(slot) === false) {
      if (e) this.#drop(key);
      this.#free.push(slot);
      return;
    }
    e = { slot, version: r.version, used: e?.used ?? this.#frame, next: e?.next };
    this.#cache.set(key, e);
  }

  // Fills a held entry's spare slot; the entry keeps drawing its current slot until `#promote`.
  #stage(e: Entry, r: TileResult) {
    const n = e.next;
    if (n && n.version >= r.version) return;
    if (!r.fill) {
      if (n && n.slot >= 0) this.#free.push(n.slot);
      e.next = { slot: -1, version: r.version };
      return;
    }
    const slot = n && n.slot >= 0 ? n.slot : this.#free.pop() ?? this.#evict();
    if (slot === undefined) return;
    if (r.fill(slot) === false) {
      this.#free.push(slot);
      e.next = undefined;
      return;
    }
    e.next = { slot, version: r.version };
  }

  #promote() {
    for (const e of this.#cache.values()) {
      if (!e.next) continue;
      if (e.slot >= 0) this.#free.push(e.slot);
      ({ slot: e.slot, version: e.version } = e.next);
      e.next = undefined;
    }
  }

  // Removes an entry and returns its staged slot (its own slot is the caller's).
  #drop(key: string) {
    const n = this.#cache.get(key)?.next;
    if (n && n.slot >= 0) this.#free.push(n.slot);
    this.#cache.delete(key);
  }

  // Least recently drawn entry that was not drawn in the current frame.
  #evict(): number | undefined {
    let best: string | null = null, bestUsed = this.#frame;
    for (const [k, e] of this.#cache) if (e.slot >= 0 && e.used < bestUsed) { best = k; bestUsed = e.used; }
    if (best === null) return undefined;
    const slot = this.#cache.get(best)!.slot;
    this.#drop(best);
    return slot;
  }

  #mode(): ViewerTool { return this.#spring ?? (this.intercept ? null : this.#tool); }
  #emit(e: ToolPointerEvent) { (this.intercept ?? this.onPointer)(e); }

  #bindInput() {
    const c = this.#canvas;
    let last: [number, number] | null = null;
    let downAt: [number, number] | null = null;
    const local = (e: PointerEvent | WheelEvent): [number, number] => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const toolEvent = (type: ToolPointerEvent['type'], e: PointerEvent, p: [number, number]): ToolPointerEvent => {
      const [x, y] = this.screenToDoc(p[0], p[1]);
      return {
        type, x, y, pressure: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY, twist: e.twist,
        pointerType: e.pointerType, buttons: e.buttons, timeStamp: e.timeStamp,
        shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey,
      };
    };
    c.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.button !== 1) return;
      last = local(e);
      downAt = last;
      if (e.button === 0 && this.guideHit?.(last[0], last[1])) { c.setPointerCapture(e.pointerId); e.preventDefault(); return; }
      c.setPointerCapture(e.pointerId);
      const mode = e.button === 1 ? 'hand' : this.#mode();
      if (mode !== 'hand' && mode !== 'zoom' && mode !== 'zoomOut' && mode !== 'rotate') this.#emit(toolEvent('down', e, last));
      e.preventDefault();
    }, { signal: this.#inputAbort.signal });
    c.addEventListener('pointermove', e => {
      if (!last) return;
      const p = local(e);
      const mode = e.buttons & 4 ? 'hand' : this.#mode();
      if (mode === 'rotate') {
        const a0 = Math.atan2(last[1] - this.#h / 2, last[0] - this.#w / 2);
        const a1 = Math.atan2(p[1] - this.#h / 2, p[0] - this.#w / 2);
        this.setView({ ...this.view, rot: this.view.rot + a1 - a0 });
      } else if (mode === 'hand') {
        this.setView(panBy(this.view, p[0] - last[0], p[1] - last[1]));
      } else if (mode !== 'zoom' && mode !== 'zoomOut') {
        this.#emit(toolEvent('move', e, p));
      }
      last = p;
    }, { signal: this.#inputAbort.signal });
    const end = (e: PointerEvent) => {
      if (last && downAt) {
        const mode = e.button === 1 ? 'hand' : this.#mode();
        const clicked = Math.hypot(last[0] - downAt[0], last[1] - downAt[1]) < 3;
        if (mode === 'zoom' || mode === 'zoomOut') {
          if (clicked) {
            const out = mode === 'zoomOut' || e.altKey;
            this.animateView(zoomAt(this.#anim?.to ?? this.view, out ? 0.5 : 2, last[0], last[1], this.#w, this.#h), last[0], last[1]);
          }
        } else if (mode !== 'hand' && mode !== 'rotate') {
          this.#emit(toolEvent(e.type === 'pointercancel' ? 'cancel' : 'up', e, last));
        }
      }
      last = null;
      downAt = null;
    };
    c.addEventListener('pointerup', end, { signal: this.#inputAbort.signal });
    c.addEventListener('pointercancel', end, { signal: this.#inputAbort.signal });
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const [x, y] = local(e);
      const step = e.deltaMode === 1 ? 0.05 : 0.002;
      this.animateView(zoomAt(this.#anim?.to ?? this.view, 2 ** (-e.deltaY * step), x, y, this.#w, this.#h), x, y, 110);
    }, { passive: false, signal: this.#inputAbort.signal });
  }
}
