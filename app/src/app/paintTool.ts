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
import { intensityOf, type Rgb } from '../shell/color.ts';
import type { ToolOptions } from '../shell/OptionsBar.tsx';
import { cloneSources } from '../shell/retouch.ts';
import { Smoother } from '../shell/smoothing.ts';
import type { ToolPointerEvent, Viewer } from '../viewer.ts';
import type { DocInfo, StrokeParams } from '../worker/types.ts';
import { PAINT_LABELS, PAINT_TOOLS, type Run } from './helpers.ts';

const EFFECT_TOOLS = new Set(['dodge', 'burn', 'sponge', 'blur', 'sharpen', 'smudge', 'colorReplacement', 'mixerBrush', 'backgroundEraser']);

export interface PaintToolCtx {
  viewer: RefObject<Viewer | null>; tool: string; toolOptionsRef: RefObject<ToolOptions>; currentPreset: (id: string | null) => BrushPreset | null;
  selectedPresetRef: RefObject<string | null>; brushLib: RefObject<{ library: BrushLibrary; assets: EngineAssets } | null>;
  bgRef: RefObject<Rgb>; fgRef: RefObject<Rgb>; active: Active | null; docRef: RefObject<DocInfo | null>; strokeCounter: RefObject<number>;
  quickMask: boolean; perfRef: RefObject<PerfProbe | null>; setError: Dispatch<SetStateAction<string | null>>;
  lastStrokePoint: RefObject<Record<number, [number, number]>>; run: Run;
  // Called after each painted step of a stroke, for views that follow it live.
  onStep?: () => void;
  // Brush leash while smoothing: pointer to the painted position (doc px), null when the stroke ends.
  leash?: (line: [number, number, number, number] | null) => void;
}

