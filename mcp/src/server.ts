// photobaer-mcp: an MCP server over stdio that drives a photobaer browser tab through a loopback WebSocket.
// The tab connects as the client after the connect tool opens it with #agent=PORT.TOKEN.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer, type WebSocket } from 'ws';
import { PAGE_TOOLS } from './tools.ts';

export const DEFAULT_URL = 'https://photobaer.com/';
const ORIGINS = ['https://photobaer.com', 'https://www.photobaer.com'];
// Below the 60 s default tool timeout of common agents; connect can be called again with the same link.
const CONNECT_TIMEOUT_MS = 50_000;
const FORMATS: Record<string, string> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp', '.psd': 'psd', '.pbaer': 'project' };

// Opens the default browser without a shell, so the URL is never parsed by one.
export function launch(url: string) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

const own: Tool[] = [
  {
    name: 'connect', title: 'Connect to photobaer',
    description: 'Opens photobaer in the default browser and pairs this server with that tab. Call this first; the photobaer tools appear once the tab is connected. '
      + 'Chrome may ask the user to allow access to apps on this device. Returns the pairing URL if the tab does not connect in time.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'open_file', title: 'Open file',
    description: 'Opens an image file from disk in photobaer (PNG, JPEG, WebP, GIF, BMP, PSD or .pbaer project). Relative paths resolve against the server working directory.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'save_file', title: 'Save file',
    description: 'Saves the open document to disk. The format follows the extension (.png, .jpg, .webp, .psd, .pbaer) unless format is given. Refuses to replace a file unless overwrite is true.',
    inputSchema: {
      type: 'object', required: ['path'],
      properties: {
        path: { type: 'string' }, format: { type: 'string', enum: ['png', 'jpeg', 'webp', 'psd', 'project'] },
        quality: { type: 'number', minimum: 0, maximum: 1 }, overwrite: { type: 'boolean' },
      },
    },
  },
];

