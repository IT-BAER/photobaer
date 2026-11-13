// Baseline JPEG of one gray component (ITU T.81 with JFIF 1.02): the JPEG export of a Grayscale document.
// The browser's canvas encoder always writes three components.

// Natural-order index of each zigzag position.
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
// T.81 table K.1, luminance quantization, natural order.
const LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
// T.81 tables K.3 and K.5: luminance DC and AC codes as counts per length 1..16 and the values in code order.
const DC_COUNTS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_COUNTS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

// Code and length per value (T.81 annex C): codes count up within a length and shift left between lengths.
function huffman(counts: number[], values: number[]): { code: number[]; size: number[] } {
  const code: number[] = [], size: number[] = [];
  let c = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++, k++, c++) { code[values[k]] = c; size[values[k]] = len; }
    c <<= 1;
  }
  return { code, size };
}
const DC = huffman(DC_COUNTS, DC_VALUES), AC = huffman(AC_COUNTS, AC_VALUES);

// The luminance table scaled for quality 1..100 as the IJG library does (50 is table K.1).
export function quantTable(quality: number): number[] {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  return LUMA_Q.map(v => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}

// cos((2x + 1) u pi / 16) * C(u) / 2, for the separable 8 x 8 forward DCT.
const COS = Array.from({ length: 64 }, (_, i) => {
  const u = i >> 3, x = i & 7;
  return Math.cos((2 * x + 1) * u * Math.PI / 16) * (u ? 0.5 : Math.SQRT1_2 / 2);
});

class Bits {
  out: number[] = [];
  #acc = 0;
  #n = 0;
  put(code: number, len: number) {
    for (let i = len - 1; i >= 0; i--) {
      this.#acc = (this.#acc << 1) | ((code >> i) & 1);
      if (++this.#n === 8) this.#flush();
    }
  }
  #flush() {
    this.out.push(this.#acc);
    if (this.#acc === 0xff) this.out.push(0);
    this.#acc = 0;
    this.#n = 0;
  }
  // The last byte is padded with 1 bits.
  end() { while (this.#n) this.put(1, 1); }
}

// A value's category (bit count) and its bits (negative values as value - 1 in that many bits).
const category = (v: number) => (v ? 32 - Math.clz32(Math.abs(v)) : 0);
const valueBits = (v: number, n: number) => (v < 0 ? v + (1 << n) - 1 : v);

const u16 = (v: number) => [v >> 8, v & 0xff];
const segment = (marker: number, body: number[]) => [0xff, marker, ...u16(body.length + 2), ...body];

/**
 * A one-component JPEG of straight RGBA `rgba` (gray from red), transparency matted with white; `quality` 0..1
 * as the canvas encoder takes it.
 */
export function encodeGrayJpeg(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, quality = 0.92): Uint8Array<ArrayBuffer> {
  const q = quantTable(quality * 100);
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3];
    gray[i] = a === 255 ? rgba[i * 4] : Math.round((rgba[i * 4] * a) / 255 + 255 - a);
  }
  const bits = new Bits();
  const block = new Float64Array(64), tmp = new Float64Array(64);
  let prevDc = 0;
  for (let by = 0; by < h; by += 8) for (let bx = 0; bx < w; bx += 8) {
    // Edge blocks repeat the last row and column.
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) block[y * 8 + x] = gray[Math.min(h - 1, by + y) * w + Math.min(w - 1, bx + x)] - 128;
    for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += COS[u * 8 + x] * block[y * 8 + x];
      tmp[y * 8 + u] = s;
    }
    for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += COS[v * 8 + y] * tmp[y * 8 + u];
      block[v * 8 + u] = s;
    }
    const zz = ZIGZAG.map(i => Math.round(block[i] / q[i]));
    const diff = zz[0] - prevDc, dn = category(diff);
    prevDc = zz[0];
    bits.put(DC.code[dn], DC.size[dn]);
    if (dn) bits.put(valueBits(diff, dn), dn);
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = zz[k];
      if (!v) { run++; continue; }
      for (; run > 15; run -= 16) bits.put(AC.code[0xf0], AC.size[0xf0]);
      const n = category(v), sym = (run << 4) | n;
      bits.put(AC.code[sym], AC.size[sym]);
      bits.put(valueBits(v, n), n);
      run = 0;
    }
    if (run) bits.put(AC.code[0], AC.size[0]);
  }
  bits.end();
  const bytes = [
    0xff, 0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xdb, [0, ...ZIGZAG.map(i => q[i])]),
    ...segment(0xc0, [8, ...u16(h), ...u16(w), 1, 1, 0x11, 0]),
    ...segment(0xc4, [0x00, ...DC_COUNTS, ...DC_VALUES]),
    ...segment(0xc4, [0x10, ...AC_COUNTS, ...AC_VALUES]),
    ...segment(0xda, [1, 1, 0x00, 0, 63, 0]),
  ];
  const out = new Uint8Array(bytes.length + bits.out.length + 2);
  out.set(bytes);
  out.set(bits.out, bytes.length);
  out.set([0xff, 0xd9], bytes.length + bits.out.length);
  return out;
}
