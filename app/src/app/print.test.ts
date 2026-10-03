import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultPrint, printHtml, printLayout } from './print.ts';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('Scale to Fit Media: largest size inside the margins, centered', () => {
  // 3000 x 2000 px at 300 ppi = 254 x 169.33 mm on A4 portrait with 6.35 mm margins.
  const l = printLayout(3000, 2000, 300, { ...defaultPrint(), paper: 'a4' });
  near(l.pageWidthMm, 210); near(l.pageHeightMm, 297);
  near(l.scale, (210 - 12.7) / 254);
  near(l.widthMm, 197.3); near(l.xMm, 6.35);
  near(l.heightMm, 2000 / 300 * 25.4 * l.scale); near(l.yMm, (297 - l.heightMm) / 2);
});

test('Actual Size, Custom scale, landscape and an offset position', () => {
  const a = printLayout(600, 300, 150, { ...defaultPrint(), paper: 'a4', orientation: 'landscape', sizing: 'actual' });
  near(a.pageWidthMm, 297); near(a.widthMm, 101.6); near(a.heightMm, 50.8); near(a.scale, 1);
  const c = printLayout(600, 300, 150, { ...defaultPrint(), sizing: 'custom', scale: 0.5, centered: false, offsetXMm: 10, offsetYMm: 20, marginMm: 5 });
  near(c.widthMm, 50.8); near(c.xMm, 15); near(c.yMm, 25);
});

test('Print page: page size, image box, marks and an escaped label', () => {
  const s = { ...defaultPrint(), paper: 'a5' as const, bleedMm: 3, cropMarks: true, registrationMarks: true, labels: true };
  const l = printLayout(1000, 1000, 100, s);
  const html = printHtml(l, s, 'blob:x', 'A <b> & c');
  assert.ok(html.includes('@page { size: 148mm 210mm; margin: 0; }'));
  assert.ok(html.includes(`left:${l.xMm}mm;top:${l.yMm}mm;width:${l.widthMm}mm;height:${l.heightMm}mm`));
  assert.equal(html.match(/class="mark"/g)?.length, 8);
  assert.equal(html.match(/class="reg"/g)?.length, 4);
  assert.ok(html.includes('A &lt;b&gt; &amp; c') && !html.includes('<b>'));
  // Crop marks start at the bleed edge.
  assert.ok(html.includes(`top:${l.yMm - 3}mm;width:5mm`));
  const plain = printHtml(l, defaultPrint(), 'blob:x', 'x');
  assert.ok(!plain.includes('class="mark"') && !plain.includes('class="reg"') && !plain.includes('class="label"'));
});
