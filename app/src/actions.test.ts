import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LAYER_ARGS, NOT_LAYER_PARAMS, decodeCall, encodeCall, fromJson, mapPath, newIds, recordable, toJson, type Layers } from './actions.ts';

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
