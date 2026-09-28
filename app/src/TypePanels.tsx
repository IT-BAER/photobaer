// Character and Paragraph panels, the Properties type section and the Warp Text dialog (docs/M4.md
// section 10). Edits go to the session selection, else to the selected type layers (app/typeMenu.ts).
import type { RefObject } from 'react';
import { ColorInput, Num } from './PropertiesPanel.tsx';
import { applyType, applyWhole, paragraphOf, runOf, typeLayers, typeTarget, type TypeCtx } from './app/typeMenu.ts';
import type { ToolOptions } from './shell/OptionsBar.tsx';
import { hexToRgb, rgbToHex, type Rgb } from './shell/color.ts';
import type { FaceInfo } from './worker/types.ts';

type Span = Record<string, any>;
type Attrs = Record<string, unknown>;

const ALIGN: [string, string][] = [
  ['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['justify_left', 'Justify Last Left'], ['justify_center', 'Justify Last Center'],
  ['justify_right', 'Justify Last Right'], ['justify_all', 'Justify All'],
];
const AA: [string, string][] = [['none', 'None'], ['sharp', 'Sharp'], ['crisp', 'Crisp'], ['strong', 'Strong'], ['smooth', 'Smooth']];
const WARP = ['arc', 'arc_lower', 'arc_upper', 'arch', 'bulge', 'shell_lower', 'shell_upper', 'flag', 'wave', 'fish', 'rise', 'fisheye', 'inflate', 'squeeze', 'twist'];
const words = (s: string) => s.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

function Sel({ label, value, options, onChange, disabled }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label>{label} <select aria-label={label} value={value} disabled={disabled} onChange={e => onChange(e.currentTarget.value)}>
      {!options.some(([v]) => v === value) && <option value={value}>{value || '—'}</option>}
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
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
      <Sel label="Font Family" value={run.family} options={families.map(f => [f, f])} onChange={family => {
        const has = faces.filter(f => f.family === family).map(f => f.style);
        set('Font Family', { family, style: has.includes(run.style) ? run.style : has[0] ?? run.style, postscript_name: '' });
      }} />
      <Sel label="Font Style" value={run.style} options={styles.map(s => [s, s])} onChange={style => set('Font Style', { style, postscript_name: '' })} />
    </>
  );
}

// Window > Character: the session caret/selection run, else the last selected type layer's first run,
// else the type tool options (family, style, size, color only).
export function CharacterPanel({ c, faces, eastAsian, toolOptions, setToolOption }: {
  c: TypeCtx; faces: FaceInfo[]; eastAsian: boolean; toolOptions: ToolOptions; setToolOption: (k: string, v: unknown) => void;
}) {
  const t = typeTarget(c);
  if (!t) {
    const o = { family: toolOptions.family, style: toolOptions.style, size: Number(toolOptions.size) };
    return (
      <div className="properties-panel type-panel">
        <div className="panel-tabs"><span className="panel-tab">Character</span></div>
        <FontRows run={o} faces={faces} set={(_, a) => { for (const [k, v] of Object.entries(a)) if (k in o) setToolOption(k, v); }} />
        <Num label="Size" value={o.size} min={0.01} max={1296} step={0.1} onCommit={v => setToolOption('size', v)} />
        <label>Color <ColorInput key={String(toolOptions.color)} label="Text color" value={hexToRgb(String(toolOptions.color)) ?? [0, 0, 0]} onCommit={v => setToolOption('color', rgbToHex(v))} /></label>
        <p className="panel-empty">Select a type layer or start typing to edit its characters.</p>
      </div>
    );
  }
  const r = runOf(t), set = (_: string, a: Attrs) => applyType(c, a, null, 'Character Formatting');
  return (
    <div className="properties-panel type-panel">
      <div className="panel-tabs"><span className="panel-tab">Character</span></div>
      <FontRows run={r} faces={faces} set={set} />
      <Num label="Size" value={r.size} min={0.01} max={1296} step={0.1} onCommit={size => set('', { size })} />
      <Num label="Leading (0 = auto)" value={r.leading ?? 0} min={0} max={5000} step={0.1} onCommit={v => set('', { leading: v || null })} />
      <Num label="Tracking" value={r.tracking} min={-1000} max={10000} onCommit={tracking => set('', { tracking })} />
      <Num label="Horizontal Scale %" value={Math.round(r.horizontal_scale * 100)} min={1} max={1000} onCommit={v => set('', { horizontal_scale: v / 100 })} />
      <Num label="Vertical Scale %" value={Math.round(r.vertical_scale * 100)} min={1} max={1000} onCommit={v => set('', { vertical_scale: v / 100 })} />
      <Num label="Baseline Shift" value={r.baseline_shift} min={-5000} max={5000} step={0.1} onCommit={baseline_shift => set('', { baseline_shift })} />
      {eastAsian && <Num label="Tsume %" value={Math.round(r.tsume * 100)} min={0} max={100} onCommit={v => set('', { tsume: v / 100 })} />}
      <label>Color <ColorInput key={String(r.color)} label="Text color" value={r.color as Rgb} onCommit={color => set('', { color })} /></label>
      <Sel label="Anti-Alias" value={r.anti_alias} options={AA} onChange={anti_alias => applyWhole(c, x => ({ ...x, runs: x.runs.map((q: Span) => ({ ...q, anti_alias })) }), 'Character Formatting')} />
      <div className="professional-toggle-grid">
        <Check label="Faux Bold" checked={r.faux_bold} onChange={faux_bold => set('', { faux_bold })} />
        <Check label="Faux Italic" checked={r.faux_italic} onChange={faux_italic => set('', { faux_italic })} />
        <Check label="Underline" checked={r.underline} onChange={underline => set('', { underline })} />
        <Check label="Strikethrough" checked={r.strikethrough} onChange={strikethrough => set('', { strikethrough })} />
        <Check label="All Caps" checked={r.caps === 'all'} onChange={on => set('', { caps: on ? 'all' : 'normal' })} />
        <Check label="Small Caps" checked={r.caps === 'small'} onChange={on => set('', { caps: on ? 'small' : 'normal' })} />
        <Check label="Superscript" checked={r.baseline === 'super'} onChange={on => set('', { baseline: on ? 'super' : 'normal' })} />
        <Check label="Subscript" checked={r.baseline === 'sub'} onChange={on => set('', { baseline: on ? 'sub' : 'normal' })} />
      </div>
    </div>
  );
}

