// Ported from OpenEXR (ImfPizCompressor, ImfHuf, ImfWav), BSD-3-Clause; see app/src/exr/LICENSE.
// OpenEXR PIZ decompression: a bitmap of the 16-bit values in use, Huffman-coded 16-bit words (with a
// run-length symbol), a 2D Haar wavelet per channel, then the values mapped back through the bitmap.
// Channels are 16-bit words: one per HALF sample, two per FLOAT or UINT sample (low word first).

const damaged = (what: string) => new Error(`The EXR file is damaged (PIZ ${what}).`);

// ---------- Huffman ----------

const ENC_SIZE = 65537, DEC_BITS = 14, DEC_SIZE = 1 << DEC_BITS;
const SHORT_ZEROCODE_RUN = 59, LONG_ZEROCODE_RUN = 63, SHORTEST_LONG_RUN = 2 + LONG_ZEROCODE_RUN - SHORT_ZEROCODE_RUN;

// Bits of `b` read most significant first from bit `pos`; bits past the end read as 0. `n` <= 52.
function peek(b: Uint8Array, pos: number, n: number): number {
  let v = 0, got = 0, at = pos >> 3, skip = pos & 7;
  while (got < n) {
    const byte = at < b.length ? b[at] : 0, take = Math.min(8 - skip, n - got);
    v = v * 2 ** take + ((byte >> (8 - skip - take)) & ((1 << take) - 1));
    got += take;
    skip = 0;
    at++;
  }
  return v;
}

/** `count` 16-bit words from the Huffman block `src` (header, code-length table, bits). */
export function hufDecode(src: Uint8Array, count: number): Uint16Array {
  const out = new Uint16Array(count);
  if (!src.length) { if (count) throw damaged('data too short'); return out; }
  if (src.length < 20) throw damaged('Huffman header');
  const v = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const im = v.getUint32(0, true), iM = v.getUint32(4, true), nBits = v.getUint32(12, true);
  if (im >= ENC_SIZE || iM >= ENC_SIZE || im > iM) throw damaged('Huffman table size');
  // Code lengths, 6 bits each; 59..62 are short and 63 + 8 bits long runs of zero lengths.
  const len = new Uint8Array(ENC_SIZE);
  const table = src.subarray(20);
  let pos = 0;
  for (let i = im; i <= iM; i++) {
    if (pos + 6 > table.length * 8) throw damaged('Huffman table');
    const l = peek(table, pos, 6);
    pos += 6;
    if (l === LONG_ZEROCODE_RUN) {
      const run = peek(table, pos, 8) + SHORTEST_LONG_RUN;
      pos += 8;
      if (i + run > iM + 1) throw damaged('Huffman table');
      i += run - 1;
    } else if (l >= SHORT_ZEROCODE_RUN) {
      const run = l - SHORT_ZEROCODE_RUN + 2;
      if (i + run > iM + 1) throw damaged('Huffman table');
      i += run - 1;
    } else len[i] = l;
  }
  const data = table.subarray((pos + 7) >> 3);
  if (nBits > data.length * 8) throw damaged('bit count');
  // Canonical codes: the longest codes take the lowest values; within a length, codes count up by symbol.
  const n = new Array<number>(59).fill(0);
  for (let i = im; i <= iM; i++) n[len[i]]++;
  for (let i = 58, c = 0; i > 0; i--) { const next = Math.floor((c + n[i]) / 2); n[i] = c; c = next; }
  const code = new Float64Array(ENC_SIZE);
  for (let i = im; i <= iM; i++) if (len[i]) code[i] = n[len[i]]++;
  // Codes up to DEC_BITS long fill every table slot they prefix; longer ones list under their first DEC_BITS bits.
  const short = new Int32Array(DEC_SIZE).fill(-1), shortLen = new Uint8Array(DEC_SIZE);
  const long = new Map<number, number[]>();
  for (let i = im; i <= iM; i++) {
    const l = len[i];
    if (!l) continue;
    if (code[i] >= 2 ** l) throw damaged('Huffman code');
    if (l > DEC_BITS) {
      const k = Math.floor(code[i] / 2 ** (l - DEC_BITS));
      if (shortLen[k]) throw damaged('Huffman code');
      const list = long.get(k);
      if (list) list.push(i); else long.set(k, [i]);
    } else {
      const k0 = code[i] * 2 ** (DEC_BITS - l);
      for (let k = k0; k < k0 + 2 ** (DEC_BITS - l); k++) {
        if (shortLen[k] || long.has(k)) throw damaged('Huffman code');
        short[k] = i;
        shortLen[k] = l;
      }
    }
  }
  // The highest symbol is the run-length code: the next 8 bits repeat the last word that many times.
  let o = 0;
  pos = 0;
  const emit = (s: number) => {
    if (s === iM) {
      if (pos + 8 > nBits || o === 0) throw damaged('run');
      const run = peek(data, pos, 8);
      pos += 8;
      if (o + run > count) throw damaged('run');
      out.fill(out[o - 1], o, o + run);
      o += run;
    } else {
      if (o >= count) throw damaged('data too long');
      out[o++] = s;
    }
  };
  while (pos < nBits) {
    const k = peek(data, pos, DEC_BITS);
    if (shortLen[k]) {
      if (pos + shortLen[k] > nBits) throw damaged('Huffman code');
      pos += shortLen[k];
      emit(short[k]);
      continue;
    }
    const s = long.get(k)?.find(c => pos + len[c] <= nBits && peek(data, pos, len[c]) === code[c]);
    if (s === undefined) throw damaged('Huffman code');
    pos += len[s];
    emit(s);
  }
  if (o !== count) throw damaged('data too short');
  return out;
}

