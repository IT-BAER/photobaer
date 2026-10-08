import { ArrowUpRight } from 'lucide-react';
import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useMemo, useRef, useState, type ComponentProps, type Dispatch, type FormEvent, type RefObject, type SetStateAction } from 'react';
import { client } from '../client.ts';
import type { Active } from '../LayersPanel.tsx';
import { BLEND_MODES } from '../layers.ts';
import { AdjustmentBody, filterLabel, type PickLookupFile } from '../PropertiesPanel.tsx';
import { PatternPicker } from '../PresetPanels.tsx';
import { MENU_LABEL, type AnyKind, type Kind } from '../adjustments.ts';
import { choiceLabel } from '../i18n/choices.ts';
import { engineLabel } from '../filters/labels.ts';
import { i18n } from '../i18n/index.ts';
import { keysLabel } from '../i18n/keys.ts';
import type { BrushLibrary } from '../brushes/store.ts';
import type { EngineAssets } from '../brushes/engineAssets.ts';
import type { ColorPickerHandle } from '../shell/ColorPicker.tsx';
import type { GradientEditorHandle } from '../shell/GradientEditor.tsx';
import { rgbToHex, type Rgb } from '../shell/color.ts';
import { paintModesFor } from '../shell/tools.ts';
import { RULER_UNITS, unitToPx, type RulerUnit } from '../shell/units.ts';
import type { BrushOutline, PaintingCursor, Preferences } from '../shell/preferences.ts';
import type { Adjustment, DestructiveAdjustment, DocInfo, LayerNode, SmartFilterInfo } from '../worker/types.ts';
import {
  COLOR_RANGE_PRESETS, FILL_CONTENTS, FILL_LAYERS, MODIFY_OPS, selectCreated,
  type FillContentForm, type FillContents, type FillForm, type Item, type Run, type Show, type StrokeForm, type TrimBase,
} from './helpers.ts';
import { flattenMenus, searchCommands } from './commandSearch.ts';
import { NumberInput } from '../shell/NumberInput.tsx';

type SetState<T> = Dispatch<SetStateAction<T>>;
type DialogRef = RefObject<HTMLDialogElement | null>;
type PreviewRef = RefObject<{ open: boolean; commit: boolean; pending: Promise<unknown> }>;
type BrushLibRef = RefObject<{ library: BrushLibrary; assets: EngineAssets } | null>;
type AdjustForm = Adjustment | DestructiveAdjustment | null;
type FilterBlend = { id: number; fid: number; blend: string; opacity: number };
type ColorRange = { preset: string; fuzziness: number; range: number; localized: boolean; invert: boolean };
type ColorRangeSample = { rgb: [number, number, number]; x: number; y: number };
type ColorRangePreview = { w: number; h: number; data: Uint8Array; level: number };

const DESTRUCTIVE_TITLE: Record<DestructiveAdjustment['kind'], MessageDescriptor> = {
  shadows_highlights: msg`Shadows/Highlights`, hdr_toning: msg`HDR Toning`, desaturate: msg`Desaturate`, match_color: msg`Match Color`,
  replace_color: msg`Replace Color`, equalize: msg`Equalize`, auto_tone: msg`Auto Tone`, auto_contrast: msg`Auto Contrast`, auto_color: msg`Auto Color`,
};
const adjustTitle = (k: AnyKind) => i18n._(k in MENU_LABEL ? MENU_LABEL[k as Kind] : DESTRUCTIVE_TITLE[k as DestructiveAdjustment['kind']]);
const STROKE_LOCATION = { inside: msg`Inside`, center: msg`Center`, outside: msg`Outside` };
const MODIFY_TITLE = { border: msg`Border Selection`, smooth: msg`Smooth Selection`, expand: msg`Expand Selection`, contract: msg`Contract Selection` };
const COLOR_RANGE_LABEL: Record<string, MessageDescriptor> = {
  sampled: msg`Sampled`, reds: msg`Reds`, yellows: msg`Yellows`, greens: msg`Greens`, cyans: msg`Cyans`, blues: msg`Blues`, magentas: msg`Magentas`,
  highlights: msg`Highlights`, midtones: msg`Midtones`, shadows: msg`Shadows`, 'skin tones': msg`Skin Tones`,
};
const ANCHOR_LABEL = [
  [msg`Anchor top left`, msg`Anchor top center`, msg`Anchor top right`],
  [msg`Anchor middle left`, msg`Anchor middle center`, msg`Anchor middle right`],
  [msg`Anchor bottom left`, msg`Anchor bottom center`, msg`Anchor bottom right`],
];

