// electron/renderer/src/components/SearchPalette.tsx
//
// Cmd+K global search across meeting titles, summaries, and transcripts
// (#45). Query flows through the main-process file-grep handler at
// `search:query`. Results are keyboard-navigable; Enter opens the
// meeting, Cmd+Enter opens and jumps to the transcript timestamp if
// the hit was on a transcript line (building on #42).

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../ipc/client';
import { shortcutMod } from '../lib/shortcut';

export interface PaletteTarget {
  meetingId: string;
  /** Title from the search hit — used as a hint so the detail view's
   *  skeleton can render with the right title before meetings:get
   *  resolves. */
  title?: string;
  /** Optional — when present, open the meeting + seek the audio to
   *  this timestamp (the Cmd+Enter path). */
  seekSeconds?: number;
}

interface SearchResult {
  meetingId: string;
  title: string;
  source: 'title' | 'summary' | 'transcript';
  snippet: string;
  seconds?: number;
}

export function SearchPalette({
  open, onClose, onOpenMeeting,
}: {
  open: boolean;
  onClose: () => void;
  onOpenMeeting: (t: PaletteTarget) => void;
}): JSX.Element | null {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset state when the palette opens. Focus the input on the next
  // frame so the focus trap doesn't fight the browser's default.
  useEffect(() => {
    if (!open) return;
    setQ(''); setResults([]); setSelected(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  // Debounced search — 150ms is tight enough to feel live, wide enough
  // that each keystroke doesn't fire an IPC on a big library.
  useEffect(() => {
    if (!open) return;
    if (q.trim().length < 2) { setResults([]); return; }
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const r = (await api.search.query(q, 20)) as SearchResult[];
        if (!cancelled) { setResults(r); setSelected(0); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 150);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [q, open]);

  function openResult(r: SearchResult, withTimestamp: boolean): void {
    onOpenMeeting({
      meetingId: r.meetingId,
      title: r.title,
      ...(withTimestamp && r.seconds !== undefined ? { seekSeconds: r.seconds } : {}),
    });
    onClose();
  }

  function onKey(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (results.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(s + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[selected];
      if (r) openResult(r, e.metaKey || e.ctrlKey);
    }
  }

  if (!open) return null;

  return createPortal(
    <div
      onClick={onClose}
      className="fixed inset-0 z-[1050] bg-black/30 flex items-start justify-center pt-24 px-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        className="w-full max-w-2xl bg-surface rounded-xl shadow-pop border border-surface-border overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-surface-border flex items-center gap-3">
          <svg viewBox="0 0 24 24" className="w-4 h-4 text-ink-muted shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search across all meetings…"
            className="flex-1 bg-transparent text-sm focus:outline-none"
          />
          {loading && (
            <span className="text-[11px] text-ink-muted italic">Searching…</span>
          )}
          <kbd className="text-[10px] font-mono tracking-wider uppercase text-ink-muted/80 bg-surface-sunken border border-surface-border rounded px-1.5 py-0.5">
            Esc
          </kbd>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {q.trim().length < 2 && (
            <div className="px-4 py-6 text-xs text-ink-muted">
              Type at least 2 characters to search titles, summaries, and
              transcripts. <kbd className="font-mono">Enter</kbd> opens;
              {' '}<kbd className="font-mono">{shortcutMod()}+Enter</kbd> jumps to the
              matched timestamp.
            </div>
          )}
          {q.trim().length >= 2 && !loading && results.length === 0 && (
            <div className="px-4 py-6 text-sm text-ink-muted italic">
              No matches for <span className="text-ink font-semibold">“{q}”</span>.
            </div>
          )}
          {results.map((r, i) => (
            <ResultRow
              key={`${r.meetingId}-${r.source}-${i}`}
              result={r}
              query={q}
              active={i === selected}
              onHover={() => setSelected(i)}
              onClick={(e) => openResult(r, e.metaKey || e.ctrlKey)}
            />
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ResultRow({
  result, query, active, onHover, onClick,
}: {
  result: SearchResult;
  query: string;
  active: boolean;
  onHover: () => void;
  onClick: (e: React.MouseEvent) => void;
}): JSX.Element {
  const highlighted = useMemo(() => highlight(result.snippet, query), [result.snippet, query]);
  return (
    <div
      onMouseMove={onHover}
      onClick={onClick}
      className={`px-4 py-3 cursor-pointer border-b border-surface-border/50 last:border-0
        ${active ? 'bg-brand-indigo/5' : 'hover:bg-surface-sunken'}`}
    >
      <div className="flex items-center gap-2 text-xs text-ink-muted">
        <span className="font-semibold">{result.title}</span>
        <span className="opacity-60">·</span>
        <span className="font-mono text-[10px] tracking-wider uppercase">{result.source}</span>
        {result.seconds !== undefined && (
          <>
            <span className="opacity-60">·</span>
            <span className="font-mono tabular-nums">{fmtSnippetTimestamp(result.seconds)}</span>
            <span className="opacity-50 text-[10px]">
              <kbd className="font-mono">{shortcutMod()}+Enter</kbd> to jump
            </span>
          </>
        )}
      </div>
      <div className="text-sm mt-0.5">{highlighted}</div>
    </div>
  );
}

// Wrap matches of `query` in a highlighted span. Case-insensitive; splits
// the snippet on the lowercased query and rebuilds with the original casing
// preserved in the matched segments.
function highlight(snippet: string, query: string): React.ReactNode[] {
  if (!query) return [snippet];
  const lower = snippet.toLowerCase();
  const q = query.toLowerCase();
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

function fmtSnippetTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
