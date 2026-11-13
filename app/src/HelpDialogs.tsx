import { useEffect, useMemo, useState, type RefObject } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { Item } from './app/helpers.ts';
import { filterShortcuts, shortcutGroups, shortcutsHtml } from './app/shortcutList.ts';
import { systemInfo } from './app/systemInfo.ts';

type DialogRef = RefObject<HTMLDialogElement | null>;

// Help > Keyboard Shortcuts: every shortcut, searchable, and the list as an HTML page (Summarize).
export function ShortcutsDialog({ dialog, menus, title, download }: {
  dialog: DialogRef; menus: Record<string, Item[]>; title: (menu: string) => string; download: (blob: Blob, name: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const sync = () => setOpen(d.open);
    const watch = new MutationObserver(sync);
    watch.observe(d, { attributes: true, attributeFilter: ['open'] });
    return () => watch.disconnect();
  }, [dialog]);
  const groups = useMemo(() => (open ? shortcutGroups(menus, title) : []), [open, menus, title]);
  const shown = filterShortcuts(groups, query);
  const summarize = () => {
    const heading = t`photobaer Keyboard Shortcuts`;
    download(new Blob([shortcutsHtml(groups, heading, [t`Command`, t`Shortcut`])], { type: 'text/html' }), 'photobaer-shortcuts.html');
  };
  return (
    <dialog ref={dialog} className="shortcuts-dialog" aria-labelledby="shortcuts-title" onClose={() => setQuery('')}>
      <form method="dialog">
        <h2 id="shortcuts-title"><Trans>Keyboard Shortcuts</Trans></h2>
        <input type="search" value={query} onChange={e => setQuery(e.currentTarget.value)} placeholder={t`Search commands or keys`} aria-label={t`Search commands or keys`} />
        <div className="shortcuts-list">
          {shown.map(g => (
            <section key={g.id}>
              <h3>{g.title}</h3>
              <table>
                <tbody>{g.rows.map((r, i) => <tr key={i}><td>{r.command}</td><td><kbd>{r.keys}</kbd></td></tr>)}</tbody>
              </table>
            </section>
          ))}
          {!shown.length && <p className="dim"><Trans>No shortcut matches.</Trans></p>}
        </div>
        <div className="actions">
          <button type="button" onClick={summarize}><Trans>Summarize…</Trans></button>
          <button className="primary"><Trans>Close</Trans></button>
        </div>
      </form>
    </dialog>
  );
}

// Help > System Info: browser, graphics, memory and storage facts as copyable text.
export function SystemInfoDialog({ dialog, renderer }: { dialog: DialogRef; renderer: string }) {
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const watch = new MutationObserver(() => {
      if (!d.open) return;
      setCopied(false);
      setText(t`Collecting…`);
      void systemInfo(renderer).then(lines => setText(lines.join('\n')), err => setText(String(err)));
    });
    watch.observe(d, { attributes: true, attributeFilter: ['open'] });
    return () => watch.disconnect();
  }, [dialog, renderer]);
  return (
    <dialog ref={dialog} className="system-info-dialog" aria-labelledby="system-info-title">
      <form method="dialog">
        <h2 id="system-info-title"><Trans>System Info</Trans></h2>
        <textarea readOnly value={text} rows={18} aria-label={t`System Info`} />
        <div className="actions">
          <button type="button" onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true), () => {})}>{copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}</button>
          <button className="primary"><Trans>Close</Trans></button>
        </div>
      </form>
    </dialog>
  );
}
