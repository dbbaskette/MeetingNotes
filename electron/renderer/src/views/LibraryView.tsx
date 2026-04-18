// electron/renderer/src/views/LibraryView.tsx
import { useEffect, useMemo, useState } from 'react';
import { useMeetingsStore } from '../store/meetings';
import { MeetingCard } from '../components/MeetingCard';
import { RecordButton } from '../components/RecordButton';
import { api } from '../ipc/client';

interface Props {
  onOpen: (id: string) => void;
  onSettings: () => void;
}

export function LibraryView({ onOpen, onSettings }: Props): JSX.Element {
  const { meetings, refresh } = useMeetingsStore();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  // Drop stale selections — when a meeting transitions out of 'pending' we
  // shouldn't leave it checked. Keeps the bulk action count honest.
  useEffect(() => {
    const eligible = new Set(
      meetings.filter((m) => m.status === 'pending' || m.status === 'failed').map((m) => m.id),
    );
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (eligible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [meetings]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? meetings.filter((m) => m.title.toLowerCase().includes(q)) : meetings;
    const rank: Record<string, number> = { failed: 0, pending: 1, processing: 2, done: 3 };
    return [...filtered].sort((a, b) => {
      const ra = rank[a.status] ?? 4;
      const rb = rank[b.status] ?? 4;
      if (ra !== rb) return ra - rb;
      return (b.startedAt ?? '').localeCompare(a.startedAt ?? '');
    });
  }, [meetings, query]);

  const counts = useMemo(() => ({
    pending: meetings.filter((m) => m.status === 'pending').length,
    processing: meetings.filter((m) => m.status === 'processing').length,
    done: meetings.filter((m) => m.status === 'done').length,
    failed: meetings.filter((m) => m.status === 'failed').length,
  }), [meetings]);

  const selectMode = selected.size > 0;
  const pendingIds = useMemo(
    () => meetings.filter((m) => m.status === 'pending').map((m) => m.id),
    [meetings],
  );

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

  async function processAllPending(): Promise<void> {
    if (pendingIds.length === 0) return;
    setSelected(new Set());
    await api.meetings.startMany(pendingIds);
    void refresh();
  }

  return (
    <div className="max-w-5xl mx-auto p-8 pb-24">
      {/* Header */}
      <div className="flex items-center gap-4 mb-4">
        <h1 className="text-lg font-semibold tracking-tight flex-1">MeetingNotes</h1>
        <RecordButton sessionName="Meeting" />
        <button
          onClick={onSettings}
          aria-label="Settings"
          className="text-ink-muted hover:text-ink px-2 py-1 rounded-lg hover:bg-surface-sunken transition"
        >
          ⚙
        </button>
      </div>

      {/* Status counters — the app's pulse at a glance */}
      <div className="flex items-center gap-5 text-xs text-ink-muted mb-4 py-2 border-y border-surface-border">
        <Counter n={counts.pending} label="pending" dotClass="bg-status-warn" />
        <Counter n={counts.processing} label="processing" dotClass="bg-brand-indigo animate-pulse" />
        <Counter n={counts.done} label="done" dotClass="bg-status-ok" />
        {counts.failed > 0 && (
          <Counter n={counts.failed} label="failed" dotClass="bg-rose-500" />
        )}
        <div className="flex-1" />
        {counts.pending > 0 && !selectMode && (
          <button
            onClick={processAllPending}
            className="text-xs font-semibold text-brand-indigo hover:underline"
          >
            Process all pending →
          </button>
        )}
      </div>

      <input
        placeholder="Search meetings…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full p-3 border border-surface-border rounded-xl mb-4 text-sm bg-surface placeholder:text-ink-muted
                   focus:outline-none focus:border-brand-indigo focus:shadow-[0_0_0_3px_rgba(99,102,241,0.15)]"
      />

      {visible.length === 0 && (
        <EmptyState hasMeetings={meetings.length > 0} />
      )}

      <div className="space-y-2">
        {visible.map((m) => (
          <MeetingCard
            key={m.id}
            meeting={m}
            onOpen={onOpen}
            selected={selected.has(m.id)}
            selectMode={selectMode}
            onToggleSelect={toggleSelect}
          />
        ))}
      </div>

      {/* Sticky bulk-action bar */}
      <SelectionBar
        count={selected.size}
        onProcess={processSelected}
        onCancel={() => setSelected(new Set())}
      />
    </div>
  );
}

function Counter({ n, label, dotClass }: { n: number; label: string; dotClass: string }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
      <span className="font-semibold text-ink tabular-nums">{n}</span>
      <span>{label}</span>
    </div>
  );
}

function EmptyState({ hasMeetings }: { hasMeetings: boolean }): JSX.Element {
  if (hasMeetings) {
    return (
      <div className="text-ink-muted text-sm py-12 text-center">
        No meetings match your search.
      </div>
    );
  }
  return (
    <div className="text-center py-16">
      <div className="text-4xl mb-4 opacity-40">◈</div>
      <div className="text-sm text-ink-muted max-w-sm mx-auto leading-relaxed">
        Hit <span className="font-semibold text-ink">Record</span> to start a new session,
        or drop an MP3 in <code className="text-xs bg-surface-sunken px-1 py-0.5 rounded">~/Music/Audio Hijack</code>.
      </div>
    </div>
  );
}

function SelectionBar({
  count,
  onProcess,
  onCancel,
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
            ▶ Process {count} {count === 1 ? 'meeting' : 'meetings'}
          </button>
        </div>
      </div>
    </div>
  );
}
