import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import { createServer } from './server.ts';
import { PAGE_TOOLS } from './tools.ts';

type Msg = { id: number; tool: string; input: Record<string, unknown> };

// A fake photobaer tab: answers tool calls from a handler map.
function page(url: string, origin: string, handlers: Record<string, (i: Record<string, unknown>) => unknown> = {}) {
  const ws = new WebSocket(url, { origin });
  const seen: Msg[] = [];
  ws.on('message', d => {
    const m = JSON.parse(String(d)) as Msg;
    seen.push(m);
    ws.send(JSON.stringify({ id: m.id, result: handlers[m.tool]?.(m.input) ?? { error: `no handler ${m.tool}` } }));
  });
  const opened = new Promise<void>((ok, fail) => { ws.on('open', () => ok()); ws.on('error', fail); ws.on('unexpected-response', (_q, r) => fail(new Error(`HTTP ${r.statusCode}`))); });
  return { ws, seen, opened };
}
const hello = { type: 'hello', version: 1, tools: [
  { name: 'get_document', title: 'Get document', description: 'd', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'get_preview', title: 'Get preview', description: 'p', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'new_tab_tool', title: 'New', description: 'n', inputSchema: { type: 'object', properties: {} }, annotations: {} },
] };
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

test('pairs one photobaer tab and mirrors its tools, files and images to the agent', async () => {
  let link = '', opens = 0;
  const server = createServer({ url: 'https://photobaer.com/', open: u => { link = u; opens++; } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed++; });
  await Promise.all([server.connect(a), client.connect(b)]);
  const names = async () => (await client.listTools()).tools.map(t => t.name).sort();

  const shipped = ['connect', ...PAGE_TOOLS.map(t => t.name), 'open_file', 'save_file'].sort();
  assert.deepEqual(await names(), shipped, 'the shipped page tools are listed before a tab connects');
  assert.match(text(await client.callTool({ name: 'get_document', arguments: {} })), /not connected\. Call connect first/);
  assert.match(text(await client.callTool({ name: 'nope', arguments: {} })), /Unknown tool/);

  const connecting = client.callTool({ name: 'connect', arguments: {} });
  while (!link) await new Promise(r => setTimeout(r, 5));
  const second = client.callTool({ name: 'connect', arguments: {} });
  const m = /^https:\/\/photobaer\.com\/#agent=(\d+)\.([0-9a-f]{32})$/.exec(link);
  assert.ok(m, link);
  const ws = (token: string) => `ws://127.0.0.1:${m![1]}/?token=${token}`;

  await assert.rejects(page(ws(m![2]), 'https://evil.example').opened, /HTTP 403/, 'foreign origin');
  await assert.rejects(page(ws('0'.repeat(32)), 'https://photobaer.com').opened, /HTTP 403/, 'wrong token');

  const dir = await mkdtemp(join(tmpdir(), 'pbmcp-'));
  const tab = page(ws(m![2]), 'https://photobaer.com', {
    get_document: () => ({ name: 'x', width: 2, height: 1 }),
    get_preview: () => ({ image: { mimeType: 'image/png', data: 'iVBO' }, width: 2, height: 1 }),
    open_bytes: i => ({ opened: i.name }),
    export_bytes: i => (i.format === 'png' ? { data: Buffer.from([7, 8, 9]).toString('base64'), warnings: [] } : { error: 'nope' }),
  });
  await tab.opened;
  await assert.rejects(page(ws(m![2]), 'https://photobaer.com').opened, /HTTP 409/, 'second tab');
  tab.ws.send(JSON.stringify(hello));
  assert.match(text(await connecting), /Connected/);
  assert.match(text(await second), /Connected/, 'a second waiting connect call also resolves');
  assert.equal(opens, 1, 'the browser opens once per link');
  assert.equal(changed, 1);
  assert.deepEqual(await names(), [...shipped, 'new_tab_tool'].sort(), 'a newer tab adds its tools');

  assert.deepEqual(JSON.parse(text(await client.callTool({ name: 'get_document', arguments: {} }))), { name: 'x', width: 2, height: 1 });
  const shot = await client.callTool({ name: 'get_preview', arguments: {} }) as { content: object[] };
  assert.deepEqual(shot.content, [{ type: 'image', mimeType: 'image/png', data: 'iVBO' }, { type: 'text', text: '{"width":2,"height":1}' }]);

  const src = join(dir, 'in.png');
  await writeFile(src, Buffer.from([1, 2, 3]));
  const opened = JSON.parse(text(await client.callTool({ name: 'open_file', arguments: { path: src } })));
  assert.deepEqual(opened, { opened: 'in.png', document: { name: 'x', width: 2, height: 1 } });
  assert.deepEqual(tab.seen.find(s => s.tool === 'open_bytes')!.input, { name: 'in.png', data: Buffer.from([1, 2, 3]).toString('base64') });
  const missing = await client.callTool({ name: 'open_file', arguments: { path: join(dir, 'none.png') } });
  assert.equal(missing.isError, true);

  const out = join(dir, 'out.png');
  assert.match(text(await client.callTool({ name: 'save_file', arguments: { path: out } })), /out\.png/);
  assert.deepEqual([...await readFile(out)], [7, 8, 9]);
  assert.deepEqual(tab.seen.at(-1)!.input, { format: 'png' });
  const again = await client.callTool({ name: 'save_file', arguments: { path: out } });
  assert.equal(again.isError, true);
  assert.match(text(again), /exists/);
  const bad = await client.callTool({ name: 'save_file', arguments: { path: join(dir, 'a.tif') } });
  assert.match(text(bad), /format/);
  const failed = await client.callTool({ name: 'save_file', arguments: { path: join(dir, 'a.psd') } });
  assert.equal(failed.isError, true);
  assert.match(text(failed), /nope/);

  tab.ws.close();
  while (changed < 2) await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(await names(), shipped);
  await assert.rejects(page(ws(m![2]), 'https://photobaer.com').opened, /HTTP 403/, 'a used token does not pair again');
  await client.close();
  await server.close();
});

test('a tab that sends malformed frames is closed and the server keeps running', async () => {
  const server = createServer({ url: 'http://localhost:5174/', open: null });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  // The link stays valid because none of these tabs completes a hello.
  const m = /#agent=(\d+)\.([0-9a-f]{32})/.exec(text(await client.callTool({ name: 'connect', arguments: {} })))!;
  for (const frame of ['null', '7', '{"type":"hello","version":1,"tools":"x"}']) {
    const tab = page(`ws://127.0.0.1:${m[1]}/?token=${m[2]}`, 'http://localhost:5174');
    await tab.opened;
    const closed = new Promise(r => tab.ws.on('close', r));
    tab.ws.send(frame);
    await closed;
    assert.ok((await client.listTools()).tools.length > 3, `server still answers after ${frame}`);
  }
  await client.close();
  await server.close();
});

test('without a browser launcher, connect returns the link and the next call waits for that tab', async () => {
  const server = createServer({ url: 'http://localhost:5174/', open: null });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const first = text(await client.callTool({ name: 'connect', arguments: {} }));
  const m = /http:\/\/localhost:5174\/#agent=(\d+)\.([0-9a-f]{32})/.exec(first);
  assert.ok(m, first);
  const waiting = client.callTool({ name: 'connect', arguments: {} });
  const tab = page(`ws://127.0.0.1:${m[1]}/?token=${m[2]}`, 'http://localhost:5174');
  await tab.opened;
  tab.ws.send(JSON.stringify(hello));
  assert.match(text(await waiting), /Connected/);
  await client.close();
  await server.close();
});