export function usePaintTool(c: PaintToolCtx) {
  const {
    viewer, tool, toolOptionsRef, currentPreset, selectedPresetRef, brushLib, bgRef, fgRef, active, docRef, strokeCounter, quickMask, perfRef,
    setError, lastStrokePoint, run, onStep, leash,
  } = c;
  // Brush, pencil, eraser and the stamp/heal brushes: pointermove samples are coalesced and sent as
  // one strokeTo per animation frame; the smoother runs on the document-space samples before they are queued.
  // Samples carry x, y, pressure (stride 3) or also tiltX, tiltY, twist for pen strokes (stride 6).
  useEffect(() => {
    const v = viewer.current;
    if (!v || !PAINT_TOOLS.has(tool)) return;
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
        onStep?.();
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

    async function paramsFor(x: number, y: number, stride: Stride, seed: number, alt: boolean): Promise<StrokeParams | Record<string, unknown>> {
      const o = toolOptionsRef.current;
      const input = { stride, seed };
      const pencilParams = async (rgb: Rgb, mode: string) => {
        const preset = presetFor(), lib = brushLib.current;
        if (preset && lib) await lib.assets.prepare(preset);
        return { ...presetStrokeParams(preset, o, { tool: 'pencil', rgba: [...rgb, 255], mode, bg: [...bgRef.current, 255], seed, stride, resolve: lib?.assets.resolve }), intensity: intensityOf(rgb) };
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
      const mode = EFFECT_TOOLS.has(tool) ? 'normal' : o.mode as string;
      const out = presetStrokeParams(preset, o, { tool: 'brush', rgba: [...fgRef.current, 255], mode, bg: [...bgRef.current, 255], seed, stride, resolve: lib?.assets.resolve });
      if (!EFFECT_TOOLS.has(tool)) out.intensity = intensityOf(fgRef.current);
      // Smudge spaces its dabs at most 2 % of the tip.
      if (tool === 'smudge') out.spacing = Math.min(Number(out.spacing ?? 0.25), 0.02);
      return { ...out, ...await retouchParams(x, y, alt) };
    }

    // Stamp and heal tools (docs/M5.md section 9): the color source or the heal kind of the stroke.
    async function retouchParams(x: number, y: number, alt: boolean): Promise<Record<string, unknown>> {
      const o = toolOptionsRef.current;
      const pct = (v: unknown, d: number) => (typeof v === 'number' ? v : d) / 100;
      if (tool === 'spotHealing') return { heal: o.type };
      if (tool === 'dodge' || tool === 'burn') return { effect: { kind: 'toning', tool, range: o.range, exposure: pct(o.exposure, 50), protectTones: !!o.protectTones } };
      if (tool === 'sponge') return { effect: { kind: 'sponge', mode: o.mode, vibrance: !!o.vibrance, flow: pct(o.flow, 100) } };
      if (tool === 'blur' || tool === 'sharpen') return { effect: { kind: 'focus', tool, allLayers: !!o.allLayers } };
      if (tool === 'smudge') {
        // Finger painting (the option, or Alt at stroke start, not both) starts with the foreground.
        const finger = !!o.fingerPainting !== alt;
        return { effect: { kind: 'smudge', strength: pct(o.strength, 50), allLayers: !!o.allLayers, blend: o.mode, ...(finger ? { fingerPaint: fgRef.current } : {}) } };
      }
      // Background Swatch compares against the background color instead of the pixels under the brush.
      const sampling = o.sampling === 'once' ? 'once' : 'continuous';
      const swatch = o.sampling === 'backgroundSwatch' ? { sample: bgRef.current } : {};
      const match = { tolerance: Number(o.tolerance), sampling, limits: o.limits, ...swatch };
      if (tool === 'colorReplacement') return { aliased: !o.antiAlias, effect: { kind: 'colorReplace', mode: o.mode, color: fgRef.current, ...match } };
      if (tool === 'backgroundEraser') return { effect: { kind: 'backgroundErase', ...match, ...(o.protectForeground ? { protect: fgRef.current } : {}) } };
      if (tool === 'mixerBrush') {
        // Without Load Brush After Each Stroke the engine keeps the last stroke's paint well.
        const load = o.loadAfterStroke !== false ? { color: fgRef.current } : {};
        return { effect: { kind: 'mixer', wet: pct(o.wet, 50), load: pct(o.load, 50), mix: pct(o.mix, 50), allLayers: !!o.allLayers, blend: o.mode ?? 'normal', clean: !!o.cleanAfterStroke, ...load } };
      }
      if (tool === 'historyBrush') return { historySource: true };
      if (tool === 'artHistoryBrush') return { historySource: true, art: { style: o.style, area: o.area, tolerance: pct(o.tolerance, 0) } };
      // Pattern Stamp and the Healing Brush with Source Pattern; Aligned tiles from the document origin.
      const patternSource = async () => {
        const lib = brushLib.current;
        const ref = (o.pattern as string) || lib?.library.patterns()[0]?.id;
        const patternId = ref && lib ? await lib.assets.pattern(ref) : undefined;
        if (patternId === undefined) throw new Error('Choose a pattern first.');
        return { kind: 'pattern', patternId, origin: o.aligned ? [0, 0] : [x, y], impressionist: !!o.impressionist };
      };
      if (tool === 'patternStamp') return { source: await patternSource() };
      const diffusion = Number(o.diffusion);
      if (tool === 'healingBrush' && o.source === 'pattern') return { source: await patternSource(), heal: 'healing', diffusion };
      if (tool !== 'cloneStamp' && tool !== 'healingBrush') return {};
      const slot = cloneSources.slot(), key = docRef.current?.key ?? '';
      if (!slot.anchor) throw new Error(tool === 'cloneStamp' ? 'Alt-click to set a clone source first.' : 'Alt-click to set a source for the Healing Brush.');
      if (slot.key !== key) throw new Error('The clone source is in another document. Alt-click to set a new source.');
      const map = cloneSources.beginStroke({ x, y }, key, !!o.aligned)!;
      const sample = tool === 'cloneStamp' ? o.sample : o.allLayers ? 'allLayers' : 'currentLayer';
      const source = { kind: 'clone', ...map, sample, ignoreAdjustments: !!o.ignoreAdjustments, ...(slot.layerId !== null ? { layerId: slot.layerId } : {}) };
      return tool === 'healingBrush' ? { source, heal: 'healing', diffusion } : { source };
    }

    let pointer: [number, number] | null = null;
    // One animation-frame loop per stroke while build-up or smoothing catch-up needs time-driven samples.
    function startFrames(buildUp: boolean) {
      st.buildUp = buildUp ? new BuildUp(performance.now()) : null;
      const loop = (now: number) => {
        const s = st.smoother, last = st.last;
        if (!s || !last) { st.frame = 0; return; }
        const caught = s.catchUp(now);
        if (caught) push(caught, last.slice(2));
        if (caught && pointer && st.last) leash?.([pointer[0], pointer[1], st.last[0], st.last[1]]);
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
    function strokeParams(x: number, y: number, stride: Stride, alt = false) {
      return paramsFor(x, y, stride, strokeSeed(active!.id, ++strokeCounter.current), alt);
    }

    async function begin(e: ToolPointerEvent) {
      if (!active) return;
      const stride = strideFor(e.pointerType);
      const p = await strokeParams(e.x, e.y, stride, e.altKey);
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
      pointer = [e.x, e.y];
      if (st.last) leash?.([e.x, e.y, st.last[0], st.last[1]]);
    }
    async function end(e: ToolPointerEvent) {
      // A quick click releases before strokeBegin has answered; finish the begin first.
      await st.begun;
      if (!st.smoother) return;
      push(st.smoother.end([e.x, e.y], e.timeStamp), inputFields(e, st.stride));
      flush();
      stopFrames();
      leash?.(null);
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
        // Alt-click sets the clone source of the active slot and paints nothing.
        if (e.altKey && (tool === 'cloneStamp' || tool === 'healingBrush')) {
          cloneSources.setAnchor({ x: e.x, y: e.y }, docRef.current?.key ?? '', active.id);
          return;
        }
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
