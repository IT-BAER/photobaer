import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writePsd, readPsd, type LayerTextData, type Layer, type Psd } from 'ag-psd';
import { initSync } from '../engine-pkg/photobaer_engine.js';
import { importPsd, exportPsd, compositeRgba } from '../psd.ts';
import { textIn } from './text.ts';

initSync({ module: readFileSync(new URL('../engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });

const W = 120, H = 60;
const bytesOf = (psd: Psd) => new Uint8Array(writePsd(psd, { generateThumbnail: false }));
const res = (ppi: number) => ({ resolutionInfo: {
  horizontalResolution: ppi, horizontalResolutionUnit: 'PPI' as const, widthUnit: 'Inches' as const,
  verticalResolution: ppi, verticalResolutionUnit: 'PPI' as const, heightUnit: 'Inches' as const,
} });
const font = { name: 'ArialMT' };
// A 20x10 opaque block with a gradient so a shifted or resampled cache would differ.
const pixels = () => {
  const data = new Uint8ClampedArray(20 * 10 * 4);
  for (let i = 0; i < 200; i++) data.set([i, 255 - i, (i * 7) % 256, 255], i * 4);
  return { width: 20, height: 10, data };
};

function textLayer(text: Partial<LayerTextData>, name = 'T'): Layer {
  return {
    name, left: 30, top: 20, imageData: pixels(),
    text: { text: 'Hello world', transform: [1, 0, 0, 1, 30, 28], antiAlias: 'crisp', style: { font, fontSize: 24 }, ...text },
  };
}

function roundTrip(psd: Psd, edit?: (e: any, n: any) => void) {
  const { engine, warnings } = importPsd(bytesOf(psd));
  try {
    const m = JSON.parse(engine.manifest());
    if (edit) edit(engine, m.layers[0]);
    const out = exportPsd(engine);
    return { m, warnings, outWarnings: out.warnings, back: readPsd(out.bytes, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true }), engine: null };
  } finally {
    engine.free();
  }
}

test('24 pt in a 300 ppi file reads 24 pt and writes fontSize 100 back', () => {
  const r = roundTrip({ width: W, height: H, imageResources: res(300), children: [textLayer({ style: { font, fontSize: 100 } })] });
  const t = r.m.layers[0].text;
  assert.equal(r.m.layers[0].kind, 'text');
  assert.equal(t.runs[0].size, 24);
  assert.equal(t.runs[0].postscript_name, 'ArialMT');
  assert.ok(!r.warnings.some(w => w.includes('text')), r.warnings.join());
  const back = r.back.children![0].text!;
  assert.equal((back.styleRuns?.[0]?.style ?? back.style)!.fontSize, 100);
  assert.equal(back.style?.font?.name ?? back.styleRuns?.[0].style.font?.name, 'ArialMT');
});

test('point and box layers keep text, runs, paragraphs and leading', () => {
  const runs = [
    { length: 6, style: { font, fontSize: 24, autoLeading: true } },
    { length: 5, style: { font, fontSize: 24, fauxBold: true, autoLeading: false, leading: 30 } },
  ];
  const para = [{ length: 11, style: { justification: 'center' as const, startIndent: 10 } }];
  const point = textLayer({ styleRuns: runs, paragraphStyleRuns: para, shapeType: 'point' }, 'P');
  const box = textLayer({ styleRuns: runs, paragraphStyleRuns: para, shapeType: 'box', boxBounds: [0, 0, 80, 40] }, 'B');
  const r = roundTrip({ width: W, height: H, children: [point, box] });
  const [p, b] = r.m.layers.map((n: any) => n.text);
  assert.deepEqual(p.shape, { type: 'point' });
  assert.deepEqual(b.shape, { type: 'paragraph', box: [0, 0, 80, 40] });
  for (const t of [p, b]) {
    assert.equal(t.text, 'Hello world');
    assert.deepEqual(t.runs.map((x: any) => [x.length, x.faux_bold, x.leading]), [[6, false, null], [5, true, 30]]);
    assert.deepEqual(t.paragraphs.map((x: any) => [x.length, x.alignment, x.indent_left]), [[11, 'center', 10]]);
    assert.equal(t.runs[0].anti_alias, 'crisp');
  }
  const [bp, bb] = r.back.children!.map(l => l.text!);
  assert.equal(bp.shapeType, 'point');
  assert.equal(bb.shapeType, 'box');
  assert.deepEqual(bb.boxBounds, [0, 0, 80, 40]);
  for (const t of [bp, bb]) {
    assert.equal(t.text, 'Hello world');
    assert.equal(t.antiAlias, 'crisp');
    const styles = t.styleRuns!.map(s => ({ ...t.style, ...s.style }));
    assert.deepEqual(styles.map(s => [!!s.fauxBold, s.autoLeading, s.autoLeading ? undefined : s.leading]), [[false, true, undefined], [true, false, 30]]);
    const ps = { ...t.paragraphStyle, ...t.paragraphStyleRuns?.[0]?.style };
    assert.equal(ps.justification, 'center');
    assert.equal(ps.startIndent, 10);
  }
});

test('warp arc bend 50 % round-trips', () => {
  const warp = { style: 'arc' as const, value: 50, perspective: -20, perspectiveOther: 10, rotate: 'horizontal' as const };
  const r = roundTrip({ width: W, height: H, children: [textLayer({ warp })] });
  assert.deepEqual(r.m.layers[0].text.warp, { style: 'arc', bend: 0.5, horizontal: -0.2, vertical: 0.1, axis: 'horizontal' });
  const w = r.back.children![0].text!.warp!;
  assert.deepEqual([w.style, w.value, w.perspective, w.perspectiveOther], ['arc', 50, -20, 10]);
});

test('unmapped EngineData fields survive a text-only edit', () => {
  const layer = textLayer({
    style: { font, fontSize: 24, strokeColor: { r: 1, g: 2, b: 3 }, outlineWidth: 2 },
    superscriptSize: 0.5,
  });
  const r = roundTrip({ width: W, height: H, children: [layer] }, (e, n) => {
    e.set_text(n.id, JSON.stringify({ ...n.text, text: 'Jello world' }));
  });
  const t = r.back.children![0].text!;
  assert.equal(t.text, 'Jello world');
  const s = { ...t.style, ...t.styleRuns?.[0]?.style };
  // ag-psd stores EngineData colors as 0..1 floats, so a round trip drifts by < 0.01.
  const sc = s.strokeColor as { r: number; g: number; b: number };
  [sc.r - 1, sc.g - 2, sc.b - 3].forEach(d => assert.ok(Math.abs(d) < 0.01, JSON.stringify(sc)));
  assert.equal(s.outlineWidth, 2);
  assert.equal(t.superscriptSize, 0.5);
});

test('an imported text layer renders its PSD pixels exactly until edited', () => {
  const text = importPsd(bytesOf({ width: W, height: H, children: [textLayer({})] }));
  const plain = importPsd(bytesOf({ width: W, height: H, children: [{ name: 'T', left: 30, top: 20, imageData: pixels() }] }));
  try {
    const a = compositeRgba(text.engine), b = compositeRgba(plain.engine);
    let max = 0;
    for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
    assert.equal(max, 0);
    assert.ok(a.some((v, i) => i % 4 === 0 && v > 0), 'the cache is not empty');
  } finally {
    text.engine.free();
    plain.engine.free();
  }
});

test('text on a path maps to on-path text from the bezier curve', () => {
  const t = textIn({
    text: 'abc', style: { font, fontSize: 12 },
    textPath: { bezierCurve: { controlPoints: [0, 0, 10, 0, 20, 0, 30, 0, 30, 0, 40, 0, 50, 0, 60, 0] }, data: { type: 2, frameMatrix: [1, 0, 0, 1, 0, 0], textRange: [0, 3], pathData: { reversed: true } } },
  }, 72, () => {});
  assert.equal(t.shape.type, 'onPath');
  assert.deepEqual(t.shape.path.subpaths[0].points, [[0, 0, 0, 0, 10, 0], [30, 0, 20, 0, 40, 0], [60, 0, 50, 0, 60, 0]]);
  assert.equal(t.shape.path.subpaths[0].closed, false);
  assert.equal(t.shape.start, 0);
  assert.equal(t.shape.end, 60);
  assert.equal(t.shape.flip, true);
});

test('run and paragraph lengths are clamped to the text (EngineData counts a trailing return)', () => {
  const t = textIn({ text: 'ab', style: { font }, styleRuns: [{ length: 1, style: {} }, { length: 2, style: { fauxBold: true } }], paragraphStyleRuns: [{ length: 3, style: {} }] }, 72, () => {});
  assert.deepEqual(t.runs.map((r: any) => r.length), [1, 1]);
  assert.deepEqual(t.paragraphs.map((p: any) => p.length), [2]);
});

test('malformed text frames map to point text instead of throwing', () => {
  for (const textPath of [{ data: { type: 2 } }, {}, { bezierCurve: {}, data: { type: 2 } }]) {
    const t = textIn({ text: 'a', style: { font }, textPath } as unknown as LayerTextData, 72, () => {});
    assert.equal(t.shape.type, 'point', JSON.stringify(textPath));
  }
});