const JUST: [string, string][] = [['word', 'Word Spacing'], ['letter', 'Letter Spacing'], ['glyph', 'Glyph Scaling']];

// Window > Paragraph: the paragraph at the session caret, else the first of the last selected type layer.
export function ParagraphPanel({ c }: { c: TypeCtx }) {
  const t = typeTarget(c);
  if (!t) {
    return (
      <div className="properties-panel type-panel">
        <div className="panel-tabs"><span className="panel-tab">Paragraph</span></div>
        <p className="panel-empty">Select a type layer or start typing to edit its paragraphs.</p>
      </div>
    );
  }
  const p = paragraphOf(t), set = (a: Attrs) => applyType(c, null, a, 'Paragraph Formatting');
  const pt = (label: string, key: string) => <Num key={key} label={label} value={p[key]} min={-10000} max={10000} step={0.1} onCommit={v => set({ [key]: v })} />;
  return (
    <div className="properties-panel type-panel">
      <div className="panel-tabs"><span className="panel-tab">Paragraph</span></div>
      <Sel label="Alignment" value={p.alignment} options={ALIGN} onChange={alignment => set({ alignment })} />
      {pt('Indent Left', 'indent_left')}{pt('Indent Right', 'indent_right')}{pt('Indent First Line', 'indent_first')}
      {pt('Space Before', 'space_before')}{pt('Space After', 'space_after')}
      <Sel label="Composer" value={p.composer} options={[['every_line', 'Every-line Composer'], ['single_line', 'Single-line Composer']]} onChange={composer => set({ composer })} />
      <div className="professional-toggle-grid">
        <Check label="Hyphenate" checked={p.hyphenate} onChange={hyphenate => set({ hyphenate })} />
        <Check label="Right-to-Left" checked={p.rtl} onChange={rtl => set({ rtl })} />
        <Check label="Roman Hanging Punctuation" checked={p.hanging_punctuation} onChange={hanging_punctuation => set({ hanging_punctuation })} />
      </div>
      <details>
        <summary>Justification</summary>
        {JUST.map(([k, label]) => (['Minimum', 'Desired', 'Maximum'] as const).map((m, i) => (
          <Num key={k + m} label={`${label} ${m} %`} value={Math.round(p.justification[k][i] * 100)} min={0} max={1000}
            onCommit={v => set({ justification: { ...p.justification, [k]: p.justification[k].map((x: number, j: number) => (j === i ? v / 100 : x)) } })} />
        )))}
      </details>
      <details>
        <summary>Hyphenation</summary>
        {([['min_word', 'Words Longer Than', 2, 25], ['after_first', 'After First', 1, 15], ['before_last', 'Before Last', 1, 15], ['limit', 'Hyphen Limit', 0, 25], ['zone', 'Hyphenation Zone', 0, 8640]] as [string, string, number, number][])
          .map(([k, label, min, max]) => <Num key={k} label={label} value={p.hyphenation[k]} min={min} max={max} onCommit={v => set({ hyphenation: { ...p.hyphenation, [k]: v } })} />)}
        <Check label="Hyphenate Capitalized Words" checked={p.hyphenation.capitalized} onChange={capitalized => set({ hyphenation: { ...p.hyphenation, capitalized } })} />
      </details>
    </div>
  );
}

