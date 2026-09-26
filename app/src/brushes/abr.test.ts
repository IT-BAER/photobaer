import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAbr, decodePatternRecords } from './abr.ts';
import { defaultDynamics, dyn } from './preset.ts';
import { writeAbrV2, writeAbrV6, sampSection, pattSection, descriptor, W, type DV } from './abrWriter.testutil.ts';

const pct = (v: number): DV => ['UntF', '#Prc', v];
const obj = (cls: string, items: [string, DV][]): DV => ['Objc', cls, items];
const uuid = (n: number) => `aaaaaaaa-bbbb-cccc-dddd-00000000000${n}`;

test('v2: computed and sampled records, default dynamics, one no-dynamics warning', () => {
  const r = parseAbr(writeAbrV2([
    { type: 'computed', name: 'Round 30', spacing: 20, diameter: 30, roundness: 50, angle: 45, hardness: 75 },
    { type: 'sampled', name: 'Grain', spacing: 30, bitmap: { w: 3, h: 2, depth: 8, compression: 0, samples: [0, 64, 128, 192, 255, 10] } },
    { type: 'sampled', name: 'Packed', spacing: 25, bitmap: { w: 4, h: 2, depth: 8, compression: 1, samples: [7, 7, 7, 7, 1, 2, 3, 4] } },
    { type: 'computed', name: 'Bad', spacing: 25, diameter: 0, roundness: 100, angle: 0, hardness: 100 },
  ]));
  assert.equal(r.report.version, 2);
  assert.equal(r.report.warnings.filter(w => /no dynamics/.test(w)).length, 1);
  assert.ok(r.report.warnings.some(w => /Bad: diameter 0/.test(w)));
  assert.equal(r.presets.length, 4);
  const [a, b, c, d] = r.presets;
  assert.equal(a.name, 'Round 30');
  assert.deepEqual(a.tip, { kind: 'computed', profile: 'round', diameter: 30, hardness: 0.75, angle: 45, roundness: 0.5, spacing: 0.2, flipX: false, flipY: false });
  assert.deepEqual(a.dynamics, defaultDynamics());
  assert.equal(b.tip.kind, 'sampled');
  assert.equal(b.tip.diameter, 3);
  assert.equal(b.tip.spacing, 0.3);
  const tip = r.tips.find(t => b.tip.kind === 'sampled' && t.id === b.tip.tipRef)!;
  assert.deepEqual([tip.width, tip.height, [...tip.alpha]], [3, 2, [0, 64, 128, 192, 255, 10]]);
  const tip2 = r.tips.find(t => c.tip.kind === 'sampled' && t.id === c.tip.tipRef)!;
  assert.deepEqual([...tip2.alpha], [7, 7, 7, 7, 1, 2, 3, 4]);
  assert.equal(d.tip.diameter, 25);
});

