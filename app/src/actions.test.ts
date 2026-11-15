import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LAYER_ARGS, NOT_LAYER_PARAMS, actionKeyOf, conditionHolds, decodeCall, encodeCall, fromJson, mapPath, newIds, playSteps, recordable, stepFields, toJson, withFields, type ActionStep, type Layers } from './actions.ts';
import type { DocInfo, LayerNode } from './worker/types.ts';

const layers = (...l: [number, string][]): Layers => ({ ids: l.map(x => x[0]), names: new Map(l) });

test('every worker param named like a layer id is mapped or listed as not a layer', () => {
  const src = readFileSync(new URL('./engine.worker.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('const api = {'), src.indexOf('\n};', src.indexOf('const api = {')));
  const missing: string[] = [];
  for (const m of body.matchAll(/^ {2}(?:async )?([a-zA-Z]+)\((.*)\)(?::[^{]*)? \{/gm)) {
    const [, op, params] = m;
    // Top-level params only: split on commas outside braces, brackets, parens and angle brackets.
    const tops: string[] = [];
    let depth = 0, cur = '';
    for (const ch of params) {
      if ('{[(<'.includes(ch)) depth++;
      if ('}])>'.includes(ch)) depth--;
      if (ch === ',' && depth === 0) { tops.push(cur); cur = ''; } else cur += ch;
    }
    tops.push(cur);
    tops.forEach((p, i) => {
      const pm = /^\s*([a-zA-Z]+)\??: number(\[\])?( \| null)?\s*$/.exec(p.replace(/ = .*$/, ''));
      if (!pm || !/^(id|ids|layerId|excludeId|above|parent|layer|from|to)$/.test(pm[1])) return;
      if (NOT_LAYER_PARAMS.has(`${op}.${pm[1]}`)) return;
      const want = pm[2] ? `${i}[]` : `${i}`;
      if (!(LAYER_ARGS[op] ?? []).includes(want)) missing.push(`${op}.${pm[1]} -> ${want}`);
    });
  }
  assert.deepEqual(missing, []);
});

test('mapPath maps ids, id lists and nested ids without changing the input', () => {
  const args = [[{ id: 3, shape: {} }, { id: 4 }], 'x'];
  const out = mapPath(args, '0[].id', v => (v as number) * 10);
  assert.deepEqual(out, [[{ id: 30, shape: {} }, { id: 40 }], 'x']);
  assert.equal((args[0] as { id: number }[])[0].id, 3);
  assert.deepEqual(mapPath([7, 8], '1', () => 0), [7, 0]);
  assert.deepEqual(mapPath([{ above: 2 }], '0.id', () => 0), [{ above: 2 }]);
});

test('encode then decode moves an action to another document', () => {
  // Recorded on a doc where layer 5 "Background" existed and the action made layer 9.
  const before = layers([5, 'Background']);
  const created = [9];
  const rec = [
    encodeCall({ op: 'addLayer', args: [5, 'Glow'] }, before, []),
    encodeCall({ op: 'setProps', args: [9, { opacity: 5 }] }, before, created),
    encodeCall({ op: 'command', args: ['fill', 5, 'pixels', [5, 5, 5, 255]] }, before, created),
    encodeCall({ op: 'groupNodes', args: [[9, 5]] }, before, created),
  ];
  assert.deepEqual(rec[0].args, [{ $L: { n: 'Background' } }, 'Glow']);
  assert.deepEqual(rec[1].args, [{ $L: { c: 0 } }, { opacity: 5 }]);
  assert.deepEqual(rec[2].args[3], [5, 5, 5, 255]);
  // Target doc: Background is id 1, the replayed addLayer made id 2.
  const now = layers([2, 'Glow'], [1, 'Background']);
  assert.deepEqual(decodeCall(rec[0], now, [], null).args, [1, 'Glow']);
  assert.deepEqual(decodeCall(rec[1], now, [2], null).args, [2, { opacity: 5 }]);
  assert.deepEqual(decodeCall(rec[2], now, [2], null).args, ['fill', 1, 'pixels', [5, 5, 5, 255]]);
  assert.deepEqual(decodeCall(rec[3], now, [2], null).args, [[2, 1]]);
});

test('a missing name or created layer falls back to the target layer, else fails', () => {
  const rec = encodeCall({ op: 'deleteNode', args: [5] }, layers([5, 'Old']), []);
  assert.deepEqual(decodeCall(rec, layers([1, 'Other']), [], 1).args, [1]);
  assert.throws(() => decodeCall(rec, layers([1, 'Other']), [], null), /no layer named "Old"/);
  assert.deepEqual(decodeCall({ op: 'deleteNode', args: [{ $L: { c: 0 } }] }, layers(), [], 1).args, [1]);
  assert.throws(() => decodeCall({ op: 'deleteNode', args: [{ $L: { c: 0 } }] }, layers(), [], null), /not created/);
});

test('newIds lists created layers in tree order', () => {
  assert.deepEqual(newIds(layers([1, 'a']), layers([4, 'x'], [3, 'y'], [1, 'a'])), [4, 3]);
});

test('toJson keeps typed arrays; recordable refuses files', () => {
  const v = { a: new Uint8Array([1, 2, 255]), f: new Float32Array([1.5, -2]), n: [1] };
  const back = fromJson<typeof v>(toJson(v));
  assert.deepEqual([...back.a], [1, 2, 255]);
  assert.ok(back.f instanceof Float32Array);
  assert.deepEqual([...back.f], [1.5, -2]);
  assert.equal(recordable([1, { x: new Uint8Array(2) }]), true);
  assert.equal(recordable([new Blob(['x'])]), false);
});

const L = { $L: { n: 'Background' } };
const step = (id: string, calls: ActionStep['calls'] = [], more: Partial<ActionStep> = {}): ActionStep => ({ id, label: id, enabled: true, calls, ...more });

test('stepFields lists the dialog values of the last dialog call; withFields edits a copy', () => {
  const blur = (radius: number) => ({ op: 'applyFilter', args: [L, 'pixels', { kind: 'gaussian_blur', params: { radius } }, 'Gaussian Blur', true] });
  const s = step('Gaussian Blur', [blur(2), blur(4), { op: 'previewEnd', args: [true] }]);
  assert.deepEqual(stepFields(s).map(f => [f.label, f.value]), [['radius', 4]]);
  const out = withFields(s, [8]);
  assert.deepEqual(out.calls[1].args[2], { kind: 'gaussian_blur', params: { radius: 8 } });
  assert.deepEqual(s.calls[1].args[2], { kind: 'gaussian_blur', params: { radius: 4 } }, 'the input stays as recorded');

  const size = step('Canvas Size', [{ op: 'canvasSize', args: [640, 480, 0.5, 0, [255, 255, 255, 255]] }]);
  assert.deepEqual(stepFields(size).map(f => [f.label, f.value]), [['width', 640], ['height', 480], ['anchor x', 0.5], ['anchor y', 0], ['color › 1', 255], ['color › 2', 255], ['color › 3', 255], ['color › 4', 255]]);
  const lv = step('Levels', [{ op: 'adjust', args: [L, { kind: 'levels', params: { composite: { input_black: 10, input_white: 245, gamma: 1.2 }, red: null } }, 'Levels'] }]);
  assert.deepEqual(stepFields(lv).map(f => [f.label, f.value]), [['composite › input black', 10], ['composite › input white', 245], ['composite › gamma', 1.2]]);
  assert.deepEqual(stepFields(step('Opacity', [{ op: 'setProps', args: [L, { opacity: 0.5 }] }])), [], 'not a dialog command');
  assert.deepEqual(stepFields(step('Curves', [{ op: 'adjust', args: [L, { kind: 'curves', params: { mode: 'point', composite: [[0, 0], [255, 255]] } }, 'Curves'] }])).map(f => f.label), ['mode']);
});

test('playSteps splits at stop and dialog steps and plays the edited copy; Cancel ends playback', async () => {
  const blur = step('Blur', [{ op: 'applyFilter', args: [L, 'pixels', { kind: 'gaussian_blur', params: { radius: 2 } }, 'Gaussian Blur'] }], { dialog: true });
  const steps = [step('a'), blur, step('b'), step('Stop', [], { stop: { message: 'm', allowContinue: true } }), step('c')];
  const segs: [string[], boolean][] = [];
  const asked: string[] = [];
  const ok = await playSteps(steps, {
    play: async (seg, resume) => { segs.push([seg.map(s => s.id), resume]); assert.ok(seg[0].id !== 'Blur' || (seg[0].calls[0].args[2] as { params: { radius: number } }).params.radius === 9); return true; },
    stop: () => true,
    ask: async s => { asked.push(s.id); return withFields(s, [9]); },
  });
  assert.equal(ok, true);
  assert.deepEqual(asked, ['Blur']);
  assert.deepEqual(segs, [[['a'], false], [['Blur', 'b'], true], [['c'], true]]);

  segs.length = 0;
  assert.equal(await playSteps(steps, { play: async seg => { segs.push([seg.map(s => s.id), false]); return true; }, stop: () => true, ask: async () => null }), false);
  assert.deepEqual(segs.map(s => s[0]), [['a']], 'Cancel in the dialog stops before the step');
  segs.length = 0;
  assert.equal(await playSteps(steps, { play: async seg => { segs.push([seg.map(s => s.id), false]); return true; }, stop: () => false }), false);
  assert.deepEqual(segs.map(s => s[0]), [['a', 'Blur', 'b']], 'without an ask hook dialog steps play as recorded');
});

test('menu item and conditional steps: the menu hook runs, the condition picks Then or Else, nested actions cannot loop', async () => {
  const log: string[] = [];
  const sets: Record<string, ActionStep[]> = {
    Wide: [step('w1')],
    Tall: [step('t1')],
    Self: [step('If', [], { cond: { if: 'square', then: 'Self', else: null } })],
  };
  const h = (square: boolean) => ({
    play: async (seg: ActionStep[], resume: boolean) => { log.push(`play ${seg.map(s => s.id).join(',')}${resume ? ' resume' : ''}`); return true; },
    stop: () => true,
    menu: async (s: ActionStep) => { log.push(`menu ${s.menu!.path.join('>')}`); return true; },
    holds: (c: string) => c === 'landscape' ? !square : square,
    action: (name: string) => sets[name],
  });
  const steps = [step('a'), step('Menu', [], { menu: { path: ['Image', 'Image Size…'] } }), step('b'), step('If', [], { cond: { if: 'landscape', then: 'Wide', else: 'Tall' } }), step('c')];
  assert.equal(await playSteps(steps, h(false)), true);
  assert.deepEqual(log, ['play a', 'menu Image>Image Size…', 'play b resume', 'play w1', 'play c']);
  log.length = 0;
  assert.equal(await playSteps(steps, h(true)), true);
  assert.deepEqual(log.slice(3), ['play t1', 'play c']);
  await assert.rejects(playSteps([step('If', [], { cond: { if: 'landscape', then: 'Gone', else: null } })], h(false)), /"Gone"/);
  await assert.rejects(playSteps(sets.Self, h(true)), /plays itself/);
  log.length = 0;
  sets.Loop = [step('blur'), step('If', [], { cond: { if: 'square', then: 'Loop', else: null } })];
  await assert.rejects(playSteps(sets.Loop, h(true), ['Loop']), /plays itself/);
  assert.deepEqual(log, ['play blur'], 'the played action counts as playing, so its steps run once');
  log.length = 0;
  assert.equal(await playSteps([step('If', [], { cond: { if: 'square', then: 'Self', else: null } }), step('z')], h(false)), true);
  assert.deepEqual(log, ['play z'], 'a false condition with Else None plays nothing');
});

test('conditionHolds checks the document and the active layer', () => {
  const node = (id: number, name: string, more: Partial<LayerNode> = {}): LayerNode => ({ id, name, kind: 'pixel', visible: true, opacity: 1, fill: 1, blend: 'normal', clipping: false, locks: { transparency: false, pixels: false, position: false }, mask: null, style: null, blending: {} as LayerNode['blending'], ...more });
  const doc = (w: number, h: number, layers: LayerNode[], more: Partial<DocInfo> = {}) => ({ width: w, height: h, layers, mode: null, gray: false, selection: null, ...more }) as unknown as DocInfo;
  const bg = node(1, 'Background'), text = node(2, 'Title', { kind: 'text', mask: { enabled: true, default: 0 } });
  const d = doc(300, 200, [bg, text]);
  assert.equal(conditionHolds('landscape', d, 2), true);
  assert.equal(conditionHolds('square', d, 2), false);
  assert.equal(conditionHolds('square', doc(64, 64, [bg]), 1), true);
  assert.equal(conditionHolds('rgb', d, 2), true);
  assert.equal(conditionHolds('gray', doc(8, 8, [bg], { gray: true }), 1), true);
  assert.equal(conditionHolds('cmyk', doc(8, 8, [bg], { mode: { kind: 'cmyk' } as DocInfo['mode'] }), 1), true);
  assert.equal(conditionHolds('rgb', doc(8, 8, [bg], { mode: { kind: 'cmyk' } as DocInfo['mode'] }), 1), false);
  assert.equal(conditionHolds('layers', d, 2), true);
  assert.equal(conditionHolds('layers', doc(8, 8, [bg]), 1), false);
  assert.equal(conditionHolds('selection', doc(8, 8, [bg], { selection: { bounds: [0, 0, 4, 4], default: 0 } }), 1), true);
  assert.equal(conditionHolds('background', d, 1), true);
  assert.equal(conditionHolds('background', d, 2), false);
  assert.equal(conditionHolds('background', doc(8, 8, [node(1, 'Background'), node(3, 'Background')]), 3), false, 'only the bottom layer');
  assert.equal(conditionHolds('text', d, 2), true);
  assert.equal(conditionHolds('pixelMask', d, 2), true);
  assert.equal(conditionHolds('pixelMask', d, 1), false);
  assert.equal(conditionHolds('text', d, null), false, 'no active layer: layer conditions are false');
});

test('actionKeyOf names F2 to F12 with Shift and Ctrl; other keys and Alt are not action keys', () => {
  const k = (key: string, m: Partial<Record<'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) =>
    actionKeyOf({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...m });
  assert.equal(k('F2'), 'F2');
  assert.equal(k('F12', { shiftKey: true, ctrlKey: true }), 'Shift+Ctrl+F12');
  assert.equal(k('F5', { metaKey: true }), 'Ctrl+F5');
  assert.equal(k('F1'), null);
  assert.equal(k('F13'), null);
  assert.equal(k('F9', { altKey: true }), null);
  assert.equal(k('a'), null);
});
