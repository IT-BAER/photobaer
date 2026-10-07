// Character and Paragraph panels, the Properties type section and the Warp Text dialog (docs/M4.md
// section 10). Edits go to the session selection, else to the selected type layers (app/typeMenu.ts).
import { useState, type RefObject } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { ColorInput, Num } from './PropertiesPanel.tsx';
import { applyType, applyWhole, loadStyles, paragraphOf, runOf, saveStyles, typeLayers, typeTarget, type TypeCtx } from './app/typeMenu.ts';
import { newStyle } from './shell/typecommands.ts';
import type { ToolOptions } from './shell/OptionsBar.tsx';
import { hexToRgb, rgbToHex, type Rgb } from './shell/color.ts';
import type { FaceInfo } from './worker/types.ts';
import { i18n } from './i18n/index.ts';

type Span = Record<string, any>;
type Attrs = Record<string, unknown>;

type Option = [string, string | MessageDescriptor];
const ALIGN: Option[] = [
  ['left', msg({ message: 'Left', context: 'text alignment' })], ['center', msg({ message: 'Center', context: 'text alignment' })],
  ['right', msg({ message: 'Right', context: 'text alignment' })], ['justify_left', msg`Justify Last Left`], ['justify_center', msg`Justify Last Center`],
  ['justify_right', msg`Justify Last Right`], ['justify_all', msg`Justify All`],
];
const AA: Option[] = [['none', msg`None`], ['sharp', msg`Sharp`], ['crisp', msg`Crisp`], ['strong', msg`Strong`], ['smooth', msg`Smooth`]];
const WARP: Option[] = [
  ['arc', msg`Arc`], ['arc_lower', msg`Arc Lower`], ['arc_upper', msg`Arc Upper`], ['arch', msg`Arch`], ['bulge', msg`Bulge`],
  ['shell_lower', msg`Shell Lower`], ['shell_upper', msg`Shell Upper`], ['flag', msg`Flag`], ['wave', msg`Wave`], ['fish', msg`Fish`],
  ['rise', msg`Rise`], ['fisheye', msg`Fisheye`], ['inflate', msg`Inflate`], ['squeeze', msg`Squeeze`], ['twist', msg`Twist`],
];

function Sel({ label, value, options, onChange, disabled }: { label: string; value: string; options: Option[]; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label>{label} <select aria-label={label} value={value} disabled={disabled} onChange={e => onChange(e.currentTarget.value)}>
      {!options.some(([v]) => v === value) && <option value={value}>{value || '—'}</option>}
      {options.map(([v, l]) => <option key={v} value={v}>{typeof l === 'string' ? l : i18n._(l)}</option>)}
    </select></label>
  );
}
const Check = ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) => (
  <label className="adjustment-check"><input type="checkbox" checked={checked} onChange={e => onChange(e.currentTarget.checked)} /> {label}</label>
);

// Family and style pickers; a family change keeps the style when the new family has it.
function FontRows({ run, faces, set }: { run: Span; faces: FaceInfo[]; set: (label: string, a: Attrs) => void }) {
  const families = [...new Set(faces.map(f => f.family))].sort();
  const styles = faces.filter(f => f.family === run.family).map(f => f.style);
  return (
    <>
      <Sel label={t`Font Family`} value={run.family} options={families.map(f => [f, f])} onChange={family => {
        const has = faces.filter(f => f.family === family).map(f => f.style);
        set('Font Family', { family, style: has.includes(run.style) ? run.style : has[0] ?? run.style, postscript_name: '' });
      }} />
      <Sel label={t`Font Style`} value={run.style} options={styles.map(s => [s, s])} onChange={style => set('Font Style', { style, postscript_name: '' })} />
    </>
  );
}

