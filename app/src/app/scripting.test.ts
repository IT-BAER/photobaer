import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { scriptHost, scriptSource, type ScriptDeps } from './scripting.ts';
import type { DocInfo } from '../worker/types.ts';

function deps(doc: object | null = { name: 'a', layers: [{ id: 1 }] }) {
  const calls: unknown[][] = [], alerts: string[] = [], downloads: unknown[][] = [];
  const d: ScriptDeps = {
    doc: () => doc as DocInfo | null,
    call: async (op, args) => { calls.push([op, ...args]); return { ok: op }; },
    alert: m => { alerts.push(m); },
    download: async (...a) => { downloads.push(a); },
  };
  return { d, calls, alerts, downloads };
}

// Runs a script's source as its worker would, answering requests with scriptHost.
function run(text: string, d: ScriptDeps) {
  return new Promise<string | undefined>(resolve => {
    const ctx: Record<string, unknown> = {};
    ctx.postMessage = async (m: { id?: number; kind?: string; op?: unknown; args?: unknown; done?: boolean; error?: string }) => {
      if (m.done) { resolve(m.error); return; }
      const reply = await scriptHost(String(m.kind), m.op, m.args, d).then(result => ({ id: m.id, result }), (e: Error) => ({ id: m.id, error: e.message }));
      (ctx.onmessage as (e: { data: unknown }) => void)({ data: reply });
    };
    vm.runInNewContext(scriptSource(text), ctx);
  });
}

test('a script reads the document, calls edits and alerts through app', async () => {
  const { d, calls, alerts, downloads } = deps();
  const err = await run(`
    const doc = await app.document();
    const r = await app.call('command', 'invert', doc.layers[0].id, 'pixels');
    await app.alert(doc.name + ' ' + r.ok);
    await app.download('out.jpg', 'image/jpeg', 2);
  `, d);
  assert.equal(err, undefined);
  assert.deepEqual(calls, [['command', 'invert', 1, 'pixels']]);
  assert.deepEqual(alerts, ['a command']);
  assert.deepEqual(downloads, [['out.jpg', 'image/jpeg', 1]]);
});

test('a script cannot call app-level ops and its errors end it with the message', async () => {
  const { d, calls } = deps();
  for (const op of ['openFile', 'closeDoc', 'undo', 'playAction', 'constructor', '__proto__', 'Foo']) {
    assert.equal(await run(`await app.call(${JSON.stringify(op)})`, d), `"${op}" cannot run in a script.`);
  }
  assert.equal(await run('throw new Error("boom")', d), 'boom');
  assert.equal(await run('await app.download("x.gif", "image/gif")', d), 'Unsupported type "image/gif": use image/png, image/jpeg or image/webp.');
  assert.equal(calls.length, 0);
  assert.equal(await run('await app.call("addLayer", 1)', deps(null).d), 'Open a document first.');
});
