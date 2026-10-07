// Visible UI text must go through Lingui (docs/I18N.md phase 3). Counts hard-coded strings per file against a
// baseline that only shrinks; UPDATE_BASELINE=1 rewrites it after extraction. Heuristic: regexes, not a parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const BASELINE = fileURLToPath(new URL('hardcoded-baseline.json', import.meta.url));

const JSX_TEXT = />[ \t]*[^<>{}\n=;()&|?]*[A-Za-z]{2}[^<>{}\n;]*</g;
const ATTR = /\b(?:title|aria-label|placeholder|alt|label)="[^"]*[A-Za-z][^"]*"/g;
const PROP = /\b(?:label|title|tip): ['`][^'`\n]*[A-Za-z]{2}/g;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return /^(locales|engine-pkg)$/.test(e.name) ? [] : files(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$|\.d\.ts$/.test(e.name) ? [p] : [];
  });
}

export function hardcoded(path: string, raw: string): string[] {
  const source = raw.replace(/<Trans\b[^>]*>[\s\S]*?<\/Trans>/g, '');
  const found: string[] = [...(source.match(PROP) ?? [])];
  if (path.endsWith('.tsx')) found.push(...(source.match(JSX_TEXT) ?? []).filter(m => !/^>\s*</.test(m)), ...(source.match(ATTR) ?? []));
  return found;
}

test('hardcoded finds JSX text, literal text attributes and label properties, not translated text', () => {
  assert.deepEqual(hardcoded('a.tsx', '<b title="Zoom in">Open file</b>'), ['>Open file<', 'title="Zoom in"']);
  assert.deepEqual(hardcoded('a.ts', "{ label: 'Snap', run }"), ["label: 'Snap"]);
  assert.deepEqual(hardcoded('a.tsx', '<b title={t`Zoom in`}><Trans>Open file</Trans></b>{tl(msg`Snap`)}'), []);
});

test('no new hard-coded UI text (wrap it in Trans, t or msg; UPDATE_BASELINE=1 after removing some)', () => {
  const counts: Record<string, number> = {};
  const hits: Record<string, string[]> = {};
  for (const f of files(SRC)) {
    const h = hardcoded(f, readFileSync(f, 'utf8'));
    if (h.length) { const k = relative(SRC, f).replaceAll('\\', '/'); counts[k] = h.length; hits[k] = h; }
  }
  if (process.env.UPDATE_BASELINE) writeFileSync(BASELINE, `${JSON.stringify(counts, Object.keys(counts).sort(), 1)}\n`);
  const base = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>;
  const grown = Object.keys(counts).filter(k => counts[k] > (base[k] ?? 0)).map(k => `${k}: ${base[k] ?? 0} -> ${counts[k]}\n  ${hits[k].join('\n  ')}`);
  assert.deepEqual(grown, [], 'new hard-coded text');
  const shrunk = Object.keys(base).filter(k => (counts[k] ?? 0) < base[k]);
  assert.deepEqual(shrunk, [], 'fewer hard-coded strings: run with UPDATE_BASELINE=1');
});
