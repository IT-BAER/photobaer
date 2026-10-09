// Type menu, the type entries of the Layers context menu, and the shared type target (docs/M4.md
// section 10): edits go to the open session, else to every selected type layer as one step.
import type { RefObject } from 'react';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { i18n } from '../i18n/index.ts';
import { client } from '../client.ts';
import type { TextJson } from '../psd/text.ts';
import { ANTI_ALIAS, LOREM, OPENTYPE, featureOn, loremText, setFeature, setParagraphs, type TextStyle } from '../shell/typecommands.ts';
import { spanAt, type SpanAttrs } from '../shell/typesession.ts';
import type { LayerNode } from '../worker/types.ts';
import { tl, type Item, type Run } from './helpers.ts';
import type { TypeApi } from './typeTools.ts';

type Attrs = Record<string, unknown>;
type Span = { length: number } & Record<string, any>;

export const PREVIEW_SIZES: [MessageDescriptor, number][] = [[msg`None`, 0], [msg`Small`, 12], [msg`Medium`, 16], [msg`Large`, 24], [msg`Extra Large`, 32], [msg`Huge`, 48]];
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

// Character and Paragraph Styles lists in local storage (app-wide, D12); malformed entries are dropped.
const STYLE_KEYS = { character: 'photobaer.characterStyles', paragraph: 'photobaer.paragraphStyles' };
const isStyle = (x: any): x is TextStyle => !!x && typeof x.id === 'string' && typeof x.name === 'string' && !!x.character && typeof x.character === 'object' && !Array.isArray(x.character);
export function loadStyles(kind: 'character' | 'paragraph'): TextStyle[] {
  try { const v = JSON.parse(localStorage.getItem(STYLE_KEYS[kind]) ?? '[]'); return Array.isArray(v) ? v.filter(isStyle) : []; } catch { return []; }
}
export function saveStyles(kind: 'character' | 'paragraph', list: TextStyle[]) {
  try { localStorage.setItem(STYLE_KEYS[kind], JSON.stringify(list)); } catch { /* storage blocked: the list lasts for this page */ }
}

export type TypePanel = 'character' | 'paragraph' | 'characterStyles' | 'paragraphStyles' | 'glyphs';
export const TYPE_PANELS: [TypePanel, MessageDescriptor][] = [
  ['character', msg`Character Panel`], ['paragraph', msg`Paragraph Panel`], ['glyphs', msg`Glyphs Panel`],
  ['characterStyles', msg`Character Styles Panel`], ['paragraphStyles', msg`Paragraph Styles Panel`],
];
export interface TypeCtx {
  typeRef: RefObject<TypeApi | null>; selected: LayerNode[]; anyText: boolean; run: Run; setError: (m: string) => void;
  openWarp: () => void; prefs: TypePrefs; setPrefs: (p: TypePrefs) => void;
  panels: Record<TypePanel, boolean>; togglePanel: (p: TypePanel) => void;
  fontDialog: (kind: 'resolve' | 'replace') => void;
  // Loads system faces a family or PostScript name needs; loadSystemFonts is null without Local Font Access.
  ensureFamilies: (names: string[]) => Promise<void>; loadSystemFonts: (() => void) | null;
}

export const typeLayers = (nodes: LayerNode[]) => nodes.filter(n => n.kind === 'text' && n.text);
const session = (c: TypeCtx) => c.typeRef.current?.session() ?? null;
const attrsOf = (a: SpanAttrs, s: Span) => (typeof a === 'function' ? a(s) : a);

