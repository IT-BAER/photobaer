import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOCALES, RELEASED } from './index.ts';
import { check, poEntries, shape } from './catalogCheck.ts';

test('check accepts a faithful translation and flags lost placeholders, tags and plural keys', () => {
  assert.deepEqual(check('de', 'Open {name}?', '{name} öffnen?'), []);
  assert.deepEqual(check('de', '{n, plural, one {# file} other {# files}}', '{n, plural, one {# Datei} other {# Dateien}}'), []);
  assert.deepEqual(check('ja', '{n, plural, one {# file} other {# files}}', '{n, plural, other {# 個のファイル}}'), []);
  assert.deepEqual(check('fr', '{n, plural, one {# file} other {# files}}', '{n, plural, one {# fichier} other {# fichiers}}'), []);
  assert.deepEqual(check('de', 'Code under <0>AGPL</0>.', 'Code unter <0>AGPL</0>.'), []);
  assert.match(check('de', 'Open {name}?', '{Name} öffnen?').join(), /placeholders/);
  assert.match(check('de', 'Code under <0>AGPL</0>.', 'Code unter AGPL.').join(), /tags/);
  assert.match(check('ja', '{n, plural, one {# file} other {# files}}', '{n, plural, one {#} other {#}}').join(), /not in ja/);
  assert.match(check('pl', '{n, plural, one {# file} other {# files}}', '{n, plural, one {#} other {#}}').join(), /lacks pl keys: few,many/);
  assert.match(check('de', '{k, select, a {A} other {B}}', '{k, select, other {B}}').join(), /select keys/);
  assert.match(check('de', 'Open {name}?', '{name öffnen?').join(), /bad placeholder|unterminated/);
});

const catalogs = LOCALES.filter(l => l !== 'en').map(l => ({
  locale: l,
  entries: poEntries(readFileSync(new URL(`../locales/${l}/messages.po`, import.meta.url), 'utf8')),
}));

test('every English message parses as ICU', () => {
  const en = poEntries(readFileSync(new URL('../locales/en/messages.po', import.meta.url), 'utf8'));
  const bad = en.flatMap(e => { try { shape(e.id); return []; } catch (err) { return [(err as Error).message]; } });
  assert.deepEqual(bad, []);
});

test('translations keep the placeholders, tags and plural/select keys of their English source', () => {
  const problems = catalogs.flatMap(({ locale, entries }) => entries.filter(e => e.str)
    .flatMap(e => check(locale, e.id, e.str).map(p => `${locale} ${JSON.stringify(e.id)}: ${p}`)));
  assert.deepEqual(problems, []);
});

test('released languages translate every message', () => {
  const missing = catalogs.filter(c => RELEASED.includes(c.locale))
    .flatMap(({ locale, entries }) => entries.filter(e => !e.str).map(e => `${locale} ${JSON.stringify(e.id)}`));
  assert.deepEqual(missing, []);
});
