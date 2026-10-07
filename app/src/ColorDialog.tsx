// Edit > Color Settings, Assign Profile and Convert to Profile, View > Proof Setup > Custom and 32-bit
// Preview Options, plus the Profile Mismatch and Missing Profile questions asked while opening a file.
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { MessageDescriptor } from '@lingui/core';
import { i18n } from './i18n/index.ts';
import { client } from './client.ts';
import type { DocInfo } from './engine.worker.ts';
import type { IccProfile } from './worker/types.ts';
import {
  CMYK_SPACES, COLOR_PRESETS, GRAY_SPACES, INTENTS, POLICIES, RGB_SPACES, loadColorSettings, matchPreset, saveColorSettings,
  type ColorSettings, type Intent, type OpenAction, type Policy,
} from './app/colorSettings.ts';
import { DEFAULT_VIEW, HDR_EXPOSURE, HDR_GAMMA, sanitizeHdr, type HdrMethod, type HdrPreview } from './app/proof.ts';
import { rememberLoadedProfiles } from './app/profileStore.ts';
import { NumberInput } from './shell/NumberInput.tsx';

export type ColorDialogKind = 'settings' | 'assign' | 'convert' | 'proof' | 'hdr';
export interface ColorDialogHandle {
  open(kind: ColorDialogKind): void;
  // Profile Mismatch (embedded set) or Missing Profile for an RGB or Gray (`space`) `file`; null when cancelled.
  ask(file: string, embedded: string | null, space?: 'rgb' | 'gray'): Promise<OpenAction | null>;
}