// Window > Character: the session caret/selection run, else the last selected type layer's first run,
// else the type tool options (family, style, size, color only).
export function CharacterPanel({ c, faces, eastAsian, toolOptions, setToolOption }: {
  c: TypeCtx; faces: FaceInfo[]; eastAsian: boolean; toolOptions: ToolOptions; setToolOption: (k: string, v: unknown) => void;
}) {
  const target = typeTarget(c);
  if (!target) {
    const o = { family: toolOptions.family, style: toolOptions.style, size: Number(toolOptions.size) };
    return (
      <div className="properties-panel type-panel">
        <div className="panel-tabs"><span className="panel-tab"><Trans>Character</Trans></span></div>
        <FontRows run={o} faces={faces} set={(_, a) => { for (const [k, v] of Object.entries(a)) if (k in o) setToolOption(k, v); }} />
        <Num label={t`Size`} value={o.size} min={0.01} max={1296} step={0.1} onCommit={v => setToolOption('size', v)} />
        <label><Trans>Color</Trans> <ColorInput key={String(toolOptions.color)} label={t`Text color`} value={hexToRgb(String(toolOptions.color)) ?? [0, 0, 0]} onCommit={v => setToolOption('color', rgbToHex(v))} /></label>
        <p className="panel-empty"><Trans>Select a type layer or start typing to edit its characters.</Trans></p>
      </div>
    );
  }
  const r = runOf(target), set = (_: string, a: Attrs) => applyType(c, a, null, 'Character Formatting');
  return (
    <div className="properties-panel type-panel">
      <div className="panel-tabs"><span className="panel-tab"><Trans>Character</Trans></span></div>
      <FontRows run={r} faces={faces} set={set} />
      <Num label={t`Size`} value={r.size} min={0.01} max={1296} step={0.1} onCommit={size => set('', { size })} />
      <Num label={t`Leading (0 = auto)`} value={r.leading ?? 0} min={0} max={5000} step={0.1} onCommit={v => set('', { leading: v || null })} />
      <Num label={t`Tracking`} value={r.tracking} min={-1000} max={10000} onCommit={tracking => set('', { tracking })} />
      <Num label={t`Horizontal Scale %`} value={Math.round(r.horizontal_scale * 100)} min={1} max={1000} onCommit={v => set('', { horizontal_scale: v / 100 })} />
      <Num label={t`Vertical Scale %`} value={Math.round(r.vertical_scale * 100)} min={1} max={1000} onCommit={v => set('', { vertical_scale: v / 100 })} />
      <Num label={t`Baseline Shift`} value={r.baseline_shift} min={-5000} max={5000} step={0.1} onCommit={baseline_shift => set('', { baseline_shift })} />
      {eastAsian && <Num label={t`Tsume %`} value={Math.round(r.tsume * 100)} min={0} max={100} onCommit={v => set('', { tsume: v / 100 })} />}
      <label><Trans>Color</Trans> <ColorInput key={String(r.color)} label={t`Text color`} value={r.color as Rgb} onCommit={color => set('', { color })} /></label>
      <Sel label={t`Anti-Alias`} value={r.anti_alias} options={AA} onChange={anti_alias => applyWhole(c, x => ({ ...x, runs: x.runs.map((q: Span) => ({ ...q, anti_alias })) }), 'Character Formatting')} />
      <div className="professional-toggle-grid">
        <Check label={t`Faux Bold`} checked={r.faux_bold} onChange={faux_bold => set('', { faux_bold })} />
        <Check label={t`Faux Italic`} checked={r.faux_italic} onChange={faux_italic => set('', { faux_italic })} />
        <Check label={t`Underline`} checked={r.underline} onChange={underline => set('', { underline })} />
        <Check label={t`Strikethrough`} checked={r.strikethrough} onChange={strikethrough => set('', { strikethrough })} />
        <Check label={t`All Caps`} checked={r.caps === 'all'} onChange={on => set('', { caps: on ? 'all' : 'normal' })} />
        <Check label={t`Small Caps`} checked={r.caps === 'small'} onChange={on => set('', { caps: on ? 'small' : 'normal' })} />
        <Check label={t`Superscript`} checked={r.baseline === 'super'} onChange={on => set('', { baseline: on ? 'super' : 'normal' })} />
        <Check label={t`Subscript`} checked={r.baseline === 'sub'} onChange={on => set('', { baseline: on ? 'sub' : 'normal' })} />
      </div>
    </div>
  );
}

