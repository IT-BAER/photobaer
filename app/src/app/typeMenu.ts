// Type menu, the type entries of the Layers context menu, and the shared type target (docs/M4.md
// section 10): edits go to the open session, else to every selected type layer as one step.
import type { RefObject } from 'react';
import { client } from '../client.ts';
import type { TextJson } from '../psd/text.ts';
import { ANTI_ALIAS, LOREM, OPENTYPE, featureOn, loremText, setFeature, setParagraphs } from '../shell/typecommands.ts';
import { spanAt, type SpanAttrs } from '../shell/typesession.ts';
import type { LayerNode } from '../worker/types.ts';
import type { Item, Run } from './helpers.ts';
import type { TypeApi } from './typeTools.ts';

type Attrs = Record<string, unknown>;
type Span = { length: number } & Record<string, any>;

export const PREVIEW_SIZES: [string, number][] = [['None', 0], ['Small', 12], ['Medium', 16], ['Large', 24], ['Extra Large', 32], ['Huge', 48]];
export interface TypePrefs {
  previewSize: number; language: 'default' | 'eastAsian' | 'middleEastern'; middleEasternComposer: boolean;
  defaults: { character: Attrs; paragraph: Attrs } | null;
}
const PREFS_KEY = 'photobaer.typePrefs';
const PREFS: TypePrefs = { previewSize: 16, language: 'default', middleEasternComposer: false, defaults: null };
export function loadTypePrefs(): TypePrefs {
  try { return { ...PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }; } catch { return PREFS; }
}
export function saveTypePrefs(p: TypePrefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage blocked: the prefs last for this page */ }
}

export type TypePanel = 'character' | 'paragraph';
export interface TypeCtx {
  typeRef: RefObject<TypeApi | null>; selected: LayerNode[]; anyText: boolean; run: Run; setError: (m: string) => void;
  openWarp: () => void; prefs: TypePrefs; setPrefs: (p: TypePrefs) => void;
  panels: Record<TypePanel, boolean>; togglePanel: (p: TypePanel) => void;
}

export const typeLayers = (nodes: LayerNode[]) => nodes.filter(n => n.kind === 'text' && n.text);
const session = (c: TypeCtx) => c.typeRef.current?.session() ?? null;
const attrsOf = (a: SpanAttrs, s: Span) => (typeof a === 'function' ? a(s) : a);

// Character and/or paragraph attributes on the session selection, else on all runs/paragraphs of the selected type layers.
export function applyType(c: TypeCtx, run: SpanAttrs | null, para: Attrs | null, label: string) {
  const t = c.typeRef.current;
  if (t?.editing()) { if (run) t.applyRun(run); if (para) t.applyParagraph(para); return; }
  const edits = typeLayers(c.selected).map(n => {
    let x: TextJson = n.text!;
    if (run) x = { ...x, runs: x.runs.map((r: Span) => ({ ...r, ...attrsOf(run, r), length: r.length })) };
    if (para) x = setParagraphs(x, para);
    return [n.id, x] as [number, TextJson];
  });
  if (edits.length) void c.run(null, () => client.call('typeSetMany', edits, label));
}

// A whole-model change (orientation, warp, anti-alias) on the session or on each selected type layer.
export function applyWhole(c: TypeCtx, f: (t: TextJson) => TextJson, label: string) {
  const t = c.typeRef.current;
  if (t?.editing()) { t.replace(f); return; }
  const edits = typeLayers(c.selected).map(n => [n.id, f(n.text!)] as [number, TextJson]);
  if (edits.length) void c.run(null, () => client.call('typeSetMany', edits, label));
}

// The model the panels and check marks read: the session's (at its selection start), else the last selected type layer's.
export function typeTarget(c: Pick<TypeCtx, 'typeRef' | 'selected'>): { text: TextJson; at: number } | null {
  const s = c.typeRef.current?.session();
  if (s) return { text: s.text, at: s.range[0] };
  const n = typeLayers(c.selected).at(-1);
  return n ? { text: n.text!, at: 0 } : null;
}
export function runOf(t: { text: TextJson; at: number }): Span {
  return t.text.runs[spanAt(t.text.runs, Math.max(0, t.at - (t.at > 0 && t.at === t.text.text.length ? 1 : 0)))];
}
export const paragraphOf = (t: { text: TextJson; at: number }): Span => t.text.paragraphs[spanAt(t.text.paragraphs, t.at)];

const check = (on: boolean, label: string) => (on ? `✓ ${label}` : label);

