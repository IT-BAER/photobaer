// Agent bridge: the page connects to a local photobaer-mcp server that a coding agent started, and
// serves the same tools as WebMCP plus file transfer. Pairing comes from the #agent=PORT.TOKEN fragment.
import type { ToolDef } from './webmcp.ts';

export const FORMATS = ['png', 'jpeg', 'webp', 'psd'] as const;
export type Format = typeof FORMATS[number];
export interface BridgeCtx {
  openFile: (f: File) => Promise<{ warnings: string[] } | void>;
  exportFile: (format: Format, quality?: number) => Promise<{ blob: Blob; warnings: string[] }>;
  status: (connected: boolean) => void;
}
type Socket = { onopen: (() => void) | null; onclose: (() => void) | null; onmessage: ((e: { data: string }) => void) | null; send(s: string): void; close(): void };

export function pairing(hash: string) {
  const m = /^#agent=(\d{1,5})\.([0-9a-f]{32})$/.exec(hash);
  const port = m ? Number(m[1]) : 0;
  return m && port >= 1 && port <= 65535 ? { port, token: m[2] } : null;
}

export async function toBase64(b: Blob) {
  const u = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromBase64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export function connectBridge(p: { port: number; token: string }, tools: ToolDef[], ctx: BridgeCtx, WS: new (url: string) => Socket = WebSocket as never) {
  const ws = new WS(`ws://127.0.0.1:${p.port}/?token=${p.token}`);
  const byName = new Map(tools.map(t => [t.name, t]));
  // File transfer stays off the WebMCP list: an in-page agent has no disk to read from or write to.
  const files: Record<string, (i: Record<string, unknown>) => Promise<unknown>> = {
    open_bytes: async ({ name, data }) => {
      return { opened: name, ...await ctx.openFile(new File([fromBase64(String(data))], String(name))) };
    },
    export_bytes: async ({ format, quality }) => {
      if (!FORMATS.includes(format as Format)) throw new Error(`format must be one of ${FORMATS.join(', ')}`);
      const { blob, warnings } = await ctx.exportFile(format as Format, typeof quality === 'number' ? quality : undefined);
      return { data: await toBase64(blob), warnings };
    },
  };
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', version: 1, tools: tools.map(({ execute: _, ...t }) => t) }));
    ctx.status(true);
  };
  ws.onclose = () => ctx.status(false);
  ws.onmessage = async e => {
    const { id, tool, input } = JSON.parse(e.data) as { id: number; tool: string; input: Record<string, unknown> };
    let result: unknown;
    try {
      const run = byName.get(tool)?.execute ?? files[tool];
      if (!run) throw new Error(`Unknown tool: ${tool}`);
      result = await run(input ?? {});
    } catch (err) {
      result = { error: (err as Error).message };
    }
    ws.send(JSON.stringify({ id, result }));
  };
  return { close: () => ws.close() };
}
