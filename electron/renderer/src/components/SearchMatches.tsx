// electron/renderer/src/components/SearchMatches.tsx
//
// Snippet stack rendered directly beneath a LibraryRow when the Library
// is in search mode. Each line is one "why this matched" hit (summary
// line or transcript line); transcript hits with a timestamp are
// clickable to open the meeting + seek to that moment.
//
// Title hits are deliberately filtered out — the title is already in
// the row above. A meeting that only matched on title gets no snippet
// block at all, which is the right outcome: the row itself is the
// evidence.

import { useMemo } from 'react';

export interface SearchHit {
  meetingId: string;
  title: string;
  source: 'title' | 'summary' | 'transcript';
  snippet: string;
  seconds?: number;
}

interface Props {
  hits: SearchHit[];
  query: string;
  /** Open the meeting and seek to `seconds`. Only invoked for
   *  transcript hits that carried a timestamp. */
  onJump: (seconds: number) => void;
  /** Open the meeting with no seek (clicked the summary snippet). */
  onOpen: () => void;
}

const MAX_VISIBLE = 3;

export function SearchMatches({ hits, query, onJump, onOpen }: Props): JSX.Element | null {
  const nonTitle = hits.filter((h) => h.source !== 'title');
  if (nonTitle.length === 0) return null;

  const visible = nonTitle.slice(0, MAX_VISIBLE);
  const extra = nonTitle.length - visible.length;

  return (
    // Sits flush under the row with a left rule that ties the snippets
    // visually to the meeting card above. -mt-1 closes the gap from the
    // row's space-y-2 so the block reads as part of the row, not a
    // separate card.
    <div className="-mt-1 ml-6 mb-1 pl-3 border-l-2 border-brand-indigo/20 space-y-0.5">
      {visible.map((h, i) => (
        <MatchLine
          key={`${h.source}-${h.seconds ?? i}`}
          hit={h}
          query={query}
          onClick={() => {
            if (h.source === 'transcript' && h.seconds !== undefined) onJump(h.seconds);
            else onOpen();
          }}
        />
      ))}
      {extra > 0 && (
        <div className="text-[11px] text-ink-muted/80 pl-1 pt-0.5 italic">
          + {extra} more match{extra === 1 ? '' : 'es'}
        </div>
      )}
    </div>
  );
}

function MatchLine({
  hit, query, onClick,
}: {
  hit: SearchHit;
  query: string;
  onClick: () => void;
}): JSX.Element {
  const highlighted = useMemo(() => highlight(hit.snippet, query), [hit.snippet, query]);
  const isTranscript = hit.source === 'transcript';
  const hasSeek = isTranscript && hit.seconds !== undefined;

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="group/match w-full text-left text-xs px-2 py-1 rounded-md
                 hover:bg-surface-sunken transition-colors flex items-baseline gap-2"
    >
      <span
        className={`font-mono text-[9px] tracking-wider uppercase shrink-0 px-1.5 py-px rounded
          ${isTranscript ? 'bg-brand-indigo/10 text-brand-indigo' : 'bg-surface-sunken text-ink-muted'}`}
      >
        {hit.source}
      </span>
      {hasSeek && (
        <span className="font-mono text-[10px] tabular-nums text-brand-indigo shrink-0">
          {fmtTimestamp(hit.seconds!)}
        </span>
      )}
      <span className="text-ink min-w-0 truncate">{highlighted}</span>
      {hasSeek && (
        <span className="ml-auto text-[10px] text-ink-muted/60 opacity-0 group-hover/match:opacity-100 shrink-0">
          jump →
        </span>
      )}
    </button>
  );
}

function highlight(snippet: string, query: string): React.ReactNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [snippet];
  const lower = snippet.toLowerCase();
  const out: React.ReactNode[] = [];
  let cursor = 0;
  while (cursor < snippet.length) {
    const idx = lower.indexOf(q, cursor);
    if (idx < 0) { out.push(snippet.slice(cursor)); break; }
    if (idx > cursor) out.push(snippet.slice(cursor, idx));
    out.push(
      <mark key={idx} className="bg-status-warnBg text-ink rounded px-0.5">
        {snippet.slice(idx, idx + q.length)}
      </mark>,
    );
    cursor = idx + q.length;
  }
  return out;
}

function fmtTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
