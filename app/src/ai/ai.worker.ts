// Runs the models: segmentation with onnxruntime-web (WebGPU when the browser has a usable adapter, else WASM on
// the CPU) and face landmarks with MediaPipe on the CPU. Both runtimes load on first use through a dynamic import,
// so they stay in their own chunks.
import type { InferenceSession } from 'onnxruntime-web';
import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import visionLoader from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';
import visionWasm from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';
import { toInput, toMask } from './tensor.ts';

export type AiRequest =
  | { id: number; op: 'load'; model: ArrayBuffer }
  | { id: number; op: 'segment'; rgba: ArrayBuffer; side: number }
  | { id: number; op: 'loadFace'; model: ArrayBuffer }
  | { id: number; op: 'faces'; rgba: ArrayBuffer; w: number; h: number };
export type AiReply = { id: number; result?: unknown; error?: string };
// Face landmarks: `count` faces of 478 (x, y) pairs normalized to the image, and the face oval's landmark indices
// in contour order.
export type FacesResult = { points: ArrayBuffer; count: number; oval: number[] };

let session: InferenceSession | null = null;
let ort: typeof import('onnxruntime-web') | null = null;
let landmarker: FaceLandmarker | null = null;
let oval: number[] = [];

// The session on WebGPU, else on WASM; returns the backend in use.
async function load(model: ArrayBuffer) {
  ort ??= await import('onnxruntime-web/webgpu');
  ort.env.wasm.numThreads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const bytes = new Uint8Array(model);
  if ('gpu' in navigator) {
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] });
      return 'webgpu';
    } catch (err) {
      console.warn('segmentation model: WebGPU failed, using WASM', err);
    }
  }
  session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  return 'wasm';
}

// The mask (side x side, 0..255) of a side x side RGBA8 image.
async function segment(rgba: ArrayBuffer, side: number) {
  if (!session || !ort) throw new Error('the model is not loaded');
  const input = new ort.Tensor('float32', toInput(new Uint8Array(rgba), side, side), [1, 3, side, side]);
  const out = await session.run({ [session.inputNames[0]]: input });
  const t = out[session.outputNames[0]];
  const mask = toMask(t.data as Float32Array);
  input.dispose();
  t.dispose();
  return mask.buffer;
}

// The face landmarker, up to 8 faces per image. Created once per worker: MediaPipe's loader clears its module
// factory after the first load, so a second one fails ("ModuleFactory not set").
async function loadFace(model: ArrayBuffer) {
  if (landmarker) return 'cpu';
  const { FaceLandmarker } = await import('@mediapipe/tasks-vision');
  const at = (u: string) => new URL(u, self.location.href).href;
  landmarker = await FaceLandmarker.createFromOptions({ wasmLoaderPath: at(visionLoader), wasmBinaryPath: at(visionWasm) }, {
    baseOptions: { modelAssetBuffer: new Uint8Array(model), delegate: 'CPU' }, runningMode: 'IMAGE', numFaces: 8,
  });
  // The oval as connections (start, end); walk them into one contour.
  const next = new Map(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL.map(c => [c.start, c.end]));
  oval = [];
  for (let i: number | undefined = FaceLandmarker.FACE_LANDMARKS_FACE_OVAL[0]?.start; i !== undefined && !oval.includes(i); i = next.get(i)) oval.push(i);
  return 'cpu';
}

function faces(rgba: ArrayBuffer, w: number, h: number) {
  if (!landmarker) throw new Error('the model is not loaded');
  const r = landmarker.detect(new ImageData(new Uint8ClampedArray(rgba), w, h));
  const points = new Float32Array(r.faceLandmarks.length * 478 * 2);
  r.faceLandmarks.forEach((f, k) => f.slice(0, 478).forEach((p, i) => { points[(k * 478 + i) * 2] = p.x; points[(k * 478 + i) * 2 + 1] = p.y; }));
  return { points: points.buffer, count: r.faceLandmarks.length, oval } satisfies FacesResult;
}

self.onmessage = async (ev: MessageEvent<AiRequest>) => {
  const m = ev.data;
  try {
    const result = m.op === 'load' ? await load(m.model)
      : m.op === 'segment' ? await segment(m.rgba, m.side)
        : m.op === 'loadFace' ? await loadFace(m.model)
          : faces(m.rgba, m.w, m.h);
    const buf = result instanceof ArrayBuffer ? result : typeof result === 'object' && 'points' in result ? result.points : null;
    postMessage({ id: m.id, result } satisfies AiReply, { transfer: buf ? [buf] : [] });
  } catch (err) {
    postMessage({ id: m.id, error: err instanceof Error ? err.message : String(err) } satisfies AiReply);
  }
};