// Character and/or paragraph attributes on the session selection, else on all runs/paragraphs of the selected type layers.
export function applyType(c: TypeCtx, run: SpanAttrs | null, para: Attrs | null, label: string) {
  const family = run && typeof run === 'object' && typeof run.family === 'string' ? run.family : null;
  if (family) { void c.ensureFamilies([family]).then(() => applyLoaded(c, run, para, label), e => c.setError((e as Error).message)); return; }
  applyLoaded(c, run, para, label);
}
function applyLoaded(c: TypeCtx, run: SpanAttrs | null, para: Attrs | null, label: string) {
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

export function typeMenuItems(c: TypeCtx): Item[] {
  const sel = typeLayers(c.selected), open = !!session(c), any = open || sel.length > 0;
  const target = typeTarget(c), r0 = target && runOf(target);
  const ids = sel.map(n => n.id), last = sel.at(-1);
  const layerOff = !sel.length;
  const { prefs, setPrefs } = c;
  const setPref = (p: Partial<TypePrefs>) => { const n = { ...prefs, ...p }; saveTypePrefs(n); setPrefs(n); };
  return [
    {
      ...tl(msg`Panels`), keys: '›', run: () => {}, sub: TYPE_PANELS.map(([k, label]) => ({ ...tl(label, c.panels[k]), run: () => c.togglePanel(k) })),
    },
    {
      ...tl(msg`Anti-Alias`), keys: '›', sep: true, run: () => {}, off: !any, sub: ANTI_ALIAS.map(([label, v], i) => ({
        ...tl(label, r0?.anti_alias === v && ANTI_ALIAS.findIndex(([, w]) => w === v) === i),
        run: () => applyWhole(c, t => ({ ...t, runs: t.runs.map((r: Span) => ({ ...r, anti_alias: v })) }), label.message!),
      })),
    },
    {
      ...tl(msg`Orientation`), keys: '›', run: () => {}, off: !any, sub: ([['horizontal', msg`Horizontal`], ['vertical', msg`Vertical`]] as const).map(([o, label]) => ({
        ...tl(label, target?.text.orientation === o),
        run: () => applyWhole(c, t => ({ ...t, orientation: o }), label.message!),
      })),
    },
    {
      ...tl(msg`OpenType`), keys: '›', run: () => {}, off: !any, sub: OPENTYPE.map(([label, tag]) => {
        const on = !!r0 && featureOn(r0, tag);
        return { ...tl(label, on), run: () => applyType(c, r => { const { length: _, ...rest } = setFeature(r, tag, !on); return rest; }, null, label.message!) };
      }),
    },
    { ...tl(msg`Create Work Path`), sep: true, off: !last || !last.text!.text, run: () => last && c.run(null, () => client.call('typeWorkPath', last.id)) },
    { ...tl(msg`Convert to Shape`), off: layerOff, run: () => c.run(i18n._(msg`Converting…`), () => client.call('typeToShape', ids)) },
    { ...tl(msg`Rasterize Type Layer`), sep: true, off: layerOff, run: () => c.run(i18n._(msg`Rasterizing…`), () => client.call('rasterizeLayers', 'type', ids, 'Rasterize Type Layer')) },
    { ...tl(msg`Convert to Paragraph Text`), sep: true, off: !sel.some(n => n.text!.shape?.type !== 'paragraph'), run: () => c.run(null, () => client.call('typeConvert', ids, 'paragraph')) },
    { ...tl(msg`Convert to Point Text`), off: !sel.some(n => n.text!.shape?.type === 'paragraph'), run: () => c.run(null, () => client.call('typeConvert', ids, 'point')) },
    { ...tl(msg`Warp Text…`), off: !any, run: c.openWarp },
    {
      ...tl(msg`Font Preview Size`), keys: '›', sep: true, run: () => {}, sub: PREVIEW_SIZES.map(([label, px]) => ({
        ...tl(label, prefs.previewSize === px), run: () => setPref({ previewSize: px }),
      })),
    },
    {
      ...tl(msg`Language Options`), keys: '›', run: () => {}, sub: [
        ...([['default', msg`Default Features`], ['eastAsian', msg`East Asian Features`], ['middleEastern', msg`Middle Eastern Features`]] as [TypePrefs['language'], MessageDescriptor][])
          .map(([k, label]) => ({ ...tl(label, prefs.language === k), run: () => setPref({ language: k }) })),
        { ...tl(msg`Middle Eastern & South Asian Composer`, prefs.middleEasternComposer), sep: true, run: () => setPref({ middleEasternComposer: !prefs.middleEasternComposer }) },
      ],
    },
    { ...tl(msg`Update All Text Layers`), sep: true, off: !c.anyText, run: () => c.run(i18n._(msg`Updating…`), () => client.call('typeRenderAll')) },
    { ...tl(msg`Replace All Missing Fonts`), off: !c.anyText, run: () => c.fontDialog('replace') },
    { ...tl(msg`Resolve Missing Fonts`), off: !c.anyText, run: () => c.fontDialog('resolve') },
    ...(c.loadSystemFonts ? [{ ...tl(msg`Load System Fonts`), run: c.loadSystemFonts }] : []),
    {
      ...tl(msg`Paste Lorem Ipsum`), sep: true, off: !any, run: () => {
        const t = c.typeRef.current;
        if (t?.editing()) t.insert(LOREM);
        else void c.run(null, () => client.call('typeSetMany', sel.map(n => [n.id, loremText(n.text!)]), 'Paste Lorem Ipsum'));
      },
    },
    {
      ...tl(msg`Load Default Type Styles`), sep: true, off: layerOff, run: () => {
        const d = prefs.defaults;
        if (!d) { c.setError(i18n._(msg`No default type styles have been saved yet.`)); return; }
        void c.run(null, () => client.call('typeSetMany', sel.map(n => [n.id, setParagraphs({ ...n.text!, runs: n.text!.runs.map((r: Span) => ({ ...r, ...d.character, length: r.length })) }, d.paragraph)]), 'Load Default Type Styles'));
      },
    },
    {
      ...tl(msg`Save Default Type Styles`), off: layerOff, run: () => {
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
    { ...tl(msg`Convert to Shape`), run: () => c.run(i18n._(msg`Converting…`), () => client.call('typeToShape', ids.length ? ids : [n.id])) },
    { ...tl(msg`Create Work Path`), off: !n.text.text, run: () => c.run(null, () => client.call('typeWorkPath', n.id)) },
    { ...tl(para ? msg`Convert to Point Text` : msg`Convert to Paragraph Text`), run: () => c.run(null, () => client.call('typeConvert', [n.id], para ? 'point' : 'paragraph')) },
    { ...tl(msg`Warp Text…`), run: c.openWarp },
  ];
}
