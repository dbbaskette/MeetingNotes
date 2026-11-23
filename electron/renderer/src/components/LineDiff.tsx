// electron/renderer/src/components/LineDiff.tsx
//
// Renders a line-level diff (lib/line-diff). Removed and added lines carry a
// "−" / "+" marker and a word for screen readers as well as colour, so the
// change is not conveyed by colour alone.
import { useMemo, useState } from 'react';
import { collapseUnchanged, diffLines, diffStats } from '../lib/line-diff';

export function LineDiff({ before, after, beforeLabel, afterLabel, className = '' }: {
  before: string; after: string;
  /** What the removed side is, for the summary line: "Current notes". */
  beforeLabel: string; afterLabel: string;
  className?: string;
}): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const stats = useMemo(() => diffStats(lines), [lines]);
  const rows = useMemo(() => (showAll ? lines : collapseUnchanged(lines)), [lines, showAll]);
  const unchanged = stats.added === 0 && stats.removed === 0;
  return (
    <div className={className}>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
        <span role="status">
          {unchanged ? 'No differences in the text.' : <>
            <span className="font-semibold text-danger-text">− {stats.removed} only in {beforeLabel.toLowerCase()}</span>
            {' · '}
            <span className="font-semibold text-status-ok">+ {stats.added} only in {afterLabel.toLowerCase()}</span>
          </>}
        </span>
        {!unchanged && <button type="button" className="underline hover:text-ink" aria-pressed={showAll} onClick={() => setShowAll((value) => !value)}>
          {showAll ? 'Show changes only' : 'Show unchanged lines'}
        </button>}
      </div>
      <div className="max-h-[45vh] overflow-auto rounded-md border border-surface-border bg-surface font-mono text-xs leading-relaxed">
        {rows.map((row, index) => 'skipped' in row && row.op === 'gap'
          ? <div key={index} className="select-none bg-surface-sunken px-3 py-0.5 text-center text-[11px] text-ink-muted">{row.skipped} unchanged {row.skipped === 1 ? 'line' : 'lines'}</div>
          : <div key={index} className={`flex gap-2 px-3 whitespace-pre-wrap break-words ${row.op === 'removed' ? 'bg-danger-bg text-danger-text' : row.op === 'added' ? 'bg-status-okBg text-status-ok' : 'text-ink-soft'}`}>
              <span aria-hidden="true" className="w-3 shrink-0 select-none text-center">{row.op === 'removed' ? '−' : row.op === 'added' ? '+' : ''}</span>
              <span className="min-w-0 flex-1">{row.op !== 'same' && <span className="sr-only">{row.op === 'removed' ? `Only in ${beforeLabel}: ` : `Only in ${afterLabel}: `}</span>}{row.text || ' '}</span>
            </div>)}
      </div>
    </div>
  );
}
