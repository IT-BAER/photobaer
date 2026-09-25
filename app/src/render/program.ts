// The engine's draw program for one display tile (docs/M1.md section 3, "Draw program").
// 32-byte header, 32-byte steps, then payloads; all little endian.

export const OP = {
  draw: 0, pushTransparent: 1, pushCopy: 2, pop: 3, popLerp: 4,
  pushShape: 5, divShape: 6, mulShape: 7, subBackdrop: 8, popAddBackdrop: 9, popShape: 10,
} as const;

export interface Step {
  op: number; maskKind: number; mode: number; node: number;
  scale: number; maskConst: number; src: bigint; mask: bigint;
}
export interface Payload { key: bigint; mask: boolean; bytes: Uint8Array }
export interface Program {
  level: number; ox: number; oy: number; vw: number; vh: number;
  steps: Step[]; payloads: Payload[];
}

export function decodeProgram(buf: ArrayBuffer): Program {
  const v = new DataView(buf);
  const version = v.getUint32(0, true);
  if (version !== 1) throw new Error(`unknown draw program version ${version}`);
  const nSteps = v.getUint32(24, true);
  const steps: Step[] = [];
  for (let i = 0; i < nSteps; i++) {
    const o = 32 + i * 32;
    steps.push({
      op: v.getUint8(o), maskKind: v.getUint8(o + 1), mode: v.getUint8(o + 2),
      node: v.getUint32(o + 4, true), scale: v.getFloat32(o + 8, true), maskConst: v.getFloat32(o + 12, true),
      src: v.getBigUint64(o + 16, true), mask: v.getBigUint64(o + 24, true),
    });
  }
  const payloads: Payload[] = [];
  let o = 32 + nSteps * 32;
  for (let i = v.getUint32(28, true); i > 0; i--) {
    const len = v.getUint32(o + 12, true);
    payloads.push({
      key: v.getBigUint64(o, true),
      mask: v.getUint32(o + 8, true) === 1,
      bytes: new Uint8Array(buf, o + 16, len),
    });
    o += 16 + len;
  }
  return {
    level: v.getUint32(4, true), ox: v.getUint32(8, true), oy: v.getUint32(12, true),
    vw: v.getUint32(16, true), vh: v.getUint32(20, true), steps, payloads,
  };
}

/// Every payload key the steps reference (0 means the top of the stack, not a tile).
export function referencedKeys(p: Program): bigint[] {
  const out = new Set<bigint>();
  for (const s of p.steps) {
    if (s.src !== 0n) out.add(s.src);
    if (s.maskKind === 2) out.add(s.mask);
  }
  return [...out];
}

/// Byte-bounded LRU of GPU payload tiles. `keys()` is what the worker gets as `known`, so an
/// evicted key is asked for again instead of being referenced without its bytes.
export class PayloadCache<T> {
  #map = new Map<bigint, { value: T; bytes: number }>();
  #bytes = 0;
  #limit: number;
  #dispose: (v: T) => void;
  constructor(limit: number, dispose: (v: T) => void) {
    this.#limit = limit;
    this.#dispose = dispose;
  }

  get size() { return this.#bytes; }

  get(key: bigint): T | undefined {
    const e = this.#map.get(key);
    if (!e) return undefined;
    this.#map.delete(key);
    this.#map.set(key, e);
    return e.value;
  }

  set(key: bigint, value: T, bytes: number) {
    const old = this.#map.get(key);
    if (old) {
      this.#bytes -= old.bytes;
      this.#dispose(old.value);
      this.#map.delete(key);
    }
    this.#map.set(key, { value, bytes });
    this.#bytes += bytes;
    this.#evict(key);
  }

  get limit() { return this.#limit; }

  set limit(bytes: number) {
    this.#limit = bytes;
    this.#evict();
  }

  delete(key: bigint) {
    const e = this.#map.get(key);
    if (!e) return;
    this.#map.delete(key);
    this.#bytes -= e.bytes;
    this.#dispose(e.value);
  }

  // Least recently used first, never `keep`.
  #evict(keep?: bigint) {
    for (const k of this.#map.keys()) {
      if (this.#bytes <= this.#limit) break;
      if (k !== keep) this.delete(k);
    }
  }

  keys(): BigUint64Array {
    return BigUint64Array.from(this.#map.keys());
  }

  clear() {
    for (const e of this.#map.values()) this.#dispose(e.value);
    this.#map.clear();
    this.#bytes = 0;
  }
}