function fullDesc(): Uint8Array {
  const dynBrush: [string, DV][] = [
    ['Nm  ', ['TEXT', 'Dyn Brush']],
    ['Brsh', obj('sampledBrush', [
      ['Dmtr', ['UntF', '#Pxl', 42]], ['Angl', ['UntF', '#Ang', 30]], ['Rndn', pct(50)], ['Spcn', pct(15)],
      ['Intr', ['bool', true]], ['flipX', ['bool', true]], ['flipY', ['bool', false]], ['sampledData', ['TEXT', uuid(1)]],
    ])],
    ['useTipDynamics', ['bool', true]],
    ['szVr', obj('brVr', [['bVTy', ['long', 2]], ['fStp', ['long', 25]], ['jitter', pct(20)], ['Mnm ', pct(5)]])],
    ['angleDynamics', obj('brVr', [['bVTy', ['long', 6]], ['jitter', pct(10)]])],
    ['roundnessDynamics', obj('brVr', [['bVTy', ['long', 1]], ['fStp', ['long', 12]], ['Mnm ', pct(30)]])],
    ['flipXJitter', ['bool', true]], ['brushProjection', ['bool', true]],
    ['useScatter', ['bool', true]],
    ['scatterDynamics', obj('brVr', [['bVTy', ['long', 0]], ['jitter', pct(250)], ['bothAxes', ['bool', true]], ['Cnt ', ['long', 3]], ['countJitter', pct(40)]])],
    ['useTexture', ['bool', true]],
    ['Txtr', obj('Ptrn', [['Nm  ', ['TEXT', 'Grid']], ['Idnt', ['TEXT', 'pat-1']]])],
    ['textureBlendMode', ['enum', 'BlnM', 'CBrn']], ['textureDepth', pct(70)], ['textureScale', pct(150)],
    ['textureBrightness', ['long', 20]], ['textureContrast', ['long', -30]],
    ['textureDepthDynamics', obj('brVr', [['bVTy', ['long', 2]], ['Mnm ', pct(10)]])],
    ['minimumDepth', pct(25)], ['InvT', ['bool', true]], ['textureEachTip', ['bool', true]],
    ['useDualBrush', ['bool', true]],
    ['dualBrush', obj('dualBrush', [
      ['Flip', ['bool', true]],
      ['Brsh', obj('computedBrush', [['Dmtr', ['UntF', '#Pxl', 12]], ['Hrdn', pct(60)], ['Rndn', pct(100)], ['Angl', ['UntF', '#Ang', 0]], ['Spcn', pct(55)]])],
      ['BlnM', ['enum', 'BlnM', 'Drkn']], ['useScatter', ['bool', true]], ['Spcn', pct(60)], ['Cnt ', ['long', 2]], ['bothAxes', ['bool', true]],
      ['scatterDynamics', obj('brVr', [['jitter', pct(40)]])],
    ])],
    ['useColorDynamics', ['bool', true]],
    ['clVr', obj('brVr', [['jitter', pct(25)]])],
    ['H   ', pct(10)], ['Strt', pct(20)], ['Brgh', pct(30)], ['purity', pct(-40)], ['colorDynamicsPerTip', ['bool', true]],
    ['usePaintDynamics', ['bool', true]],
    ['opVr', obj('brVr', [['bVTy', ['long', 2]], ['Mnm ', pct(0)]])],
    ['prVr', obj('brVr', [['jitter', pct(50)]])],
    ['useBrushPose', ['bool', true]],
    ['brushPose', obj('brushPose', [['overrideTilt', ['bool', true]], ['tiltX', ['doub', 30]], ['tiltY', ['doub', -20]], ['overridePressure', ['bool', true]], ['pressure', pct(60)]])],
    ['toolOptions', obj('currentToolOptions', [
      ['Opct', pct(85)], ['Flw ', pct(40)], ['Md  ', ['enum', 'BlnM', 'Mltp']],
      ['Clr ', obj('RGBC', [['Rd  ', ['doub', 255]], ['Grn ', ['doub', 128]], ['Bl  ', ['doub', 0]]])],
    ])],
    ['brushGroup', obj('brushGroup', [['Nm  ', ['TEXT', 'Inks']]])],
    ['Wtdg', ['bool', true]], ['Rpt ', ['bool', true]], ['Nose', ['bool', true]], ['protectTexture', ['bool', true]],
    ['zzUn', ['long', 1]],
  ];
  const plain: [string, DV][] = [['Nm  ', ['TEXT', 'Plain']], ['Brsh', obj('computedBrush', [['Dmtr', ['UntF', '#Pxl', 10]], ['Hrdn', pct(100)]])]];
  return descriptor('null', [['Brsh', ['VlLs', [obj('brushPreset', dynBrush), obj('brushPreset', plain)]]]]);
}

