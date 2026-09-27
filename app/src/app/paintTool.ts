import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { client } from '../client.ts';
import type { Active } from '../LayersPanel.tsx';
import { nodeById } from '../layers.ts';
import type { PerfProbe } from '../render/perf.ts';
import { buildUpFor, presetStrokeParams, smoothingFor, type PaintTool } from '../brushes/brushParams.ts';
import type { EngineAssets } from '../brushes/engineAssets.ts';
import type { BrushPreset } from '../brushes/preset.ts';
import type { BrushLibrary } from '../brushes/store.ts';
import { BuildUp, inputFields, strideFor, strokeSeed, type Stride } from '../brushes/strokeInput.ts';
import type { Rgb } from '../shell/color.ts';
import type { ToolOptions } from '../shell/OptionsBar.tsx';
import { Smoother } from '../shell/smoothing.ts';
import type { ToolPointerEvent, Viewer } from '../viewer.ts';
import type { DocInfo, StrokeParams } from '../worker/types.ts';
import { PAINT_LABELS, type Run } from './helpers.ts';

export interface PaintToolCtx {
  viewer: RefObject<Viewer | null>; tool: string; toolOptionsRef: RefObject<ToolOptions>; currentPreset: (id: string | null) => BrushPreset | null;
  selectedPresetRef: RefObject<string | null>; brushLib: RefObject<{ library: BrushLibrary; assets: EngineAssets } | null>;
  bgRef: RefObject<Rgb>; fgRef: RefObject<Rgb>; active: Active | null; docRef: RefObject<DocInfo | null>; strokeCounter: RefObject<number>;
  quickMask: boolean; perfRef: RefObject<PerfProbe | null>; setError: Dispatch<SetStateAction<string | null>>;
  lastStrokePoint: RefObject<Record<number, [number, number]>>; run: Run;
}

