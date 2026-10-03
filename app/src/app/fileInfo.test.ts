import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { embedInfo, parseXmp, readInfo, xmpPacket, type FileInfo } from './fileInfo.ts';

const INFO: FileInfo = {
  title: 'Sunset & <Sea>', author: 'Ann "B" Muster', description: 'Line 1\nLine 2', keywords: ['beach', 'evening sky'],
  copyright: '© 2026 Ann', copyright_url: 'https://example.com/?a=1&b=2',
};

// A 1x1 RGBA PNG built with node's zlib, independent of the code under test.
function png() {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 1, 2, 3, 4]))), chunk('IEND', Buffer.alloc(0))]));
}

// Every PNG chunk as [type, data], checking each CRC with node's zlib.
function chunks(b: Uint8Array) {
  const out: [string, Buffer][] = [];
  const buf = Buffer.from(b);
  for (let o = 8; o < buf.length;) {
    const n = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8);
    assert.equal(buf.readUInt32BE(o + 8 + n), crc32(buf.subarray(o + 4, o + 8 + n)), `${type} CRC`);
    out.push([type, buf.subarray(o + 8, o + 8 + n)]);
    o += 12 + n;
  }
  return out;
}

test('XMP packet round-trips every field, escaped', () => {
  const x = xmpPacket(INFO);
  assert.ok(x.startsWith('<?xpacket begin='));
  assert.ok(!x.includes('<Sea>'), 'markup is escaped');
  assert.deepEqual(parseXmp(x), INFO);
});

test('XMP written by other tools: attribute form, language alternatives, several creators', () => {
  const x = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"
      xmpRights:WebStatement="https://a.example/&#x41;">
      <dc:title><rdf:Alt><rdf:li xml:lang="de">Titel</rdf:li><rdf:li xml:lang="x-default">Title &amp; co</rdf:li></rdf:Alt></dc:title>
      <dc:creator><rdf:Seq><rdf:li>Ann</rdf:li><rdf:li>Bob</rdf:li></rdf:Seq></dc:creator>
      <dc:subject><rdf:Bag/></dc:subject>
    </rdf:Description></rdf:RDF></x:xmpmeta>`;
  assert.deepEqual(parseXmp(x), { title: 'Title & co', author: 'Ann; Bob', description: '', keywords: [], copyright: '', copyright_url: 'https://a.example/A' });
  assert.equal(parseXmp('<x:xmpmeta/>'), null, 'no fields');
});

test('PNG: iTXt XML:com.adobe.xmp after IHDR, replaced on a second embed, read back', () => {
  const once = embedInfo(png(), 'image/png', { ...INFO, title: 'old' });
  const b = embedInfo(once, 'image/png', INFO);
  const c = chunks(b);
  assert.deepEqual(c.map(x => x[0]), ['IHDR', 'iTXt', 'IDAT', 'IEND']);
  const t = c[1][1];
  assert.equal(t.toString('latin1', 0, 18), 'XML:com.adobe.xmp\0');
  assert.deepEqual([...t.subarray(18, 22)], [0, 0, 0, 0], 'uncompressed, no language or translated keyword');
  assert.deepEqual(parseXmp(t.subarray(22).toString('utf8')), INFO);
  assert.deepEqual(readInfo(b), INFO);
  assert.equal(readInfo(png()), null);
});

test('JPEG: one APP1 XMP segment after APP0, old one replaced, scan data kept', () => {
  const app0 = [0xff, 0xe0, 0, 4, 1, 2];
  const dqt = [0xff, 0xdb, 0, 3, 7];
  const jpg = Uint8Array.from([0xff, 0xd8, ...app0, ...dqt, 0xff, 0xda, 0, 2, 9, 9, 9, 0xff, 0xd9]);
  const b = embedInfo(embedInfo(jpg, 'image/jpeg', { ...INFO, author: 'x' }), 'image/jpeg', INFO);
  const buf = Buffer.from(b);
  const segs: [number, Buffer][] = [];
  let o = 2;
  while (buf[o] === 0xff && buf[o + 1] !== 0xda) { const n = buf.readUInt16BE(o + 2); segs.push([buf[o + 1], buf.subarray(o + 4, o + 2 + n)]); o += 2 + n; }
  assert.deepEqual(segs.map(s => s[0]), [0xe0, 0xe1, 0xdb]);
  const ns = 'http://ns.adobe.com/xap/1.0/\0';
  assert.equal(segs[1][1].toString('latin1', 0, ns.length), ns);
  assert.deepEqual(parseXmp(segs[1][1].subarray(ns.length).toString('utf8')), INFO);
  assert.deepEqual([...buf.subarray(o)], [0xff, 0xda, 0, 2, 9, 9, 9, 0xff, 0xd9]);
  assert.deepEqual(readInfo(b), INFO);
});

test('PSD: image resource 1060 holds the XMP, other resources and the rest kept', () => {
  const res = (id: number, data: number[]) => [0x38, 0x42, 0x49, 0x4d, id >> 8, id & 255, 0, 0, 0, 0, 0, data.length, ...data, ...(data.length & 1 ? [0] : [])];
  const blocks = [...res(1005, [1, 2, 3]), ...res(1060, [60, 120])];
  const head = [...Buffer.from('8BPS'), 0, 1, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, 1, 0, 8, 0, 3];
  const psd = Uint8Array.from([...head, 0, 0, 0, 0, 0, 0, 0, blocks.length, ...blocks, 0xaa, 0xbb]);
  const b = Buffer.from(embedInfo(psd, 'image/vnd.adobe.photoshop', INFO));
  const len = b.readUInt32BE(30);
  const ids: number[] = [];
  let xmp = '';
  for (let o = 34; o < 34 + len;) {
    assert.equal(b.toString('latin1', o, o + 4), '8BIM');
    const id = b.readUInt16BE(o + 4), n = b.readUInt32BE(o + 8);
    ids.push(id);
    if (id === 1060) xmp = b.toString('utf8', o + 12, o + 12 + n);
    o += 12 + n + (n & 1);
  }
  assert.deepEqual(ids, [1005, 1060]);
  assert.deepEqual(parseXmp(xmp), INFO);
  assert.deepEqual([...b.subarray(34 + len)], [0xaa, 0xbb]);
  assert.deepEqual(readInfo(b), INFO);
});