const SHAPE_LABEL: Record<string, string> = { point: 'Point Text', paragraph: 'Paragraph Text', onPath: 'Text on Path', inShape: 'Text in Shape' };

// Properties for a type layer: every edit sets all runs or paragraphs of the last selected type layer,
// one step labelled by its field.
export function TypeProperties({ c, faces }: { c: TypeCtx; faces: FaceInfo[] }) {
  const n = typeLayers(c.selected).at(-1);
  if (!n) return null;
  const one = { ...c, selected: [n] }, t = n.text!, r = t.runs[0] as Span, p = t.paragraphs[0] as Span;
  const run = (label: string, a: Attrs) => applyType(one, a, null, label);
  const para = (label: string, a: Attrs) => applyType(one, null, a, label);
  return (
    <div className="properties-panel type-panel">
      <div className="panel-tabs"><span className="panel-tab">Properties</span></div>
      <div className="adjustment-header"><h3>{SHAPE_LABEL[t.shape?.type] ?? 'Type'}</h3><span className="swatch" style={{ background: rgbToHex(r.color) }} /></div>
      <h4>Character</h4>
      <FontRows run={r} faces={faces} set={run} />
      <Num label="Font Size" value={r.size} min={0.1} max={1296} step={0.1} onCommit={size => run('Font Size', { size })} />
      <Num label="Leading (0 = auto)" value={r.leading ?? 0} min={0} max={5000} step={0.1} onCommit={v => run('Leading', { leading: v || null })} />
      <Num label="Tracking" value={r.tracking} min={-1000} max={10000} onCommit={tracking => run('Tracking', { tracking })} />
      <label>Color <ColorInput key={String(r.color)} label="Text Color" value={r.color} onCommit={color => run('Text Color', { color })} /></label>
      <div className="professional-toggle-grid">
        <Check label="Bold" checked={r.faux_bold} onChange={faux_bold => run('Faux Bold', { faux_bold })} />
        <Check label="Italic" checked={r.faux_italic} onChange={faux_italic => run('Faux Italic', { faux_italic })} />
        <Check label="Underline" checked={r.underline} onChange={underline => run('Underline', { underline })} />
        <Check label="Strikethrough" checked={r.strikethrough} onChange={strikethrough => run('Strikethrough', { strikethrough })} />
      </div>
      <h4>Paragraph</h4>
      <Sel label="Align" value={p.alignment} options={ALIGN} onChange={alignment => para('Alignment', { alignment })} />
      <Sel label="Direction" value={p.rtl ? 'rtl' : 'ltr'} options={[['ltr', 'Left to Right'], ['rtl', 'Right to Left']]} onChange={v => para('Direction', { rtl: v === 'rtl' })} />
      {([['indent_left', 'Indent Left'], ['indent_right', 'Indent Right'], ['space_before', 'Space Before'], ['space_after', 'Space After']] as [string, string][])
        .map(([k, label]) => <Num key={k} label={`${label} (pt)`} value={p[k]} min={-10000} max={10000} step={0.1} onCommit={v => para(label, { [k]: v })} />)}
      <h4>Type Options</h4>
      <Sel label="Orientation" value={t.orientation} options={[['horizontal', 'Horizontal'], ['vertical', 'Vertical']]}
        onChange={orientation => applyWhole(one, x => ({ ...x, orientation }), 'Orientation')} />
      <Num label="Baseline Shift" value={r.baseline_shift} min={-500} max={500} step={0.1} onCommit={baseline_shift => run('Baseline Shift', { baseline_shift })} />
      <div className="professional-toggle-grid">
        <Check label="Uppercase" checked={r.caps === 'all'} onChange={on => run('Uppercase', { caps: on ? 'all' : 'normal' })} />
        <Check label="Small Caps" checked={r.caps === 'small'} onChange={on => run('Small Caps', { caps: on ? 'small' : 'normal' })} />
        <Check label="Superscript" checked={r.baseline === 'super'} onChange={on => run('Superscript', { baseline: on ? 'super' : 'normal' })} />
        <Check label="Subscript" checked={r.baseline === 'sub'} onChange={on => run('Subscript', { baseline: on ? 'sub' : 'normal' })} />
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
        applyWhole(c, t => ({ ...t, warp }), 'Warp Text');
      }}>
        <h2>Warp Text</h2>
        <label>Style <select name="style" defaultValue="arc">
          <option value="none">None</option>
          {WARP.map(s => <option key={s} value={s}>{words(s)}</option>)}
        </select></label>
        <label><input type="radio" name="axis" value="horizontal" defaultChecked /> Horizontal</label>
        <label><input type="radio" name="axis" value="vertical" /> Vertical</label>
        {slider('bend', 'Bend %', 50)}
        {slider('horizontal', 'Horizontal Distortion %', 0)}
        {slider('vertical', 'Vertical Distortion %', 0)}
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </dialog>
  );
}
