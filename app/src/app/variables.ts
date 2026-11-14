// Image > Variables: layer bindings, data sets, CSV/TSV import and export, and what applying a set changes.
// The model is DocVector.variables in engine/src/path.rs.
import type { TextJson } from '../psd/text.ts';

export type VariableKind = 'visibility' | 'text' | 'pixels';
/** Pixel Replacement: how the image fills the layer's bounds, where it sits there (x, y from 0 to 1), and
 * whether what lies outside the bounds is cut off; `box` [x, y, w, h] holds the bounds of the first applied set. */
export type PixelMethod = 'fit' | 'fill' | 'as_is' | 'conform';
export interface PixelOptions { method: PixelMethod; align: [number, number]; clip: boolean; box?: [number, number, number, number] }
export interface Variable { kind: VariableKind; name: string; layer: number; pixels?: PixelOptions }
export const defaultPixels = (): PixelOptions => ({ method: 'fit', align: [0.5, 0.5], clip: false });
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
  if (name !== null) variables.push({ kind, name, layer, ...(kind === 'pixels' ? { pixels: old?.pixels ?? defaultPixels() } : {}) });
  const data_sets = !old ? m.data_sets : m.data_sets.map(d => {
    const value = valueOf(d, old.name), { [old.name]: _, ...rest } = d.values;
    return { ...d, values: name !== null && value !== undefined ? { ...rest, [name]: value } : rest };
  });
  return { ...m, variables, data_sets };
}

/** The Pixel Replacement options of the variable bound to `layer`; the stored box stays unless `o` has one. */
export function setPixelOptions(m: Variables, layer: number, o: PixelOptions): Variables {
  if (!o.align.every(a => Number.isFinite(a) && a >= 0 && a <= 1)) throw new Error('The alignment must lie between 0 and 1.');
  return { ...m, variables: m.variables.map(v => {
    if (v.layer !== layer || v.kind !== 'pixels') return v;
    const box = o.box ?? v.pixels?.box;
    return { ...v, pixels: { ...o, align: [...o.align], ...(box && { box: [...box] }) } };
  }) };
}

/** The key a Pixel Replacement value finds its loaded image by: the file name of a path, lower case. */
export const imageKey = (value: string) => value.trim().split(/[\\/]/).pop()!.toLowerCase();

export interface Box { x: number; y: number; w: number; h: number }
/** Where an image of `img` size lands for a layer whose content bounds are `box`, and the rectangle it is cut to. */
export function pixelPlacement(box: Box, img: { w: number; h: number }, o: PixelOptions): Box & { clip: Box | null } {
  const kx = box.w / img.w, ky = box.h / img.h;
  const [sx, sy] = o.method === 'fit' ? [Math.min(kx, ky), Math.min(kx, ky)] : o.method === 'fill' ? [Math.max(kx, ky), Math.max(kx, ky)]
    : o.method === 'conform' ? [kx, ky] : [1, 1];
  const w = Math.max(1, Math.round(img.w * sx)), h = Math.max(1, Math.round(img.h * sy));
  return { x: Math.round(box.x + (box.w - w) * o.align[0]), y: Math.round(box.y + (box.h - h) * o.align[1]), w, h, clip: o.clip ? box : null };
}

// PSD storage: a private image resource Photoshop ignores, holding the model with each binding as its layer's
// position in the layer list and its name, because layer ids change when a PSD opens.
export const VARIABLES_RESOURCE = 4001;
interface Stored { photobaer: 'variables'; version: 1; variables: (Omit<Variable, 'layer'> & { at: number; layer_name: string })[]; data_sets: DataSet[]; active: string | null }

export function variablesResource(m: Variables, nodes: { id: number; name: string }[]): Uint8Array {
  const variables = m.variables.map(({ layer, ...v }) => {
    const at = nodes.findIndex(n => n.id === layer);
    return { ...v, at, layer_name: nodes[at]?.name ?? '' };
  });
  const s: Stored = { photobaer: 'variables', version: 1, variables, data_sets: m.data_sets, active: m.active };
  return new TextEncoder().encode(JSON.stringify(s));
}

/** The model of a variables resource on the layers `nodes` of the opened file, with the names of bindings
 * whose layer is gone; null when the data is not one. */
export function readVariablesResource(b: Uint8Array, nodes: { id: number; name: string }[]): { model: Variables; lost: string[] } | null {
  let s: Stored;
  try { s = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)); } catch { return null; }
  if (s?.photobaer !== 'variables' || !Array.isArray(s.variables) || !Array.isArray(s.data_sets)) return null;
  const lost: string[] = [], variables: Variable[] = [];
  for (const { at, layer_name, ...v } of s.variables) {
    const n = nodes[at]?.name === layer_name && layer_name ? nodes[at] : nodes.find(n => n.name === layer_name && layer_name);
    if (n) variables.push({ ...v, layer: n.id }); else lost.push(v.name);
  }
  return { model: { variables, data_sets: s.data_sets, active: s.active ?? null }, lost };
}

const visibility = (s: string) => {
  const t = s.trim().toLowerCase();
  return ['true', 'visible', '1', 'yes'].includes(t) ? true : ['false', 'hidden', '0', 'no'].includes(t) ? false : null;
};

// What applying data set `name` changes; a missing value, or a blank visibility, leaves the layer alone.
export function planDataSet(m: Variables, nodes: { id: number; kind: string; name: string }[], name: string) {
  const set = m.data_sets.find(d => d.name === name);
  if (!set) throw new Error(`No data set named "${name}".`);
  const visible: [number, boolean][] = [], text: [number, string][] = [], pixels: [number, string, PixelOptions][] = [], errors: string[] = [];
  for (const v of m.variables) {
    const value = valueOf(set, v.name);
    if (value === undefined) continue;
    const n = nodes.find(n => n.id === v.layer);
    if (!n) { errors.push(`Variable "${v.name}" is bound to a layer that no longer exists.`); continue; }
    if (v.kind === 'pixels') {
      if (!value.trim()) continue;
      if (n.kind === 'pixel') pixels.push([n.id, value, v.pixels ?? defaultPixels()]);
      else errors.push(`Variable "${v.name}" needs a pixel layer, but "${n.name}" is not one.`);
      continue;
    }
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
  return { visible, text, pixels, errors };
}

// The first run and paragraph style carry the whole new text.
export const replaceText = (t: TextJson, s: string): TextJson =>
  ({ ...t, text: s, runs: [{ ...t.runs[0], length: s.length }], paragraphs: [{ ...t.paragraphs[0], length: s.length }] });