// ---------- wavelet ----------

// 14-bit (signed) and 16-bit (modular) Haar pair decoders: [a, b] from [low, high].
function wdec14(l: number, h: number): [number, number] {
  const ls = (l << 16) >> 16, hs = (h << 16) >> 16;
  const a = ls + (hs & 1) + (hs >> 1);
  return [a & 0xffff, (a - hs) & 0xffff];
}
function wdec16(l: number, h: number): [number, number] {
  const b = (l - (h >> 1)) & 0xffff;
  return [(h + b - 0x8000) & 0xffff, b];
}

/** Inverse 2D wavelet in place over `nx` x `ny` words of `w` from `at`, `ox` apart in a row and `oy` between rows. */
function wav2Decode(w: Uint16Array, at: number, nx: number, ox: number, ny: number, oy: number, mx: number) {
  const dec = mx < 1 << 14 ? wdec14 : wdec16;
  const n = Math.min(nx, ny);
  let p = 1;
  while (p <= n) p <<= 1;
  p >>= 1;
  let p2 = p;
  p >>= 1;
  while (p >= 1) {
    const oy1 = oy * p, oy2 = oy * p2, ox1 = ox * p, ox2 = ox * p2;
    const ey = at + oy * (ny - p2);
    let py = at;
    for (; py <= ey; py += oy2) {
      const ex = py + ox * (nx - p2);
      let px = py;
      for (; px <= ex; px += ox2) {
        const p01 = px + ox1, p10 = px + oy1, p11 = p10 + ox1;
        const [i00, i10] = dec(w[px], w[p10]);
        const [i01, i11] = dec(w[p01], w[p11]);
        [w[px], w[p01]] = dec(i00, i01);
        [w[p10], w[p11]] = dec(i10, i11);
      }
      // An odd column at this level.
      if (nx & p) {
        const p10 = px + oy1;
        [w[px], w[p10]] = dec(w[px], w[p10]);
      }
    }
    // An odd row at this level.
    if (ny & p) {
      const ex = py + ox * (nx - p2);
      for (let px = py; px <= ex; px += ox2) {
        const p01 = px + ox1;
        [w[px], w[p01]] = dec(w[px], w[p01]);
      }
    }
    p2 = p;
    p >>= 1;
  }
}

// ---------- PIZ ----------

/**
 * One PIZ block of `rows` rows of `w` pixels, `words` 16-bit words per sample of each channel (1 for HALF, 2 for
 * FLOAT and UINT), to the uncompressed layout: per row, each channel's samples, little-endian.
 */
export function unPiz(src: Uint8Array, w: number, rows: number, words: number[]): Uint8Array {
  const v = new DataView(src.buffer, src.byteOffset, src.byteLength);
  if (src.length < 4) throw damaged('data too short');
  const minNonZero = v.getUint16(0, true), maxNonZero = v.getUint16(2, true);
  if (maxNonZero >= 8192) throw damaged('bitmap');
  let p = 4;
  const bitmap = new Uint8Array(8192);
  if (minNonZero <= maxNonZero) {
    const n = maxNonZero - minNonZero + 1;
    if (p + n > src.length) throw damaged('bitmap');
    bitmap.set(src.subarray(p, p + n), minNonZero);
    p += n;
  }
  // Word k of the wavelet data stands for the k-th value in use (0 always is).
  const lut = new Uint16Array(65536);
  let k = 0;
  for (let i = 0; i < 65536; i++) if (i === 0 || bitmap[i >> 3] & (1 << (i & 7))) lut[k++] = i;
  const maxValue = k - 1;
  if (p + 4 > src.length) throw damaged('data too short');
  const length = v.getInt32(p, true);
  p += 4;
  if (length < 0 || p + length > src.length) throw damaged('data too short');
  const total = words.reduce((a, s) => a + s * w * rows, 0);
  const buf = hufDecode(src.subarray(p, p + length), total);
  let at = 0;
  const starts = words.map(s => { const a = at; at += s * w * rows; return a; });
  words.forEach((s, c) => { for (let j = 0; j < s; j++) wav2Decode(buf, starts[c] + j, w, s, rows, w * s, maxValue); });
  for (let i = 0; i < total; i++) buf[i] = lut[buf[i]];
  const out = new Uint8Array(total * 2), ov = new DataView(out.buffer);
  let q = 0;
  for (let y = 0; y < rows; y++) words.forEach((s, c) => {
    const row = starts[c] + y * w * s;
    for (let x = 0; x < w * s; x++, q += 2) ov.setUint16(q, buf[row + x], true);
  });
  return out;
}
