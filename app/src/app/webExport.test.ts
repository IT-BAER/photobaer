import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { assetSpecs, encodeGif, encodePng8, fileStem, makePdf, pathsSvg, quantize } from './webExport.ts';

// 4 x 2: red, green, blue, transparent / white, black, red, red.
const W = 4, H = 2;
const PX = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 0, 255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
const rgbaOf = (q: ReturnType<typeof quantize>) => [...q.index].map(i => (i === q.transparent ? [0, 0, 0, 0] : [...q.palette.subarray(i * 3, i * 3 + 3), 255]));

// Minimal GIF reader (one frame, global table): an LZW decoder independent of the encoder.
function readGif(b: Uint8Array) {
  assert.equal(new TextDecoder().decode(b.subarray(0, 6)), 'GIF89a');
  const w = b[6] | b[7] << 8, h = b[8] | b[9] << 8, size = 2 << (b[10] & 7);
  const table = b.subarray(13, 13 + size * 3);
  let p = 13 + size * 3, transparent = -1;
  if (b[p] === 0x21 && b[p + 1] === 0xf9) { if (b[p + 3] & 1) transparent = b[p + 6]; p += 8; }
  assert.equal(b[p], 0x2c);
  p += 10;
  const min = b[p++];
  const data: number[] = [];
  for (let n = b[p++]; n; n = b[p++]) { data.push(...b.subarray(p, p + n)); p += n; }
  assert.equal(b[p], 0x3b, 'trailer');
  const out: number[] = [], clear = 1 << min;
  let dict: number[][] = [], width = min + 1, bit = 0, prev: number[] | null = null;
  const reset = () => { dict = Array.from({ length: clear + 2 }, (_, i) => [i]); width = min + 1; prev = null; };
  reset();
  while (bit + width <= data.length * 8) {
    let c = 0;
    for (let i = 0; i < width; i++, bit++) c |= (data[bit >> 3] >> (bit & 7) & 1) << i;
    if (c === clear) { reset(); continue; }
    if (c === clear + 1) break;
    const e: number[] = c < dict.length ? dict[c] : [...prev!, prev![0]];
    out.push(...e);
    if (prev) dict.push([...prev, e[0]]);
    prev = e;
    if (dict.length === 1 << width && width < 12) width++;
  }
  return { w, h, table, transparent, index: out };
}

test('quantize keeps exact colors when they fit and marks transparency', () => {
  const q = quantize(PX, W, 256, 'none', true);
  assert.deepEqual(rgbaOf(q), [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [0, 0, 0, 0], [255, 255, 255, 255], [0, 0, 0, 255], [255, 0, 0, 255], [255, 0, 0, 255]]);
  assert.ok(q.palette.length / 3 <= 6);
  const two = quantize(PX, W, 2, 'diffusion', false);
  assert.equal(two.palette.length / 3, 2);
  assert.equal(two.transparent, -1);
  assert.ok(two.index.every(i => i < 2));
});

test('GIF and PNG-8 decode back to the quantized pixels', async () => {
  const q = quantize(PX, W, 256, 'none', true);
  const g = readGif(encodeGif(q, W, H));
  assert.deepEqual([g.w, g.h], [W, H]);
  assert.deepEqual(g.index, [...q.index]);
  assert.equal(g.transparent, q.transparent);
  assert.deepEqual([...g.table.subarray(0, q.palette.length)], [...q.palette]);
  // A long run exercises code-width growth past 9 bits.
  const big = new Uint8ClampedArray(64 * 64 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7) % 251));
  const bq = quantize(big, 64, 64, 'pattern', false);
  assert.deepEqual(readGif(encodeGif(bq, 64, 64)).index, [...bq.index]);

  const png = await encodePng8(q, W, H);
  const chunks = new Map<string, Uint8Array>();
  for (let p = 8; p < png.length;) {
    const n = new DataView(png.buffer, png.byteOffset).getUint32(p);
    chunks.set(new TextDecoder().decode(png.subarray(p + 4, p + 8)), png.subarray(p + 8, p + 8 + n));
    p += 12 + n;
  }
  const ihdr = chunks.get('IHDR')!;
  assert.deepEqual([...ihdr.subarray(8, 10)], [8, 3], '8-bit palette');
  assert.deepEqual([...chunks.get('PLTE')!], [...q.palette]);
  assert.equal(chunks.get('tRNS')![q.transparent], 0);
  const raw = inflateSync(chunks.get('IDAT')!);
  assert.deepEqual([...raw], [0, ...q.index.subarray(0, 4), 0, ...q.index.subarray(4)]);
  assert.ok(chunks.has('IEND'));
});

