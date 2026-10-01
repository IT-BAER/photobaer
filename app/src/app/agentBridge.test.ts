import test from 'node:test';
import assert from 'node:assert/strict';
import { connectBridge, pairing } from './agentBridge.ts';
import type { ToolDef } from './webmcp.ts';

class FakeSocket {
  static last: FakeSocket;
  sent: unknown[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  url: string;
  constructor(url: string) { this.url = url; FakeSocket.last = this; }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; this.onclose?.(); }
}
const tick = () => new Promise(r => setTimeout(r, 0));

test('pairing reads port and token from the #agent fragment', () => {
  const token = 'ab'.repeat(16);
  assert.deepEqual(pairing(`#agent=4321.${token}`), { port: 4321, token });
  for (const bad of ['', '#agent=0.' + token, '#agent=70000.' + token, '#agent=4321.xyz', '#other=1', `#agent=4321.${token}x`]) assert.equal(pairing(bad), null, bad);
});

test('the bridge sends the tool list, answers calls and transfers files as base64', async () => {
  const tools: ToolDef[] = [{
    name: 'echo', title: 'Echo', description: 'd', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true },
    execute: async i => ({ got: i }),
  }];
  const opened: File[] = [], status: boolean[] = [];
  const b = connectBridge({ port: 4321, token: 'ab'.repeat(16) }, tools, {
    openFile: async f => { opened.push(f); },
    exportFile: async (format, quality) => (format === 'png' ? { blob: new Blob([new Uint8Array([1, 2, 255])]), warnings: [String(quality)] } : Promise.reject(new Error('boom'))),
    status: s => status.push(s),
  }, FakeSocket as never);
  const ws = FakeSocket.last;
  assert.equal(ws.url, `ws://127.0.0.1:4321/?token=${'ab'.repeat(16)}`);

  ws.onopen!();
  assert.deepEqual(ws.sent[0], { type: 'hello', version: 1, tools: [{ name: 'echo', title: 'Echo', description: 'd', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] });
  assert.deepEqual(status, [true]);

  const reply = async (msg: object) => { ws.sent.length = 0; ws.onmessage!({ data: JSON.stringify(msg) }); for (let i = 0; i < 5 && !ws.sent.length; i++) await tick(); return ws.sent[0]; };
  assert.deepEqual(await reply({ id: 1, tool: 'echo', input: { a: 1 } }), { id: 1, result: { got: { a: 1 } } });
  assert.deepEqual(await reply({ id: 2, tool: 'nope', input: {} }), { id: 2, result: { error: 'Unknown tool: nope' } });

  assert.deepEqual(await reply({ id: 3, tool: 'open_bytes', input: { name: 'x.png', data: btoa('\x01\x02\xff') } }), { id: 3, result: { opened: 'x.png' } });
  assert.equal(opened[0].name, 'x.png');
  assert.deepEqual([...new Uint8Array(await opened[0].arrayBuffer())], [1, 2, 255]);

  assert.deepEqual(await reply({ id: 4, tool: 'export_bytes', input: { format: 'png', quality: 0.5 } }), { id: 4, result: { data: btoa('\x01\x02\xff'), warnings: ['0.5'] } });
  assert.deepEqual(await reply({ id: 5, tool: 'export_bytes', input: { format: 'psd' } }), { id: 5, result: { error: 'boom' } });

  b.close();
  assert.equal(ws.closed, true);
  assert.deepEqual(status, [true, false]);
});