const ok = (v: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

// open: null leaves the browser to the user; connect then returns the link first and waits on the next call.
export function createServer({ url = DEFAULT_URL, open = launch }: { url?: string; open?: ((url: string) => void) | null } = {}) {
  const origins = new Set([...ORIGINS, new URL(url).origin]);
  const server = new Server({ name: 'photobaer', version: '0.1.1' }, { capabilities: { tools: { listChanged: true } } });
  let wss: WebSocketServer | null = null, port = 0, token = '';
  let tab: WebSocket | null = null, tabTools: Tool[] = [];
  const waiting: (() => void)[] = [];
  const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  let nextId = 1;

  function call(tool: string, input: object): Promise<unknown> {
    if (!tab || !tabTools.length) return Promise.reject(new Error('photobaer is not connected. Call connect first.'));
    const id = nextId++, ws = tab;
    return new Promise((ok, fail) => { pending.set(id, { ok, fail }); ws.send(JSON.stringify({ id, tool, input })); });
  }
  // The page reports failures as { error } results.
  async function checked(tool: string, input: object) {
    const r = await call(tool, input) as { error?: string };
    if (r && typeof r === 'object' && typeof r.error === 'string') throw new Error(r.error);
    return r;
  }

  function listen() {
    if (wss) return Promise.resolve();
    wss = new WebSocketServer({
      host: '127.0.0.1', port: 0, maxPayload: 2 ** 30,
      verifyClient: ({ origin, req }, done) => {
        const t = new URL(req.url ?? '/', 'http://x').searchParams.get('token');
        if (!origins.has(origin) || !token || t !== token) return done(false, 403);
        if (tab) return done(false, 409);
        done(true);
      },
    });
    wss.on('connection', ws => {
      tab = ws;
      ws.on('message', d => {
        let m;
        try { m = JSON.parse(String(d)); } catch { ws.close(1003, 'Invalid JSON'); return; }
        if (!m || typeof m !== 'object') { ws.close(1003, 'Invalid message'); return; }
        if (m.type === 'hello') {
          if (m.version !== 1 || !Array.isArray(m.tools)) { ws.close(1002, 'Unsupported photobaer bridge version'); return; }
          tabTools = m.tools;
          // A pairing link works once.
          token = '';
          void server.sendToolListChanged().catch(() => {});
          for (const w of waiting.splice(0)) w();
          return;
        }
        pending.get(m.id)?.ok(m.result);
        pending.delete(m.id);
      });
      ws.on('close', () => {
        if (tab !== ws) return;
        tab = null;
        tabTools = [];
        for (const p of pending.values()) p.fail(new Error('photobaer disconnected'));
        pending.clear();
        void server.sendToolListChanged().catch(() => {});
      });
    });
    return new Promise<void>((ok, fail) => {
      wss!.once('listening', () => { port = (wss!.address() as { port: number }).port; ok(); });
      wss!.once('error', fail);
    });
  }

  async function connect() {
    if (tab && tabTools.length) return ok({ connected: true, tools: tabTools.map(t => t.name) });
    await listen();
    // A new link opens the browser once; later calls only wait for that tab.
    const fresh = !token;
    if (fresh) token = randomBytes(16).toString('hex');
    const link = `${url}#agent=${port}.${token}`;
    if (fresh && !open) return { content: [{ type: 'text', text: `Ask the user to open this URL in Chrome, Edge or Firefox, then call connect again to wait for the tab: ${link}` }] };
    const done = new Promise<boolean>(r => { waiting.push(() => r(true)); setTimeout(() => r(false), CONNECT_TIMEOUT_MS).unref(); });
    if (fresh) open?.(link);
    if (!await done) return fail(`photobaer did not connect within ${CONNECT_TIMEOUT_MS / 1000} s. Ask the user to open this URL in Chrome, Edge or Firefox and allow access to apps on this device if asked, then call connect again to keep waiting: ${link}`);
    return { content: [{ type: 'text', text: `Connected. photobaer tools: ${tabTools.map(t => t.name).join(', ')}` }] };
  }

  async function openFile({ path }: Record<string, unknown>) {
    const file = resolve(String(path));
    const data = (await readFile(file)).toString('base64');
    const r = await checked('open_bytes', { name: basename(file), data });
    return ok({ ...r as object, document: await checked('get_document', {}) });
  }

  async function saveFile({ path, format, quality, overwrite }: Record<string, unknown>) {
    const file = resolve(String(path));
    const fmt = typeof format === 'string' ? format : FORMATS[extname(file).toLowerCase()];
    if (!fmt) return fail(`Cannot tell the format of ${file}. Pass format: png, jpeg, webp, psd or project.`);
    if (!overwrite && await access(file).then(() => true, () => false)) return fail(`${file} exists. Pass overwrite: true to replace it.`);
    const r = await checked('export_bytes', { format: fmt, ...(typeof quality === 'number' ? { quality } : {}) }) as { data: string; warnings: string[] };
    const bytes = Buffer.from(r.data, 'base64');
    await writeFile(file, bytes);
    return ok({ saved: file, format: fmt, bytes: bytes.length, warnings: r.warnings });
  }

  // An { image } result becomes MCP image content so the agent sees it; the rest stays JSON text.
  function toResult(r: unknown): CallToolResult {
    const { error, image, ...rest } = (r && typeof r === 'object' ? r : { value: r }) as { error?: string; image?: { mimeType: string; data: string } };
    if (typeof error === 'string') return fail(error);
    if (!image) return ok(r);
    return { content: [{ type: 'image', mimeType: image.mimeType, data: image.data }, { type: 'text', text: JSON.stringify(rest) }] };
  }

  // Some agents read the list only once, so the shipped page tools are listed before a tab connects;
  // a connected tab's own definitions win and may add tools newer than this package.
  const pageTools = () => [...tabTools, ...(PAGE_TOOLS as Tool[]).filter(s => !tabTools.some(t => t.name === s.name))];
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...own, ...pageTools()] }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
    try {
      if (name === 'connect') return await connect();
      if (name === 'open_file') return await openFile(args);
      if (name === 'save_file') return await saveFile(args);
      if (!pageTools().some(t => t.name === name)) return fail(`Unknown tool: ${name}`);
      return toResult(await call(name, args));
    } catch (e) {
      return fail((e as Error).message);
    }
  });
  server.onclose = () => { tab?.close(); wss?.close(); };
  return server;
}
