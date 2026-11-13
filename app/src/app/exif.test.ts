import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { exifBlock, fileExif, readExif } from './exif.ts';
import { embedExif } from './fileInfo.ts';

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
const TEXT = { description: 'Ein Bild', artist: 'Ann Muster', copyright: '© 2026 Ann', dpi: 300 };

test('EXIF block: big-endian IFD0 with the text tags and the resolution; nothing when there is no text', () => {
  const b = exifBlock(TEXT)!;
  assert.deepEqual([...b.subarray(0, 8)], [0x4d, 0x4d, 0, 42, 0, 0, 0, 8]);
  assert.deepEqual(readExif(b), { ImageDescription: 'Ein Bild', Artist: 'Ann Muster', Copyright: '© 2026 Ann', XResolution: '300/1', YResolution: '300/1', ResolutionUnit: '2' });
  assert.equal(exifBlock({ dpi: 72 }), null);
});

test('PNG: one eXIf chunk after IHDR, replaced on a second embed, CRCs valid', () => {
  const b = embedExif(embedExif(png(), 'image/png', exifBlock({ artist: 'old' })!), 'image/png', exifBlock(TEXT)!);
  const types: string[] = [];
  const buf = Buffer.from(b);
  for (let o = 8; o < buf.length;) {
    const n = buf.readUInt32BE(o), t = buf.toString('latin1', o + 4, o + 8);
    assert.equal(buf.readUInt32BE(o + 8 + n), crc32(buf.subarray(o + 4, o + 8 + n)), `${t} CRC`);
    types.push(t);
    o += 12 + n;
  }
  assert.deepEqual(types, ['IHDR', 'eXIf', 'IDAT', 'IEND']);
  assert.equal(readExif(fileExif(b)!).Artist, 'Ann Muster');
});

test('JPEG: one APP1 Exif segment after APP0, old one replaced, XMP and scan kept', () => {
  const xmp = [0xff, 0xe1, 0, 8, ...Buffer.from('http:/')];
  const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, ...xmp, 0xff, 0xdb, 0, 3, 7, 0xff, 0xda, 0, 2, 9, 9, 0xff, 0xd9]);
  const b = embedExif(embedExif(jpg, 'image/jpeg', exifBlock({ artist: 'old' })!), 'image/jpeg', exifBlock(TEXT)!);
  const markers: number[] = [];
  let o = 2;
  while (b[o] === 0xff && b[o + 1] !== 0xda) { markers.push(b[o + 1]); o += 2 + (b[o + 2] << 8 | b[o + 3]); }
  assert.deepEqual(markers, [0xe0, 0xe1, 0xe1, 0xdb]);
  assert.equal(Buffer.from(b).toString('latin1', 12, 18), 'Exif\0\0');
  assert.deepEqual([...b.subarray(o)], [0xff, 0xda, 0, 2, 9, 9, 0xff, 0xd9]);
  assert.equal(readExif(fileExif(b)!).Copyright, '© 2026 Ann');
});

