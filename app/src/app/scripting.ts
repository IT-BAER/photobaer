// File > Scripts > Browse: a user script runs in its own Worker (no DOM); `app` in the script is a
// proxy whose calls the page answers through `scriptHost`. The API is documented in docs/scripting.md.
import { NO_RECORD } from '../actions.ts';
import type { DocInfo } from '../worker/types.ts';

export interface ScriptDeps {
  doc(): DocInfo | null;
  call(op: string, args: unknown[]): Promise<unknown>;
  alert(message: string): void;
  download(name: string, type: string, quality: number): Promise<void>;
}

// The script's `app` object; the user text runs as the body of an async function.
const PRELUDE = `"use strict";
const pending = new Map(); let next = 0;
const ask = (kind, op, args) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); postMessage({ id, kind, op, args }); });
onmessage = e => { const m = e.data, p = pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.error !== undefined) p.reject(new Error(m.error)); else p.resolve(m.result); };
const app = Object.freeze({
  document: () => ask('document'),
  call: (op, ...args) => ask('call', op, args),
  alert: message => ask('alert', null, [String(message)]),
  download: (name, type = 'image/png', quality = 0.92) => ask('download', null, [String(name), String(type), Number(quality)]),
});
`;

export function scriptSource(text: string) {
  return `${PRELUDE}(async () => {\n${text}\n})().then(() => postMessage({ done: true }), e => postMessage({ done: true, error: e instanceof Error ? e.message : String(e) }));\n`;
}

const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

// One request from a script. Document calls are the ones an action may record: no files, tabs, history or app settings.
export async function scriptHost(kind: string, op: unknown, args: unknown, deps: ScriptDeps): Promise<unknown> {
  const a = Array.isArray(args) ? args : [];
  if (kind === 'document') return deps.doc();
  if (kind === 'alert') { deps.alert(String(a[0])); return null; }
  if (kind === 'download') {
    if (!deps.doc()) throw new Error('There is no document to download.');
    if (!TYPES.has(String(a[1]))) throw new Error(`Unsupported type "${String(a[1])}": use image/png, image/jpeg or image/webp.`);
    const q = Number(a[2]);
    await deps.download(String(a[0]), String(a[1]), Number.isFinite(q) ? Math.min(1, Math.max(0, q)) : 0.92);
    return null;
  }
  if (kind !== 'call') throw new Error(`Unknown request "${kind}".`);
  if (typeof op !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(op) || op in Object.prototype || NO_RECORD.has(op)) throw new Error(`"${String(op)}" cannot run in a script.`);
  if (!deps.doc()) throw new Error('Open a document first.');
  return deps.call(op, a);
}

// Runs `text` until it finishes; rejects with the script's error. `signal` stops it.
export function runScript(text: string, deps: ScriptDeps, signal?: AbortSignal): Promise<void> {
  const url = URL.createObjectURL(new Blob([scriptSource(text)], { type: 'text/javascript' }));
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  return new Promise<void>((resolve, reject) => {
    const end = (err?: string) => { w.terminate(); if (err === undefined) resolve(); else reject(new Error(err)); };
    signal?.addEventListener('abort', () => end('The script was stopped.'));
    w.onerror = e => { e.preventDefault(); end(e.message || 'The script could not start.'); };
    w.onmessage = async e => {
      const m = e.data as { id?: number; kind?: string; op?: unknown; args?: unknown; done?: boolean; error?: string };
      if (m.done) { end(m.error); return; }
      try {
        w.postMessage({ id: m.id, result: await scriptHost(String(m.kind), m.op, m.args, deps) });
      } catch (err) {
        w.postMessage({ id: m.id, error: err instanceof Error ? err.message : String(err) });
      }
    };
  });
}
