export type Entry = { context: string; id: string; str: string };

// msgctxt/msgid/msgstr triples of a PO file, joining continuation lines; the header entry is skipped.
export function poEntries(po: string): Entry[] {
  const out: Entry[] = [];
  const lines = po.split(/\r?\n/);
  let cur: Partial<Entry> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^(msgctxt|msgid|msgstr) (".*")$/.exec(lines[i]);
    if (!m) continue;
    let value = JSON.parse(m[2]) as string;
    while (lines[i + 1]?.startsWith('"')) value += JSON.parse(lines[++i]) as string;
    if (m[1] === 'msgctxt') cur = { context: value };
    else if (m[1] === 'msgid') cur = { context: cur.context ?? '', id: value };
    else {
      if (cur.id) out.push({ context: cur.context ?? '', id: cur.id, str: value });
      cur = {};
    }
  }
  return out;
}

type Shape = { args: string[]; branches: Map<string, string[]>; tags: string[] };

// Placeholders, plural/select keys and <n> tags of an ICU message (Lingui's subset, no apostrophe quoting).
export function shape(text: string): Shape {
  const args = new Set<string>();
  const branches = new Map<string, string[]>();
  const tags = (text.match(/<\/?\d+\/?>/g) ?? []).sort();
  const walk = (s: string, i: number, depth: number): number => {
    while (i < s.length) {
      if (s[i] === '}') { if (depth > 0) return i; throw new Error(`unbalanced } in ${text}`); }
      if (s[i] !== '{') { i++; continue; }
      const head = /^\{\s*([\w.]+)\s*(?:,\s*(\w+)\s*)?(,|\})/.exec(s.slice(i));
      if (!head) throw new Error(`bad placeholder in ${text}`);
      const [all, name, type, end] = head;
      i += all.length;
      if (end === '}') { args.add(type ? `${name}:${type}` : name); continue; }
      if (type !== 'plural' && type !== 'select' && type !== 'selectordinal') {
        const close = s.indexOf('}', i);
        args.add(`${name}:${type}:${s.slice(i, close).trim()}`);
        i = close + 1;
        continue;
      }
      const keys: string[] = [];
      for (;;) {
        const key = /^\s*(offset:\d+\s*)?(=?[\w-]+)\s*\{/.exec(s.slice(i));
        if (!key) break;
        keys.push(key[2]);
        i = walk(s, i + key[0].length, depth + 1) + 1;
      }
      const close = /^\s*\}/.exec(s.slice(i));
      if (!close) throw new Error(`unterminated ${type} in ${text}`);
      i += close[0].length;
      branches.set(`${name}:${type}`, keys.sort());
    }
    if (depth > 0) throw new Error(`unterminated branch in ${text}`);
    return i;
  };
  walk(text, 0, 0);
  return { args: [...args].sort(), branches, tags };
}

// Plural categories integer counts reach (fr "many" only covers 1e6 and up), plus the ICU-required "other".
function needed(rules: Intl.PluralRules): Set<string> {
  const out = new Set<string>(['other']);
  for (let n = 0; n <= 1000; n++) out.add(rules.select(n));
  return out;
}

// Problems of one translation against its English source; plural keys follow the locale's CLDR categories.
export function check(locale: string, id: string, str: string): string[] {
  let src: Shape, dst: Shape;
  try { src = shape(id); dst = shape(str); } catch (e) { return [(e as Error).message]; }
  const problems: string[] = [];
  if (src.args.join() !== dst.args.join()) problems.push(`placeholders ${src.args} != ${dst.args}`);
  if (src.tags.join() !== dst.tags.join()) problems.push(`tags ${src.tags} != ${dst.tags}`);
  const cardinal = new Intl.PluralRules(locale), ordinal = new Intl.PluralRules(locale, { type: 'ordinal' });
  for (const [arg, keys] of src.branches) {
    const got = dst.branches.get(arg);
    if (!got) { problems.push(`missing ${arg}`); continue; }
    if (arg.endsWith(':select')) {
      if (keys.join() !== got.join()) problems.push(`${arg} keys ${keys} != ${got}`);
      continue;
    }
    const rules = arg.endsWith(':selectordinal') ? ordinal : cardinal;
    const allowed = new Set<string>(rules.resolvedOptions().pluralCategories);
    const exact = keys.filter(k => k.startsWith('='));
    const wrong = got.filter(k => !k.startsWith('=') && !allowed.has(k));
    const missing = [...needed(rules)].filter(k => !got.includes(k)).sort();
    if (wrong.length) problems.push(`${arg} keys not in ${locale}: ${wrong}`);
    if (missing.length) problems.push(`${arg} lacks ${locale} keys: ${missing}`);
    if (exact.some(k => !got.includes(k))) problems.push(`${arg} lost exact keys ${exact}`);
  }
  for (const arg of dst.branches.keys()) if (!src.branches.has(arg)) problems.push(`extra ${arg}`);
  return problems;
}
