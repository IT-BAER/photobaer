// Module worker: parses an ABR file off the UI thread. In: the file's ArrayBuffer. Out: the AbrResult, with the
// tip and pattern pixel buffers transferred.
import { parseAbr, type AbrResult } from './abr.ts';

export function abrMessage(buf: ArrayBuffer): { result: AbrResult; transfer: ArrayBuffer[] } {
  const result = parseAbr(new Uint8Array(buf));
  const transfer = new Set<ArrayBuffer>();
  for (const t of result.tips) transfer.add(t.alpha.buffer as ArrayBuffer);
  for (const p of result.patterns) transfer.add(p.data.buffer as ArrayBuffer);
  // Records that are views into the input keep it alive; the input was transferred in and is ours to send back.
  return { result, transfer: [...transfer] };
}

onmessage = (ev: MessageEvent<ArrayBuffer>) => {
  const { result, transfer } = abrMessage(ev.data);
  postMessage(result, { transfer });
};