function fullV6(): Uint8Array {
  return writeAbrV6([
    ['samp', sampSection([
      { id: uuid(1), bitmap: { w: 3, h: 2, depth: 8, compression: 0, samples: [0, 64, 128, 192, 255, 10] } },
      { id: uuid(2), bitmap: { w: 4, h: 2, depth: 8, compression: 1, samples: [5, 5, 5, 5, 1, 2, 3, 4] } },
      { id: uuid(3), bitmap: { w: 2, h: 2, depth: 16, compression: 0, samples: [0x1234, 0xff00, 0x0001, 0x8000] } },
      { id: 'short', bitmap: { w: 2, h: 1, depth: 16, compression: 1, samples: [0xabcd, 0xabcd] } },
      { id: uuid(5), junk: 7, bitmap: { w: 1, h: 1, depth: 8, compression: 0, samples: [99] } },
    ])],
    ['patt', pattSection([
      { id: 'pat-1', name: 'Grid', mode: 3, w: 2, h: 2, compression: 1, planes: [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]] },
      { id: 'pat-1', name: 'Grid again', mode: 1, w: 1, h: 1, compression: 0, planes: [[9]] },
      { id: 'pat-2', name: 'Gray', mode: 1, w: 2, h: 1, compression: 0, planes: [[10, 200]] },
    ])],
    ['phry', new Uint8Array(8)],
    ['zzzz', new Uint8Array(3)],
    ['desc', fullDesc()],
  ]);
}

test('v6: sampled tips at 8 and 16 bit, raw and RLE, fixed offset and probe', () => {
  const r = parseAbr(fullV6());
  assert.equal(r.report.version, 6);
  const byId = new Map(r.tips.map(t => [t.id, t]));
  assert.deepEqual([...byId.get(uuid(1))!.alpha], [0, 64, 128, 192, 255, 10]);
  assert.deepEqual([...byId.get(uuid(2))!.alpha], [5, 5, 5, 5, 1, 2, 3, 4]);
  assert.deepEqual([...byId.get(uuid(3))!.alpha], [0x12, 0xff, 0x00, 0x80]);
  assert.deepEqual([...byId.get('short')!.alpha], [0xab, 0xab]);
  assert.deepEqual([...byId.get(uuid(5))!.alpha], [99]);
  assert.equal(r.tips.length, 5);
  // Only the record with junk before its header needs the probe; the short id uses the after-id offset.
  assert.deepEqual(r.report.warnings.filter(w => /probing/.test(w)), ['8BIM samp record 5: bitmap header found by probing at byte 54']);
});

