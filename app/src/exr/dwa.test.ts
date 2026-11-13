import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflate } from 'pako';
import { unDwa } from './dwa.ts';

// A DWA block of version 2 with no channel rules and `sizes` (11 header fields) before `data`.
function block(sizes: Partial<Record<'unknownRaw' | 'unknownSize' | 'acSize' | 'dcSize' | 'rleSize' | 'rleRaw' | 'rleFull' | 'acCount' | 'dcCount', number>>, data: Uint8Array) {
  const s = { unknownRaw: 0, unknownSize: 0, acSize: 0, dcSize: 0, rleSize: 0, rleRaw: 0, rleFull: 0, acCount: 0, dcCount: 0, ...sizes };
  const head = new Uint8Array(88 + 2), v = new DataView(head.buffer);
  [2, s.unknownRaw, s.unknownSize, s.acSize, s.dcSize, s.rleSize, s.rleRaw, s.rleFull, s.acCount, s.dcCount, 0].forEach((x, i) => v.setBigUint64(i * 8, BigInt(x), true));
  v.setUint16(88, 2, true);
  const out = new Uint8Array(head.length + data.length);
  out.set(head);
  out.set(data, head.length);
  return out;
}
const half = [{ name: 'Y', type: 1, linear: false }];

test('DWA header counts beyond what the block can hold are refused before allocating', () => {
  assert.throws(() => unDwa(block({ acSize: 4, acCount: 2 ** 39 }, new Uint8Array(4)), 8, 8, half), /damaged/);
  assert.throws(() => unDwa(block({ dcSize: 4, dcCount: 2 ** 39 }, new Uint8Array(4)), 8, 8, half), /damaged/);
  assert.throws(() => unDwa(block({ rleSize: 4, rleRaw: 8, rleFull: 2 ** 39 }, new Uint8Array(4)), 8, 8, half), /damaged/);
  assert.throws(() => unDwa(block({ unknownSize: 4, unknownRaw: 2 ** 39 }, new Uint8Array(4)), 8, 8, half), /damaged/);
});

test('DWA zlib data that inflates past its declared size is refused', () => {
  const bomb = deflate(new Uint8Array(1 << 24));
  assert.throws(() => unDwa(block({ unknownSize: bomb.length, unknownRaw: 128 }, bomb), 8, 8, half), /damaged/);
});
