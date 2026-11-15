// Models photobaer downloads on first use, at a pinned revision with a known size and sha256, kept in Cache
// Storage so later uses work offline. docs/PLAN.md section 3 lists their licences.
import { t } from '@lingui/core/macro';
import '../i18n/index.ts'; // activates English before `t` runs outside the app (node tests)

export interface Model { id: string; kind: 'segmentation' | 'face'; name: string; url: string; bytes: number; sha256: string; license: string }

// IS-Net general use (Qin et al. 2022), fp16 weights with float32 input and output, 1024 x 1024: Select Subject,
// Object Selection, Remove Background and Select Background.
export const SEGMENTATION = {
  id: 'isnet-general-fp16',
  kind: 'segmentation',
  name: 'IS-Net',
  url: 'https://huggingface.co/imgly/isnet-general-onnx/resolve/440dea96dd4a3b06bbbf5abec3e26569dd7ec49f/onnx/model_fp16.onnx',
  bytes: 88_152_708,
  sha256: '2eb4b5dda7ec41c617e59706e5aafa1f978c9a5f983d2518d9f0ae4d6eb04f20',
  license: 'Apache-2.0',
  side: 1024,
} satisfies Model & { side: number };

// MediaPipe Face Landmarker (face detector and Face Mesh V2, 478 landmarks), float16, run with
// @mediapipe/tasks-vision: Face-Aware Liquify. Licence per Google's model card.
export const FACE: Model = {
  id: 'face-landmarker-fp16-1',
  kind: 'face',
  name: 'Face Landmarker',
  url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  bytes: 3_758_596,
  sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
  license: 'Apache-2.0',
};

export const MODEL_CACHE = 'photobaer-models';

async function sha256(b: Uint8Array<ArrayBuffer>) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b));
  return [...d].map(x => x.toString(16).padStart(2, '0')).join('');
}

// The model's bytes from Cache Storage; null when it was never downloaded or the browser has no Cache Storage.
export async function cachedModel(m: Model): Promise<ArrayBuffer | null> {
  if (typeof caches === 'undefined') return null;
  const r = await (await caches.open(MODEL_CACHE)).match(m.url);
  return r ? r.arrayBuffer() : null;
}

// Downloads `m`; `progress` gets the bytes received so far. Kept only when its size and sha256 match.
export async function downloadModel(m: Model, progress: (bytes: number) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
  const r = await fetch(m.url, { signal, credentials: 'omit' });
  const status = r.status;
  if (!r.ok || !r.body) throw new Error(t`The model download failed (HTTP ${status}).`);
  const buf = new Uint8Array(m.bytes), reader = r.body.getReader();
  const damaged = () => new Error(t`The downloaded model is damaged. Try again.`);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > m.bytes) { await reader.cancel(); throw damaged(); }
    buf.set(value, got);
    got += value.length;
    progress(got);
  }
  if (got !== m.bytes || await sha256(buf) !== m.sha256) throw damaged();
  if (typeof caches !== 'undefined') await (await caches.open(MODEL_CACHE)).put(m.url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } }));
  return buf.buffer;
}
