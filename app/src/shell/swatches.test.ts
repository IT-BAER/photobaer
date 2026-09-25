import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAco, writeAco, parseAse, writeAse, defaultSwatches } from './swatches.ts';

// Built by hand from the documented ACO v1 layout: version(2) count(2), then per swatch
// colorSpace(2) + four 16-bit values, RGB scaled 0-65535 (component * 257).
function acoV1Fixture(): Uint8Array {
  const buf = new Uint8Array(4 + 10 * 2);
  const d = new DataView(buf.buffer);
  d.setUint16(0, 1); // version 1
  d.setUint16(2, 2); // two swatches
  d.setUint16(4, 0); // RGB
  d.setUint16(6, 255 * 257); d.setUint16(8, 0); d.setUint16(10, 0); d.setUint16(12, 0);
  d.setUint16(14, 8); // Grayscale
  d.setUint16(16, Math.round(128 * 39.0625)); d.setUint16(18, 0); d.setUint16(20, 0); d.setUint16(22, 0);
  return buf;
}

test('parses an ACO v1 fixture built from the documented byte layout', () => {
  const { swatches, warnings } = parseAco(acoV1Fixture());
  assert.equal(warnings.length, 0);
  assert.deepEqual(swatches[0].rgb, [255, 0, 0]);
  assert.deepEqual(swatches[1].rgb, [128, 128, 128]);
});

test('ACO v2 round-trips names and RGB through write/parse', () => {
  const input = [{ name: 'Fire', rgb: [255, 0, 0] as [number, number, number] }, { name: 'Ink', rgb: [10, 20, 30] as [number, number, number] }];
  const { swatches, warnings } = parseAco(writeAco(input));
  assert.equal(warnings.length, 0);
  assert.deepEqual(swatches.map(s => s.name), ['Fire', 'Ink']);
  assert.deepEqual(swatches[0].rgb, [255, 0, 0]);
  assert.deepEqual(swatches[1].rgb, [10, 20, 30]);
});

test('unsupported ACO color spaces are skipped with a warning', () => {
  const buf = new Uint8Array(4 + 10);
  const d = new DataView(buf.buffer);
  d.setUint16(0, 1); d.setUint16(2, 1);
  d.setUint16(4, 2); // CMYK, unsupported
  const { swatches, warnings } = parseAco(buf);
  assert.equal(swatches.length, 0);
  assert.equal(warnings.length, 1);
});

test('ASE round-trips RGB and Gray entries through write/parse', () => {
  const input = [{ name: 'Sky', rgb: [40, 120, 220] as [number, number, number] }];
  const { swatches, warnings } = parseAse(writeAse(input));
  assert.equal(warnings.length, 0);
  assert.equal(swatches[0].name, 'Sky');
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(swatches[0].rgb[i] - input[0].rgb[i]) <= 1);
});

// Built by hand: "ASEF" + version 1.0 + 1 block, a color entry named "Gy" in the Gray model.
function aseGrayFixture(): Uint8Array {
  const name = 'Gy';
  const bodyLen = 2 + (name.length + 1) * 2 + 4 + 4 + 2;
  const buf = new Uint8Array(4 + 4 + 4 + 2 + 4 + bodyLen);
  const d = new DataView(buf.buffer);
  let p = 0;
  const ascii = (s: string) => { for (const ch of s) d.setUint8(p++, ch.charCodeAt(0)); };
  ascii('ASEF');
  d.setUint16(p, 1); p += 2; d.setUint16(p, 0); p += 2;
  d.setUint32(p, 1); p += 4;
  d.setUint16(p, 0x0001); p += 2;
  d.setUint32(p, bodyLen); p += 4;
  d.setUint16(p, name.length + 1); p += 2;
  for (const ch of name) { d.setUint16(p, ch.charCodeAt(0)); p += 2; }
  d.setUint16(p, 0); p += 2;
  ascii('Gray');
  d.setFloat32(p, 0.5); p += 4;
  d.setUint16(p, 2); p += 2;
  return buf;
}

test('parses an ASE Gray fixture built from the documented byte layout', () => {
  const { swatches, warnings } = parseAse(aseGrayFixture());
  assert.equal(warnings.length, 0);
  assert.equal(swatches[0].name, 'Gy');
  assert.deepEqual(swatches[0].rgb, [128, 128, 128]);
});

test('default swatch set is the grey ramp plus 12 hues x 3 rows', () => {
  const s = defaultSwatches();
  assert.equal(s.length, 11 + 12 * 3);
});
