// .pbaer project file: gzip( "PBAERPRJ" | u32 version | u32 len | manifest JSON | { u32 idLo | u32 idHi | u32 len | bytes }* | 0 0 0 ).
// All integers little-endian. Tile bytes are the engine's raw tile pixels.
const MAGIC = 'PBAERPRJ';
const VERSION = 1;

// Node = v1 layer (tiles only) or v2 node (pixel tiles, mask tiles, children).
type ManifestNode = { tiles?: number[]; mask?: { tiles?: number[] } | null; children?: ManifestNode[] };

export function tileIds(manifest: string): Set<number> {
  const ids = new Set<number>();
  const walk = (n: ManifestNode) => {
    for (const id of n.tiles ?? []) if (id) ids.add(id);
    for (const id of n.mask?.tiles ?? []) if (id) ids.add(id);
    for (const c of n.children ?? []) walk(c);
  };
  for (const n of (JSON.parse(manifest) as { layers: ManifestNode[] }).layers) walk(n);
  return ids;
}

function u32s(...v: number[]) {
  const b = new DataView(new ArrayBuffer(v.length * 4));
  v.forEach((x, i) => b.setUint32(i * 4, x, true));
  return b.buffer;
}

export async function packProject(manifest: string, tileBytes: (id: number) => Uint8Array): Promise<Blob> {
  const m = new TextEncoder().encode(manifest);
  const parts: BlobPart[] = [new TextEncoder().encode(MAGIC), u32s(VERSION, m.length), m];
  for (const id of tileIds(manifest)) {
    const t = tileBytes(id);
    parts.push(u32s(id % 2 ** 32, Math.floor(id / 2 ** 32), t.length), t as Uint8Array<ArrayBuffer>);
  }
  parts.push(u32s(0, 0, 0));
  return new Response(new Blob(parts).stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

export async function unpackProject(file: Blob): Promise<{ manifest: string; tiles: Map<number, Uint8Array> }> {
  let buf: ArrayBuffer;
  try {
    buf = await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  } catch {
    throw new Error('not a Photobaer project (not gzip)');
  }
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (buf.byteLength < 16 || new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) throw new Error('not a Photobaer project');
  if (dv.getUint32(8, true) !== VERSION) throw new Error(`unsupported project version ${dv.getUint32(8, true)}`);
  let at = 16 + dv.getUint32(12, true);
  if (at > buf.byteLength) throw new Error('project file truncated');
  const manifest = new TextDecoder().decode(bytes.subarray(16, at));
  const tiles = new Map<number, Uint8Array>();
  for (;;) {
    if (at + 12 > buf.byteLength) throw new Error('project file truncated');
    const id = dv.getUint32(at, true) + dv.getUint32(at + 4, true) * 2 ** 32;
    const len = dv.getUint32(at + 8, true);
    at += 12;
    if (id === 0) break;
    if (at + len > buf.byteLength) throw new Error('project file truncated');
    tiles.set(id, bytes.subarray(at, at + len));
    at += len;
  }
  return { manifest, tiles };
}
