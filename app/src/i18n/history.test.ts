// History labels stay English in the worker; historyLabel translates them for display. The coverage scan is a
// heuristic over source text (no parser): it finds literal labels in the places listed in `labelSources`, not
// labels built elsewhere or passed through variables it does not know (those fall back to English).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageDescriptor } from '@lingui/core';
import { i18n } from './index.ts';
import { HISTORY_LABELS, HISTORY_PATTERNS, historyLabel } from './history.ts';
import { ENGINE_LABELS } from '../filters/labels.ts';
import { DESTRUCTIVE_LABEL, EDIT_LABEL, MENU_LABEL } from '../adjustments.ts';
import { BOOL_LABEL } from '../shell/shapetools.ts';
import { TOOLS } from '../shell/tools.ts';
import { EFFECT_LABEL } from '../layerStyle.ts';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return /^(locales|engine-pkg|worker)$/.test(e.name) ? [] : files(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$|\.d\.ts$|engine\.worker\.ts$/.test(e.name) ? [p] : [];
  });
}

// Index after the bracket that closes the one at `s[i]`; skips strings and template literals.
function close(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "'" || c === '"') { j = s.indexOf(c, j + 1); continue; }
    if (c === '`') { j = template(s, j); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (--depth === 0) return j + 1; }
  }
  return s.length;
}
// Index of the backtick that ends the template literal starting at `s[i]`.
function template(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '`') return j;
    else if (s[j] === '$' && s[j + 1] === '{') j = close(s, j + 1) - 1;
  }
  return s.length;
}
// Top-level comma-separated parts of the bracket group starting at `s[i]`.
function args(s: string, i: number): string[] {
  const end = close(s, i) - 1, out: string[] = [];
  let depth = 0, from = i + 1;
  for (let j = i + 1; j < end; j++) {
    const c = s[j];
    if (c === "'" || c === '"') j = s.indexOf(c, j + 1);
    else if (c === '`') j = template(s, j);
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(from, j).trim()); from = j + 1; }
  }
  out.push(s.slice(from, end).trim());
  return out;
}