type Kind = ColorDialogKind | 'mismatch' | 'missing';
const NAMES: Record<Kind, MessageDescriptor> = {
  settings: msg`Color Settings`, assign: msg`Assign Profile`, convert: msg`Convert to Profile`, mismatch: msg`Embedded Profile Mismatch`, missing: msg`Missing Profile`,
  proof: msg`Customize Proof Condition`, hdr: msg`32-bit Preview Options`,
};
const HDR_METHODS: [HdrMethod, MessageDescriptor][] = [['exposureAndGamma', msg`Exposure and Gamma`], ['highlightCompression', msg`Highlight Compression`]];

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
  const [question, setQuestion] = useState({ file: '', embedded: '', space: 'rgb' as 'rgb' | 'gray' });
  const [proof, setProof] = useState({ preserveNumbers: false, simulatePaper: false, simulateBlackInk: false, preview: true });
  const [hdr, setHdr] = useState<HdrPreview>(DEFAULT_VIEW.hdr);
  const hdrBefore = useRef<HdrPreview | null>(null);
  // Assign Profile's Preview: whether the document shows the chosen profile now.
  const [assignPreview, setAssignPreview] = useState(true);
  const assignOn = useRef(false);

  useEffect(() => { client.call('setColorSettings', settings).then(d => { if (d) show(d); }, e => setError((e as Error).message)); }, [settings]);

  const gray = !!doc?.gray;
  const cmykDoc = doc?.mode?.kind === 'cmyk';
  const working = cmykDoc ? settings.cmyk : gray ? settings.gray : settings.rgb;
  const refresh = () => client.call('iccProfiles').then(list => {
    setProfiles(list);
    rememberLoadedProfiles(list.filter(p => p.loaded));
  }, e => setError((e as Error).message));
  const loadedOf = (space: string) => profiles.filter(p => p.loaded && p.space === space).map(p => p.name);

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
      if (k !== 'hdr') void refresh();
      dialog.current?.showModal();
    },
    ask(file, embedded, space = 'rgb') {
      answer.current?.(null);
      setKind(embedded ? 'mismatch' : 'missing');
      setQuestion({ file, embedded: embedded ?? '', space });
      const policy = space === 'gray' ? settings.grayPolicy : settings.rgbPolicy;
      setChoice(embedded ? ({ off: 'discard', preserveEmbedded: 'keep', convertToWorking: 'convert' } as const)[policy] : 'leave');
      dialog.current?.showModal();
      return new Promise(r => { answer.current = r; });
    },
  }), [doc, settings, working]);

  function endAssignPreview() {
    if (!assignOn.current) return;
    assignOn.current = false;
    client.call('previewAssign', null, true).then(show, e => setError((e as Error).message));
  }

  function close(a: OpenAction | null) {
    if (hdrBefore.current) { previewHdr(hdrBefore.current); hdrBefore.current = null; }
    endAssignPreview();
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
        const fileName = f.name, reason = (e as Error).message;
        setError(t`Could not load ${fileName}: ${reason}`);
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
    endAssignPreview();
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
      ? client.call('assignProfile', assignTarget)
      : client.call('convertToProfile', profile, { intent: opts.intent, blackPointCompensation: opts.bpc, dither: opts.dither, flatten: opts.flatten });
    run.then(show, e => setError((e as Error).message));
  }

  const assignTarget = choice === 'none' ? null : choice === 'working' ? working : profile;
  useEffect(() => {
    if (kind !== 'assign') return;
    if (!assignPreview) { endAssignPreview(); return; }
    assignOn.current = true;
    client.call('previewAssign', assignTarget, false).then(show, e => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, assignTarget, assignPreview]);

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
    <label><Trans>Intent</Trans> <select aria-label={t`Intent`} value={o.intent} onChange={e => set({ intent: e.currentTarget.value as Intent })}>
      {INTENTS.map(([v, l]) => <option key={v} value={v}>{i18n._(l)}</option>)}
    </select></label>
    <label className="check"><input type="checkbox" checked={o.bpc} onChange={e => set({ bpc: e.currentTarget.checked })} /> <Trans>Use Black Point Compensation</Trans></label>
    <label className="check"><input type="checkbox" checked={o.dither} onChange={e => set({ dither: e.currentTarget.checked })} /> <Trans>Use Dither (8-bit/channel images)</Trans></label>
  </>;
  const preset = matchPreset(draft);
  const policy = (label: string, value: Policy, set: (p: Policy) => void, space: string) => (
    <label>{label} <select aria-label={t`${label} policy`} value={value} onChange={e => set(e.currentTarget.value as Policy)}>
      {POLICIES.map(([v, l]) => <option key={v} value={v}>{i18n._({ ...l, values: { space } })}</option>)}
    </select></label>
  );

  const workingKind = cmykDoc ? 'CMYK' : gray ? t`Gray` : 'RGB';
  const assumed = gray ? 'Gray Gamma 2.2' : 'sRGB IEC61966-2.1';
  const profileName = doc?.profile?.name ?? t`Untagged`;
  const sourceProfile = cmykDoc ? t`${profileName} (stored as sRGB IEC61966-2.1)` : doc?.profile?.name ?? t`Untagged (treated as ${assumed})`;
  const askFile = question.file;
  const askEmbedded = question.embedded;
  const askWorking = settings[question.space];
  const askSpace = question.space === 'gray' ? t`Gray` : 'RGB';
  const askDocKind = question.space === 'gray' ? t`Grayscale` : 'RGB';

  return (
    <dialog ref={dialog} className="mode-dialog color-dialog" aria-label={kind ? i18n._(NAMES[kind]) : t`Color`} onClose={() => { setKind(null); if (answer.current || hdrBefore.current || assignOn.current) close(null); }}>
      {kind && (
        <form onSubmit={e => { e.preventDefault(); ok(); }}>
          <h2>{i18n._(NAMES[kind])}</h2>
          {kind === 'settings' && <>
            <label><Trans>Settings</Trans> <select aria-label={t`Settings`} value={preset} onChange={e => {
              const p = COLOR_PRESETS.find(x => x.name === e.currentTarget.value);
              if (p) setDraft(p.settings);
            }}>
              {preset === 'Custom' && <option value="Custom">{t`Custom`}</option>}
              {COLOR_PRESETS.map(p => <option key={p.name} value={p.name}>{i18n._(p.label)}</option>)}
            </select></label>
            <fieldset><legend><Trans>Working Spaces</Trans></legend>
              <label><Trans>RGB</Trans> {select(t`RGB working space`, draft.rgb, v => setDraft({ ...draft, rgb: v }), [...RGB_SPACES, ...loadedOf('rgb')])}</label>
              <label><Trans>CMYK</Trans> {select(t`CMYK working space`, draft.cmyk, v => setDraft({ ...draft, cmyk: v }), [...CMYK_SPACES, ...loadedOf('cmyk')])}</label>
              <label><Trans>Gray</Trans> {select(t`Gray working space`, draft.gray, v => setDraft({ ...draft, gray: v }), [...GRAY_SPACES, ...loadedOf('gray')])}</label>
              <button type="button" onClick={load}><Trans>Load…</Trans></button>
            </fieldset>
            <fieldset><legend><Trans>Color Management Policies</Trans></legend>
              {policy(t`RGB`, draft.rgbPolicy, p => setDraft({ ...draft, rgbPolicy: p }), t`RGB`)}
              {policy(t`Gray`, draft.grayPolicy, p => setDraft({ ...draft, grayPolicy: p }), t`Gray`)}
              <label className="check"><input type="checkbox" checked={draft.askWhenOpening} onChange={e => setDraft({ ...draft, askWhenOpening: e.currentTarget.checked })} /> <Trans>Profile Mismatches: Ask When Opening</Trans></label>
              <label className="check"><input type="checkbox" checked={draft.askWhenMissing} onChange={e => setDraft({ ...draft, askWhenMissing: e.currentTarget.checked })} /> <Trans>Missing Profiles: Ask When Opening</Trans></label>
            </fieldset>
            <fieldset><legend><Trans>Conversion Options</Trans></legend>
              {conversion(draft, p => setDraft({ ...draft, ...p }))}
            </fieldset>
            <fieldset><legend><Trans>Advanced Controls</Trans></legend>
              <div className="row">
                <label className="check"><input type="checkbox" checked={draft.desaturateOn} onChange={e => setDraft({ ...draft, desaturateOn: e.currentTarget.checked })} /> <Trans>Desaturate Monitor Colors By:</Trans></label>
                <NumberInput aria-label={t`Desaturate by`} min={1} max={100} disabled={!draft.desaturateOn} value={draft.desaturateBy}
                  onValue={n => { const v = Math.round(n); if (v >= 1 && v <= 100) setDraft({ ...draft, desaturateBy: v }); }} /> %
              </div>
            </fieldset>
            <p className="hint">{i18n._(COLOR_PRESETS.find(p => p.name === preset)?.description ?? msg`Custom settings.`)}</p>
          </>}
          {kind === 'assign' && <>
            {radio('none', t`Don't Color Manage This Document`)}
            {radio('working', t`Working ${workingKind}: ${working}`)}
            <div className="row">
              {radio('profile', t`Profile:`)}
              {select(t`Profile`, profile, setProfile, own.map(p => p.name), choice !== 'profile')}
              <button type="button" onClick={load}><Trans>Load…</Trans></button>
            </div>
            <label className="check"><input type="checkbox" checked={assignPreview} onChange={e => setAssignPreview(e.currentTarget.checked)} /> <Trans>Preview</Trans></label>
          </>}
          {kind === 'convert' && <>
            <fieldset><legend><Trans>Source Space</Trans></legend>
              <p><Trans>Profile: {sourceProfile}</Trans></p>
            </fieldset>
            <fieldset><legend><Trans>Destination Space</Trans></legend>
              <div className="row">
                <label><Trans>Profile</Trans> {select(t`Destination profile`, profile, setProfile, profiles.map(p => p.name))}</label>
                <button type="button" onClick={load}><Trans>Load…</Trans></button>
              </div>
            </fieldset>
            <fieldset><legend><Trans>Conversion Options</Trans></legend>
              {conversion(opts, p => setOpts({ ...opts, ...p }))}
              <label className="check"><input type="checkbox" checked={opts.flatten} onChange={e => setOpts({ ...opts, flatten: e.currentTarget.checked })} /> <Trans>Flatten Image to Preserve Appearance</Trans></label>
            </fieldset>
          </>}
          {kind === 'proof' && <>
            <div className="row">
              <label><Trans>Device to Simulate</Trans> {select(t`Device to Simulate`, profile, setProfile, profiles.map(p => p.name))}</label>
              <button type="button" onClick={load}><Trans>Load…</Trans></button>
            </div>
            <label className="check"><input type="checkbox" checked={proof.preserveNumbers && sameKind} disabled={!sameKind}
              onChange={e => setProof({ ...proof, preserveNumbers: e.currentTarget.checked })} /> <Trans>Preserve Numbers</Trans></label>
            <label><Trans>Rendering Intent</Trans> <select aria-label={t`Rendering Intent`} value={opts.intent} disabled={proof.preserveNumbers && sameKind}
              onChange={e => setOpts({ ...opts, intent: e.currentTarget.value as Intent })}>
              {INTENTS.map(([v, l]) => <option key={v} value={v}>{i18n._(l)}</option>)}
            </select></label>
            <label className="check"><input type="checkbox" checked={opts.bpc} onChange={e => setOpts({ ...opts, bpc: e.currentTarget.checked })} /> <Trans>Black Point Compensation</Trans></label>
            <fieldset><legend><Trans>Display Options (On-Screen)</Trans></legend>
              <label className="check"><input type="checkbox" checked={proof.simulatePaper} onChange={e => setProof({ ...proof, simulatePaper: e.currentTarget.checked })} /> <Trans>Simulate Paper Color</Trans></label>
              <label className="check"><input type="checkbox" checked={proof.simulateBlackInk || proof.simulatePaper} disabled={proof.simulatePaper}
                onChange={e => setProof({ ...proof, simulateBlackInk: e.currentTarget.checked })} /> <Trans>Simulate Black Ink</Trans></label>
            </fieldset>
            <label className="check"><input type="checkbox" checked={proof.preview} onChange={e => setProof({ ...proof, preview: e.currentTarget.checked })} /> <Trans>Preview</Trans></label>
          </>}
          {kind === 'hdr' && <>
            <label><Trans>Method</Trans> <select aria-label={t`Method`} value={hdr.method} onChange={e => previewHdr({ ...hdr, method: e.currentTarget.value as HdrMethod })}>
              {HDR_METHODS.map(([v, l]) => <option key={v} value={v}>{i18n._(l)}</option>)}
            </select></label>
            {hdr.method === 'exposureAndGamma' && <>
              <label><Trans>Exposure</Trans> <input type="range" aria-label={t`Exposure`} min={-HDR_EXPOSURE} max={HDR_EXPOSURE} step={0.01} value={hdr.exposure}
                onChange={e => previewHdr(sanitizeHdr({ ...hdr, exposure: Number(e.currentTarget.value) }))} />
                <NumberInput aria-label={t`Exposure value`} min={-HDR_EXPOSURE} max={HDR_EXPOSURE} step={0.01} value={hdr.exposure}
                  onValue={v => previewHdr(sanitizeHdr({ ...hdr, exposure: v }))} /></label>
              <label><Trans>Gamma</Trans> <input type="range" aria-label={t`Gamma`} min={Math.log10(HDR_GAMMA[0])} max={Math.log10(HDR_GAMMA[1])} step={0.01} value={Math.log10(hdr.gamma)}
                onChange={e => previewHdr(sanitizeHdr({ ...hdr, gamma: Number((10 ** Number(e.currentTarget.value)).toFixed(2)) }))} />
                <NumberInput aria-label={t`Gamma value`} min={HDR_GAMMA[0]} max={HDR_GAMMA[1]} step={0.01} value={hdr.gamma}
                  onValue={v => previewHdr(sanitizeHdr({ ...hdr, gamma: v }))} /></label>
            </>}
          </>}
          {kind === 'mismatch' && <>
            <p><Trans>The document “{askFile}” has an embedded color profile that does not match the current {askSpace} working space.</Trans></p>
            <p><Trans>Embedded: {askEmbedded}<br />Working: {askWorking}</Trans></p>
            {radio('keep', t`Use the embedded profile (instead of the working space)`)}
            {radio('convert', t`Convert document's colors to the working space`)}
            {radio('discard', t`Discard the embedded profile (don't color manage)`)}
          </>}
          {kind === 'missing' && <>
            <p><Trans>The {askDocKind} document “{askFile}” does not have an embedded color profile.</Trans></p>
            {radio('leave', t`Leave as is (don't color manage)`)}
            {radio('assign', t`Assign working ${askSpace}: ${askWorking}`)}
          </>}
          <div className="actions">
            <button type="button" onClick={() => close(null)}><Trans>Cancel</Trans></button>
            <button type="submit" className="primary"><Trans>OK</Trans></button>
          </div>
        </form>
      )}
    </dialog>
  );
}
