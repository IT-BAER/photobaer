// First use of a model feature: the download question (size, host, licence) with progress, and the command
// without the model where one exists. Later uses load the model from Cache Storage without asking.
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { ai } from './client.ts';
import { cachedModel, downloadModel, SEGMENTATION, type Model } from './models.ts';
import { formatNumber } from '../i18n/numbers.ts';
import { errorText } from '../i18n/errors.ts';

export type ModelChoice = 'model' | 'classic' | null;
export interface ModelDialogHandle {
  // Loads `model` (the segmentation model by default), asking to download it when it is not stored yet: 'model'
  // once it is loaded, 'classic' when the user picks the command without the model (offered when `classic` is
  // true), null on Cancel.
  ready(feature: string, classic: boolean, model?: Model): Promise<ModelChoice>;
}

type Answer = 'download' | 'classic' | null;
const mb = (bytes: number) => formatNumber(bytes / 1e6, 1);

export function ModelDialog({ ref, setBusy }: { ref: Ref<ModelDialogHandle>; setBusy: (label: string | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [s, setS] = useState<{ feature: string; classic: boolean; model: Model; got: number | null; error: string | null }>({ feature: '', classic: false, model: SEGMENTATION, got: null, error: null });
  const answer = useRef<((a: Answer) => void) | null>(null);
  const download = useRef<AbortController | null>(null);

  async function load(m: Model, bytes: ArrayBuffer) {
    setBusy(t`Loading the model…`);
    try { await ai.loadModel(m, bytes); } finally { setBusy(null); }
  }
  function reply(a: Answer) {
    const f = answer.current;
    answer.current = null;
    f?.(a);
  }

  useImperativeHandle(ref, () => ({
    async ready(feature, classic, model = SEGMENTATION) {
      if (ai.isLoaded(model)) return 'model';
      const stored = await cachedModel(model).catch(() => null);
      if (stored) { await load(model, stored); return 'model'; }
      setS({ feature, classic, model, got: null, error: null });
      dialog.current?.showModal();
      for (;;) {
        const a = await new Promise<Answer>(r => { answer.current = r; });
        if (a !== 'download') { dialog.current?.close(); return a; }
        const ac = new AbortController();
        download.current = ac;
        setS(x => ({ ...x, got: 0, error: null }));
        let bytes: ArrayBuffer;
        try {
          bytes = await downloadModel(model, got => setS(x => ({ ...x, got })), ac.signal);
        } catch (err) {
          if (ac.signal.aborted) { dialog.current?.close(); return null; }
          setS(x => ({ ...x, got: null, error: errorText(err) }));
          continue;
        } finally {
          download.current = null;
        }
        // A load error goes to the caller: the dialog is closed by then.
        dialog.current?.close();
        await load(model, bytes);
        return 'model';
      }
    },
  }));

  const m = s.model, host = new URL(m.url).host, size = mb(m.bytes), licence = m.license, feature = s.feature;
  const got = s.got === null ? null : mb(s.got);
  const cancel = () => { if (download.current) download.current.abort(); else reply(null); };
  return (
    <dialog ref={dialog} className="mode-dialog model-dialog" aria-label={feature} onCancel={e => { e.preventDefault(); cancel(); }}>
      <form onSubmit={e => { e.preventDefault(); reply('download'); }}>
        <h2>{feature}</h2>
        <p>{m.kind === 'face'
          ? <Trans>{feature} uses a face model that runs on this computer; your images are not uploaded.</Trans>
          : <Trans>{feature} uses a segmentation model that runs on this computer; your images are not uploaded.</Trans>}</p>
        <p><Trans>Download the model once ({size} MB from {host}, licence {licence})? It is kept in this browser and also works offline.</Trans></p>
        {got !== null && <p><progress max={m.bytes} value={s.got!} /> <Trans>{got} of {size} MB</Trans></p>}
        {s.error && <p className="hint bad" role="alert">{s.error}</p>}
        <div className="actions">
          {s.classic && <button type="button" disabled={got !== null} onClick={() => reply('classic')}><Trans>Use Without Model</Trans></button>}
          <button type="button" onClick={cancel}><Trans>Cancel</Trans></button>
          <button type="submit" className="primary" disabled={got !== null}><Trans>Download</Trans></button>
        </div>
      </form>
    </dialog>
  );
}