const JUST: [string, MessageDescriptor[]][] = [
  ['word', [msg`Word Spacing Minimum %`, msg`Word Spacing Desired %`, msg`Word Spacing Maximum %`]],
  ['letter', [msg`Letter Spacing Minimum %`, msg`Letter Spacing Desired %`, msg`Letter Spacing Maximum %`]],
  ['glyph', [msg`Glyph Scaling Minimum %`, msg`Glyph Scaling Desired %`, msg`Glyph Scaling Maximum %`]],
];

// Window > Paragraph: the paragraph at the session caret, else the first of the last selected type layer.
export function ParagraphPanel({ c }: { c: TypeCtx }) {
  const target = typeTarget(c);
  if (!target) {
    return (
      <div className="properties-panel type-panel">
        <div className="panel-tabs"><span className="panel-tab"><Trans>Paragraph</Trans></span></div>
        <p className="panel-empty"><Trans>Select a type layer or start typing to edit its paragraphs.</Trans></p>
      </div>
    );
  }
  const p = paragraphOf(target), set = (a: Attrs) => applyType(c, null, a, 'Paragraph Formatting');
  const pt = (label: string, key: string) => <Num key={key} label={label} value={p[key]} min={-10000} max={10000} step={0.1} onCommit={v => set({ [key]: v })} />;
  return (
    <div className="properties-panel type-panel">
      <div className="panel-tabs"><span className="panel-tab"><Trans>Paragraph</Trans></span></div>
      <Sel label={t`Alignment`} value={p.alignment} options={ALIGN} onChange={alignment => set({ alignment })} />
      {pt(t`Indent Left`, 'indent_left')}{pt(t`Indent Right`, 'indent_right')}{pt(t`Indent First Line`, 'indent_first')}
      {pt(t`Space Before`, 'space_before')}{pt(t`Space After`, 'space_after')}
      <Sel label={t`Composer`} value={p.composer} options={[['every_line', t`Every-line Composer`], ['single_line', t`Single-line Composer`]]} onChange={composer => set({ composer })} />
      <div className="professional-toggle-grid">
        <Check label={t`Hyphenate`} checked={p.hyphenate} onChange={hyphenate => set({ hyphenate })} />
        <Check label={t`Right-to-Left`} checked={p.rtl} onChange={rtl => set({ rtl })} />
        <Check label={t`Roman Hanging Punctuation`} checked={p.hanging_punctuation} onChange={hanging_punctuation => set({ hanging_punctuation })} />
      </div>
      <details>
        <summary><Trans>Justification</Trans></summary>
        {JUST.map(([k, labels]) => labels.map((d, i) => (
          <Num key={d.message} label={i18n._(d)} value={Math.round(p.justification[k][i] * 100)} min={0} max={1000}
            onCommit={v => set({ justification: { ...p.justification, [k]: p.justification[k].map((x: number, j: number) => (j === i ? v / 100 : x)) } })} />
        )))}
      </details>
      <details>
        <summary><Trans>Hyphenation</Trans></summary>
        {([['min_word', t`Words Longer Than`, 2, 25], ['after_first', t`After First`, 1, 15], ['before_last', t`Before Last`, 1, 15], ['limit', t`Hyphen Limit`, 0, 25], ['zone', t`Hyphenation Zone`, 0, 8640]] as [string, string, number, number][])
          .map(([k, label, min, max]) => <Num key={k} label={label} value={p.hyphenation[k]} min={min} max={max} onCommit={v => set({ hyphenation: { ...p.hyphenation, [k]: v } })} />)}
        <Check label={t`Hyphenate Capitalized Words`} checked={p.hyphenation.capitalized} onChange={capitalized => set({ hyphenation: { ...p.hyphenation, capitalized } })} />
      </details>
    </div>
  );
}

const SHAPE_LABEL: Record<string, MessageDescriptor> = { point: msg`Point Text`, paragraph: msg`Paragraph Text`, onPath: msg`Text on Path`, inShape: msg`Text in Shape` };
const INDENTS: [string, string, MessageDescriptor][] = [
  ['indent_left', 'Indent Left', msg`Indent Left (pt)`], ['indent_right', 'Indent Right', msg`Indent Right (pt)`],
  ['space_before', 'Space Before', msg`Space Before (pt)`], ['space_after', 'Space After', msg`Space After (pt)`],
];

