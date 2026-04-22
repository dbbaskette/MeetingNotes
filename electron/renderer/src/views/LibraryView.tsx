// electron/renderer/src/views/LibraryView.tsx
//
// Single unified list. Previously the view was split into an Inbox zone
// (pending recordings) and a Library zone (everything processed or in-
// flight). The two-zone split duplicated row rendering, filtering, and
// search logic; merging into one list with an "Unprocessed" filter chip
// makes the whole catalog searchable and removes the conceptual split
// between "arrivals" and "meetings" — they're all meetings, some
// haven't started processing yet.
import { useEffect, useMemo, useState } from 'react';
import { useMeetingsStore } from '../store/meetings';
import { LibraryRow } from '../components/LibraryRow';
import { RecordButton } from '../components/RecordButton';
import { LiveRecordingRow } from '../components/LiveRecordingRow';
import { MeetingDetectedBanner } from '../components/MeetingDetectedBanner';
import { api } from '../ipc/client';

interface Props {
  onOpen: (id: string) => void;
  onSettings: () => void;
}

type LibFilter = 'all' | 'unprocessed' | 'processing' | 'done' | 'failed';

export function LibraryView({ onOpen, onSettings }: Props): JSX.Element {
  const { meetings, refresh } = useMeetingsStore();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [libFilter, setLibFilter] = useState<LibFilter>('all');
  const [liveRecording, setLiveRecording] = useState<
    { sessionId: string; label: string; startedAt: string } | null
  >(null);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  // From the user's perspective `awaiting_user` is just "still in flight"
  // — the pipeline hasn't reached `done`, it's just paused for input. So
  // the Processing filter and counter both bucket awaiting_user with
  // processing. Awaiting comes first in the sort because those rows
  // actively need attention from the user, not just patience.
  const isInFlight = (s: string): boolean => s === 'processing' || s === 'awaiting_user';

  const library = useMemo(() => {
    const q = query.trim().toLowerCase();
    const searched = q ? meetings.filter((m) => m.title.toLowerCase().includes(q)) : meetings;
    const filtered = libFilter === 'all'
      ? searched
      : libFilter === 'unprocessed'
        ? searched.filter((m) => m.status === 'pending')
        : libFilter === 'processing'
          ? searched.filter((m) => isInFlight(m.status))
          : searched.filter((m) => m.status === libFilter);
    // Pending first (user can act), then awaiting_user (needs YOU mid-
    // pipeline), processing (needs patience), failed (needs attention),
    // done (chronological).
    const rank: Record<string, number> = {
      pending: 0, awaiting_user: 1, processing: 2, failed: 3, done: 4,
    };
    return [...filtered].sort((a, b) => {
      const ra = rank[a.status] ?? 9;
      const rb = rank[b.status] ?? 9;
      if (ra !== rb) return ra - rb;
      return (b.startedAt ?? '').localeCompare(a.startedAt ?? '');
    });
  }, [meetings, query, libFilter]);

  const libCounts = useMemo(() => ({
    all: meetings.length,
    unprocessed: meetings.filter((m) => m.status === 'pending').length,
    processing: meetings.filter((m) => isInFlight(m.status)).length,
    done: meetings.filter((m) => m.status === 'done').length,
    failed: meetings.filter((m) => m.status === 'failed').length,
  }), [meetings]);

  const pendingIds = useMemo(
    () => meetings.filter((m) => m.status === 'pending').map((m) => m.id),
    [meetings],
  );

  // Drop stale selections — a meeting that just transitioned out of pending
  // (e.g. user clicked Process and it's now 'processing') shouldn't stay
  // checked. Keeps the "N selected" pill honest.
  useEffect(() => {
    const ids = new Set(pendingIds);
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (ids.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [pendingIds]);

  function toggleSelect(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function processSelected(): Promise<void> {
    const ids = [...selected];
    if (ids.length === 0) return;
    setSelected(new Set());
    await api.meetings.startMany(ids);
    void refresh();
  }

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8 pb-24">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header className="flex items-center gap-4 mb-8">
        <div className="flex items-center gap-2.5">
          <div
            className="w-6 h-6 rounded-md"
            style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)' }}
          />
          <h1 className="text-lg font-semibold tracking-tight">MeetingNotes</h1>
        </div>
        <div className="flex-1" />
        <RecordButton onStarted={({ sessionId, label }) => setLiveRecording({
          sessionId, label, startedAt: new Date().toISOString(),
        })} />
        <button
          onClick={onSettings}
          aria-label="Settings"
          title="Settings"
          className="w-9 h-9 rounded-md shrink-0 flex items-center justify-center
                     text-ink-muted hover:text-ink hover:bg-surface-sunken
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40
                     transition"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.36.14.68.36.93.66.24.3.41.65.48 1.02L21 11a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </header>

      {!liveRecording && (
        <MeetingDetectedBanner
          onStartRecording={({ sessionId, label }) => setLiveRecording({
            sessionId, label, startedAt: new Date().toISOString(),
          })}
        />
      )}

      {liveRecording && (
        <div className="mb-6">
          <LiveRecordingRow
            sessionId={liveRecording.sessionId}
            label={liveRecording.label}
            startedAt={liveRecording.startedAt}
            onStopped={() => { setLiveRecording(null); void refresh(); }}
          />
        </div>
      )}

      {/* ── LIBRARY (unified list) ──────────────────────────────────────── */}
      <section>
        <div className="flex items-baseline gap-3 mb-3">
          <h2 className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted">
            Library
          </h2>
          <span className="text-[11px] text-ink-muted">
            {libCounts.all} {libCounts.all === 1 ? 'meeting' : 'meetings'}
          </span>
        </div>

        {/* Filter chips — each status chip hides when its count is zero so
            users aren't staring at "Failed 0" on a fresh install. Search
            yields width first on narrow via flex-1. */}
        <div className="flex items-center flex-wrap gap-2 mb-3">
          <FilterChip
            active={libFilter === 'all'}
            onClick={() => setLibFilter('all')}
            label="All"
            n={libCounts.all}
          />
          {libCounts.unprocessed > 0 && (
            <FilterChip
              active={libFilter === 'unprocessed'}
              onClick={() => setLibFilter('unprocessed')}
              label="Unprocessed"
              n={libCounts.unprocessed}
              dotClass="bg-ink-muted"
            />
          )}
          {libCounts.processing > 0 && (
            <FilterChip
              active={libFilter === 'processing'}
              onClick={() => setLibFilter('processing')}
              label="Processing"
              n={libCounts.processing}
              dotClass="bg-brand-indigo animate-pulse"
            />
          )}
          {libCounts.done > 0 && (
            <FilterChip
              active={libFilter === 'done'}
              onClick={() => setLibFilter('done')}
              label="Processed"
              n={libCounts.done}
              dotClass="bg-status-ok"
            />
          )}
          {libCounts.failed > 0 && (
            <FilterChip
              active={libFilter === 'failed'}
              onClick={() => setLibFilter('failed')}
              label="Failed"
              n={libCounts.failed}
              dotClass="bg-rose-500"
            />
          )}
          <input
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 sm:flex-none sm:w-56 sm:ml-auto min-w-[8rem] py-1.5 px-3 border border-surface-border rounded-lg text-sm bg-surface placeholder:text-ink-muted
                       focus:outline-none focus:border-brand-indigo focus:shadow-[0_0_0_3px_rgba(99,102,241,0.15)]"
          />
        </div>

        {library.length === 0 ? (
          <LibraryEmpty
            hasAny={libCounts.all > 0}
            filter={libFilter}
            query={query}
          />
        ) : (
          <div className="space-y-2">
            {library.map((m) => (
              <LibraryRow
                key={m.id}
                meeting={m}
                onOpen={onOpen}
                onChanged={() => void refresh()}
                checked={m.status === 'pending' ? selected.has(m.id) : undefined}
                onToggle={m.status === 'pending' ? () => toggleSelect(m.id) : undefined}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Bulk action bar (docked) ────────────────────────────────────── */}
      <SelectionBar
        count={selected.size}
        onProcess={processSelected}
        onCancel={() => setSelected(new Set())}
      />
    </div>
  );
}

// ─── Supporting pieces ─────────────────────────────────────────────────────

function FilterChip({
  active, onClick, label, n, dotClass,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  n: number;
  dotClass?: string;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`
        inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full
        transition border
        ${active
          ? 'bg-ink text-surface border-ink'
          : 'bg-surface text-ink-muted border-surface-border hover:text-ink hover:border-ink/30'}
      `}
    >
      {dotClass && <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />}
      <span>{label}</span>
      <span className={`tabular-nums ${active ? 'opacity-80' : 'opacity-60'}`}>{n}</span>
    </button>
  );
}

function LibraryEmpty({
  hasAny, filter, query,
}: {
  hasAny: boolean;
  filter: LibFilter;
  query: string;
}): JSX.Element {
  if (query && hasAny) {
    return (
      <div className="text-center py-10 text-sm text-ink-muted">
        No meetings match <span className="font-semibold text-ink">“{query}”</span>.
      </div>
    );
  }
  if (hasAny && filter !== 'all') {
    const filterLabel = filter === 'unprocessed' ? 'unprocessed' : filter;
    return (
      <div className="text-center py-10 text-sm text-ink-muted">
        No {filterLabel} meetings.
      </div>
    );
  }
  return (
    <div className="text-center py-16">
      <div className="text-4xl mb-4 opacity-40">◈</div>
      <div className="text-sm text-ink-muted max-w-sm mx-auto leading-relaxed">
        Hit <span className="font-semibold text-ink">Record</span> to start a new session,
        or drop an audio file in{' '}
        <code className="text-xs bg-surface-sunken px-1 py-0.5 rounded">~/Music/MeetingNotes</code>.
      </div>
    </div>
  );
}

function SelectionBar({
  count, onProcess, onCancel,
}: {
  count: number;
  onProcess: () => void;
  onCancel: () => void;
}): JSX.Element {
  const visible = count > 0;
  return (
    <div
      aria-hidden={!visible}
      className={`
        fixed bottom-0 left-0 right-0 z-10
        transition-transform duration-200 ease-out
        ${visible ? 'translate-y-0' : 'translate-y-full'}
      `}
    >
      <div className="max-w-5xl mx-auto px-8 pb-4">
        <div className="bg-ink text-surface rounded-xl shadow-pop flex items-center gap-3 px-4 py-3">
          <span className="text-sm font-semibold tabular-nums">
            {count} selected
          </span>
          <div className="flex-1" />
          <button
            onClick={onCancel}
            className="text-sm text-surface/70 hover:text-surface px-3 py-1.5 rounded-lg hover:bg-surface/10 transition"
          >
            Cancel
          </button>
          <button
            onClick={onProcess}
            className="text-sm font-semibold bg-brand-indigo text-white px-4 py-1.5 rounded-lg hover:bg-brand-indigo/90 transition"
          >
            ▶ Process {count} {count === 1 ? 'recording' : 'recordings'}
          </button>
        </div>
      </div>
    </div>
  );
}
