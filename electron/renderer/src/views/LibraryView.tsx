// electron/renderer/src/views/LibraryView.tsx
//
// Two-zone layout:
//
//   ┌─ INBOX ────────────────────────────────┐
//   │ unprocessed recordings; checkbox list; │
//   │ primary action = "Process N selected"   │
//   └─────────────────────────────────────────┘
//   ┌─ LIBRARY ──────────────────────────────┐
//   │ processed meetings; searchable;         │
//   │ filter chips by status                  │
//   └─────────────────────────────────────────┘
//
// Zones are *visually* separate — different typography, different density,
// different action vocabulary. The old single-list UI piled four statuses
// into one table and relied on hover-reveal checkboxes. This version makes
// the "new arrivals → pick what to process" mental model the explicit top
// half of the page.
import { useEffect, useMemo, useState } from 'react';
import { useMeetingsStore } from '../store/meetings';
import { InboxRow } from '../components/InboxRow';
import { LibraryRow } from '../components/LibraryRow';
import { RecordButton } from '../components/RecordButton';
import { api } from '../ipc/client';

interface Props {
  onOpen: (id: string) => void;
  onSettings: () => void;
}

type LibFilter = 'all' | 'processing' | 'done' | 'failed';

export function LibraryView({ onOpen, onSettings }: Props): JSX.Element {
  const { meetings, refresh } = useMeetingsStore();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [libFilter, setLibFilter] = useState<LibFilter>('all');

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const inbox = useMemo(
    () =>
      meetings
        .filter((m) => m.status === 'pending')
        .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')),
    [meetings],
  );

  // From the user's perspective `awaiting_user` is just "still in flight"
  // — the pipeline hasn't reached `done`, it's just paused for input. So the
  // Processing filter and counter both bucket awaiting_user with processing.
  // Awaiting comes first in the sort because those rows actively need
  // attention from the user, not just patience.
  const isInFlight = (s: string): boolean => s === 'processing' || s === 'awaiting_user';

  const library = useMemo(() => {
    const q = query.trim().toLowerCase();
    const notPending = meetings.filter((m) => m.status !== 'pending');
    const searched = q ? notPending.filter((m) => m.title.toLowerCase().includes(q)) : notPending;
    const filtered = libFilter === 'all'
      ? searched
      : libFilter === 'processing'
        ? searched.filter((m) => isInFlight(m.status))
        : searched.filter((m) => m.status === libFilter);
    // Awaiting first (needs YOU), then processing (needs patience), then
    // failed (needs attention), then done (chronological).
    const rank: Record<string, number> = { awaiting_user: 0, processing: 1, failed: 2, done: 3 };
    return [...filtered].sort((a, b) => {
      const ra = rank[a.status] ?? 9;
      const rb = rank[b.status] ?? 9;
      if (ra !== rb) return ra - rb;
      return (b.startedAt ?? '').localeCompare(a.startedAt ?? '');
    });
  }, [meetings, query, libFilter]);

  const libCounts = useMemo(() => ({
    all: meetings.filter((m) => m.status !== 'pending').length,
    processing: meetings.filter((m) => isInFlight(m.status)).length,
    done: meetings.filter((m) => m.status === 'done').length,
    failed: meetings.filter((m) => m.status === 'failed').length,
  }), [meetings]);

  // Drop stale selections — a meeting that just transitioned out of pending
  // (e.g. user clicked Process and it's now 'processing') shouldn't stay
  // checked. Keeps the "N selected" pill honest.
  useEffect(() => {
    const pendingIds = new Set(inbox.map((m) => m.id));
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (pendingIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [inbox]);

  function toggleSelect(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll(): void {
    setSelected((prev) => (prev.size === inbox.length ? new Set() : new Set(inbox.map((m) => m.id))));
  }

  async function processSelected(): Promise<void> {
    const ids = [...selected];
    if (ids.length === 0) return;
    setSelected(new Set());
    await api.meetings.startMany(ids);
    void refresh();
  }

  const allSelected = inbox.length > 0 && selected.size === inbox.length;

  return (
    <div className="max-w-5xl mx-auto p-8 pb-24">
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
        <RecordButton sessionName="Meeting" />
        <button
          onClick={onSettings}
          aria-label="Settings"
          className="text-ink-muted hover:text-ink px-2 py-1 rounded-lg hover:bg-surface-sunken transition"
        >
          ⚙
        </button>
      </header>

      {/* ── INBOX ───────────────────────────────────────────────────────── */}
      {inbox.length > 0 && (
        <section className="mb-10">
          <div className="flex items-baseline gap-3 mb-3">
            <h2 className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted">
              Inbox
            </h2>
            <span className="text-[11px] text-ink-muted">
              {inbox.length} {inbox.length === 1 ? 'recording' : 'recordings'} waiting
            </span>
            <div className="flex-1" />
            <button
              onClick={toggleSelectAll}
              className="text-[11px] font-semibold text-brand-indigo hover:underline"
            >
              {allSelected ? 'Clear' : 'Select all'}
            </button>
          </div>
          <div className="bg-surface border border-surface-border rounded-xl overflow-hidden divide-y divide-surface-border">
            {inbox.map((m) => (
              <InboxRow
                key={m.id}
                meeting={m}
                checked={selected.has(m.id)}
                onToggle={() => toggleSelect(m.id)}
                onOpen={() => onOpen(m.id)}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── LIBRARY ─────────────────────────────────────────────────────── */}
      <section>
        <div className="flex items-baseline gap-3 mb-3">
          <h2 className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted">
            Library
          </h2>
          <span className="text-[11px] text-ink-muted">
            {libCounts.all} {libCounts.all === 1 ? 'meeting' : 'meetings'}
          </span>
        </div>

        {/* Filter chips — declarative, replaces the mixed-status list */}
        <div className="flex items-center gap-2 mb-3">
          <FilterChip
            active={libFilter === 'all'}
            onClick={() => setLibFilter('all')}
            label="All"
            n={libCounts.all}
          />
          {libCounts.processing > 0 && (
            <FilterChip
              active={libFilter === 'processing'}
              onClick={() => setLibFilter('processing')}
              label="Processing"
              n={libCounts.processing}
              dotClass="bg-brand-indigo animate-pulse"
            />
          )}
          <FilterChip
            active={libFilter === 'done'}
            onClick={() => setLibFilter('done')}
            label="Processed"
            n={libCounts.done}
            dotClass="bg-status-ok"
          />
          {libCounts.failed > 0 && (
            <FilterChip
              active={libFilter === 'failed'}
              onClick={() => setLibFilter('failed')}
              label="Failed"
              n={libCounts.failed}
              dotClass="bg-rose-500"
            />
          )}
          <div className="flex-1" />
          <input
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-56 py-1.5 px-3 border border-surface-border rounded-lg text-sm bg-surface placeholder:text-ink-muted
                       focus:outline-none focus:border-brand-indigo focus:shadow-[0_0_0_3px_rgba(99,102,241,0.15)]"
          />
        </div>

        {library.length === 0 ? (
          <LibraryEmpty
            hasAny={libCounts.all > 0}
            hasInbox={inbox.length > 0}
            filter={libFilter}
            query={query}
          />
        ) : (
          <div className="space-y-2">
            {library.map((m) => (
              <LibraryRow key={m.id} meeting={m} onOpen={onOpen} />
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
  hasAny, hasInbox, filter, query,
}: {
  hasAny: boolean;
  hasInbox: boolean;
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
    return (
      <div className="text-center py-10 text-sm text-ink-muted">
        No {filter} meetings.
      </div>
    );
  }
  if (hasInbox) {
    return (
      <div className="text-center py-10 text-sm text-ink-muted italic">
        Nothing here yet — pick recordings from the Inbox above and process them.
      </div>
    );
  }
  return (
    <div className="text-center py-16">
      <div className="text-4xl mb-4 opacity-40">◈</div>
      <div className="text-sm text-ink-muted max-w-sm mx-auto leading-relaxed">
        Hit <span className="font-semibold text-ink">Record</span> to start a new session,
        or drop an MP3 in{' '}
        <code className="text-xs bg-surface-sunken px-1 py-0.5 rounded">~/Music/Audio Hijack</code>.
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