export function FillDialog({ fillDialog, endPreviewDialog, previewRef, fillForm, setFillForm, picker, brushLib, depth }: {
  fillDialog: DialogRef; endPreviewDialog: () => void; previewRef: PreviewRef; fillForm: FillForm; setFillForm: SetState<FillForm>;
  picker: RefObject<ColorPickerHandle | null>; brushLib: BrushLibRef; depth?: number;
}) {
  return (
    <dialog ref={fillDialog} className="live-preview" aria-label={t({ message: 'Fill', context: 'command' })} onClose={endPreviewDialog}>
      <form onSubmit={e => { e.preventDefault(); previewRef.current.commit = true; fillDialog.current?.close(); }}>
        <h2><Trans context="command">Fill</Trans></h2>
        <label><Trans>Contents</Trans> <select name="contents" value={fillForm.contents} onChange={e => setFillForm({ ...fillForm, contents: e.currentTarget.value as FillContents })}>
          {Object.entries(FILL_CONTENTS).map(([k, l]) => <option key={k} value={k}>{i18n._(l)}</option>)}
        </select></label>
        <label><Trans>Custom color</Trans> <button type="button" className="gradient-swatch" aria-label={t`Custom fill color`} style={{ background: rgbToHex(fillForm.color) }}
          onClick={() => picker.current?.open(fillForm.color, t`Fill Color`, c => setFillForm(f => ({ ...f, color: c, contents: 'color' })))} /></label>
        {fillForm.contents === 'contentAware' && <>
          <label><Trans>Content-Aware Structure</Trans> <input name="caStructure" type="range" min={1} max={7} value={fillForm.caStructure}
            onChange={e => setFillForm({ ...fillForm, caStructure: Number(e.currentTarget.value) })} /> {fillForm.caStructure}</label>
          <label><Trans>Content-Aware Color</Trans> <input name="caColor" type="range" min={0} max={10} value={fillForm.caColor}
            onChange={e => setFillForm({ ...fillForm, caColor: Number(e.currentTarget.value) })} /> {fillForm.caColor}</label>
        </>}
        {fillForm.contents === 'pattern' && (
          <label><Trans>Pattern</Trans> <select name="pattern" value={fillForm.pattern || brushLib.current?.library.patterns()[0]?.id} onChange={e => setFillForm({ ...fillForm, pattern: e.currentTarget.value })}>
            {brushLib.current?.library.patterns().map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
        )}
        <label><Trans>Mode</Trans> <select name="mode" value={fillForm.mode} onChange={e => setFillForm({ ...fillForm, mode: e.currentTarget.value })}>
          {paintModesFor(depth, fillForm.mode).map(m => <option key={m} value={m}>{choiceLabel(m)}</option>)}
        </select></label>
        <label><Trans>Opacity</Trans> <NumberInput name="opacity" min={0} max={100} value={fillForm.opacity}
          onValue={v => setFillForm({ ...fillForm, opacity: Math.min(100, Math.max(0, v)) })} /> %</label>
        <label><input name="preserve" type="checkbox" checked={fillForm.preserve} onChange={e => setFillForm({ ...fillForm, preserve: e.currentTarget.checked })} /> <Trans>Preserve Transparency</Trans></label>
        <div className="actions">
          <button type="button" onClick={() => fillDialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

// Edit > Content-Aware Fill…: Structure 1..7 and Color Adaptation 0..10, no live preview.
export function ContentAwareFillDialog({ dialog, submit }: { dialog: DialogRef; submit: (structure: number, color: number) => void }) {
  const [structure, setStructure] = useState(4);
  const [color, setColor] = useState(5);
  return (
    <dialog ref={dialog} aria-label={t`Content-Aware Fill`}>
      <form onSubmit={e => { e.preventDefault(); dialog.current?.close(); submit(structure, color); }}>
        <h2><Trans>Content-Aware Fill</Trans></h2>
        <label><Trans>Structure</Trans> <input name="structure" type="range" min={1} max={7} value={structure} onChange={e => setStructure(Number(e.currentTarget.value))} /> {structure}</label>
        <label><Trans>Color Adaptation</Trans> <input name="color" type="range" min={0} max={10} value={color} onChange={e => setColor(Number(e.currentTarget.value))} /> {color}</label>
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export function StrokeDialog({ strokeDialog, endPreviewDialog, previewRef, strokeForm, setStrokeForm, picker, depth }: {
  strokeDialog: DialogRef; endPreviewDialog: () => void; previewRef: PreviewRef; strokeForm: StrokeForm; setStrokeForm: SetState<StrokeForm>;
  picker: RefObject<ColorPickerHandle | null>; depth?: number;
}) {
  return (
    <dialog ref={strokeDialog} className="live-preview" aria-label={t({ message: 'Stroke', context: 'command' })} onClose={endPreviewDialog}>
      <form onSubmit={e => { e.preventDefault(); previewRef.current.commit = true; strokeDialog.current?.close(); }}>
        <h2><Trans context="command">Stroke</Trans></h2>
        <label><Trans>Width</Trans> <NumberInput name="width" min={1} max={250} value={strokeForm.width}
          onValue={v => setStrokeForm({ ...strokeForm, width: Math.min(250, Math.max(1, Math.round(v))) })} /> px</label>
        <label><Trans>Color</Trans> <button type="button" className="gradient-swatch" aria-label={t`Stroke color`} style={{ background: rgbToHex(strokeForm.color) }}
          onClick={() => picker.current?.open(strokeForm.color, t`Stroke Color`, c => setStrokeForm(f => ({ ...f, color: c })))} /></label>
        <fieldset className="stroke-location">
          <legend><Trans>Location</Trans></legend>
          {(['inside', 'center', 'outside'] as const).map(l => (
            <label key={l}><input type="radio" name="location" value={l} checked={strokeForm.location === l} onChange={() => setStrokeForm({ ...strokeForm, location: l })} /> {i18n._(STROKE_LOCATION[l])}</label>
          ))}
        </fieldset>
        <label><Trans>Mode</Trans> <select name="mode" value={strokeForm.mode} onChange={e => setStrokeForm({ ...strokeForm, mode: e.currentTarget.value })}>
          {paintModesFor(depth, strokeForm.mode).map(m => <option key={m} value={m}>{choiceLabel(m)}</option>)}
        </select></label>
        <label><Trans>Opacity</Trans> <NumberInput name="opacity" min={0} max={100} value={strokeForm.opacity}
          onValue={v => setStrokeForm({ ...strokeForm, opacity: Math.min(100, Math.max(0, v)) })} /> %</label>
        <label><input name="preserve" type="checkbox" checked={strokeForm.preserve} onChange={e => setStrokeForm({ ...strokeForm, preserve: e.currentTarget.checked })} /> <Trans>Preserve Transparency</Trans></label>
        <div className="actions">
          <button type="button" onClick={() => strokeDialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export function AdjustDialog({ adjustDialog, adjustForm, endPreviewDialog, previewRef, adjustSession, setAdjustForm, gradEditor, pickLookupFile, active }: {
  adjustDialog: DialogRef; adjustForm: AdjustForm; endPreviewDialog: () => void; previewRef: PreviewRef; adjustSession: number;
  setAdjustForm: SetState<AdjustForm>; gradEditor: RefObject<GradientEditorHandle | null>; pickLookupFile: PickLookupFile; active: Active | null;
}) {
  return (
    <dialog ref={adjustDialog} className="live-preview" aria-label={adjustForm ? adjustTitle(adjustForm.kind) : t`Adjustment`} onClose={endPreviewDialog}>
      <form onSubmit={e => { e.preventDefault(); previewRef.current.commit = true; adjustDialog.current?.close(); }}>
        <h2>{adjustForm && adjustTitle(adjustForm.kind)}</h2>
        {adjustForm && (
          <AdjustmentBody key={adjustSession} adjustment={adjustForm} onChange={a => setAdjustForm(a)} openGradientEditor={(g, ok) => gradEditor.current?.open(g, ok)} pickLookupFile={pickLookupFile} histogramId={active?.id ?? 0} />
        )}
        <div className="actions">
          <button type="button" onClick={() => adjustDialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export function FillContentDialog({ fillContentDialog, submitFillContent, fillContentForm, setFillContentForm, picker, doc, brushLib, show, setError }: {
  fillContentDialog: DialogRef; submitFillContent: () => void; fillContentForm: FillContentForm; setFillContentForm: SetState<FillContentForm>;
  picker: RefObject<ColorPickerHandle | null>; doc: DocInfo | null; brushLib: BrushLibRef; show: Show; setError: SetState<string | null>;
}) {
  return (
    <dialog ref={fillContentDialog}>
      <form onSubmit={e => { e.preventDefault(); submitFillContent(); }}>
        <h2>{i18n._(FILL_LAYERS[fillContentForm.type].title)}</h2>
        {fillContentForm.type === 'solid' && (
          <label><Trans>Color</Trans> <button type="button" className="gradient-swatch" aria-label={t`Fill color`} style={{ background: rgbToHex(fillContentForm.color) }}
            onClick={() => picker.current?.open(fillContentForm.color, t`Fill Color`, c => setFillContentForm(f => ({ ...f, color: c })))} /></label>
        )}
        {fillContentForm.type === 'gradient' && (
          <>
            <label><Trans>Style</Trans> <select value={fillContentForm.style} onChange={e => setFillContentForm({ ...fillContentForm, style: e.currentTarget.value as FillContentForm['style'] })}>
              {(['linear', 'radial', 'angle', 'reflected', 'diamond'] as const).map(s => <option key={s} value={s}>{choiceLabel(s)}</option>)}
            </select></label>
            <label><Trans>Angle</Trans> <NumberInput value={fillContentForm.angle} onValue={v => setFillContentForm({ ...fillContentForm, angle: v })} /> °</label>
            <label><Trans>Scale</Trans> <NumberInput min={10} max={150} value={fillContentForm.scalePct} onValue={v => setFillContentForm({ ...fillContentForm, scalePct: Math.min(150, Math.max(10, v)) })} /> %</label>
            <label><input type="checkbox" checked={fillContentForm.reverse} onChange={e => setFillContentForm({ ...fillContentForm, reverse: e.currentTarget.checked })} /> <Trans>Reverse</Trans></label>
            <label><input type="checkbox" checked={fillContentForm.dither} onChange={e => setFillContentForm({ ...fillContentForm, dither: e.currentTarget.checked })} /> <Trans>Dither</Trans></label>
            <label><input type="checkbox" checked={fillContentForm.alignWithLayer} onChange={e => setFillContentForm({ ...fillContentForm, alignWithLayer: e.currentTarget.checked })} /> <Trans>Align with layer</Trans></label>
          </>
        )}
        {fillContentForm.type === 'pattern' && (
          <>
            {doc && (
              <PatternPicker doc={doc} library={brushLib.current?.library ?? null} value={fillContentForm.patternId} onDoc={d => show(d)} onError={setError}
                set={id => setFillContentForm(f => ({ ...f, patternId: id }))} />
            )}
            <label><Trans>Scale</Trans> <NumberInput min={1} max={1000} value={fillContentForm.scalePct} onValue={v => setFillContentForm({ ...fillContentForm, scalePct: Math.min(1000, Math.max(1, v)) })} /> %</label>
            <label><Trans>Angle</Trans> <NumberInput value={fillContentForm.angle} onValue={v => setFillContentForm({ ...fillContentForm, angle: v })} /> °</label>
            <label><input type="checkbox" checked={fillContentForm.linked} onChange={e => setFillContentForm({ ...fillContentForm, linked: e.currentTarget.checked })} /> <Trans>Link with layer</Trans></label>
          </>
        )}
        <div className="actions">
          <button type="button" onClick={() => fillContentDialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary" disabled={fillContentForm.type === 'pattern' && !fillContentForm.patternId}><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export function NewImageDialog({ newDialog, createNew }: { newDialog: DialogRef; createNew: (e: FormEvent<HTMLFormElement>) => void }) {
  return (
    <dialog ref={newDialog}>
      <form onSubmit={createNew}>
        <h2><Trans>New image</Trans></h2>
        <label><Trans>Width</Trans> <FormNumber name="w" min={1} max={65536} defaultValue={1920} required /> px</label>
        <label><Trans>Height</Trans> <FormNumber name="h" min={1} max={65536} defaultValue={1080} required /> px</label>
        <label><Trans>Bit depth</Trans> <select name="depth" defaultValue="8"><option value="8">{t`8-bit`}</option><option value="16">{t`16-bit`}</option><option value="32">{t`32-bit`}</option></select></label>
        <label><Trans>Background</Trans> <select name="bg" defaultValue="white"><option value="white">{t`White`}</option><option value="black">{t`Black`}</option><option value="transparent">{t`Transparent`}</option></select></label>
        <div className="actions">
          <button type="button" onClick={() => newDialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>Create</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export type CloseChoice = 'save' | 'discard' | 'cancel';

// Close prompt for a dirty tab; Escape cancels and Save has the focus.
export function CloseDialog({ closeDialog, name, choose }: { closeDialog: DialogRef; name: string; choose: (c: CloseChoice) => void }) {
  return (
    <dialog ref={closeDialog} onCancel={e => { e.preventDefault(); choose('cancel'); }}>
      <form onSubmit={e => { e.preventDefault(); choose('save'); }}>
        <p><Trans>Save changes to the photobaer document &quot;{name}&quot; before closing?</Trans></p>
        <div className="actions">
          <button type="button" onClick={() => choose('cancel')}><Trans>Cancel</Trans></button>
          <button type="button" onClick={() => choose('discard')}><Trans>Don&apos;t Save</Trans></button>
          <button type="submit" className="primary"><Trans>Save</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export type MergeChoice = 'merge' | 'keep' | 'cancel';

// 32 -> 16/8 Bits/Channel with several layers: Merge allows HDR Toning; Escape cancels.
export function MergeDialog({ mergeDialog, depth, choose }: { mergeDialog: DialogRef; depth: number; choose: (c: MergeChoice) => void }) {
  return (
    <dialog ref={mergeDialog} onCancel={e => { e.preventDefault(); choose('cancel'); }}>
      <form onSubmit={e => { e.preventDefault(); choose('merge'); }}>
        <p><Trans>Merge layers before converting to {depth} Bits/Channel? Merging allows HDR Toning options; without it, each layer is toned with Local Adaptation.</Trans></p>
        <div className="actions">
          <button type="button" onClick={() => choose('cancel')}><Trans>Cancel</Trans></button>
          <button type="button" onClick={() => choose('keep')}><Trans>Don&apos;t Merge</Trans></button>
          <button type="submit" className="primary"><Trans>Merge</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export function SearchDialog({ menus, close }: { menus: Record<string, Item[]>; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const commands = useMemo(() => flattenMenus(menus), [menus]);
  const results = useMemo(() => searchCommands(commands, query), [commands, query]);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => { document.getElementById(`search-option-${index}`)?.scrollIntoView({ block: 'nearest' }); }, [index]);
  const pick = (i: number) => {
    const c = results[i];
    if (!c || c.off) return;
    dialog.current?.close();
    close();
    c.run();
  };
  return (
    <dialog ref={dialog} className="search-dialog" aria-label={t`Search`} onClose={close}>
      <input autoFocus value={query} aria-label={t`Search commands`} role="combobox" aria-expanded aria-controls="search-results"
        aria-activedescendant={results.length ? `search-option-${index}` : undefined}
        onChange={e => { setQuery(e.target.value); setIndex(0); }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (results.length) setIndex((index + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length);
          } else if (e.key === 'Enter') { e.preventDefault(); pick(index); }
        }} />
      <ul id="search-results" role="listbox" aria-label={t`Commands`}>
        {results.map((c, i) => (
          <li key={i} id={`search-option-${i}`} role="option" aria-selected={i === index} aria-disabled={c.off || undefined}
            className={c.off ? 'off' : undefined} onMouseMove={() => setIndex(i)} onClick={() => pick(i)}>
            <span>{c.label}<small>{c.path}</small></span>
            {c.keys && c.keys !== '›' && <kbd>{keysLabel(c.keys)}</kbd>}
          </li>
        ))}
        {!results.length && <li className="empty"><Trans>No matching commands</Trans></li>}
      </ul>
    </dialog>
  );
}

export function AboutDialog({ aboutDialog }: { aboutDialog: DialogRef }) {
  return (
    <dialog ref={aboutDialog} className="about-dialog" aria-label={t`About photobaer`}>
      <form method="dialog">
        <h2><img src="./logo-light.png" alt="" width={40} height={40} />photobaer</h2>
        <p><Trans>Image editing in your browser</Trans></p>
        <p>© 2026 IT-BAER</p>
        <p>
          <Trans>Code licensed under <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">AGPL-3.0</a>.</Trans>{' '}
          <a href="https://github.com/IT-BAER/photobaer" target="_blank" rel="noreferrer"><Trans>Source code</Trans></a>
        </p>
        <p className="dim"><Trans>The photobaer name and logo are not covered by the code license.</Trans></p>
        <p className="dim">
          <a href="/impressum/" target="_blank" rel="noreferrer"><Trans>Legal Notice</Trans></a> · <a href="/privacy/" target="_blank" rel="noreferrer"><Trans>Privacy</Trans></a> ·{' '}
          <a href="/terms/" target="_blank" rel="noreferrer"><Trans>Terms</Trans></a> · <a href="/licenses/" target="_blank" rel="noreferrer"><Trans>Licenses</Trans></a>
        </p>
        <div className="actions"><button className="primary"><Trans>OK</Trans></button></div>
      </form>
    </dialog>
  );
}

// A self-hosted copy pairs with its own origin instead of photobaer.com.
const agentServer = (origin: string) => `npx -y photobaer-mcp${origin === 'https://photobaer.com' ? '' : ` --url ${origin}/`}`;
const agentSetup = (origin: string) => [
  { name: 'Claude Code', cmd: `claude mcp add photobaer -- ${agentServer(origin)}` },
  { name: 'Codex', cmd: `codex mcp add photobaer -- ${agentServer(origin)}` },
];
const AGENT_PROMPT = 'Use the photobaer MCP tools. Call connect first; it opens photobaer in my browser. '
  + 'Open my image with open_file, edit it with list_filters and run_filter, or list_commands and run_command, '
  + 'check each result with get_preview, and save it with save_file.\n\nTask: ';

function CopyRow({ text, multiline }: { text: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-row">
      {multiline ? <textarea readOnly value={text} rows={5} /> : <input readOnly value={text} onFocus={e => e.currentTarget.select()} />}
      <button type="button" onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true), () => {})}>{copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}</button>
    </div>
  );
}

export function AgentDialog({ agentDialog }: { agentDialog: DialogRef }) {
  const native = 'modelContext' in document || 'modelContext' in navigator;
  return (
    <dialog ref={agentDialog} className="agent-dialog" aria-labelledby="agent-title">
      <form method="dialog">
        <h2 id="agent-title"><Trans>Use with AI agents</Trans></h2>
        <p>
          <Trans>Coding agents such as Claude Code and Codex can open images from your disk in photobaer, run filters and menu commands, look at the result and save it.</Trans>{' '}
          <Trans>The editing runs in this browser tab; photobaer-mcp runs on your computer and only connects the agent to the tab.</Trans>
        </p>
        <h3><Trans>1. Add the photobaer MCP server to your agent</Trans></h3>
        {agentSetup(location.origin).map(a => <label key={a.name} className="copy-label">{a.name}<CopyRow text={a.cmd} /></label>)}
        <p className="dim"><Trans>Needs Node.js 20 or newer.</Trans> <Trans>On the first connect, Chrome and Edge ask to allow access to apps on this device. Allow it, or the agent cannot reach the tab.</Trans></p>
        <h3><Trans>2. Start with this prompt</Trans></h3>
        <CopyRow text={AGENT_PROMPT} multiline />
        {native && <p className="dim"><Trans>This browser also has WebMCP enabled, so in-browser agents can use the same tools on this tab.</Trans></p>}
        <div className="actions"><button className="primary"><Trans>Close</Trans></button></div>
      </form>
    </dialog>
  );
}

const HEART = 'M12 21s-7.5-4.6-9.6-9.3C.9 8.3 3 4.5 6.6 4.5c2.1 0 3.8 1.2 5.4 3.1 1.6-1.9 3.3-3.1 5.4-3.1 3.6 0 5.7 3.8 4.2 7.2C19.5 16.4 12 21 12 21z';
// Brand marks from simple-icons (CC0).
const DONATE_OPTIONS = [
  { id: 'paypal', name: 'PayPal', note: msg`Donate any amount`, href: 'https://www.paypal.com/donate/?hosted_button_id=5XXRC7THMTRRS', icon: 'M15.607 4.653H8.941L6.645 19.251H1.82L4.862 0h7.995c3.754 0 6.375 2.294 6.473 5.513-.648-.478-2.105-.86-3.722-.86m6.57 5.546c0 3.41-3.01 6.853-6.958 6.853h-2.493L11.595 24H6.74l1.845-11.538h3.592c4.208 0 7.346-3.634 7.153-6.949a5.24 5.24 0 0 1 2.848 4.686M9.653 5.546h6.408c.907 0 1.942.222 2.363.541-.195 2.741-2.655 5.483-6.441 5.483H8.714Z' },
  { id: 'bmc', name: 'Buy Me a Coffee', note: msg`Send a coffee`, href: 'https://www.buymeacoffee.com/itbaer', icon: 'M20.216 6.415l-.132-.666c-.119-.598-.388-1.163-1.001-1.379-.197-.069-.42-.098-.57-.241-.152-.143-.196-.366-.231-.572-.065-.378-.125-.756-.192-1.133-.057-.325-.102-.69-.25-.987-.195-.4-.597-.634-.996-.788a5.723 5.723 0 00-.626-.194c-1-.263-2.05-.36-3.077-.416a25.834 25.834 0 00-3.7.062c-.915.083-1.88.184-2.75.5-.318.116-.646.256-.888.501-.297.302-.393.77-.177 1.146.154.267.415.456.692.58.36.162.737.284 1.123.366 1.075.238 2.189.331 3.287.37 1.218.05 2.437.01 3.65-.118.299-.033.598-.073.896-.119.352-.054.578-.513.474-.834-.124-.383-.457-.531-.834-.473-.466.074-.96.108-1.382.146-1.177.08-2.358.082-3.536.006a22.228 22.228 0 01-1.157-.107c-.086-.01-.18-.025-.258-.036-.243-.036-.484-.08-.724-.13-.111-.027-.111-.185 0-.212h.005c.277-.06.557-.108.838-.147h.002c.131-.009.263-.032.394-.048a25.076 25.076 0 013.426-.12c.674.019 1.347.067 2.017.144l.228.031c.267.04.533.088.798.145.392.085.895.113 1.07.542.055.137.08.288.111.431l.319 1.484a.237.237 0 01-.199.284h-.003c-.037.006-.075.01-.112.015a36.704 36.704 0 01-4.743.295 37.059 37.059 0 01-4.699-.304c-.14-.017-.293-.042-.417-.06-.326-.048-.649-.108-.973-.161-.393-.065-.768-.032-1.123.161-.29.16-.527.404-.675.701-.154.316-.199.66-.267 1-.069.34-.176.707-.135 1.056.087.753.613 1.365 1.37 1.502a39.69 39.69 0 0011.343.376.483.483 0 01.535.53l-.071.697-1.018 9.907c-.041.41-.047.832-.125 1.237-.122.637-.553 1.028-1.182 1.171-.577.131-1.165.2-1.756.205-.656.004-1.31-.025-1.966-.022-.699.004-1.556-.06-2.095-.58-.475-.458-.54-1.174-.605-1.793l-.731-7.013-.322-3.094c-.037-.351-.286-.695-.678-.678-.336.015-.718.3-.678.679l.228 2.185.949 9.112c.147 1.344 1.174 2.068 2.446 2.272.742.12 1.503.144 2.257.156.966.016 1.942.053 2.892-.122 1.408-.258 2.465-1.198 2.616-2.657.34-3.332.683-6.663 1.024-9.995l.215-2.087a.484.484 0 01.39-.426c.402-.078.787-.212 1.074-.518.455-.488.546-1.124.385-1.766zm-1.478.772c-.145.137-.363.201-.578.233-2.416.359-4.866.54-7.308.46-1.748-.06-3.477-.254-5.207-.498-.17-.024-.353-.055-.47-.18-.22-.236-.111-.71-.054-.995.052-.26.152-.609.463-.646.484-.057 1.046.148 1.526.22.577.088 1.156.159 1.737.212 2.48.226 5.002.19 7.472-.14.45-.06.899-.13 1.345-.21.399-.072.84-.206 1.08.206.166.281.188.657.162.974a.544.544 0 01-.169.364zm-6.159 3.9c-.862.37-1.84.788-3.109.788a5.884 5.884 0 01-1.569-.217l.877 9.004c.065.78.717 1.38 1.5 1.38 0 0 1.243.065 1.658.065.447 0 1.786-.065 1.786-.065.783 0 1.434-.6 1.499-1.38l.94-9.95a3.996 3.996 0 00-1.322-.238c-.826 0-1.491.284-2.26.613z' },
];

export function DonateDialog({ donateDialog }: { donateDialog: DialogRef }) {
  return (
    <dialog ref={donateDialog} className="donate-dialog" aria-labelledby="donate-title">
      <form method="dialog">
        <div className="donate-heart"><svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d={HEART} /></svg></div>
        <h2 id="donate-title"><Trans>Support photobaer</Trans></h2>
        <p><Trans>photobaer is free and open source. Your support helps keep it alive and maintained.</Trans></p>
        <div className="donate-options">
          {DONATE_OPTIONS.map(o => (
            <a key={o.id} className={`donate-option ${o.id}`} href={o.href} target="_blank" rel="noopener noreferrer">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d={o.icon} /></svg>
              <span><strong>{o.name}</strong><small>{i18n._(o.note)}</small></span>
              <ArrowUpRight className="donate-arrow" size={16} aria-hidden="true" />
            </a>
          ))}
        </div>
        <p className="dim"><Trans>Thank you for thinking about supporting it. It means a lot!</Trans></p>
        <div className="actions"><button><Trans>Maybe later</Trans></button></div>
      </form>
    </dialog>
  );
}

export function FeatherDialog({ featherDialog, run }: { featherDialog: DialogRef; run: Run }) {
  return (
    <dialog ref={featherDialog}>
      <form onSubmit={e => {
        e.preventDefault();
        const r = Number(new FormData(e.currentTarget).get('radius'));
        featherDialog.current?.close();
        run(null, () => client.call('selectCommand', 'feather', r));
      }}>
        <h2><Trans>Feather Selection</Trans></h2>
        <label><Trans>Feather radius</Trans> <FormNumber name="radius" min={0.1} max={1000} step={0.1} defaultValue={1} required /> px</label>
        <div className="actions">
          <button type="button" onClick={() => featherDialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export function ModifyDialog({ modifyDialog, run, modifyOp }: { modifyDialog: DialogRef; run: Run; modifyOp: keyof typeof MODIFY_OPS }) {
  return (
    <dialog ref={modifyDialog}>
      <form onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        modifyDialog.current?.close();
        run(null, () => client.call('modifySelection', modifyOp, Number(f.get('radius')), f.get('canvasBounds') === 'on'));
      }}>
        <h2>{i18n._(MODIFY_TITLE[modifyOp])}</h2>
        <label><Trans>Radius</Trans> <FormNumber key={modifyOp} name="radius" min={MODIFY_OPS[modifyOp].min} max={MODIFY_OPS[modifyOp].max} defaultValue={MODIFY_OPS[modifyOp].default} required /> px</label>
        <label><input name="canvasBounds" type="checkbox" /> <Trans>Apply effect at canvas bounds</Trans></label>
        <div className="actions">
          <button type="button" onClick={() => modifyDialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export function SaveSelectionDialog({ saveSelDialog, run, doc }: { saveSelDialog: DialogRef; run: Run; doc: DocInfo | null }) {
  return (
    <dialog ref={saveSelDialog}>
      <form onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const channel = f.get('channel');
        saveSelDialog.current?.close();
        run(null, () => client.call('saveSelection', channel ? null : String(f.get('name')), channel ? Number(channel) : null, String(f.get('mode'))));
      }}>
        <h2><Trans>Save Selection</Trans></h2>
        <label><Trans>Channel</Trans>
          <select name="channel" defaultValue="">
            <option value="">{t`New channel`}</option>
            {doc?.channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label><Trans>Name</Trans> <input name="name" type="text" defaultValue={`Selection ${(doc?.channels.length ?? 0) + 1}`} /></label>
        <label><Trans>Operation</Trans> <select name="mode" defaultValue="new">
          <option value="new">{t`Replace`}</option><option value="add">{t`Add to channel`}</option>
          <option value="subtract">{t`Subtract from channel`}</option><option value="intersect">{t`Intersect with channel`}</option>
        </select></label>
        <div className="actions">
          <button type="button" onClick={() => saveSelDialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export function LoadSelectionDialog({ loadSelDialog, run, doc }: { loadSelDialog: DialogRef; run: Run; doc: DocInfo | null }) {
  return (
    <dialog ref={loadSelDialog}>
      <form onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        loadSelDialog.current?.close();
        run(null, () => client.call('loadSelection', Number(f.get('channel')), f.get('invert') === 'on', String(f.get('mode'))));
      }}>
        <h2><Trans>Load Selection</Trans></h2>
        <label><Trans>Channel</Trans> <select name="channel" defaultValue={doc?.channels[0]?.id}>
          {doc?.channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
        <label><input name="invert" type="checkbox" /> <Trans>Invert</Trans></label>
        <label><Trans>Operation</Trans> <select name="mode" defaultValue="new">
          <option value="new">{t`New Selection`}</option><option value="add">{t`Add to Selection`}</option>
          <option value="subtract">{t`Subtract from Selection`}</option><option value="intersect">{t`Intersect with Selection`}</option>
        </select></label>
        <div className="actions">
          <button type="button" onClick={() => loadSelDialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export function TrimDialog({ trimDialog, run }: { trimDialog: DialogRef; run: Run }) {
  return (
    <dialog ref={trimDialog}>
      <form onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const on = (k: string) => f.get(k) === 'on';
        trimDialog.current?.close();
        run(t`Trimming…`, () => client.call('trim', String(f.get('basedOn')) as TrimBase, on('top'), on('bottom'), on('left'), on('right')));
      }}>
        <h2><Trans>Trim</Trans></h2>
        <fieldset className="stroke-location trim-group">
          <legend><Trans>Based On</Trans></legend>
          {([['transparent', t`Transparent Pixels`], ['topLeftPixel', t`Top Left Pixel Color`], ['bottomRightPixel', t`Bottom Right Pixel Color`]] as [TrimBase, string][]).map(([v, l]) => (
            <label key={v}><input type="radio" name="basedOn" value={v} defaultChecked={v === 'transparent'} /> {l}</label>
          ))}
        </fieldset>
        <fieldset className="stroke-location">
          <legend><Trans>Trim Away</Trans></legend>
          {([['top', t`Top`], ['bottom', t`Bottom`], ['left', t`Left`], ['right', t`Right`]] as const).map(([k, l]) => (
            <label key={k}><input type="checkbox" name={k} defaultChecked /> {l}</label>
          ))}
        </fieldset>
        <div className="actions">
          <button type="button" onClick={() => trimDialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export type AutomateKind = 'align' | 'blend' | 'photomerge' | 'hdr';
const AUTOMATE_TITLE: Record<AutomateKind, MessageDescriptor> = { align: msg`Auto-Align Layers`, blend: msg`Auto-Blend Layers`, photomerge: msg`Photomerge`, hdr: msg`Merge to HDR Pro` };

// Edit > Auto-Align / Auto-Blend Layers (on `ids`) and File > Automate > Photomerge / Merge to HDR Pro.
export function AutomateDialog({ dialog, kind, ids, docCount, run }: { dialog: DialogRef; kind: AutomateKind; ids: number[]; docCount: number; run: Run }) {
  const radios = (name: string, legend: string, items: [string, string][]) => (
    <fieldset className="stroke-location">
      <legend>{legend}</legend>
      {items.map(([v, l], i) => <label key={v}><input type="radio" name={name} value={v} defaultChecked={i === 0} /> {l}</label>)}
    </fieldset>
  );
  return (
    <dialog ref={dialog} aria-label={i18n._(AUTOMATE_TITLE[kind])}>
      <form key={kind} onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const on = (k: string) => f.get(k) === 'on';
        dialog.current?.close();
        if (kind === 'align') run(t`Aligning…`, () => client.call('autoAlign', ids, f.get('projection') === 'reposition'));
        else if (kind === 'blend') run(t`Blending…`, () => client.call('autoBlend', ids, f.get('method') === 'stack', on('seamless')));
        else if (kind === 'photomerge') run(t`Merging…`, () => client.call('photomerge', on('blend')));
        else run(t`Merging…`, () => client.call('mergeHdr', Number(f.get('stops'))));
      }}>
        <h2>{i18n._(AUTOMATE_TITLE[kind])}</h2>
        {kind === 'align' && radios('projection', t`Projection`, [['auto', t`Auto`], ['perspective', t`Perspective`], ['reposition', t`Reposition`]])}
        {kind === 'blend' && <>
          {radios('method', t`Blend Method`, [['panorama', t`Panorama`], ['stack', t`Stack Images`]])}
          <label><input type="checkbox" name="seamless" defaultChecked /> <Trans>Seamless Tones and Colors</Trans></label>
        </>}
        {kind === 'photomerge' && <>
          <p><Trans>Aligns and merges the pixel layers of the active document.</Trans></p>
          <label><input type="checkbox" name="blend" defaultChecked /> <Trans>Blend Images Together</Trans></label>
        </>}
        {kind === 'hdr' && <>
          <p><Trans>Merges the {docCount} open documents, in tab order, as an exposure bracket.</Trans></p>
          <label><Trans>Stops Between Exposures</Trans> <FormNumber name="stops" min={0.25} max={4} step={0.25} defaultValue={2} required /></label>
        </>}
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

const num = (s: string) => (s.trim() === '' ? NaN : Number(s));
type NumberProps = ComponentProps<typeof NumberInput>;

// A form field that submits its plain number (hidden input), whatever decimal separator the UI shows.
function FormNumber({ name, defaultValue, ...rest }: Omit<NumberProps, 'value' | 'onValue' | 'name'> & { name: string; defaultValue: number }) {
  const [v, setV] = useState(defaultValue);
  return <><NumberInput {...rest} value={v} onValue={setV} /><input type="hidden" name={name} value={v} /></>;
}

// A number field over a string state; an empty field sets ''.
function TextNumber({ value, set, ...rest }: Omit<NumberProps, 'value' | 'onValue'> & { value: string; set: (s: string) => void }) {
  const n = num(value);
  return <NumberInput {...rest} value={Number.isNaN(n) ? '' : n} onValue={v => set(String(v))} onInput={e => { if (e.currentTarget.value.trim() === '') set(''); }} />;
}

// The form remounts after every close and on doc size changes, so each open starts from the document.
export function CanvasSizeDialog({ canvasSizeDialog, doc, run, fg, bg }: { canvasSizeDialog: DialogRef; doc: DocInfo | null; run: Run; fg: Rgb; bg: Rgb }) {
  const [opens, setOpens] = useState(0);
  return (
    <dialog ref={canvasSizeDialog} aria-label={t`Canvas Size`} onClose={() => setOpens(n => n + 1)}>
      {doc && <CanvasSizeForm key={`${opens}/${doc.width}x${doc.height}`} dialog={canvasSizeDialog} doc={doc} run={run} fg={fg} bg={bg} />}
    </dialog>
  );
}

function CanvasSizeForm({ dialog, doc, run, fg, bg }: { dialog: DialogRef; doc: DocInfo; run: Run; fg: Rgb; bg: Rgb }) {
  const [w, setW] = useState(String(doc.width)), [h, setH] = useState(String(doc.height));
  const [unit, setUnit] = useState<'px' | 'pct'>('px'), [relative, setRelative] = useState(false);
  const [anchor, setAnchor] = useState<[number, number]>([0, 0]), [color, setColor] = useState('background');
  const reset = (u: 'px' | 'pct', rel: boolean) => {
    setUnit(u); setRelative(rel);
    setW(rel ? '0' : u === 'px' ? String(doc.width) : '100'); setH(rel ? '0' : u === 'px' ? String(doc.height) : '100');
  };
  const target = (v: string, cur: number) => {
    const n = num(v);
    return Math.round(unit === 'px' ? (relative ? cur + n : n) : relative ? cur * (1 + n / 100) : (cur * n) / 100);
  };
  const tw = target(w, doc.width), th = target(h, doc.height);
  const curW = doc.width, curH = doc.height;
  const newSize = Number.isFinite(tw) && Number.isFinite(th) ? `${tw} × ${th} px` : '-';
  const valid = tw >= 1 && th >= 1 && (tw !== doc.width || th !== doc.height);
  const fills: Record<string, [number, number, number, number] | null> = {
    background: [...bg.map(v => v / 255), 1] as [number, number, number, number],
    foreground: [...fg.map(v => v / 255), 1] as [number, number, number, number],
    white: [1, 1, 1, 1], black: [0, 0, 0, 1], transparent: null,
  };
  return (
    <form onSubmit={e => {
      e.preventDefault();
      if (!valid) return;
      dialog.current?.close();
      run(t`Resizing…`, () => client.call('canvasSize', tw, th, anchor[0], anchor[1], fills[color]));
    }}>
      <h2><Trans>Canvas Size</Trans></h2>
      <div><Trans>Current size: {curW} × {curH} px</Trans></div>
      <label><Trans>Width</Trans> <TextNumber step="any" value={w} set={setW} required /></label>
      <label><Trans>Height</Trans> <TextNumber step="any" value={h} set={setH} required /></label>
      <label><Trans>Unit</Trans> <select value={unit} onChange={e => reset(e.currentTarget.value as 'px' | 'pct', relative)}>
        <option value="px">{t`Pixels`}</option><option value="pct">{t`Percent`}</option>
      </select></label>
      <label><input type="checkbox" checked={relative} onChange={e => reset(unit, e.currentTarget.checked)} /> <Trans>Relative</Trans></label>
      <div><Trans>New size: {newSize}</Trans></div>
      <div className="anchor-grid" role="group" aria-label={t`Anchor`}>
        {[-1, 0, 1].flatMap(y => [-1, 0, 1].map(x => (
          <button
            key={`${x}/${y}`} type="button" aria-pressed={anchor[0] === x && anchor[1] === y}
            aria-label={i18n._(ANCHOR_LABEL[y + 1][x + 1])} onClick={() => setAnchor([x, y])}
          />
        )))}
      </div>
      <label><Trans>Canvas extension color</Trans> <select value={color} onChange={e => setColor(e.currentTarget.value)}>
        <option value="background">{t`Background`}</option><option value="foreground">{t`Foreground`}</option><option value="white">{t`White`}</option>
        <option value="black">{t`Black`}</option><option value="transparent">{t`Transparent`}</option>
      </select></label>
      <div className="actions">
        <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
        <button type="submit" className="primary" disabled={!valid}><Trans>OK</Trans></button>
      </div>
    </form>
  );
}

export function ImageSizeDialog({ imageSizeDialog, doc, run }: { imageSizeDialog: DialogRef; doc: DocInfo | null; run: Run }) {
  const [opens, setOpens] = useState(0);
  return (
    <dialog ref={imageSizeDialog} aria-label={t`Image Size`} onClose={() => setOpens(n => n + 1)}>
      {doc && <ImageSizeForm key={`${opens}/${doc.width}x${doc.height}/${doc.resolution}`} dialog={imageSizeDialog} doc={doc} run={run} />}
    </dialog>
  );
}

function ImageSizeForm({ dialog, doc, run }: { dialog: DialogRef; doc: DocInfo; run: Run }) {
  const [w, setW] = useState(String(doc.width)), [h, setH] = useState(String(doc.height)), [res, setRes] = useState(String(doc.resolution));
  const [constrain, setConstrain] = useState(true), [resample, setResample] = useState(true);
  const [method, setMethod] = useState('auto'), [scaleStyles, setScaleStyles] = useState(true);
  const tw = resample ? Math.round(num(w)) : doc.width, th = resample ? Math.round(num(h)) : doc.height, r = num(res);
  const valid = tw >= 1 && th >= 1 && r > 0 && (tw !== doc.width || th !== doc.height || r !== doc.resolution);
  const sizeText = tw >= 1 && th >= 1 ? `${tw} × ${th} px` : '-';
  const shrink = tw <= doc.width && th <= doc.height, grow = tw >= doc.width && th >= doc.height;
  const interp = method !== 'auto' ? method : shrink && !grow ? 'bicubicSharper' : grow && !shrink ? 'bicubicSmoother' : 'bicubic';
  const link = (v: string, axis: 'w' | 'h') => {
    const n = num(v);
    (axis === 'w' ? setW : setH)(v);
    if (constrain && Number.isFinite(n)) (axis === 'w' ? setH : setW)(String(Math.max(1, Math.round(axis === 'w' ? (n * doc.height) / doc.width : (n * doc.width) / doc.height))));
  };
  return (
    <form onSubmit={e => {
      e.preventDefault();
      if (!valid) return;
      dialog.current?.close();
      run(t`Resizing…`, () => client.call('imageSize', tw, th, interp, scaleStyles, r));
    }}>
      <h2><Trans>Image Size</Trans></h2>
      <label><Trans>Width</Trans> <TextNumber min={1} step={1} value={resample ? w : String(doc.width)} disabled={!resample} set={v => link(v, 'w')} required /> px</label>
      <label><Trans>Height</Trans> <TextNumber min={1} step={1} value={resample ? h : String(doc.height)} disabled={!resample} set={v => link(v, 'h')} required /> px</label>
      <label><Trans>Resolution</Trans> <TextNumber min={1} step="any" value={res} set={setRes} required /> ppi</label>
      <label><input type="checkbox" checked={constrain} onChange={e => setConstrain(e.currentTarget.checked)} /> <Trans>Constrain proportions</Trans></label>
      <label><input type="checkbox" checked={resample} onChange={e => { setResample(e.currentTarget.checked); setW(String(doc.width)); setH(String(doc.height)); }} /> <Trans>Resample</Trans></label>
      <label><Trans>Method</Trans> <select value={method} disabled={!resample} onChange={e => setMethod(e.currentTarget.value)}>
        <option value="auto">{t`Automatic`}</option><option value="bicubicSmoother">{t`Bicubic Smoother`}</option><option value="bicubicSharper">{t`Bicubic Sharper`}</option>
        <option value="bicubic">{t`Bicubic`}</option><option value="bilinear">{t`Bilinear`}</option><option value="nearest">{t`Nearest Neighbor`}</option><option value="lanczos3">{t`Lanczos 3`}</option>
      </select></label>
      <label><input type="checkbox" checked={scaleStyles} onChange={e => setScaleStyles(e.currentTarget.checked)} /> <Trans>Scale Styles</Trans></label>
      <div><Trans>Image size: {sizeText}</Trans></div>
      <div className="actions">
        <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
        <button type="submit" className="primary" disabled={!valid}><Trans>OK</Trans></button>
      </div>
    </form>
  );
}

export function GlobalLightDialog({ globalLightDialog, doc, run }: { globalLightDialog: DialogRef; doc: DocInfo | null; run: Run }) {
  return (
    <dialog ref={globalLightDialog}>
      <form key={doc ? `${doc.globalLight.angle}/${doc.globalLight.altitude}` : ''} onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        globalLightDialog.current?.close();
        run(null, () => client.call('setGlobalLight', { angle: Number(f.get('angle')), altitude: Number(f.get('altitude')) }));
      }}>
        <h2><Trans>Global Light</Trans></h2>
        <label><Trans>Angle</Trans> <FormNumber name="angle" min={-360} max={360} step="any" defaultValue={doc?.globalLight.angle ?? 120} required /> °</label>
        <label><Trans>Altitude</Trans> <FormNumber name="altitude" min={0} max={90} step="any" defaultValue={doc?.globalLight.altitude ?? 30} required /> °</label>
        <div className="actions">
          <button type="button" onClick={() => globalLightDialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export function FilterBlendDialog({ filterBlendDialog, setFilterBlend, filterBlend, run, filters }: {
  filterBlendDialog: DialogRef; setFilterBlend: SetState<FilterBlend | null>; filterBlend: FilterBlend | null; run: Run; filters: SmartFilterInfo[];
}) {
  return (
    <dialog ref={filterBlendDialog} onClose={() => setFilterBlend(null)}>
      {filterBlend && (
        <form onSubmit={e => {
          e.preventDefault();
          const f = filterBlend;
          filterBlendDialog.current?.close();
          run(null, () => client.call('setSmartFilter', f.id, f.fid, { blend: f.blend, opacity: f.opacity / 100 }, 'Blending Options'));
        }}>
          <h2><Trans>Blending Options</Trans></h2>
          <label><Trans>Filter</Trans> <select value={filterBlend.fid} onChange={e => {
            const f = filters.find(x => x.id === Number(e.currentTarget.value));
            if (f) setFilterBlend({ ...filterBlend, fid: f.id, blend: f.blend, opacity: Math.round(f.opacity * 100) });
          }}>
            {[...filters].reverse().map(f => <option key={f.id} value={f.id}>{engineLabel(filterLabel(f.filter))}</option>)}
          </select></label>
          <label><Trans>Mode</Trans> <select value={filterBlend.blend} onChange={e => setFilterBlend({ ...filterBlend, blend: e.currentTarget.value })}>
            {BLEND_MODES.map(m => <option key={m} value={m}>{choiceLabel(m)}</option>)}
          </select></label>
          <label><Trans>Opacity</Trans> <NumberInput min={0} max={100} step={1} value={filterBlend.opacity}
            onValue={v => setFilterBlend({ ...filterBlend, opacity: Math.min(100, Math.max(0, v)) })} /> %</label>
          <div className="actions">
            <button type="button" onClick={() => filterBlendDialog.current?.close()}><Trans>Cancel</Trans></button>
            <button type="submit" className="primary"><Trans>OK</Trans></button>
          </div>
        </form>
      )}
    </dialog>
  );
}

export function ScaleEffectsDialog({ scaleEffectsDialog, node, run }: { scaleEffectsDialog: DialogRef; node: LayerNode | undefined; run: Run }) {
  return (
    <dialog ref={scaleEffectsDialog}>
      <form key={node?.style ? `${node.id}/${node.style.scale}` : ''} onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        scaleEffectsDialog.current?.close();
        if (node) run(null, () => client.call('scaleEffects', node.id, Number(f.get('scale'))));
      }}>
        <h2><Trans>Scale Layer Effects</Trans></h2>
        <label><Trans>Scale</Trans> <FormNumber name="scale" min={1} max={1000} step={1} defaultValue={Math.round((node?.style?.scale ?? 1) * 100)} required /> %</label>
        <div className="actions">
          <button type="button" onClick={() => scaleEffectsDialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

// Layer > Lock Layers: prefilled from the active layer, applied to every selected layer.
export function LockLayersDialog({ lockLayersDialog, node, ids, run }: { lockLayersDialog: DialogRef; node: LayerNode | undefined; ids: number[]; run: Run }) {
  const l = node?.locks;
  return (
    <dialog ref={lockLayersDialog}>
      <form key={l ? `${node.id}/${l.transparency}/${l.pixels}/${l.position}` : ''} onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        lockLayersDialog.current?.close();
        const locks = { transparency: f.has('transparency'), pixels: f.has('pixels'), position: f.has('position') };
        if (ids.length) run(null, () => client.call('setLocks', ids, locks, 'Lock Layers'));
      }}>
        <h2><Trans>Lock Layers</Trans></h2>
        <label><input name="transparency" type="checkbox" defaultChecked={l?.transparency} /> <Trans>Transparency</Trans></label>
        <label><input name="pixels" type="checkbox" defaultChecked={l?.pixels} /> <Trans>Pixels</Trans></label>
        <label><input name="position" type="checkbox" defaultChecked={l?.position} /> <Trans>Position</Trans></label>
        <div className="actions">
          <button type="button" onClick={() => lockLayersDialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export function RotateDialog({ rotateDialog, run }: { rotateDialog: DialogRef; run: Run }) {
  return (
    <dialog ref={rotateDialog}>
      <form onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        rotateDialog.current?.close();
        run('Rotating…', () => client.call('rotateCanvasArbitrary', Number(f.get('angle')), String(f.get('interp')) as 'nearest' | 'bilinear' | 'bicubic'));
      }}>
        <h2><Trans>Rotate Canvas</Trans></h2>
        <label><Trans>Angle</Trans> <FormNumber name="angle" min={-360} max={360} step="any" defaultValue={0} required /> ° <Trans>clockwise</Trans></label>
        <label><Trans>Interpolation</Trans> <select name="interp" defaultValue="bicubic">
          <option value="nearest">{t`Nearest Neighbor`}</option><option value="bilinear">{t`Bilinear`}</option><option value="bicubic">{t`Bicubic`}</option>
        </select></label>
        <div className="actions">
          <button type="button" onClick={() => rotateDialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export function ColorRangeDialog({ colorRangeDialog, setColorRangeOpen, active, colorRangeSamples, closeColorRange, run, colorRange, setColorRange, colorRangeCanvas, colorRangePreview, setColorRangeSamples }: {
  colorRangeDialog: DialogRef; setColorRangeOpen: SetState<boolean>; active: Active | null; colorRangeSamples: ColorRangeSample[];
  closeColorRange: () => void; run: Run; colorRange: ColorRange; setColorRange: SetState<ColorRange>; colorRangeCanvas: RefObject<HTMLCanvasElement | null>;
  colorRangePreview: ColorRangePreview | null; setColorRangeSamples: SetState<ColorRangeSample[]>;
}) {
  return (
    <dialog ref={colorRangeDialog} onClose={() => setColorRangeOpen(false)}>
      <form onSubmit={e => {
        e.preventDefault();
        if (!active) return;
        const samplesFlat = colorRangeSamples.flatMap(s => s.rgb);
        const centerFlat = colorRangeSamples.flatMap(s => [s.x, s.y]);
        closeColorRange();
        run(null, () => client.call('colorRange', active.id, false, colorRange.preset, samplesFlat, colorRange.fuzziness, colorRange.range, centerFlat, colorRange.localized, colorRange.invert));
      }}>
        <h2><Trans>Color Range</Trans></h2>
        <label><Trans>Select</Trans> <select value={colorRange.preset} onChange={e => setColorRange({ ...colorRange, preset: e.target.value })}>
          {COLOR_RANGE_PRESETS.map(p => <option key={p} value={p}>{i18n._(COLOR_RANGE_LABEL[p])}</option>)}
        </select></label>
        <canvas
          ref={colorRangeCanvas} className="color-range-preview"
          onClick={e => {
            if (!colorRangePreview) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const cx = Math.round((e.clientX - rect.left) * (colorRangePreview.w / rect.width));
            const cy = Math.round((e.clientY - rect.top) * (colorRangePreview.h / rect.height));
            const x = cx * (1 << colorRangePreview.level), y = cy * (1 << colorRangePreview.level);
            if (e.altKey) {
              setColorRangeSamples(s => {
                if (!s.length) return s;
                let best = 0, bestD = Infinity;
                s.forEach((p, i) => { const d = Math.hypot(p.x - x, p.y - y); if (d < bestD) { bestD = d; best = i; } });
                return s.filter((_, i) => i !== best);
              });
              return;
            }
            client.call('sample', x, y, 1, null).then(([r, g, b]) => {
              setColorRangeSamples(s => (e.shiftKey ? [...s, { rgb: [r, g, b], x, y }] : [{ rgb: [r, g, b], x, y }]));
            });
          }}
        />
        <label><Trans>Fuzziness</Trans> <input type="range" min={0} max={200} value={colorRange.fuzziness} onChange={e => setColorRange({ ...colorRange, fuzziness: Number(e.target.value) })} /> {colorRange.fuzziness}</label>
        <label><Trans>Range</Trans> <input type="range" min={0} max={100} value={colorRange.range} onChange={e => setColorRange({ ...colorRange, range: Number(e.target.value) })} /> {colorRange.range}%</label>
        <label><input type="checkbox" checked={colorRange.localized} onChange={e => setColorRange({ ...colorRange, localized: e.target.checked })} /> <Trans>Localized color clusters</Trans></label>
        <label><input type="checkbox" checked={colorRange.invert} onChange={e => setColorRange({ ...colorRange, invert: e.target.checked })} /> <Trans>Invert</Trans></label>
        <div className="actions">
          <button type="button" onClick={closeColorRange}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary" disabled={colorRange.preset === 'sampled' && !colorRangeSamples.length}><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

// docs/M4.md section 12: position is relative to the canvas, or to the targeted artboard's origin.
export function NewGuideDialog({ newGuideDialog, run, doc, rulerUnit }: { newGuideDialog: DialogRef; run: Run; doc: DocInfo | null; rulerUnit: RulerUnit }) {
  const artboards = doc?.layers.filter(n => n.artboard) ?? [];
  return (
    <dialog ref={newGuideDialog}>
      <form onSubmit={e => {
        e.preventDefault();
        if (!doc) return;
        const f = new FormData(e.currentTarget);
        const orientation = String(f.get('orientation'));
        const unit = String(f.get('unit')) as RulerUnit;
        const value = Number(f.get('position'));
        const board = artboards.find(n => n.id === Number(f.get('target')))?.artboard;
        const h = orientation === 'horizontal';
        const size = board ? (h ? board.rect[3] - board.rect[1] : board.rect[2] - board.rect[0]) : h ? doc.height : doc.width;
        const origin = board ? board.rect[h ? 1 : 0] : 0;
        newGuideDialog.current?.close();
        run(null, () => client.call('addGuide', h ? 'y' : 'x', origin + unitToPx(value, unit, doc.resolution, size), board ? Number(f.get('target')) : 0));
      }}>
        <h2><Trans>New Guide</Trans></h2>
        <fieldset className="stroke-location">
          <legend><Trans>Orientation</Trans></legend>
          <label><input type="radio" name="orientation" value="horizontal" defaultChecked /> <Trans>Horizontal</Trans></label>
          <label><input type="radio" name="orientation" value="vertical" /> <Trans>Vertical</Trans></label>
        </fieldset>
        <label><Trans>Position</Trans> <FormNumber name="position" step="any" defaultValue={0} required />
          <select name="unit" defaultValue={rulerUnit}>{RULER_UNITS.map(u => <option key={u} value={u}>{u}</option>)}</select>
        </label>
        {artboards.length > 0 && (
          <label><Trans>Target</Trans> <select name="target" defaultValue={0}>
            <option value={0}>{t`Canvas`}</option>
            {artboards.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select></label>
        )}
        <div className="actions">
          <button type="button" onClick={() => newGuideDialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

type CursorPrefs = Pick<Preferences, 'paintingCursor' | 'brushOutline' | 'brushCrosshair' | 'crosshairWhilePainting' | 'brushLeash' | 'brushLeashColor' | 'otherCursor' | 'brushPreviewColor'>;

// Edit > Preferences > Cursors, laid out as in Photoshop.
export function CursorPrefsDialog({ dialog, prefs, save }: { dialog: DialogRef; prefs: Preferences; save: (p: CursorPrefs) => void }) {
  return (
    <dialog ref={dialog}>
      <form onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        dialog.current?.close();
        save({
          paintingCursor: String(f.get('painting')) as PaintingCursor, brushOutline: String(f.get('outline')) as BrushOutline,
          brushCrosshair: f.get('crosshair') === 'on', crosshairWhilePainting: f.get('whilePainting') === 'on',
          brushLeash: f.get('leash') === 'on', brushLeashColor: String(f.get('leashColor')),
          otherCursor: f.get('other') === 'precise' ? 'precise' : 'standard', brushPreviewColor: String(f.get('previewColor')),
        });
      }}>
        <h2><Trans>Cursors</Trans></h2>
        <fieldset>
          <legend><Trans>Painting Cursors</Trans></legend>
          {([['standard', t`Standard`], ['precise', t`Precise`], ['normal', t`Normal Brush Tip`], ['full', t`Full Size Brush Tip`]] as [PaintingCursor, string][]).map(([v, label]) => (
            <label key={v}><input type="radio" name="painting" value={v} defaultChecked={prefs.paintingCursor === v} /> {label}</label>
          ))}
          <label><Trans>Brush Tip Outline</Trans> <select name="outline" defaultValue={prefs.brushOutline}>
            {([['thin', t`Thin`], ['normal', t`Normal`], ['bold', t`Bold`], ['extraBold', t`Extra Bold`]] as [BrushOutline, string][]).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select></label>
          <label><input type="checkbox" name="crosshair" defaultChecked={prefs.brushCrosshair} /> <Trans>Show Crosshair in Brush Tip</Trans></label>
          <label><input type="checkbox" name="whilePainting" defaultChecked={prefs.crosshairWhilePainting} /> <Trans>Show Only Crosshair While Painting</Trans></label>
          <label><input type="checkbox" name="leash" defaultChecked={prefs.brushLeash} /> <Trans>Show Brush Leash While Smoothing</Trans></label>
          <label><Trans>Brush Leash Color</Trans> <input type="color" name="leashColor" defaultValue={prefs.brushLeashColor} /></label>
        </fieldset>
        <fieldset>
          <legend><Trans>Other Cursors</Trans></legend>
          <label><input type="radio" name="other" value="standard" defaultChecked={prefs.otherCursor === 'standard'} /> <Trans>Standard</Trans></label>
          <label><input type="radio" name="other" value="precise" defaultChecked={prefs.otherCursor === 'precise'} /> <Trans>Precise</Trans></label>
        </fieldset>
        <fieldset>
          <legend><Trans>Brush Preview</Trans></legend>
          <label><Trans>Color</Trans> <input type="color" name="previewColor" defaultValue={prefs.brushPreviewColor} /></label>
        </fieldset>
        <p className="hint"><Trans>Caps Lock switches between the brush tip and the crosshair, and between the tool icon and the crosshair.</Trans></p>
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export function NewGuideLayoutDialog({ newGuideLayoutDialog, run, doc }: { newGuideLayoutDialog: DialogRef; run: Run; doc: DocInfo | null }) {
  return (
    <dialog ref={newGuideLayoutDialog}>
      <form onSubmit={e => {
        e.preventDefault();
        if (!doc) return;
        const f = new FormData(e.currentTarget);
        const on = (k: string) => f.get(k) === 'on';
        const num = (k: string) => Number(f.get(k));
        const margins = on('margins') ? [num('top'), num('left'), num('bottom'), num('right')] as [number, number, number, number] : null;
        newGuideLayoutDialog.current?.close();
        run(null, () => client.call('newGuideLayout', {
          rect: [0, 0, doc.width, doc.height], columns: num('columns'), columnGutter: num('columnGutter'),
          rows: num('rows'), rowGutter: num('rowGutter'), margins, clearExisting: on('clearExisting'), artboard: 0,
        }));
      }}>
        <h2><Trans>New Guide Layout</Trans></h2>
        <label><Trans>Columns</Trans> <FormNumber name="columns" min={0} max={100} defaultValue={3} required /></label>
        <label><Trans>Column Gutter</Trans> <FormNumber name="columnGutter" min={0} max={500} defaultValue={20} required /> px</label>
        <label><Trans>Rows</Trans> <FormNumber name="rows" min={0} max={100} defaultValue={0} required /></label>
        <label><Trans>Row Gutter</Trans> <FormNumber name="rowGutter" min={0} max={500} defaultValue={20} required /> px</label>
        <fieldset className="stroke-location trim-group">
          <legend><Trans>Margins</Trans></legend>
          <label><input name="margins" type="checkbox" /> <Trans>Use margins</Trans></label>
          <label><Trans>Top</Trans> <FormNumber name="top" min={0} max={2000} defaultValue={0} /></label>
          <label><Trans>Left</Trans> <FormNumber name="left" min={0} max={2000} defaultValue={0} /></label>
          <label><Trans>Bottom</Trans> <FormNumber name="bottom" min={0} max={2000} defaultValue={0} /></label>
          <label><Trans>Right</Trans> <FormNumber name="right" min={0} max={2000} defaultValue={0} /></label>
        </fieldset>
        <label><input name="clearExisting" type="checkbox" defaultChecked /> <Trans>Clear existing guides</Trans></label>
        <div className="actions">
          <button type="button" onClick={() => newGuideLayoutDialog.current?.close()}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

export type ArtboardMode = 'new' | 'fromGroup' | 'fromLayers';

// Layer > New > Artboard / Artboard from Group / Artboard from Layers (docs/M4.md section 11).
// `selected` is the active artboard (placement and default size); `layer` the active layer.
export function ArtboardDialog({ artboardDialog, mode, run, doc, selected, layer }: {
  artboardDialog: DialogRef; mode: ArtboardMode; run: Run; doc: DocInfo | null; selected: LayerNode | null; layer: number | null;
}) {
  const count = doc?.layers.filter(n => n.artboard).length ?? 0;
  const r = selected?.artboard?.rect;
  const size = r ? [r[2] - r[0], r[3] - r[1]] : [doc?.width ?? 0, doc?.height ?? 0];
  const close = () => artboardDialog.current?.close();
  return (
    <dialog ref={artboardDialog}>
      <form key={`${mode}-${count}-${selected?.id}-${size.join('x')}`} onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const name = String(f.get('name')).trim();
        close();
        if (mode === 'new') {
          const bg = String(f.get('background')) as 'white' | 'black' | 'transparent';
          run(null, () => client.call('newArtboard', name || `Artboard ${count + 1}`, Number(f.get('w')), Number(f.get('h')), { type: bg }, selected?.id ?? 0), selectCreated);
        } else if (layer != null && mode === 'fromGroup') {
          run(null, () => client.call('artboardFromGroup', layer, name), selectCreated);
        } else if (layer != null) {
          run(null, () => client.call('artboardFromLayers', [layer], name), selectCreated);
        }
      }}>
        <h2>{mode === 'new' ? t`New Artboard` : mode === 'fromGroup' ? t`Artboard from Group` : t`Artboard from Layers`}</h2>
        <label><Trans>Name</Trans> <input name="name" defaultValue={mode === 'new' ? `Artboard ${count + 1}` : 'Artboard 1'} /></label>
        {mode === 'new' && (
          <>
            <label><Trans>Width</Trans> <FormNumber name="w" min={1} max={300000} step={1} defaultValue={size[0]} required /> px</label>
            <label><Trans>Height</Trans> <FormNumber name="h" min={1} max={300000} step={1} defaultValue={size[1]} required /> px</label>
            <label><Trans>Background</Trans> <select name="background" defaultValue="white">
              <option value="white">{t`White`}</option><option value="black">{t`Black`}</option><option value="transparent">{t`Transparent`}</option>
            </select></label>
          </>
        )}
        <div className="actions">
          <button type="button" onClick={close}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary"><Trans>OK</Trans></button>
        </div>
      </form>
    </dialog>
  );
}
