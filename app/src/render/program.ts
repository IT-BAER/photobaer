// The engine's draw program for one display tile (docs/M1.md section 3, "Draw program";
// version 2 in docs/M3.md section 2). 32-byte header, 72-byte steps, then payloads; little endian.

export const OP = {
  draw: 0, pushTransparent: 1, pushCopy: 2, pop: 3, popLerp: 4,
  pushShape: 5, divShape: 6, mulShape: 7, subBackdrop: 8, popAddBackdrop: 9, popShape: 10,
  adjust: 11, knockout: 12,
} as const;

/// `Adjust` opcodes, the `OP_*` constants of engine/src/adjust.rs.
export const ADJUST = {
  invert: 1, table: 2, vibrance: 3, hue_saturation: 4, color_balance: 5, black_white: 6,
  photo_filter: 7, channel_mixer: 8, selective_color: 9, gradient_map: 10, color_lookup: 11,
  exposure: 12, // 32-bit documents only: never in a GPU program
} as const;

/// Payload kinds: an RGBA8 tile, a mask8 tile, or an `Adjust` data block (f32 LE).
export const PAYLOAD = { rgba: 0, mask: 1, data: 2 } as const;

export const PROGRAM_VERSION = 2;
export const STEP_BYTES = 72;

export interface Step {
  op: number; maskKind: number; mode: number; flags: number; node: number;
  scale: number; maskConst: number; src: bigint; mask: bigint; opcode: number;
  /// Blend If ranges: gray, red, green, blue, each source then destination [bo, bi, wi, wo].
  blendIf: Uint8Array;
}
export interface Payload { key: bigint; kind: number; bytes: Uint8Array }
export interface Program {
  level: number; ox: number; oy: number; vw: number; vh: number;
  steps: Step[]; payloads: Payload[];
}

export function decodeProgram(buf: ArrayBuffer): Program {
  const v = new DataView(buf);
  const version = v.getUint32(0, true);
  if (version !== PROGRAM_VERSION) throw new Error(`unknown draw program version ${version}`);
  const nSteps = v.getUint32(24, true);
  const steps: Step[] = [];
  for (let i = 0; i < nSteps; i++) {
    const o = 32 + i * STEP_BYTES;
    steps.push({
      op: v.getUint8(o), maskKind: v.getUint8(o + 1), mode: v.getUint8(o + 2), flags: v.getUint8(o + 3),
      node: v.getUint32(o + 4, true), scale: v.getFloat32(o + 8, true), maskConst: v.getFloat32(o + 12, true),
      src: v.getBigUint64(o + 16, true), mask: v.getBigUint64(o + 24, true),
      opcode: v.getUint32(o + 32, true), blendIf: new Uint8Array(buf, o + 40, 32),
    });
  }
  const payloads: Payload[] = [];
  let o = 32 + nSteps * STEP_BYTES;
  for (let i = v.getUint32(28, true); i > 0; i--) {
    const len = v.getUint32(o + 12, true);
    payloads.push({
      key: v.getBigUint64(o, true),
      kind: v.getUint32(o + 8, true),
      bytes: new Uint8Array(buf, o + 16, len),
    });
    o += 16 + len;
  }
  return {
    level: v.getUint32(4, true), ox: v.getUint32(8, true), oy: v.getUint32(12, true),
    vw: v.getUint32(16, true), vh: v.getUint32(20, true), steps, payloads,
  };
}

/// Every payload key the steps reference (0 means the top of the stack, not a tile; an `Adjust`
/// src is its data block).
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
