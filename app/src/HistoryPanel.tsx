import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { historyLabel } from './i18n/history.ts';

interface Props {
  history: { labels: string[]; current: number };
  goto: (n: number) => void;
}

export function HistoryPanel({ history, goto }: Props) {
  const rows = [t`Initial state`, ...history.labels.map(historyLabel)];
  return (
    <div className="history-panel">
      <div className="panel-tabs"><span className="panel-tab"><Trans>History</Trans></span></div>
      <div role="listbox" aria-label={t`History`}>
        {rows.map((label, i) => (
          <div
            key={i}
            role="option"
            aria-selected={i === history.current}
            className={`history-row${i === history.current ? ' current' : ''}${i > history.current ? ' dimmed' : ''}`}
            onClick={() => goto(i)}
          >
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}