test('makePdf writes one page per JPEG at its point size', async () => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // The PDF embeds the JPEG bytes untouched (DCTDecode); reading page sizes never decodes them.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const pdf = makePdf([{ jpeg, width: 1, height: 1, ptW: 144, ptH: 72 }, { jpeg, width: 1, height: 1, ptW: 72, ptH: 72 }]);
  const doc = await getDocument({ data: pdf.slice() }).promise;
  assert.equal(doc.numPages, 2);
  assert.deepEqual((await doc.getPage(1)).view, [0, 0, 144, 72]);
  assert.deepEqual((await doc.getPage(2)).view, [0, 0, 72, 72]);
});

test('pathsSvg writes each path with its name; fileStem strips bad characters and dedupes', () => {
  const svg = pathsSvg(10, 20, [{ name: 'A <b>', path: { fill_rule: 'evenodd', subpaths: [{ closed: true, op: 'combine', points: [[0, 0, 0, 0, 0, 0], [5, 0, 5, 0, 5, 0], [5, 5, 5, 5, 5, 5]] }] } }]);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="10" height="20" viewBox="0 0 10 20">/);
  assert.match(svg, /<path id="A &lt;b&gt;" d="M 0 0 C 0 0 5 0 5 0 C 5 0 5 5 5 5 C 5 5 0 0 0 0 Z" fill="none" stroke="black" fill-rule="evenodd"\/>/);
  const used = new Set<string>();
  assert.equal(fileStem('a/b:c', used), 'abc');
  assert.equal(fileStem('ABC', used), 'ABC-2');
  assert.equal(fileStem('  ', used), 'Untitled');
});

test('Image Assets: comma-separated file names with scale and quality, others ignored', () => {
  assert.deepEqual(assetSpecs('200% icon.png, photo.jpg80 ,logo.jpg5, small.png8, a b.webp, c.gif, card, d.tiff, x.png32'), [
    { file: 'icon.png', format: 'png', scale: 2, quality: 1 },
    { file: 'photo.jpg', format: 'jpeg', scale: 1, quality: 0.8 },
    { file: 'logo.jpg', format: 'jpeg', scale: 1, quality: 0.5 },
    { file: 'small.png', format: 'png8', scale: 1, quality: 1 },
    { file: 'a b.webp', format: 'webp', scale: 1, quality: 0.9 },
    { file: 'c.gif', format: 'gif', scale: 1, quality: 1 },
    { file: 'x.png', format: 'png', scale: 1, quality: 1 },
  ]);
  assert.deepEqual(assetSpecs('m.jpg10, n.webp11'), [{ file: 'm.jpg', format: 'jpeg', scale: 1, quality: 1 }, { file: 'n.webp', format: 'webp', scale: 1, quality: 0.11 }]);
  assert.deepEqual(assetSpecs('Layer 1'), []);
  assert.deepEqual(assetSpecs(String.raw`a\b.png, c/d.png`), [], 'no path separators');
  assert.deepEqual(assetSpecs('0% a.png, 50.5% b.jpg100'), [{ file: 'b.jpg', format: 'jpeg', scale: 0.505, quality: 1 }]);
});