export function usePaintTool(c: PaintToolCtx) {
  const {
    viewer, tool, toolOptionsRef, currentPreset, selectedPresetRef, brushLib, bgRef, fgRef, active, docRef, strokeCounter, quickMask, perfRef,
    setError, lastStrokePoint, run,
  } = c;
  // Brush, pencil and eraser: pointermove samples are coalesced and sent as one strokeTo per
  // animation frame; the smoother runs on the document-space samples before they are queued.
  // Samples carry x, y, pressure (stride 3) or also tiltX, tiltY, twist for pen strokes (stride 6).
  useEffect(() => {
    const v = viewer.current;
    if (!v || !(tool === 'brush' || tool === 'pencil' || tool === 'eraser')) return;
    const st: {
      smoother: Smoother | null; layerId: number | null; raf: number; stride: Stride;
      pending: number[]; last: number[] | null; lastSampleAt: number;
      buildUp: BuildUp | null; frame: number; begun: Promise<void> | null;
    } = { smoother: null, layerId: null, raf: 0, stride: 3, pending: [], last: null, lastSampleAt: 0, buildUp: null, frame: 0, begun: null };

    function flush() {
      if (!st.pending.length) return;
      const samples = Float64Array.from(st.pending.splice(0));
      const sampled = st.lastSampleAt;
      const sent = performance.now();
      client.call('strokeTo', samples).then(r => {
        const resolved = performance.now();
        viewer.current?.invalidate(r.version, r.dirty);
        perfRef.current?.recordSample(r.version, { sampled, sent, resolved });
      }, e => setError((e as Error).message));
    }
    function schedule() {
      if (st.raf) return;
      st.raf = requestAnimationFrame(() => { st.raf = 0; flush(); });
    }
    function push(p: [number, number], fields: number[]) {
      st.last = [p[0], p[1], ...fields];
      st.lastSampleAt = performance.now();
      st.pending.push(...st.last);
      schedule();
    }

    // The selected preset drives every paint tool except the block eraser.
    function presetFor() {
      if (tool === 'eraser' && toolOptionsRef.current.mode === 'block') return null;
      return currentPreset(selectedPresetRef.current);
    }

    async function paramsFor(x: number, y: number, stride: Stride, seed: number): Promise<StrokeParams | Record<string, unknown>> {
      const o = toolOptionsRef.current;
      const input = { stride, seed };
      const pencilParams = async (rgb: Rgb, mode: string) => {
        const preset = presetFor(), lib = brushLib.current;
        if (preset && lib) await lib.assets.prepare(preset);
        return presetStrokeParams(preset, o, { tool: 'pencil', rgba: [...rgb, 255], mode, bg: [...bgRef.current, 255], seed, stride, resolve: lib?.assets.resolve });
      };
      if (tool === 'pencil') {
        let rgb = fgRef.current;
        if (o.autoErase && active) {
          const [r, g, b] = await client.call('sample', x, y, 1, active.id);
          if (r === fgRef.current[0] && g === fgRef.current[1] && b === fgRef.current[2]) rgb = bgRef.current;
        }
        return pencilParams(rgb, o.mode as string);
      }
      const preset = presetFor();
      const lib = brushLib.current;
      if (preset && lib) await lib.assets.prepare(preset);
      if (tool === 'eraser') {
        // Looked up fresh (not a dep) so a doc update mid-drag never tears down the running stroke.
        const activeNode = active && docRef.current ? nodeById(docRef.current.layers, active.id) : undefined;
        const locked = !!activeNode?.locks.transparency;
        const mode = locked ? 'normal' : 'clear';
        const rgb = locked ? bgRef.current : fgRef.current;
        if (o.mode === 'block') return { rgba: [...rgb, 255], mode, size: 16 / (viewer.current?.view.zoom || 1), tip: 'square', aliased: true, ...input };
        return presetStrokeParams(preset, o, { tool: 'eraser', rgba: [...rgb, 255], mode, bg: [...bgRef.current, 255], seed, stride, resolve: lib?.assets.resolve });
      }
      return presetStrokeParams(preset, o, { tool: 'brush', rgba: [...fgRef.current, 255], mode: o.mode as string, bg: [...bgRef.current, 255], seed, stride, resolve: lib?.assets.resolve });
    }

    // One animation-frame loop per stroke while build-up or smoothing catch-up needs time-driven samples.
    function startFrames(buildUp: boolean) {
      st.buildUp = buildUp ? new BuildUp(performance.now()) : null;
      const loop = (now: number) => {
        const s = st.smoother, last = st.last;
        if (!s || !last) { st.frame = 0; return; }
        const caught = s.catchUp(now);
        if (caught) push(caught, last.slice(2));
        const n = st.buildUp?.tick(now) ?? 0;
        for (let i = 0; i < n; i++) st.pending.push(...st.last!);
        if (n) schedule();
        st.frame = requestAnimationFrame(loop);
      };
      st.frame = requestAnimationFrame(loop);
    }
    function stopFrames() {
      if (st.frame) { cancelAnimationFrame(st.frame); st.frame = 0; }
      st.buildUp = null;
    }
    function strokeParams(x: number, y: number, stride: Stride) {
      return paramsFor(x, y, stride, strokeSeed(active!.id, ++strokeCounter.current));
    }

    async function begin(e: ToolPointerEvent) {
      if (!active) return;
      const stride = strideFor(e.pointerType);
      const p = await strokeParams(e.x, e.y, stride);
      await client.call('strokeBegin', active.id, quickMask ? 'selection' : 'pixels', p, PAINT_LABELS[tool]);
      st.layerId = active.id;
      st.stride = stride;
      const preset = presetFor();
      const o = toolOptionsRef.current;
      const smoothing = smoothingFor(preset, o), buildUp = buildUpFor(preset, o, tool as PaintTool);
      st.smoother = new Smoother(smoothing, viewer.current?.view.zoom || 1);
      push(st.smoother.start([e.x, e.y], e.timeStamp), inputFields(e, stride));
      if (buildUp || smoothing.catchUp) startFrames(buildUp);
    }
    function move(e: ToolPointerEvent) {
      if (!st.smoother) return;
      st.buildUp?.moved(e.timeStamp);
      push(st.smoother.move([e.x, e.y], e.timeStamp), inputFields(e, st.stride));
    }
    async function end(e: ToolPointerEvent) {
      // A quick click releases before strokeBegin has answered; finish the begin first.
      await st.begun;
      if (!st.smoother) return;
      push(st.smoother.end([e.x, e.y], e.timeStamp), inputFields(e, st.stride));
      flush();
      stopFrames();
      st.smoother = null;
      if (st.layerId != null && st.last) lastStrokePoint.current[st.layerId] = [st.last[0], st.last[1]];
      st.layerId = null;
      run(null, () => client.call('strokeEnd'));
    }
    async function shiftLine(e: ToolPointerEvent) {
      if (!active) return;
      const from = lastStrokePoint.current[active.id];
      if (!from) return begin(e).then(() => end(e));
      const stride = strideFor(e.pointerType);
      const fields = inputFields(e, stride);
      const p = await strokeParams(from[0], from[1], stride);
      await client.call('strokeBegin', active.id, quickMask ? 'selection' : 'pixels', p, PAINT_LABELS[tool]);
      const r = await client.call('strokeTo', Float64Array.from([from[0], from[1], ...fields, e.x, e.y, ...fields]));
      viewer.current?.invalidate(r.version, r.dirty);
      lastStrokePoint.current[active.id] = [e.x, e.y];
      run(null, () => client.call('strokeEnd'));
    }

    v.onPointer = e => {
      if (!active) return;
      if (e.type === 'down') {
        if (e.shiftKey && lastStrokePoint.current[active.id]) { void shiftLine(e); return; }
        st.begun = begin(e).catch(err => setError((err as Error).message));
      } else if (e.type === 'move') {
        move(e);
      } else {
        void end(e);
      }
    };
    return () => {
      v.onPointer = () => {};
      if (st.raf) cancelAnimationFrame(st.raf);
      stopFrames();
    };
  }, [tool, active, quickMask]);
}
