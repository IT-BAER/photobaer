// Translation batches for a PO catalog.
//   node scripts/po-batches.mjs split <locale> <size> <dir>  untranslated entries -> <dir>/batch-NN.json
//   node scripts/po-batches.mjs merge <locale> <dir>         <dir>/batch-NN.out.json ({ key: msgstr }) -> catalog
// key = msgctxt + "\u0004" + msgid (Lingui's own convention); merge only fills empty msgstr.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cmd, locale, ...rest] = process.argv.slice(2);
const file = new URL(`../app/src/locales/${locale}/messages.po`, import.meta.url);
const po = readFileSync(file, 'utf8');
const eol = po.includes('\r\n') ? '\r\n' : '\n';
const lines = po.split(/\r?\n/);

// Entries with the line range of their msgstr (first line and continuation lines).
function entries() {
  const out = [];
  let cur = { comments: [], origins: [] };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#. ')) { cur.comments.push(line.slice(3)); continue; }
    if (line.startsWith('#: ')) { cur.origins.push(line.slice(3)); continue; }
    const m = /^(msgctxt|msgid|msgstr) (".*")$/.exec(line);
    if (!m) continue;
    const start = i;
    let value = JSON.parse(m[2]);
    while (lines[i + 1]?.startsWith('"')) value += JSON.parse(lines[++i]);
    if (m[1] !== 'msgstr') { cur[m[1]] = value; continue; }
    if (cur.msgid) out.push({ ...cur, msgstr: value, start, end: i });
    cur = { comments: [], origins: [] };
  }
  return out;
}
const keyOf = e => (e.msgctxt ? `${e.msgctxt}\u0004` : '') + e.msgid;

if (cmd === 'split') {
  const [size, dir] = rest;
  mkdirSync(dir, { recursive: true });
  const todo = entries().filter(e => !e.msgstr).map(e => ({
    key: keyOf(e), ...(e.msgctxt && { context: e.msgctxt }), source: e.msgid,
    ...(e.comments.length && { comment: e.comments.join('\n') }), files: e.origins.join(' '),
  }));
  for (let b = 0; b * size < todo.length; b++) {
    const name = join(dir, `batch-${String(b + 1).padStart(2, '0')}.json`);
    writeFileSync(name, JSON.stringify(todo.slice(b * size, (b + 1) * size), null, 1) + '\n');
  }
  console.log(`${locale}: ${todo.length} untranslated in ${Math.ceil(todo.length / size)} batches`);
} else if (cmd === 'merge') {
  const [dir] = rest;
  const done = {};
  for (const f of readdirSync(dir).filter(f => /^batch-\d+\.out\.json$/.test(f)).sort())
    Object.assign(done, JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const byKey = new Map(entries().map(e => [keyOf(e), e]));
  const unknown = Object.keys(done).filter(k => !byKey.has(k));
  if (unknown.length) throw new Error(`unknown keys: ${unknown.slice(0, 5).join(' | ')}`);
  let filled = 0;
  // Replace from the bottom so earlier line numbers stay valid.
  for (const e of [...byKey.values()].reverse()) {
    const str = done[keyOf(e)];
    if (e.msgstr || typeof str !== 'string' || !str) continue;
    lines.splice(e.start, e.end - e.start + 1, `msgstr ${JSON.stringify(str)}`);
    filled++;
  }
  writeFileSync(file, lines.join(eol));
  console.log(`${locale}: filled ${filled} of ${Object.keys(done).length} translations`);
} else {
  throw new Error('usage: split <locale> <size> <dir> | merge <locale> <dir>');
}