test('v6: patterns decode RGB with PackBits and gray raw, deduped by id', () => {
  const r = parseAbr(fullV6());
  assert.deepEqual(r.patterns.map(p => p.id), ['pat-1', 'pat-2']);
  const [p1, p2] = r.patterns;
  assert.deepEqual([p1.width, p1.height, p1.channels, p1.name], [2, 2, 4, 'Grid']);
  assert.deepEqual([...p1.data], [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  assert.deepEqual([p2.channels, ...p2.data], [1, 10, 200]);
});

test('v6: descriptor maps tip, dynamics, captured options and group to exact values', () => {
  const r = parseAbr(fullV6());
  const p = r.presets.find(x => x.name === 'Dyn Brush')!;
  assert.deepEqual(p.tip, { kind: 'sampled', tipRef: uuid(1), diameter: 42, hardness: 1, angle: 30, roundness: 0.5, spacing: 0.15, flipX: true, flipY: false });
  const d = p.dynamics;
  assert.deepEqual(d.shape, {
    enabled: true, size: dyn({ control: 'penPressure', fadeSteps: 25, jitter: 0.2, minimum: 0.05 }),
    angle: dyn({ control: 'direction', jitter: 0.1 }), roundness: dyn({ control: 'fade', fadeSteps: 12, minimum: 0.3 }),
    flipXJitter: true, flipYJitter: false, brushProjection: true,
  });
  assert.deepEqual(d.scattering, { enabled: true, amount: 2.5, scatter: dyn(), bothAxes: true, count: 3, countJitter: dyn({ jitter: 0.4 }) });
  assert.deepEqual(d.texture, {
    enabled: true, patternRef: 'pat-1', invert: true, scale: 1.5, brightness: 0.2, contrast: -0.3, eachTip: true, mode: 'color burn',
    depth: 0.7, minimumDepth: 0.25, depthJitter: dyn({ control: 'penPressure', minimum: 0.1 }),
  });
  assert.deepEqual(d.dualBrush, {
    enabled: true, tip: { kind: 'computed', profile: 'round', diameter: 12, hardness: 0.6, angle: 0, roundness: 1, spacing: 0.55, flipX: false, flipY: false },
    mode: 'darken', size: 12, spacing: 0.6, scatter: 0.4, bothAxes: true, count: 2, flipX: true, flipY: false,
  });
  assert.deepEqual(d.color, { enabled: true, fgBg: 0.25, hueJitter: 0.1, satJitter: 0.2, briJitter: 0.3, purity: -0.4, perTip: true });
  assert.deepEqual(d.transfer, { enabled: true, opacity: dyn({ control: 'penPressure' }), flow: dyn({ jitter: 0.5 }) });
  assert.deepEqual(d.pose, { enabled: true, overrideTilt: true, tiltX: 30, tiltY: -20, overrideRotation: false, rotation: 0, overridePressure: true, pressure: 0.6 });
  assert.deepEqual([d.wetEdges, d.buildUp, d.noise, d.protectTexture], [true, true, 0.1, true]);
  assert.deepEqual(p.captured, { opacity: 0.85, flow: 0.4, mode: 'multiply', color: [255, 128, 0] });
  assert.equal(p.group, 'Inks');
  const plain = r.presets.find(x => x.name === 'Plain')!;
  assert.deepEqual(plain.dynamics, defaultDynamics());
  assert.equal(plain.tip.diameter, 10);
});

test('v6: unused tips become presets; unknown keys and sections are skipped by name', () => {
  const r = parseAbr(fullV6());
  // Dyn Brush + Plain from desc, plus the four tips no descriptor references.
  assert.equal(r.presets.length, 6);
  assert.ok(r.report.skipped.some(s => s.includes('zzUn')));
  assert.ok(r.report.skipped.some(s => s.includes('phry') && s.includes('hierarchy not decoded')));
  assert.ok(r.report.skipped.some(s => s.includes('zzzz')));
});

test('lost 8BIM alignment scans forward to the next section', () => {
  const good = fullV6();
  const at = (() => { for (let i = 8; i < good.length; i++) if (String.fromCharCode(...good.subarray(i, i + 8)) === '8BIMpatt') return i; return -1; })();
  const bad = new Uint8Array(good.length + 5);
  bad.set(good.subarray(0, at)); bad.set([1, 2, 3, 4, 5], at); bad.set(good.subarray(at), at + 5);
  const r = parseAbr(bad);
  assert.ok(r.report.warnings.some(w => /alignment/.test(w)));
  assert.equal(r.patterns.length, 2);
  assert.ok(r.presets.some(p => p.name === 'Dyn Brush'));
});

test('corrupt: truncation at every 97th byte never throws and warns', () => {
  for (const file of [fullV6(), writeAbrV2([{ type: 'sampled', name: 'G', spacing: 25, bitmap: { w: 40, h: 40, depth: 8, compression: 1, samples: Array.from({ length: 1600 }, (_, i) => i % 7) } }])]) {
    for (let n = 0; n < file.length; n += 97) {
      const r = parseAbr(file.subarray(0, n));
      assert.ok(r.report.warnings.length > 0, `cut at ${n}`);
    }
  }
});

test('corrupt: huge section length, header too short, unknown descriptor type tag', () => {
  const huge = writeAbrV6([['samp', new Uint8Array(4)]]);
  new DataView(huge.buffer).setUint32(12, 0x7fffffff);
  assert.ok(parseAbr(huge).report.warnings.length > 0);
  assert.ok(parseAbr(new Uint8Array([0, 6])).report.warnings.some(w => /header/.test(w)));
  const desc = descriptor('null', [['Brsh', ['VlLs', [obj('brushPreset', [['Nm  ', ['TEXT', 'X']], ['odd ', ['raw', 'QQQQ', new Uint8Array(5)]]])]]]]);
  const r = parseAbr(writeAbrV6([['desc', desc]]));
  assert.ok(r.report.skipped.some(s => s.includes('QQQQ')));
  assert.ok(r.report.warnings.length > 0);
});

test('corrupt: 200 seeded random buffers never throw and warn', () => {
  let s = 0x9e3779b9;
  const next = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
  for (let i = 0; i < 200; i++) {
    const buf = new Uint8Array(next() % 600);
    for (let k = 0; k < buf.length; k++) buf[k] = next() & 255;
    // Every third buffer gets a plausible v6 header and an 8BIM start to reach the section walker.
    if (i % 3 === 0 && buf.length > 12) buf.set([0, 6, 0, 1, 56, 66, 73, 77], 0);
    if (i % 3 === 1 && buf.length > 4) buf.set([0, 2], 0);
    const r = parseAbr(buf);
    assert.ok(r.report.warnings.length > 0, `buffer ${i}`);
  }
});

test('decodePatternRecords reads an unprefixed record run (.pat body)', () => {
  const r = decodePatternRecords(pattSection([{ id: 'p', name: 'P', mode: 1, w: 1, h: 1, compression: 0, planes: [[42]] }]).subarray(4), false);
  assert.deepEqual(r.patterns.map(p => [p.id, ...p.data]), [['p', 42]]);
});

// A record with a 0-length id followed directly by the bitmap header (no name/junk bytes): 24 bytes
// claiming a 2500x2500 8-bit tip, with almost nothing behind the header.
function truncatedSampRecords(n: number, comp: 0 | 1): Uint8Array {
  const w = new W();
  for (let i = 0; i < n; i++) {
    const rec = new W().u8(0).i32(0).i32(0).i32(2500).i32(2500).i16(8).u8(comp).bytes(new Uint8Array(4)).out();
    w.u32(rec.length).bytes(rec);
  }
  return w.out();
}

for (const comp of [0, 1] as const) {
  test(`C1: ${comp === 0 ? 'raw' : 'PackBits'} truncated tip records do not allocate huge bitmaps`, () => {
    const file = writeAbrV6([['samp', truncatedSampRecords(40, comp)]]);
    const t0 = performance.now();
    const r = parseAbr(file);
    assert.ok(performance.now() - t0 < 200);
    assert.equal(r.tips.length, 0);
    assert.ok(r.report.warnings.length > 0);
  });
}

test('C1: PackBits header with an all-zero row-length table does not allocate before the pixel budget check', () => {
  const w = new W().u8(0).i32(0).i32(0).i32(2500).i32(2500).i16(8).u8(1).bytes(new Uint8Array(5000));
  const body = w.out();
  const section = new W().u32(body.length).bytes(body).out();
  const t0 = performance.now();
  const r = parseAbr(writeAbrV6([['samp', section]]));
  assert.ok(performance.now() - t0 < 200);
  assert.equal(r.tips.length, 0);
  assert.ok(r.report.warnings.length > 0);
});

test('C1: v1/v2 sampled tip header without the v6 header-plausibility gate still respects decodeBitmap truncation', () => {
  const r0 = new W().i32(0).i16(25).ustr('Huge').u8(1).i16(0).i16(0).i16(2500).i16(2500);
  r0.i32(0).i32(0).i32(2500).i32(2500).i16(8).u8(0);
  const body = r0.out();
  const file = new W().i16(2).i16(1).i16(2).i32(body.length).bytes(body).out();
  const r = parseAbr(file);
  assert.equal(r.tips.length, 0);
  assert.ok(r.report.warnings.length > 0);
});

test('descriptor: 64-deep nested VlLs warns and does not throw', () => {
  let v: DV = ['VlLs', []];
  for (let i = 0; i < 64; i++) v = ['VlLs', [v]];
  const desc = descriptor('null', [['zzKy', v]]);
  const r = parseAbr(writeAbrV6([['desc', desc]]));
  assert.ok(r.report.skipped.some(s => /nesting deeper/.test(s)));
});
