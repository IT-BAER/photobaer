// Filter names and parameter labels come from the engine in English; the app translates them by that text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, filter_schema } from '../engine-pkg/photobaer_engine.js';
import { engineLabel, ENGINE_LABELS } from './labels.ts';
import { menuLabel, type FilterSpec } from './schema.ts';
import { i18n } from '../i18n/index.ts';

initSync({ module: readFileSync(new URL('../engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });
const specs = JSON.parse(filter_schema()) as FilterSpec[];

test('every engine filter name and parameter label has a message', () => {
  const texts = new Set(specs.flatMap(s => [s.label, ...s.params.map(p => p.label)]));
  assert.deepEqual([...texts].filter(t => !ENGINE_LABELS[t]), []);
  assert.deepEqual(Object.keys(ENGINE_LABELS).filter(t => !texts.has(t)), [], 'no unused messages');
  for (const [text, d] of Object.entries(ENGINE_LABELS)) assert.equal(d.message, text);
});

test('engineLabel shows the active language and falls back to the engine text', () => {
  const gauss = specs.find(s => s.label === 'Gaussian Blur')!;
  i18n.loadAndActivate({ locale: 'de', messages: { [ENGINE_LABELS.Radius.id!]: 'Radius (de)', [ENGINE_LABELS['Gaussian Blur'].id!]: 'Gaußscher Weichzeichner' } });
  try {
    assert.equal(engineLabel('Radius'), 'Radius (de)');
    assert.equal(engineLabel('Not In Engine'), 'Not In Engine');
    assert.equal(menuLabel(gauss), 'Gaußscher Weichzeichner…');
  } finally {
    i18n.loadAndActivate({ locale: 'en', messages: {} });
  }
});
