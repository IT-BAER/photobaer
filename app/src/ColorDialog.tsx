// Edit > Color Settings, Assign Profile and Convert to Profile, View > Proof Setup > Custom and 32-bit
// Preview Options, plus the Profile Mismatch and Missing Profile questions asked while opening a file.
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { client } from './client.ts';
import type { DocInfo } from './engine.worker.ts';
import type { IccProfile } from './worker/types.ts';
import {
  CMYK_SPACES, COLOR_PRESETS, GRAY_SPACES, INTENTS, POLICIES, RGB_SPACES, loadColorSettings, matchPreset, saveColorSettings,
  type ColorSettings, type Intent, type OpenAction, type Policy,
} from './app/colorSettings.ts';
import { DEFAULT_VIEW, HDR_EXPOSURE, HDR_GAMMA, sanitizeHdr, type HdrMethod, type HdrPreview } from './app/proof.ts';

export type ColorDialogKind = 'settings' | 'assign' | 'convert' | 'proof' | 'hdr';
export interface ColorDialogHandle {
  open(kind: ColorDialogKind): void;
  // Profile Mismatch (embedded set) or Missing Profile for `file`; null when cancelled.
  ask(file: string, embedded: string | null): Promise<OpenAction | null>;
}

type Kind = ColorDialogKind | 'mismatch' | 'missing';
const NAMES: Record<Kind, string> = {
  settings: 'Color Settings', assign: 'Assign Profile', convert: 'Convert to Profile', mismatch: 'Embedded Profile Mismatch', missing: 'Missing Profile',
  proof: 'Customize Proof Condition', hdr: '32-bit Preview Options',
};
const HDR_METHODS: [HdrMethod, string][] = [['exposureAndGamma', 'Exposure and Gamma'], ['highlightCompression', 'Highlight Compression']];