// Properties for a type layer: every edit sets all runs or paragraphs of the last selected type layer,
// one step labelled by its field.
export function TypeProperties({ c, faces }: { c: TypeCtx; faces: FaceInfo[] }) {
  const n = typeLayers(c.selected).at(-1);
  if (!n) return null;
  const one = { ...c, selected: [n] }, tx = n.text!, r = tx.runs[0] as Span, p = tx.paragraphs[0] as Span;
  const run = (label: string, a: Attrs) => applyType(one, a, null, label);
  const para = (label: string, a: Attrs) => applyType(one, null, a, label);
  return (
    <div className="properties-panel type-panel">
      <div className="panel-tabs"><span className="panel-tab"><Trans>Properties</Trans></span></div>
      <div className="adjustment-header"><h3>{SHAPE_LABEL[tx.shape?.type] ? i18n._(SHAPE_LABEL[tx.shape?.type]) : t`Type`}</h3><span className="swatch" style={{ background: rgbToHex(r.color) }} /></div>
      <h4><Trans>Character</Trans></h4>
      <FontRows run={r} faces={faces} set={run} />
      <Num label={t`Font Size`} value={r.size} min={0.1} max={1296} step={0.1} onCommit={size => run('Font Size', { size })} />
      <Num label={t`Leading (0 = auto)`} value={r.leading ?? 0} min={0} max={5000} step={0.1} onCommit={v => run('Leading', { leading: v || null })} />
      <Num label={t`Tracking`} value={r.tracking} min={-1000} max={10000} onCommit={tracking => run('Tracking', { tracking })} />
      <label><Trans>Color</Trans> <ColorInput key={String(r.color)} label={t`Text Color`} value={r.color} onCommit={color => run('Text Color', { color })} /></label>
      <div className="professional-toggle-grid">
        <Check label={t`Bold`} checked={r.faux_bold} onChange={faux_bold => run('Faux Bold', { faux_bold })} />
        <Check label={t`Italic`} checked={r.faux_italic} onChange={faux_italic => run('Faux Italic', { faux_italic })} />
        <Check label={t`Underline`} checked={r.underline} onChange={underline => run('Underline', { underline })} />
        <Check label={t`Strikethrough`} checked={r.strikethrough} onChange={strikethrough => run('Strikethrough', { strikethrough })} />
      </div>
      <h4><Trans>Paragraph</Trans></h4>
      <Sel label={t`Align`} value={p.alignment} options={ALIGN} onChange={alignment => para('Alignment', { alignment })} />
      <Sel label={t`Direction`} value={p.rtl ? 'rtl' : 'ltr'} options={[['ltr', t`Left to Right`], ['rtl', t`Right to Left`]]} onChange={v => para('Direction', { rtl: v === 'rtl' })} />
      {INDENTS.map(([k, label, text]) => <Num key={k} label={i18n._(text)} value={p[k]} min={-10000} max={10000} step={0.1} onCommit={v => para(label, { [k]: v })} />)}
      <h4><Trans>Type Options</Trans></h4>
      <Sel label={t`Orientation`} value={tx.orientation} options={[['horizontal', t`Horizontal`], ['vertical', t`Vertical`]]}
        onChange={orientation => applyWhole(one, x => ({ ...x, orientation }), 'Orientation')} />
      <Num label={t`Baseline Shift`} value={r.baseline_shift} min={-500} max={500} step={0.1} onCommit={baseline_shift => run('Baseline Shift', { baseline_shift })} />
      <div className="professional-toggle-grid">
        <Check label={t`Uppercase`} checked={r.caps === 'all'} onChange={on => run('Uppercase', { caps: on ? 'all' : 'normal' })} />
        <Check label={t`Small Caps`} checked={r.caps === 'small'} onChange={on => run('Small Caps', { caps: on ? 'small' : 'normal' })} />
        <Check label={t`Superscript`} checked={r.baseline === 'super'} onChange={on => run('Superscript', { baseline: on ? 'super' : 'normal' })} />
        <Check label={t`Subscript`} checked={r.baseline === 'sub'} onChange={on => run('Subscript', { baseline: on ? 'sub' : 'normal' })} />
      </div>
    </div>
  );
}

