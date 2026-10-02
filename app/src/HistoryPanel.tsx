interface Props {
  history: { labels: string[]; current: number };
  goto: (n: number) => void;
}

export function HistoryPanel({ history, goto }: Props) {
  const rows = ['Initial state', ...history.labels];
  return (
    <div className="history-panel">
      <div className="panel-tabs"><span className="panel-tab">History</span></div>
      <div role="listbox" aria-label="History">
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
