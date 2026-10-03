import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyVariables, exportCsv, importDataSets, parseCsv, planDataSet, replaceText, setBinding, valueOf, type Variables } from './variables.ts';

const MODEL: Variables = {
  variables: [{ kind: 'visibility', name: 'logo', layer: 2 }, { kind: 'text', name: 'title', layer: 3 }],
  data_sets: [], active: null,
};

test('parseCsv handles quotes, doubled quotes, CRLF, a BOM and trailing blank rows', () => {
  assert.deepEqual(parseCsv('﻿a,"b,c","say ""hi"""\r\n1,"two\nlines",3\n\n', ','), [['a', 'b,c', 'say "hi"'], ['1', 'two\nlines', '3']]);
  assert.deepEqual(parseCsv('x\ty\n1\t2', '\t'), [['x', 'y'], ['1', '2']]);
});

test('importDataSets maps columns by header, detects the delimiter and reports gaps', () => {
  const r = importDataSets(MODEL, 'name;title;extra\nA;Hello;1\nB;World\n', { firstColumnIsName: true, replace: true });
  assert.deepEqual(r.model.data_sets, [
    { name: 'A', values: { title: 'Hello', extra: '1' } },
    { name: 'B', values: { title: 'World', extra: '' } },
  ]);
  assert.equal(r.model.active, 'A');
  assert.deepEqual(r.unknown, ['extra']);
  assert.deepEqual(r.missing, ['logo']);
  assert.equal(r.warnings.length, 1);
  const tsv = importDataSets(r.model, 'logo\ttitle\nfalse\tX\n', { firstColumnIsName: false, replace: false });
  assert.deepEqual(tsv.model.data_sets.map(d => d.name), ['A', 'B', 'Data Set 3']);
  assert.equal(tsv.model.active, 'A', 'appending keeps the active set');
  const dup = importDataSets(r.model, 'n,title\nA,again\n', { firstColumnIsName: true, replace: false });
  assert.deepEqual(dup.model.data_sets.map(d => d.name), ['A', 'B', 'A 2']);
  assert.throws(() => importDataSets(MODEL, '', { firstColumnIsName: false, replace: true }), /empty/);
});

test('exportCsv writes a name column and quotes when needed, and round-trips through import', () => {
  const m: Variables = { ...MODEL, data_sets: [{ name: 'One', values: { logo: 'true', title: 'a, "b"' } }, { name: 'Two', values: { title: 'x' } }], active: 'One' };
  const csv = exportCsv(m);
  assert.equal(csv, 'Data Set,logo,title\nOne,true,"a, ""b"""\nTwo,,x\n');
  assert.deepEqual(importDataSets(MODEL, csv, { firstColumnIsName: true, replace: true }).model.data_sets, [
    { name: 'One', values: { logo: 'true', title: 'a, "b"' } }, { name: 'Two', values: { logo: '', title: 'x' } },
  ]);
});

test('setBinding validates names, renames values and removes a binding', () => {
  const m = { ...MODEL, data_sets: [{ name: 'A', values: { logo: 'true', title: 'T' } }], active: 'A' };
  assert.throws(() => setBinding(m, 4, 'visibility', '9lives'), /not a valid variable name/);
  assert.throws(() => setBinding(m, 4, 'visibility', 'title'), /already/);
  const renamed = setBinding(m, 3, 'text', 'headline');
  assert.deepEqual(renamed.variables.find(v => v.layer === 3), { kind: 'text', name: 'headline', layer: 3 });
  assert.deepEqual(renamed.data_sets[0].values, { logo: 'true', headline: 'T' });
  const removed = setBinding(m, 2, 'visibility', null);
  assert.deepEqual(removed.variables.map(v => v.name), ['title']);
  assert.deepEqual(removed.data_sets[0].values, { title: 'T' });
  assert.equal(setBinding(emptyVariables(), 1, 'visibility', 'v').variables.length, 1);
});

test('planDataSet resolves visibility words and text, and reports dangling or wrong layers', () => {
  const m: Variables = {
    variables: [...MODEL.variables, { kind: 'visibility', name: 'gone', layer: 99 }, { kind: 'text', name: 'notype', layer: 2 }],
    data_sets: [{ name: 'A', values: { logo: 'Hidden', title: 'Hi', gone: 'true', notype: 'x' } }, { name: 'B', values: { logo: 'maybe' } }, { name: 'C', values: { logo: ' ', title: '' } }],
    active: null,
  };
  const nodes = [{ id: 2, kind: 'pixel', name: 'Logo' }, { id: 3, kind: 'text', name: 'Title' }];
  const a = planDataSet(m, nodes, 'A');
  assert.deepEqual(a.visible, [[2, false]]);
  assert.deepEqual(a.text, [[3, 'Hi']]);
  assert.equal(a.errors.length, 2);
  assert.match(planDataSet(m, nodes, 'B').errors[0], /maybe/);
  const c = planDataSet(m, nodes, 'C');
  assert.deepEqual([c.visible, c.text, c.errors], [[], [[3, '']], []], 'a blank visibility is unchanged, blank text is applied');
  assert.throws(() => planDataSet(m, nodes, 'D'), /No data set/);
});

test('replaceText makes one run and one paragraph that cover the new text in UTF-16 units', () => {
  const t = { text: 'old', runs: [{ length: 1, size: 12 }, { length: 2, size: 20 }], paragraphs: [{ length: 3, alignment: 'left' }], shape: { type: 'point' } };
  const r = replaceText(t, 'a😀b');
  assert.equal(r.text, 'a😀b');
  assert.deepEqual(r.runs, [{ length: 4, size: 12 }]);
  assert.deepEqual(r.paragraphs, [{ length: 4, alignment: 'left' }]);
  assert.equal(r.shape, t.shape);
});

test('variable names like constructor or toString read only the data set own values', () => {
  const m: Variables = { variables: [{ kind: 'text', name: 'constructor', layer: 3 }, { kind: 'visibility', name: 'toString', layer: 2 }], data_sets: [{ name: 'A', values: {} }], active: null };
  const p = planDataSet(m, [{ id: 2, kind: 'pixel', name: 'P' }, { id: 3, kind: 'text', name: 'T' }], 'A');
  assert.deepEqual([p.visible, p.text, p.errors], [[], [], []]);
  assert.equal(exportCsv(m), 'Data Set,constructor,toString\nA,,\n');
  assert.equal(valueOf(m.data_sets[0], 'constructor'), undefined);
  assert.deepEqual(setBinding(m, 3, 'text', 'title').data_sets[0].values, {}, 'a rename moves no inherited value');
});
