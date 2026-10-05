import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { pageBoxes } from './pdfBoxes.ts';

const bytes = (...parts: (string | Uint8Array)[]) => {
  const bs = parts.map(p => typeof p === 'string' ? Uint8Array.from(p, c => c.charCodeAt(0)) : p);
  const out = new Uint8Array(bs.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const b of bs) { out.set(b, o); o += b.length; }
  return out;
};

test('pageBoxes: an inherited MediaBox, the page CropBox, and the later object of an incremental update', async () => {
  const pdf = bytes(
    '%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >> endobj\n',
    '3 0 obj << /Type /Page /Parent 2 0 R /CropBox [ 36 36 576.5 756 ] >> endobj\n',
    '13 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] >> endobj\n',
    'trailer << /Root 1 0 R >>\n%%EOF\n',
    '3 0 obj << /Type /Page /Parent 2 0 R /CropBox [ 72 72 540 720 ] >> endobj\n%%EOF\n',
  );
  assert.deepEqual(await pageBoxes(pdf, { num: 3, gen: 0 }), { media: [0, 0, 612, 792], crop: [72, 72, 540, 720] });
  assert.deepEqual(await pageBoxes(pdf, { num: 13, gen: 0 }), { media: [0, 0, 1, 1], crop: [0, 0, 1, 1] });
});

test('pageBoxes: a page in a compressed object stream with an indirect, unordered MediaBox', async () => {
  const page = '<< /Type /Page /Parent 5 0 R /MediaBox 8 0 R >>', objs = `${page} [ 595 842 0 0 ]`;
  const head = `7 0 8 ${page.length + 1} `;
  const data = deflateSync(Buffer.from(head + objs, 'latin1'));
  const pdf = bytes(
    '%PDF-1.7\n5 0 obj << /Type /Pages /Kids [7 0 R] /Count 1 >> endobj\n',
    `9 0 obj << /Type /ObjStm /N 2 /First ${head.length} /Filter /FlateDecode /Length ${data.length} >>\nstream\r\n`, data, '\r\nendstream\nendobj\n',
  );
  assert.deepEqual(await pageBoxes(pdf, { num: 7, gen: 0 }), { media: [0, 0, 595, 842], crop: [0, 0, 595, 842] });
  assert.equal(await pageBoxes(pdf, { num: 4, gen: 0 }), null);
});