export function typeMenuItems(c: TypeCtx): Item[] {
  const sel = typeLayers(c.selected), open = !!session(c), any = open || sel.length > 0;
  const target = typeTarget(c), r0 = target && runOf(target);
  const ids = sel.map(n => n.id), last = sel.at(-1);
  const layerOff = !sel.length;
  const { prefs, setPrefs } = c;
  const setPref = (p: Partial<TypePrefs>) => { const n = { ...prefs, ...p }; saveTypePrefs(n); setPrefs(n); };
  return [
    {
      label: 'Panels', keys: '›', run: () => {}, sub: ([['character', 'Character'], ['paragraph', 'Paragraph']] as [TypePanel, string][])
        .map(([k, label]) => ({ label: check(c.panels[k], label), run: () => c.togglePanel(k) })),
    },
    {
      label: 'Anti-Alias', keys: '›', sep: true, run: () => {}, off: !any, sub: ANTI_ALIAS.map(([label, v], i) => ({
        label: check(r0?.anti_alias === v && ANTI_ALIAS.findIndex(([, w]) => w === v) === i, label),
        run: () => applyWhole(c, t => ({ ...t, runs: t.runs.map((r: Span) => ({ ...r, anti_alias: v })) }), label),
      })),
    },
    {
      label: 'Orientation', keys: '›', run: () => {}, off: !any, sub: (['Horizontal', 'Vertical'] as const).map(label => ({
        label: check(target?.text.orientation === label.toLowerCase(), label),
        run: () => applyWhole(c, t => ({ ...t, orientation: label.toLowerCase() }), label),
      })),
    },
    {
      label: 'OpenType', keys: '›', run: () => {}, off: !any, sub: OPENTYPE.map(([label, tag]) => {
        const on = !!r0 && featureOn(r0, tag);
        return { label: check(on, label), run: () => applyType(c, r => { const { length: _, ...rest } = setFeature(r, tag, !on); return rest; }, null, label) };
      }),
    },
    { label: 'Create Work Path', sep: true, off: !last || !last.text!.text, run: () => last && c.run(null, () => client.call('typeWorkPath', last.id)) },
    { label: 'Convert to Shape', off: layerOff, run: () => c.run('Converting…', () => client.call('typeToShape', ids)) },
    { label: 'Rasterize Type Layer', sep: true, off: layerOff, run: () => c.run('Rasterizing…', () => client.call('rasterizeLayers', 'type', ids)) },
    { label: 'Convert to Paragraph Text', sep: true, off: !sel.some(n => n.text!.shape?.type !== 'paragraph'), run: () => c.run(null, () => client.call('typeConvert', ids, 'paragraph')) },
    { label: 'Convert to Point Text', off: !sel.some(n => n.text!.shape?.type === 'paragraph'), run: () => c.run(null, () => client.call('typeConvert', ids, 'point')) },
    { label: 'Warp Text…', off: !any, run: c.openWarp },
    {
      label: 'Font Preview Size', keys: '›', sep: true, run: () => {}, sub: PREVIEW_SIZES.map(([label, px]) => ({
        label: check(prefs.previewSize === px, label), run: () => setPref({ previewSize: px }),
      })),
    },
    {
      label: 'Language Options', keys: '›', run: () => {}, sub: [
        ...([['default', 'Default Features'], ['eastAsian', 'East Asian Features'], ['middleEastern', 'Middle Eastern Features']] as [TypePrefs['language'], string][])
          .map(([k, label]) => ({ label: check(prefs.language === k, label), run: () => setPref({ language: k }) })),
        { label: check(prefs.middleEasternComposer, 'Middle Eastern & South Asian Composer'), sep: true, run: () => setPref({ middleEasternComposer: !prefs.middleEasternComposer }) },
      ],
    },
    { label: 'Update All Text Layers', sep: true, off: !c.anyText, run: () => c.run('Updating…', () => client.call('typeRenderAll')) },
    {
      label: 'Paste Lorem Ipsum', sep: true, off: !any, run: () => {
        const t = c.typeRef.current;
        if (t?.editing()) t.insert(LOREM);
        else void c.run(null, () => client.call('typeSetMany', sel.map(n => [n.id, loremText(n.text!)]), 'Paste Lorem Ipsum'));
      },
    },
    {
      label: 'Load Default Type Styles', sep: true, off: layerOff, run: () => {
        const d = prefs.defaults;
        if (!d) { c.setError('No default type styles have been saved yet.'); return; }
        void c.run(null, () => client.call('typeSetMany', sel.map(n => [n.id, setParagraphs({ ...n.text!, runs: n.text!.runs.map((r: Span) => ({ ...r, ...d.character, length: r.length })) }, d.paragraph)]), 'Load Default Type Styles'));
      },
    },
    {
      label: 'Save Default Type Styles', off: layerOff, run: () => {
        const t = sel[0].text!, { length: _r, ...character } = t.runs[0], { length: _p, ...paragraph } = t.paragraphs[0];
        setPref({ defaults: { character, paragraph } });
      },
    },
  ];
}

// Layers panel context menu entries for a type layer.
export function typeContextItems(n: LayerNode, c: TypeCtx): Item[] {
  if (n.kind !== 'text' || !n.text) return [];
  const ids = typeLayers(c.selected).map(x => x.id);
  const para = n.text.shape?.type === 'paragraph';
  return [
    { label: 'Convert to Shape', run: () => c.run('Converting…', () => client.call('typeToShape', ids.length ? ids : [n.id])) },
    { label: 'Create Work Path', off: !n.text.text, run: () => c.run(null, () => client.call('typeWorkPath', n.id)) },
    { label: para ? 'Convert to Point Text' : 'Convert to Paragraph Text', run: () => c.run(null, () => client.call('typeConvert', [n.id], para ? 'point' : 'paragraph')) },
    { label: 'Warp Text…', run: c.openWarp },
  ];
}