export function ColorDialog({ ref, doc, show, setError }: {
  ref: Ref<ColorDialogHandle>; doc: DocInfo | null; show: (d: DocInfo | null) => void; setError: (msg: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const answer = useRef<((a: OpenAction | null) => void) | null>(null);
  const [kind, setKind] = useState<Kind | null>(null);
  const [settings, setSettings] = useState(loadColorSettings);
  const [draft, setDraft] = useState(settings);
  const [profiles, setProfiles] = useState<IccProfile[]>([]);
  const [choice, setChoice] = useState<string>('working');
  const [profile, setProfile] = useState('');
  const [opts, setOpts] = useState({ intent: settings.intent as Intent, bpc: settings.bpc, dither: settings.dither, flatten: false });
  const [question, setQuestion] = useState({ file: '', embedded: '' });
  const [proof, setProof] = useState({ preserveNumbers: false, simulatePaper: false, simulateBlackInk: false, preview: true });
  const [hdr, setHdr] = useState<HdrPreview>(DEFAULT_VIEW.hdr);
  const hdrBefore = useRef<HdrPreview | null>(null);

  useEffect(() => { client.call('setColorSettings', settings).then(d => { if (d) show(d); }, e => setError((e as Error).message)); }, [settings]);

  const gray = !!doc?.gray;
  const cmykDoc = doc?.mode?.kind === 'cmyk';
  const working = cmykDoc ? settings.cmyk : gray ? settings.gray : settings.rgb;
  const refresh = () => client.call('iccProfiles').then(setProfiles, e => setError((e as Error).message));

  useImperativeHandle(ref, () => ({
    open(k) {
      setKind(k);
      setDraft(settings);
      setChoice(doc?.profile ? (doc.profile.name === working ? 'working' : 'profile') : k === 'assign' ? 'none' : 'working');
      setProfile(k === 'convert' ? working : doc?.profile?.name ?? working);
      setOpts({ intent: settings.intent, bpc: settings.bpc, dither: settings.dither, flatten: false });
      const v = doc?.view ?? DEFAULT_VIEW;
      if (k === 'proof') {
        setProfile(v.setup.id === 'custom' && v.setup.profile ? v.setup.profile : settings.cmyk);
        setOpts({ intent: v.setup.intent, bpc: v.setup.bpc, dither: false, flatten: false });
        setProof({ preserveNumbers: v.setup.preserveNumbers, simulatePaper: v.setup.simulatePaper, simulateBlackInk: v.setup.simulateBlackInk, preview: true });
      }
      if (k === 'hdr') { setHdr(v.hdr); hdrBefore.current = v.hdr; }
      if (k !== 'settings' && k !== 'hdr') void refresh();
      dialog.current?.showModal();
    },
    ask(file, embedded) {
      answer.current?.(null);
      setKind(embedded ? 'mismatch' : 'missing');
      setQuestion({ file, embedded: embedded ?? '' });
      setChoice(embedded ? ({ off: 'discard', preserveEmbedded: 'keep', convertToWorking: 'convert' } as const)[settings.rgbPolicy] : 'leave');
      dialog.current?.showModal();
      return new Promise(r => { answer.current = r; });
    },
  }), [doc, settings, working]);

  function close(a: OpenAction | null) {
    if (hdrBefore.current) { previewHdr(hdrBefore.current); hdrBefore.current = null; }
    const r = answer.current;
    answer.current = null;
    dialog.current?.close();
    r?.(a);
  }

  async function load() {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.icc,.icm' });
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const p = await client.call('loadProfile', new Uint8Array(await f.arrayBuffer()));
        await refresh();
        setProfile(p.name);
        setChoice('profile');
      } catch (e) {
        setError(`Could not load ${f.name}: ${(e as Error).message}`);
      }
    };
    input.click();
  }

  // 32-bit Preview Options apply while the dialog is open; Cancel puts the old ones back.
  function previewHdr(h: HdrPreview) {
    setHdr(h);
    client.call('setView', { hdr: h }).then(show, e => setError((e as Error).message));
  }

  function ok() {
    if (kind === 'mismatch' || kind === 'missing') return close(choice as OpenAction);
    hdrBefore.current = null;
    dialog.current?.close();
    if (kind === 'settings') { saveColorSettings(draft); setSettings(draft); return; }
    if (kind === 'hdr') return;
    if (kind === 'proof') {
      const setup = {
        id: 'custom' as const, profile, intent: opts.intent, bpc: opts.bpc, preserveNumbers: proof.preserveNumbers && sameKind,
        simulatePaper: proof.simulatePaper, simulateBlackInk: proof.simulateBlackInk || proof.simulatePaper,
      };
      client.call('setView', { setup, proofColors: proof.preview }).then(show, e => setError((e as Error).message));
      return;
    }
    const run = kind === 'assign'
      ? client.call('assignProfile', choice === 'none' ? null : choice === 'working' ? working : profile)
      : client.call('convertToProfile', profile, { intent: opts.intent, blackPointCompensation: opts.bpc, dither: opts.dither, flatten: opts.flatten });
    run.then(show, e => setError((e as Error).message));
  }

  const own = profiles.filter(p => p.space === (cmykDoc ? 'cmyk' : gray ? 'gray' : 'rgb'));
  // Preserve Numbers needs a device with the document's channels.
  const sameKind = profiles.find(p => p.name === profile)?.space === (gray ? 'gray' : 'rgb');
  const select = (label: string, value: string, set: (v: string) => void, list: string[], disabled = false) => (
    <select aria-label={label} value={value} disabled={disabled} onChange={e => set(e.currentTarget.value)}>
      {list.map(n => <option key={n} value={n}>{n}</option>)}
    </select>
  );
  const radio = (value: string, label: ReactNode) => (
    <label className="radio"><input type="radio" name="color-choice" checked={choice === value} onChange={() => setChoice(value)} /> {label}</label>
  );
  const conversion = (o: { intent: Intent; bpc: boolean; dither: boolean }, set: (p: Partial<typeof o>) => void) => <>
    <label>Intent <select aria-label="Intent" value={o.intent} onChange={e => set({ intent: e.currentTarget.value as Intent })}>
      {INTENTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select></label>
    <label className="check"><input type="checkbox" checked={o.bpc} onChange={e => set({ bpc: e.currentTarget.checked })} /> Use Black Point Compensation</label>
    <label className="check"><input type="checkbox" checked={o.dither} onChange={e => set({ dither: e.currentTarget.checked })} /> Use Dither (8-bit/channel images)</label>
  </>;
  const preset = matchPreset(draft);
  const policy = (label: string, value: Policy, set: (p: Policy) => void, space: string) => (
    <label>{label} <select aria-label={`${label} policy`} value={value} onChange={e => set(e.currentTarget.value as Policy)}>
      {POLICIES.map(([v, l]) => <option key={v} value={v}>{l.replace('RGB', space)}</option>)}
    </select></label>
  );

  return (
    <dialog ref={dialog} className="mode-dialog color-dialog" aria-label={kind ? NAMES[kind] : 'Color'} onClose={() => { setKind(null); if (answer.current || hdrBefore.current) close(null); }}>
      {kind && (
        <form onSubmit={e => { e.preventDefault(); ok(); }}>
          <h2>{NAMES[kind]}</h2>
          {kind === 'settings' && <>
            <label>Settings <select aria-label="Settings" value={preset} onChange={e => {
              const p = COLOR_PRESETS.find(x => x.name === e.currentTarget.value);
              if (p) setDraft(p.settings);
            }}>
              {preset === 'Custom' && <option value="Custom">Custom</option>}
              {COLOR_PRESETS.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select></label>
            <fieldset><legend>Working Spaces</legend>
              <label>RGB {select('RGB working space', draft.rgb, v => setDraft({ ...draft, rgb: v }), RGB_SPACES)}</label>
              <label>CMYK {select('CMYK working space', draft.cmyk, v => setDraft({ ...draft, cmyk: v }), CMYK_SPACES)}</label>
              <label>Gray {select('Gray working space', draft.gray, v => setDraft({ ...draft, gray: v }), GRAY_SPACES)}</label>
            </fieldset>
            <fieldset><legend>Color Management Policies</legend>
              {policy('RGB', draft.rgbPolicy, p => setDraft({ ...draft, rgbPolicy: p }), 'RGB')}
              {policy('Gray', draft.grayPolicy, p => setDraft({ ...draft, grayPolicy: p }), 'Gray')}
              <label className="check"><input type="checkbox" checked={draft.askWhenOpening} onChange={e => setDraft({ ...draft, askWhenOpening: e.currentTarget.checked })} /> Profile Mismatches: Ask When Opening</label>
              <label className="check"><input type="checkbox" checked={draft.askWhenMissing} onChange={e => setDraft({ ...draft, askWhenMissing: e.currentTarget.checked })} /> Missing Profiles: Ask When Opening</label>
            </fieldset>
            <fieldset><legend>Conversion Options</legend>
              {conversion(draft, p => setDraft({ ...draft, ...p }))}
            </fieldset>
            <p className="hint">{COLOR_PRESETS.find(p => p.name === preset)?.description ?? 'Custom settings.'}</p>
          </>}
          {kind === 'assign' && <>
            {radio('none', "Don't Color Manage This Document")}
            {radio('working', `Working ${cmykDoc ? 'CMYK' : gray ? 'Gray' : 'RGB'}: ${working}`)}
            <div className="row">
              {radio('profile', 'Profile:')}
              {select('Profile', profile, setProfile, own.map(p => p.name), choice !== 'profile')}
              <button type="button" onClick={load}>Load…</button>
            </div>
          </>}
          {kind === 'convert' && <>
            <fieldset><legend>Source Space</legend>
              <p>Profile: {cmykDoc ? `${doc?.profile?.name ?? 'Untagged'} (stored as sRGB IEC61966-2.1)` : doc?.profile?.name ?? `Untagged (treated as ${gray ? 'Gray Gamma 2.2' : 'sRGB IEC61966-2.1'})`}</p>
            </fieldset>
            <fieldset><legend>Destination Space</legend>
              <div className="row">
                <label>Profile {select('Destination profile', profile, setProfile, profiles.map(p => p.name))}</label>
                <button type="button" onClick={load}>Load…</button>
              </div>
            </fieldset>
            <fieldset><legend>Conversion Options</legend>
              {conversion(opts, p => setOpts({ ...opts, ...p }))}
              <label className="check"><input type="checkbox" checked={opts.flatten} onChange={e => setOpts({ ...opts, flatten: e.currentTarget.checked })} /> Flatten Image to Preserve Appearance</label>
            </fieldset>
          </>}
          {kind === 'proof' && <>
            <div className="row">
              <label>Device to Simulate {select('Device to Simulate', profile, setProfile, profiles.map(p => p.name))}</label>
              <button type="button" onClick={load}>Load…</button>
            </div>
            <label className="check"><input type="checkbox" checked={proof.preserveNumbers && sameKind} disabled={!sameKind}
              onChange={e => setProof({ ...proof, preserveNumbers: e.currentTarget.checked })} /> Preserve Numbers</label>
            <label>Rendering Intent <select aria-label="Rendering Intent" value={opts.intent} disabled={proof.preserveNumbers && sameKind}
              onChange={e => setOpts({ ...opts, intent: e.currentTarget.value as Intent })}>
              {INTENTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
            <label className="check"><input type="checkbox" checked={opts.bpc} onChange={e => setOpts({ ...opts, bpc: e.currentTarget.checked })} /> Black Point Compensation</label>
            <fieldset><legend>Display Options (On-Screen)</legend>
              <label className="check"><input type="checkbox" checked={proof.simulatePaper} onChange={e => setProof({ ...proof, simulatePaper: e.currentTarget.checked })} /> Simulate Paper Color</label>
              <label className="check"><input type="checkbox" checked={proof.simulateBlackInk || proof.simulatePaper} disabled={proof.simulatePaper}
                onChange={e => setProof({ ...proof, simulateBlackInk: e.currentTarget.checked })} /> Simulate Black Ink</label>
            </fieldset>
            <label className="check"><input type="checkbox" checked={proof.preview} onChange={e => setProof({ ...proof, preview: e.currentTarget.checked })} /> Preview</label>
          </>}
          {kind === 'hdr' && <>
            <label>Method <select aria-label="Method" value={hdr.method} onChange={e => previewHdr({ ...hdr, method: e.currentTarget.value as HdrMethod })}>
              {HDR_METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
            {hdr.method === 'exposureAndGamma' && <>
              <label>Exposure <input type="range" aria-label="Exposure" min={-HDR_EXPOSURE} max={HDR_EXPOSURE} step={0.01} value={hdr.exposure}
                onChange={e => previewHdr(sanitizeHdr({ ...hdr, exposure: Number(e.currentTarget.value) }))} />
                <input type="number" aria-label="Exposure value" min={-HDR_EXPOSURE} max={HDR_EXPOSURE} step={0.01} value={hdr.exposure}
                  onChange={e => previewHdr(sanitizeHdr({ ...hdr, exposure: Number(e.currentTarget.value) }))} /></label>
              <label>Gamma <input type="range" aria-label="Gamma" min={Math.log10(HDR_GAMMA[0])} max={Math.log10(HDR_GAMMA[1])} step={0.01} value={Math.log10(hdr.gamma)}
                onChange={e => previewHdr(sanitizeHdr({ ...hdr, gamma: Number((10 ** Number(e.currentTarget.value)).toFixed(2)) }))} />
                <input type="number" aria-label="Gamma value" min={HDR_GAMMA[0]} max={HDR_GAMMA[1]} step={0.01} value={hdr.gamma}
                  onChange={e => previewHdr(sanitizeHdr({ ...hdr, gamma: Number(e.currentTarget.value) }))} /></label>
            </>}
          </>}
          {kind === 'mismatch' && <>
            <p>The document “{question.file}” has an embedded color profile that does not match the current RGB working space.</p>
            <p>Embedded: {question.embedded}<br />Working: {settings.rgb}</p>
            {radio('keep', 'Use the embedded profile (instead of the working space)')}
            {radio('convert', "Convert document's colors to the working space")}
            {radio('discard', "Discard the embedded profile (don't color manage)")}
          </>}
          {kind === 'missing' && <>
            <p>The RGB document “{question.file}” does not have an embedded color profile.</p>
            {radio('leave', "Leave as is (don't color manage)")}
            {radio('assign', `Assign working RGB: ${settings.rgb}`)}
          </>}
          <div className="actions">
            <button type="button" onClick={() => close(null)}>Cancel</button>
            <button type="submit" className="primary">OK</button>
          </div>
        </form>
      )}
    </dialog>
  );
}