// Labels an expression can produce: its string literals (not ones compared with ===), templates expanded with
// their inner literals as alternatives and 'X' for other placeholders.
function literals(expr: string): string[] {
  const out: string[] = [];
  for (let j = 0; j < expr.length; j++) {
    const c = expr[j];
    if (c !== "'" && c !== '`') continue;
    const end = c === '`' ? template(expr, j) : expr.indexOf(c, j + 1);
    const body = expr.slice(j + 1, end), around = expr.slice(Math.max(0, j - 4), j) + expr.slice(end + 1, end + 5);
    if (!/[!=]==?/.test(around) && !/\[\s*$/.test(expr.slice(0, j)) && /[A-Za-z]/.test(body)) out.push(...(c === '`' ? expand(body) : [body]));
    j = end;
  }
  return out;
}
function expand(body: string): string[] {
  const i = body.indexOf('${');
  if (i < 0) return [body];
  const end = close(body, i + 1), inner = literals(body.slice(i + 2, end - 1));
  return (inner.length ? inner : ['X']).flatMap(v => expand(body.slice(0, i) + v + body.slice(end)).map(r => r));
}

const LABEL_CALL = /(?:\bhistory\.(?:run|begin|commit)|\bstepIfChanged|(?<![.\w])edit|\bcanvasEdit)\(/g;
// App wrappers that take a history label and pass it to client.call: [file, function, label argument index].
const WRAPPERS: [string, string, number][] = [
  ['app/menus.ts', 'quickFill', 1], ['app/menus.ts', 'filterCommand', 1], ['app/menus.ts', 'transformRemap', 1],
  ['App.tsx', 'contentAwareCall', 5], ['app/measureTools.tsx', 'commit', 1], ['AnalysisDialogs.tsx', 'commit', 1],
  ['NotesPanels.tsx', 'commit', 1], ['app/penTools.ts', 'commit', 2], ['PropertiesPanel.tsx', 'commit', 2],
  ['PropertiesPanel.tsx', 'edit', 0], ['PropertiesPanel.tsx', 'editStroke', 0], ['PropertiesPanel.tsx', 'flag', 2],
  ['PropertiesPanel.tsx', 'setFlag', 1], ['app/typeMenu.ts', 'applyType', 3], ['app/typeMenu.ts', 'applyLoaded', 3],
  ['TypePanels.tsx', 'applyType', 3], ['TypePanels.tsx', 'run', 0], ['TypePanels.tsx', 'para', 0],
  ['MissingFonts.tsx', 'apply', 2], ['MissingFonts.tsx', 'commit', 1],
];
// String tables whose values are sent as history labels: [file, table name].
const TABLES: [string, string][] = [['app/helpers.ts', 'PAINT_LABELS'], ['app/helpers.ts', 'FILL_LAYERS'], ['shell/DeformSession.tsx', 'LABEL']];
// Files whose `label: '…'` object properties are history labels.
const PROPS = ['shell/pentools.ts', 'app/actionsStore.ts'];
// Scanned templates whose placeholder is a closed set the scan cannot see: the labels they stand for.
const PLACEHOLDERS: Record<string, string[]> = {
  'X Shape': ['Pen Shape', 'Freeform Shape', 'Curvature Shape'], 'X Path': ['Pen Path', 'Freeform Path', 'Curvature Path'],
  'X Bits/Channel': ['8 Bits/Channel', '16 Bits/Channel', '32 Bits/Channel'],
  'Artboard X': ['Artboard X', 'Artboard Y', 'Artboard W', 'Artboard H'],
};

function labelSources(): Map<string, string> {
  const found = new Map<string, string>();
  const add = (where: string, expr: string) => { for (const l of literals(expr).flatMap(x => PLACEHOLDERS[x] ?? [x])) if (!found.has(l)) found.set(l, where); };
  const worker = ['engine.worker.ts', ...readdirSync(join(SRC, 'worker')).filter(f => /^[^.]+\.ts$/.test(f)).map(f => `worker/${f}`)];
  const labelArg = new Map<string, number>();
  for (const f of worker) {
    const s = read(f);
    for (const m of s.matchAll(LABEL_CALL)) add(f, args(s, m.index + m[0].length - 1)[0]);
    // Label tables and defaults: `const label = {…}[k]`, `labels`/`names` records, `label = '…'` parameters,
    // `label: '…'` session fields, CANVAS_REMAPS, and the return values of *Label functions.
    for (const m of s.matchAll(/\b(?:const|let) (?:label|labels|names|CANVAS_REMAPS)\b[^=\n]*= \{/g)) add(f, s.slice(m.index, close(s, m.index + m[0].length - 1)).replace(/^[^{]*/, '').replace(/\w+:/g, ''));
    for (const m of s.matchAll(/\blabel\??(?:: string)? = ('[^']*')/g)) add(f, m[1]);
    for (const m of s.matchAll(/\blabel: ([^,}\n]*'[^,}\n]*)/g)) add(f, m[1]);
    for (const m of s.matchAll(/function \w*Label\([^)]*\)[^{]*\{/g)) {
      const body = s.slice(m.index, close(s, m.index + m[0].length - 1));
      for (const r of body.matchAll(/return ([^;\n]*)/g)) add(f, r[1]);
    }
    if (f !== 'engine.worker.ts') continue;
    // Worker methods: index of the label parameter (rasterizeLayers names its label `name`).
    for (const m of s.matchAll(/^ {2}(\w+)\(/gm)) {
      const i = args(s, m.index + m[0].length - 1).findIndex(p => /^label\b/.test(p) || (m[1] === 'rasterizeLayers' && /^name\b/.test(p)));
      if (i >= 0) labelArg.set(m[1], i);
    }
  }
  assert.ok(labelArg.size > 20, 'worker label parameters found');
  for (const p of files(SRC)) {
    const f = relative(SRC, p).replaceAll('\\', '/'), s = readFileSync(p, 'utf8');
    for (const m of s.matchAll(/\bclient\.call\('(\w+)'/g)) {
      const i = labelArg.get(m[1]);
      if (i !== undefined) add(f, args(s, m.index + m[0].length - "('".length - m[1].length - 1)[i + 1] ?? '');
    }
    for (const [file, fn, i] of WRAPPERS) {
      if (file !== f) continue;
      for (const m of s.matchAll(new RegExp(`(?<![.\\w])${fn}\\(`, 'g'))) {
        const a = args(s, m.index + m[0].length - 1);
        if (!/^\w+:/.test(a[i] ?? '')) add(f, a[i] ?? '');
      }
    }
    if (PROPS.includes(f)) for (const m of s.matchAll(/label: ('[^']*')/g)) add(f, m[1]);
    for (const [file, name] of TABLES) {
      if (file !== f) continue;
      const m = new RegExp(`\\bconst ${name}\\b[^=]*= \\{`).exec(s);
      assert.ok(m, `${file}: table ${name}`);
      const body = s.slice(m.index + m[0].length - 1, close(s, m.index + m[0].length - 1));
      add(f, body.replace(/\bname: '[^']*'/g, '').replace(/\btitle: msg`[^`]*`/g, '').replace(/msg`/g, '`').replace(/\w+:/g, ''));
    }
  }
  // Descriptor tables whose English text the app sends as a label (TOOLS: the marquee tools' select steps).
  const text = (v: string | MessageDescriptor) => (typeof v === 'string' ? v : v.message!);
  const tables = [MENU_LABEL, BOOL_LABEL, EFFECT_LABEL, DESTRUCTIVE_LABEL, EDIT_LABEL].flatMap(t => Object.values(t as Record<string, string | MessageDescriptor>).map(text));
  for (const l of [...tables, ...Object.entries(TOOLS).filter(([k]) => k.startsWith('marquee')).map(([, t]) => text(t.label))]) if (!found.has(l)) found.set(l, 'table');
  return found;
}

const known = (l: string) => Object.hasOwn(HISTORY_LABELS, l) || Object.hasOwn(ENGINE_LABELS, l) || HISTORY_PATTERNS.some(p => p.re.test(l));

test('every history label in the worker and its app callers has display text', () => {
  const found = labelSources();
  assert.ok(found.has('Deselect') && found.has('Polygonal Lasso') && found.has('Rename Layer') && found.has('Align X'), 'scan finds labels');
  assert.deepEqual([...found].filter(([l]) => !known(l)).map(([l, f]) => `${f}: ${l}`), []);
});

test('historyLabel translates plain and interpolated labels and passes unknown text through', () => {
  assert.equal(historyLabel('Deselect'), 'Deselect');
  assert.equal(historyLabel('Gaussian Blur (uses a file, not recorded)'), 'Gaussian Blur (uses a file, not recorded)');
  assert.equal(historyLabel('no such step'), 'no such step');
  assert.equal(historyLabel('toString'), 'toString');
  assert.equal(historyLabel('16 Bits/Channel'), '16 Bits/Channel');
  const notRecorded = HISTORY_PATTERNS.find(p => p.re.test('x (uses a file, not recorded)'))!.d;
  const align = HISTORY_PATTERNS.find(p => p.re.test('Align x'))!.d;
  i18n.load('xx', {
    [HISTORY_LABELS.Deselect.id!]: 'Auswahl aufheben', [notRecorded.id!]: '{step} (nicht aufgezeichnet)',
    [align.id!]: '{edges} ausrichten', [HISTORY_LABELS['Top Edges'].id!]: 'Oberkanten',
  });
  i18n.activate('xx');
  try {
    assert.equal(historyLabel('Deselect'), 'Auswahl aufheben');
    assert.equal(historyLabel('Deselect (uses a file, not recorded)'), 'Auswahl aufheben (nicht aufgezeichnet)');
    assert.equal(historyLabel('Align Top Edges'), 'Oberkanten ausrichten');
    assert.equal(historyLabel('Gaussian Blur'), 'Gaussian Blur');
  } finally { i18n.activate('en'); }
});
