// Image > Variables: layer bindings, data sets, CSV/TSV import and export, and what applying a set changes.
// The model is DocVector.variables in engine/src/path.rs.
import type { TextJson } from '../psd/text.ts';

export type VariableKind = 'visibility' | 'text';
export interface Variable { kind: VariableKind; name: string; layer: number }
export interface DataSet { name: string; values: Record<string, string> }
export interface Variables { variables: Variable[]; data_sets: DataSet[]; active: string | null }

export const emptyVariables = (): Variables => ({ variables: [], data_sets: [], active: null });
// A set's own value; variable names like "constructor" must not reach Object.prototype.
export const valueOf = (d: DataSet, name: string): string | undefined => Object.hasOwn(d.values, name) ? d.values[name] : undefined;
export const validName = (n: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && n.length <= 255;

export function parseCsv(text: string, delim: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const endRow = () => { row.push(cell); rows.push(row); row = []; cell = ''; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\r' || c === '\n') { if (c === '\r' && s[i + 1] === '\n') i++; endRow(); }
    else cell += c;
  }
  if (cell !== '' || row.length) endRow();
  while (rows.length && rows[rows.length - 1].every(c => c === '')) rows.pop();
  return rows;
}

const delimiterOf = (text: string) => {
  const head = text.split(/\r?\n/, 1)[0];
  return head.includes('\t') ? '\t' : head.includes(';') && !head.includes(',') ? ';' : ',';
};

// The header row names the variables; `firstColumnIsName` takes data set names from column 1.
export function importDataSets(m: Variables, text: string, o: { firstColumnIsName: boolean; replace: boolean }) {
  const rows = parseCsv(text, delimiterOf(text));
  if (rows.length < 2) throw new Error('The file is empty or has only a header row.');
  const head = rows[0].map(h => h.trim());
  const cols = head.map((name, i) => ({ name, i })).filter(c => c.name !== '' && !(o.firstColumnIsName && c.i === 0));
  const bound = new Set(m.variables.map(v => v.name));
  const warnings: string[] = [];
  const kept = o.replace ? [] : m.data_sets;
  const taken = new Set(kept.map(d => d.name));
  const unique = (base: string) => {
    let n = base, k = 2;
    while (taken.has(n)) n = `${base} ${k++}`;
    taken.add(n);
    return n;
  };
  const added = rows.slice(1).map((r, i) => {
    if (r.length !== head.length) warnings.push(`Row ${i + 2} has ${r.length} fields but the header has ${head.length}; missing fields are blank.`);
    const values = Object.fromEntries(cols.map(c => [c.name, r[c.i] ?? '']));
    const name = (o.firstColumnIsName && r[0]?.trim()) || `Data Set ${kept.length + i + 1}`;
    return { name: unique(name), values };
  });
  const data_sets = [...kept, ...added];
  return {
    model: { ...m, data_sets, active: m.active && data_sets.some(d => d.name === m.active) ? m.active : data_sets[0].name },
    added: added.length,
    unknown: cols.filter(c => !bound.has(c.name)).map(c => c.name),
    missing: [...bound].filter(n => !cols.some(c => c.name === n)),
    warnings,
  };
}

const quote = (v: string) => /[",;\t\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

export function exportCsv(m: Variables): string {
  const names = m.variables.map(v => v.name);
  return [['Data Set', ...names], ...m.data_sets.map(d => [d.name, ...names.map(n => valueOf(d, n) ?? '')])]
    .map(r => r.map(quote).join(',') + '\n').join('');
}

// Binds (`name`) or unbinds (null) one property of a layer; data set values follow a rename and go with an unbind.
export function setBinding(m: Variables, layer: number, kind: VariableKind, name: string | null): Variables {
  const old = m.variables.find(v => v.layer === layer && v.kind === kind);
  if (name !== null) {
    if (!validName(name)) throw new Error(`"${name}" is not a valid variable name; use letters, digits and underscore, not starting with a digit.`);
    if (m.variables.some(v => v.name === name && v !== old)) throw new Error(`The name "${name}" is already bound to another layer or property.`);
  }
  if (old?.name === name) return m;
  const variables = m.variables.filter(v => v !== old);
  if (name !== null) variables.push({ kind, name, layer });
  const data_sets = !old ? m.data_sets : m.data_sets.map(d => {
    const value = valueOf(d, old.name), { [old.name]: _, ...rest } = d.values;
    return { ...d, values: name !== null && value !== undefined ? { ...rest, [name]: value } : rest };
  });
  return { ...m, variables, data_sets };
}

const visibility = (s: string) => {
  const t = s.trim().toLowerCase();
  return ['true', 'visible', '1', 'yes'].includes(t) ? true : ['false', 'hidden', '0', 'no'].includes(t) ? false : null;
};

// What applying data set `name` changes; a missing value, or a blank visibility, leaves the layer alone.
export function planDataSet(m: Variables, nodes: { id: number; kind: string; name: string }[], name: string) {
  const set = m.data_sets.find(d => d.name === name);
  if (!set) throw new Error(`No data set named "${name}".`);
  const visible: [number, boolean][] = [], text: [number, string][] = [], errors: string[] = [];
  for (const v of m.variables) {
    const value = valueOf(set, v.name);
    if (value === undefined) continue;
    const n = nodes.find(n => n.id === v.layer);
    if (!n) { errors.push(`Variable "${v.name}" is bound to a layer that no longer exists.`); continue; }
    if (v.kind === 'text') {
      if (n.kind === 'text') text.push([n.id, value]);
      else errors.push(`Variable "${v.name}" needs a type layer, but "${n.name}" is not one.`);
      continue;
    }
    if (value.trim() === '') continue;
    const on = visibility(value);
    if (on === null) errors.push(`Variable "${v.name}" expected true/false or visible/hidden but got "${value}".`);
    else visible.push([n.id, on]);
  }
  return { visible, text, errors };
}

// The first run and paragraph style carry the whole new text.
export const replaceText = (t: TextJson, s: string): TextJson =>
  ({ ...t, text: s, runs: [{ ...t.runs[0], length: s.length }], paragraphs: [{ ...t.paragraphs[0], length: s.length }] });