// A little-endian camera block written by hand: IFD0 (Make, Model, pointers), EXIF IFD, GPS IFD.
function camera(): Uint8Array {
  const b = Buffer.alloc(400);
  b.write('II', 0, 'latin1'); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4);
  const ifd = (at: number, entries: [number, number, number, number | Buffer][], dataAt: number) => {
    b.writeUInt16LE(entries.length, at);
    let d = dataAt;
    entries.forEach(([tag, type, count, v], i) => {
      const o = at + 2 + i * 12;
      b.writeUInt16LE(tag, o); b.writeUInt16LE(type, o + 2); b.writeUInt32LE(count, o + 4);
      if (typeof v === 'number') { if (type === 3) b.writeUInt16LE(v, o + 8); else b.writeUInt32LE(v, o + 8); }
      else if (v.length <= 4) v.copy(b, o + 8);
      else { b.writeUInt32LE(d, o + 8); v.copy(b, d); d += v.length; }
    });
    b.writeUInt32LE(0, at + 2 + entries.length * 12);
  };
  const rat = (...xs: number[]) => { const r = Buffer.alloc(xs.length * 4); xs.forEach((x, i) => r.writeUInt32LE(x, i * 4)); return r; };
  ifd(8, [[271, 2, 6, Buffer.from('Canon\0')], [272, 2, 9, Buffer.from('EOS R5 X\0')], [34665, 4, 1, 100], [34853, 4, 1, 250]], 64);
  ifd(100, [[33434, 5, 1, rat(1, 250)], [33437, 5, 1, rat(28, 10)], [34855, 3, 1, 400], [36867, 2, 20, Buffer.from('2026:01:02 10:11:12\0')], [37386, 5, 1, rat(50, 1)], [42036, 2, 8, Buffer.from('RF50mm\0\0')]], 180);
  ifd(250, [[1, 2, 2, Buffer.from('N\0')], [2, 5, 3, rat(48, 1, 8, 1, 30, 1)], [3, 2, 2, Buffer.from('E\0')], [4, 5, 3, rat(11, 1, 34, 1, 15, 1)]], 310);
  return new Uint8Array(b);
}

test('Camera Data: IFD0, EXIF and GPS tags of a little-endian block', () => {
  assert.deepEqual(readExif(camera()), {
    Make: 'Canon', Model: 'EOS R5 X', ExposureTime: '1/250', FNumber: '28/10', ISOSpeedRatings: '400', DateTimeOriginal: '2026:01:02 10:11:12',
    FocalLength: '50/1', LensModel: 'RF50mm', GPSLatitude: '48,8.5N', GPSLongitude: '11,34.25E',
  });
});

test('Camera Data of damaged blocks: truncated, bad offsets, not TIFF', () => {
  const c = camera();
  assert.deepEqual(readExif(c.subarray(0, 120)).Make, 'Canon', 'what was read before the cut stays');
  const bad = c.slice();
  new DataView(bad.buffer).setUint32(4, 0xfffffff0, true);
  assert.deepEqual(readExif(bad), {});
  assert.deepEqual(readExif(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9)), {});
  assert.deepEqual(readExif(new Uint8Array(0)), {});
  assert.equal(fileExif(png()), null);
});

test('EXIF block: non-ASCII text is UTF-8 with a byte count that includes the NUL, values at even offsets', () => {
  const t = { description: 'Désc', artist: 'Jürgen Ä', copyright: '© 2026 Ünal', dpi: 300 };
  const b = exifBlock(t)!, v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = v.getUint16(8);
  const seen: Record<number, string> = {};
  for (let i = 0; i < n; i++) {
    const o = 10 + i * 12, tag = v.getUint16(o), type = v.getUint16(o + 2), cnt = v.getUint32(o + 4);
    if (type !== 2) continue;
    const bytes = Buffer.from([...new TextEncoder().encode(({ 270: t.description, 315: t.artist, 33432: t.copyright } as Record<number, string>)[tag]), 0]);
    assert.equal(cnt, bytes.length, `tag ${tag} count`);
    const at = cnt <= 4 ? o + 8 : v.getUint32(o + 8);
    if (cnt > 4) assert.equal(at % 2, 0, `tag ${tag} offset is even`);
    assert.deepEqual([...b.subarray(at, at + cnt)], [...bytes], `tag ${tag} bytes`);
    seen[tag] = new TextDecoder().decode(b.subarray(at, at + cnt - 1));
  }
  assert.deepEqual(seen, { 270: 'Désc', 315: 'Jürgen Ä', 33432: '© 2026 Ünal' });
  assert.deepEqual(readExif(b), { ImageDescription: 'Désc', Artist: 'Jürgen Ä', Copyright: '© 2026 Ünal', XResolution: '300/1', YResolution: '300/1', ResolutionUnit: '2' });
});
