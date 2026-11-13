import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeGrayJpeg, quantTable } from './grayJpeg.ts';

// Marker codes in file order, with the SOF0 component count and the SOS component count.
function markers(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), out: string[] = [];
  let p = 2, comps = 0;
  while (p < b.length) {
    const m = b[p + 1];
    if (m === 0xd9) { out.push('EOI'); break; }
    const len = v.getUint16(p + 2);
    if (m === 0xc0) comps = b[p + 9];
    out.push(m.toString(16));
    p += 2 + len;
    if (m === 0xda) {
      while (p < b.length && !(b[p] === 0xff && b[p + 1] !== 0 && b[p + 1] < 0xd0 || b[p] === 0xff && b[p + 1] === 0xd9)) p++;
    }
  }
  return { out, comps };
}

test('a gray JPEG is baseline with one component: SOI, JFIF, DQT, SOF0, two DHT, SOS, EOI', () => {
  const [w, h] = [19, 11];
  const rgba = new Uint8Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : (Math.floor(i / 4) * 7) % 256));
  const b = encodeGrayJpeg(rgba, w, h, 0.9);
  assert.deepEqual([b[0], b[1]], [0xff, 0xd8]);
  const { out, comps } = markers(b);
  assert.deepEqual(out, ['e0', 'db', 'c0', 'c4', 'c4', 'da', 'EOI']);
  assert.equal(comps, 1);
  const v = new DataView(b.buffer);
  const at = b.findIndex((x, i) => x === 0xff && b[i + 1] === 0xc0);
  assert.deepEqual([v.getUint16(at + 5), v.getUint16(at + 7)], [h, w]);
});

test('the quality scale follows the IJG formula: 50 is table K.1, 100 is all ones', () => {
  assert.equal(quantTable(50)[0], 16);
  assert.ok(quantTable(100).every(x => x === 1));
  assert.equal(quantTable(1)[0], 255);
  assert.equal(quantTable(90)[0], 3);
});