const ICON = { size: 16, strokeWidth: 1.75 };

// Window > Character Styles / Paragraph Styles: save takes the target's run (and paragraph); a click
// applies the values to the session selection or the selected type layers as one step "Apply <name>".
export function TextStylesPanel({ kind, c }: { kind: 'character' | 'paragraph'; c: TypeCtx }) {
  const [list, setList] = useState(() => loadStyles(kind));
  const [name, setName] = useState('');
  const target = typeTarget(c), isChar = kind === 'character';
  const store = (next: typeof list) => { saveStyles(kind, next); setList(next); };
  return (
    <div className="properties-panel type-panel">
      <div className="panel-tabs"><span className="panel-tab">{isChar ? <Trans>Character Styles</Trans> : <Trans>Paragraph Styles</Trans>}</span></div>
      {!target && <p className="panel-empty"><Trans>Select a text layer to save or apply a style.</Trans></p>}
      <ul className="style-library-list" aria-label={isChar ? t`Character styles` : t`Paragraph styles`}>
        {list.map(s => {
          const styleName = s.name;
          return (
          <li key={s.id}>
            <button type="button" className="style-library-name" disabled={!target} onClick={() => applyType(c, s.character, s.paragraph ?? null, `Apply ${s.name}`)}>{s.name}</button>
            <button type="button" aria-label={t`Delete ${styleName}`} title={t`Delete style`} onClick={() => store(list.filter(x => x.id !== s.id))}><Trash2 {...ICON} /></button>
          </li>
          );
        })}
        {!list.length && <li className="adjustment-note"><Trans>Save your text formatting as a named style to reuse it.</Trans></li>}
      </ul>
      <div className="panel-footer">
        <input placeholder={t`Style name`} aria-label={isChar ? t`Character style name` : t`Paragraph style name`} value={name} onChange={e => setName(e.currentTarget.value)} />
        <button type="button" aria-label={isChar ? t`Save character style` : t`Save paragraph style`} title={isChar ? t`Save character style` : t`Save paragraph style`} disabled={!target}
          onClick={() => { if (target) { store([...list, newStyle(list, kind, name, runOf(target), paragraphOf(target))]); setName(''); } }}><Plus {...ICON} /></button>
      </div>
    </div>
  );
}

const detent = (v: number) => (Math.abs(v) <= 3 ? 0 : v);

// Type > Warp Text: always opens at Arc, bend 50 %, no distortion; OK applies (no live preview).
export function WarpTextDialog({ dialog, c }: { dialog: RefObject<HTMLDialogElement | null>; c: TypeCtx }) {
  const slider = (name: string, label: string, value: number) => (
    <label>{label} <input name={name} type="range" min={-100} max={100} defaultValue={value}
      onInput={e => { const el = e.currentTarget; el.value = String(detent(el.valueAsNumber)); }} /></label>
  );
  return (
    <dialog ref={dialog}>
      <form onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget), style = String(f.get('style'));
        const warp = style === 'none' ? null : {
          style, bend: Number(f.get('bend')) / 100, horizontal: Number(f.get('horizontal')) / 100, vertical: Number(f.get('vertical')) / 100, axis: String(f.get('axis')),
        };
        dialog.current?.close();
        applyWhole(c, x => ({ ...x, warp }), 'Warp Text');
      }}>
        <h2><Trans>Warp Text</Trans></h2>
        <label><Trans>Style</Trans> <select name="style" defaultValue="arc">
          <option value="none">{t`None`}</option>
          {WARP.map(([v, d]) => <option key={v} value={v}>{typeof d === 'string' ? d : i18n._(d)}</option>)}
        </select></label>
        <label><input type="radio" name="axis" value="horizontal" defaultChecked /> <Trans>Horizontal</Trans></label>
        <label><input type="radio" name="axis" value="vertical" /> <Trans>Vertical</Trans></label>
        {slider('bend', t`Bend %`, 50)}
        {slider('horizontal', t`Horizontal Distortion %`, 0)}
        {slider('vertical', t`Vertical Distortion %`, 0)}
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}
