import { useEffect, useState } from 'react';
import { FileImage } from 'lucide-react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { i18n } from './i18n/index.ts';
import { recentAge, type Recent } from './app/files.ts';

// Start screen: the Open Recent files as cards with the thumbnail taken at their last open or save.
export function RecentFiles({ recent, open }: { recent: Recent[]; open: (r: Recent) => void }) {
  const [urls, setUrls] = useState<Map<Recent, string>>(new Map());
  useEffect(() => {
    const m = new Map(recent.flatMap(r => r.thumb ? [[r, URL.createObjectURL(r.thumb)] as const] : []));
    setUrls(m);
    return () => m.forEach(u => URL.revokeObjectURL(u));
  }, [recent]);
  if (!recent.length) return null;
  const rtf = new Intl.RelativeTimeFormat(i18n.locale, { numeric: 'auto' }), now = Date.now();
  return (
    <section className="recent-files" aria-label={t`Recent`}>
      <h2><Trans>Recent</Trans></h2>
      <ul>
        {recent.map(r => {
          const url = urls.get(r);
          return (
            <li key={`${r.time}:${r.name}`}>
              <button type="button" title={r.name} onClick={() => open(r)}>
                <span className="thumb">{url ? <img src={url} alt="" /> : <FileImage size={28} aria-hidden="true" />}</span>
                <span className="name">{r.name}</span>
                <small>{rtf.format(...recentAge(r.time, now))}</small>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
