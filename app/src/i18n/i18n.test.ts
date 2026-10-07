import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMessagesFromFiles } from '@lingui/native-tools';
import { msg, plural, t } from '@lingui/core/macro';
import { i18n, LOCALES, negotiateLocale } from './index.ts';

test('negotiateLocale prefers the saved language, then the first browser language photobaer ships', () => {
  assert.equal(negotiateLocale('ja', ['de-AT', 'en'], LOCALES), 'ja');
  assert.equal(negotiateLocale(null, ['de-AT', 'en'], LOCALES), 'de');
  assert.equal(negotiateLocale(null, ['sv-SE', 'fr-CA', 'en'], LOCALES), 'fr');
  assert.equal(negotiateLocale(null, ['sv-SE'], LOCALES), 'en');
  assert.equal(negotiateLocale('xx', [], LOCALES), 'en');
});

test('negotiateLocale maps regional and script variants to the shipped one', () => {
  assert.equal(negotiateLocale(null, ['pt-PT'], LOCALES), 'pt-BR');
  assert.equal(negotiateLocale(null, ['pt'], LOCALES), 'pt-BR');
  assert.equal(negotiateLocale(null, ['zh-CN'], LOCALES), 'zh-Hans');
  assert.equal(negotiateLocale(null, ['zh'], LOCALES), 'zh-Hans');
  assert.equal(negotiateLocale(null, ['zh-TW', 'en'], LOCALES), 'en');
  assert.equal(negotiateLocale(null, ['es-MX'], LOCALES), 'es');
});

test('negotiateLocale only picks released languages', () => {
  assert.equal(negotiateLocale('de', ['de-AT'], ['en']), 'en');
  assert.equal(negotiateLocale(null, ['de-AT', 'ja'], ['en', 'ja']), 'ja');
});

test('LOCALES matches lingui.config.ts and every locale has CLDR plural rules', () => {
  const config = readFileSync(new URL('../../../lingui.config.ts', import.meta.url), 'utf8');
  const listed = JSON.parse(/locales: (\[[^\]]*\])/.exec(config)![1].replaceAll("'", '"')) as string[];
  assert.deepEqual(listed.filter(l => l !== 'pseudo'), [...LOCALES]);
  for (const l of LOCALES) assert.equal(Intl.PluralRules.supportedLocalesOf(l).length, 1, l);
});

test('Lingui macros run under node --test and render English source text', () => {
  const n = 3;
  assert.equal(t`Hello ${n} layers`, 'Hello 3 layers');
  assert.equal(i18n._(msg`Open…`), 'Open…');
  assert.equal(plural(1, { one: '# layer', other: '# layers' }), '1 layer');
  assert.equal(plural(2, { one: '# layer', other: '# layers' }), '2 layers');
});

// msgids of a PO file, joining continuation lines ("" followed by quoted parts).
function poIds(po: string): Set<string> {
  const ids = new Set<string>();
  const lines = po.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('msgid ')) continue;
    let id = JSON.parse(lines[i].slice(6)) as string;
    while (lines[i + 1]?.startsWith('"')) id += JSON.parse(lines[++i]) as string;
    if (id) ids.add(id);
  }
  return ids;
}

test('PO catalogs match the messages in the code (run pnpm i18n:extract after changing UI text)', async () => {
  const src = fileURLToPath(new URL('..', import.meta.url));
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter(f => /\.tsx?$/.test(f) && !/\.(test|d)\.ts$|engine-pkg/.test(f)).map(f => join(src, f));
  const { messages } = await extractMessagesFromFiles(files, {});
  const code = new Set(messages.map(m => m.message ?? m.id));
  const po = poIds(readFileSync(new URL('../locales/en/messages.po', import.meta.url), 'utf8'));
  assert.deepEqual([...code].filter(m => !po.has(m)), [], 'in code, missing from catalogs');
  assert.deepEqual([...po].filter(m => !code.has(m)), [], 'in catalogs, gone from code');
});
