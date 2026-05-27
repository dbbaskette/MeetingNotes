// electron/renderer/src/views/LibraryView.tsx
//
// Single unified list. Previously the view was split into an Inbox zone
// (pending recordings) and a Library zone (everything processed or in-
// flight). The two-zone split duplicated row rendering, filtering, and
// search logic; merging into one list with a "Pending" filter chip
// makes the whole catalog searchable and removes the conceptual split
// between "arrivals" and "meetings" — they're all meetings, some
// haven't started processing yet.
import { useEffect, useMemo, useState } from 'react';
import { useMeetingsStore } from '../store/meetings';
import { LibraryRow } from '../components/LibraryRow';
import { RecordButton } from '../components/RecordButton';
import { LiveRecordingRow } from '../components/LiveRecordingRow';
import { MeetingDetectedBanner } from '../components/MeetingDetectedBanner';
import { useToast } from '../components/Toasts';
import { api } from '../ipc/client';
import type { LiveRecording } from '../App';

interface Props {
  /** When opening a meeting, pass through hint data so the detail
   *  view's skeleton can paint with the right title + stage instantly,
   *  before the full meetings:get IPC resolves. */
  onOpen: (
    id: string,
    hint: { title?: string; pipelineStage?: string; status?: string },
  ) => void;
  onSettings: () => void;
  onWeekly: () => void;
  /** Recording state is owned by App (so it survives view navigation).
   *  LibraryView just reads + notifies on start/stop. */
  liveRecording: LiveRecording | null;
  onStartRecording: (r: LiveRecording) => void;
  onRecordingStopped: () => void;
}

type LibFilter = 'all' | 'pending' | 'processing' | 'done' | 'failed';

interface PipelineStatusSnapshot {
  paused: boolean;
  currentId: string | null;
  queueLength: number;
  queueIds: string[];
}

export function LibraryView({
  onOpen, onSettings, onWeekly, liveRecording, onStartRecording, onRecordingStopped,
}: Props): JSX.Element {
  const { meetings, refresh } = useMeetingsStore();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [libFilter, setLibFilter] = useState<LibFilter>('all');
  const toast = useToast();

  // Pipeline queue state. Pushed from main on every change, plus an
  // initial pull on mount so the banner appears even if no events have
  // fired this session.
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatusSnapshot>({
    paused: false, currentId: null, queueLength: 0, queueIds: [],
  });
  useEffect(() => {
    void (async () => {
      const s = await api.pipeline.status();
      setPipelineStatus(s);
    })();
    const off = api.pipeline.onStatusChange((s) => {
      setPipelineStatus(s);
      // Queue motion is itself a reason to refresh — current meeting
      // moved, etc. Cheaper than waiting for the next poll tick.
      void refresh();
    });
    return () => { off(); };
  }, [refresh]);

  // Push-refresh when main catalogs a freshly arrived recording. Stop()
  // resolves before chokidar's stability debounce fires, so the post-stop
  // refresh in LiveRecordingRow happens too early to see the new row.
  // Without this subscription the Library stayed stale until the user
  // navigated into a meeting and back (which remounted the view and
  // re-ran meetings:list). Now main pings us the instant the row exists.
  useEffect(() => {
    const off = api.meetings.onAdded(() => { void refresh(); });
    return () => { off(); };
  }, [refresh]);

  // Conditional polling. The list only changes when the user is recording
  // or the pipeline is moving something through processing/awaiting_user/
  // pending. With 47 done meetings sitting around, the old "poll every 3 s
  // forever" path was a battery drain (every tick re-runs the JOIN over
  // speakers + the per-meeting action_items aggregate in handlers.ts).
  // Now we poll while there's actual motion, refresh once on window
  // visibility regain, and otherwise stay quiet until the user does
  // something that should re-fetch (e.g. processSelected below).
  const hasMotion = useMemo(
    () => !!liveRecording || meetings.some((m) =>
      m.status === 'pending' || m.status === 'processing' || m.status === 'awaiting_user',
    ),
    [meetings, liveRecording],
  );
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!hasMotion) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh, hasMotion]);
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
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
      : libFilter === 'pending'
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
    pending: meetings.filter((m) => m.status === 'pending').length,
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
    // Explicit confirmation — the row immediately re-sorts (pending → processing
    // moves it down the list to the in-flight bucket), which users often read
    // as "nothing happened". A toast makes the action unambiguous.
    toast.show({
      message: `Processing ${ids.length} recording${ids.length === 1 ? '' : 's'}…`,
      durationMs: 4000,
    });
    void refresh();
  }

  return (
    <div className="h-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 sm:pt-6 lg:pt-8 flex flex-col">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header className="shrink-0 flex items-center gap-4 mb-8">
        <div className="flex items-center gap-2.5">
          <div
            className="w-6 h-6 rounded-md"
            style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)' }}
          />
          <h1 className="text-lg font-semibold tracking-tight">MeetingNotes</h1>
        </div>
        <nav className="flex items-center gap-1 ml-4 text-sm">
          <button
            className="px-3 py-1.5 rounded-md bg-surface-sunken text-ink font-medium"
          >
            Library
          </button>
          <button
            onClick={onWeekly}
            className="px-3 py-1.5 rounded-md text-ink-muted hover:text-ink hover:bg-surface-sunken transition"
          >
            Weekly
          </button>
        </nav>
        <div className="flex-1" />
        <RecordButton onStarted={({ sessionId, label }) => onStartRecording({
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
        <div className="shrink-0">
          <MeetingDetectedBanner
            onStartRecording={({ sessionId, label }) => onStartRecording({
              sessionId, label, startedAt: new Date().toISOString(),
            })}
          />
        </div>
      )}

      {liveRecording && (
        <div className="shrink-0 mb-6">
          <LiveRecordingRow
            sessionId={liveRecording.sessionId}
            label={liveRecording.label}
            startedAt={liveRecording.startedAt}
            onStopped={() => { onRecordingStopped(); void refresh(); }}
          />
        </div>
      )}

      <div className="shrink-0">
        <QueueBanner
          status={pipelineStatus}
          meetings={meetings}
          onChanged={() => void refresh()}
          toast={toast}
        />
      </div>


      {/* ── LIBRARY (unified list) ──────────────────────────────────────── */}
      {/* Section becomes the height-bounded flex column. Header + filter
          chips stay pinned via `shrink-0`; only the meeting rows below
          scroll, so the user never loses the chips/search while paging
          through hundreds of meetings. */}
      <section className="flex-1 min-h-0 flex flex-col">
        <div className="shrink-0 flex items-baseline gap-3 mb-3">
          <h2 className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted">
            Library
          </h2>
          <span className="text-[11px] text-ink-muted">
            {libCounts.all} {libCounts.all === 1 ? 'meeting' : 'meetings'}
          </span>
        </div>

        {/* Filter chips — always rendered so the surface is discoverable
            even on a fresh install; chips with a zero count are disabled
            (greyed + non-clickable) rather than hidden, which keeps the
            row visually stable as state evolves. Search yields width
            first on narrow via flex-1. */}
        <div className="shrink-0 flex items-center flex-wrap gap-2 mb-3">
          <FilterChip
            active={libFilter === 'all'}
            onClick={() => setLibFilter('all')}
            label="All"
            n={libCounts.all}
          />
          <FilterChip
            active={libFilter === 'pending'}
            onClick={() => setLibFilter('pending')}
            label="Pending"
            n={libCounts.pending}
            dotClass="bg-ink-muted"
          />
          <FilterChip
            active={libFilter === 'processing'}
            onClick={() => setLibFilter('processing')}
            label="Processing"
            n={libCounts.processing}
            dotClass={libCounts.processing > 0 ? 'bg-brand-indigo animate-pulse' : 'bg-brand-indigo'}
          />
          <FilterChip
            active={libFilter === 'done'}
            onClick={() => setLibFilter('done')}
            label="Processed"
            n={libCounts.done}
            dotClass="bg-status-ok"
          />
          <FilterChip
            active={libFilter === 'failed'}
            onClick={() => setLibFilter('failed')}
            label="Failed"
            n={libCounts.failed}
            dotClass="bg-rose-500"
          />
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
          // The negative-margin/padding pair on the right pushes the
          // scrollbar into the outer page margin so rows stay flush with
          // the filter chips above them. Bottom pb-8 keeps the last row
          // from sitting flush against the SelectionBar's overlay.
          <div className="flex-1 min-h-0 overflow-y-auto -mr-2 pr-2 pb-8 space-y-2">
            {library.map((m) => (
              <LibraryRow
                key={m.id}
                meeting={m}
                onOpen={(id) => onOpen(id, {
                  title: m.title,
                  pipelineStage: m.pipelineStage,
                  status: m.status,
                })}
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
  const disabled = n === 0 && !active;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
      className={`
        inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full
        transition border
        ${active
          ? 'bg-ink text-surface border-ink'
          : disabled
            ? 'bg-surface text-ink-muted/60 border-surface-border opacity-50 cursor-not-allowed'
            : 'bg-surface text-ink-muted border-surface-border hover:text-ink hover:border-ink/30'}
      `}
    >
      {dotClass && <span className={`w-1.5 h-1.5 rounded-full ${dotClass} ${disabled ? 'opacity-50' : ''}`} />}
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
    return (
      <div className="text-center py-10 text-sm text-ink-muted">
        No {filter} meetings.
      </div>
    );
  }
  return (
    <div className="text-center py-16">
      <div className="text-4xl mb-4 opacity-40">◈</div>
      <div className="text-sm text-ink-muted max-w-sm mx-auto leading-relaxed">
        Hit <span className="font-semibold text-ink">Record</span>{' '}
        <kbd className="font-mono text-[10px] px-1 py-0.5 border border-surface-border rounded text-ink-muted">⌘R</kbd>{' '}
        to start a new session,
        or drag an audio file (.m4a, .mp3, .wav) onto this window.
      </div>
    </div>
  );
}

/** Live status of the pipeline queue. Renders only when there's
 *  actual activity (current meeting in flight, or queued items) — no
 *  permanent chrome on a quiet library.
 *
 *  Three buttons:
 *    Pause       — stop pulling new items off the queue. The currently
 *                  in-flight meeting keeps going (we deliberately don't
 *                  abort mid-stage so long whisper / pyannote calls
 *                  aren't wasted).
 *    Resume      — start pulling again. Visible only while paused.
 *    Clear queue — drop everything that hasn't started yet. Cleared
 *                  meetings flip back to 'pending' so the user can see
 *                  them and decide whether to re-process. The current
 *                  in-flight meeting is NOT touched.
 */
function QueueBanner({
  status, meetings, onChanged, toast,
}: {
  status: PipelineStatusSnapshot;
  meetings: { id: string; title: string }[];
  onChanged: () => void;
  toast: ReturnType<typeof useToast>;
}): JSX.Element | null {
  const titleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of meetings) m.set(x.id, x.title);
    return m;
  }, [meetings]);

  // Hide entirely when nothing is in flight or waiting. Avoids
  // permanent chrome — the banner only appears when the user actually
  // needs to make a decision.
  if (!status.currentId && status.queueLength === 0) return null;

  const currentTitle = status.currentId ? (titleById.get(status.currentId) ?? '…') : null;

  async function pause(): Promise<void> {
    await api.pipeline.pause();
    toast.show({ message: 'Queue paused — current meeting will finish, then stop.', durationMs: 3500 });
  }
  async function resume(): Promise<void> {
    await api.pipeline.resume();
  }
  async function clear(): Promise<void> {
    const r = await api.pipeline.clear();
    toast.show({
      message: r.cleared.length > 0
        ? `Cleared ${r.cleared.length} from queue. Current meeting still finishing.`
        : 'Queue was already empty.',
      durationMs: 4000,
    });
    onChanged();
  }

  const queuedCount = status.queueLength;
  const tone = status.paused
    ? 'bg-amber-50 border-amber-200 text-amber-900'
    : 'bg-brand-indigo/5 border-brand-indigo/30 text-ink';
  const dotTone = status.paused
    ? 'bg-amber-500'
    : 'bg-brand-indigo animate-pulse';

  return (
    <div className={`mb-4 rounded-xl border px-4 py-3 flex items-center gap-3 ${tone}`}>
      <span className={`w-2 h-2 rounded-full shrink-0 ${dotTone}`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold truncate">
          {status.paused
            ? (status.currentId
              ? <>Paused — finishing <span className="opacity-80">"{currentTitle}"</span></>
              : <>Paused</>
            )
            : (status.currentId
              ? <>Processing <span className="opacity-80">"{currentTitle}"</span></>
              : <>Queue holding</>
            )}
        </div>
        {queuedCount > 0 && (
          <div className="text-[11px] text-ink-muted mt-0.5">
            {queuedCount} more {queuedCount === 1 ? 'meeting' : 'meetings'} queued{status.paused ? ' — won’t start until you resume' : ''}.
          </div>
        )}
      </div>
      {status.paused ? (
        <button
          onClick={() => void resume()}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-ink text-surface hover:opacity-90 transition shrink-0"
        >
          Resume
        </button>
      ) : (
        <button
          onClick={() => void pause()}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-surface border border-surface-border text-ink hover:border-ink/40 transition shrink-0"
        >
          Pause
        </button>
      )}
      {queuedCount > 0 && (
        <button
          onClick={() => void clear()}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg text-ink-muted hover:text-rose-700 hover:bg-rose-50 transition shrink-0"
          title="Drop queued meetings (current one keeps running)"
        >
          Clear queue
        </button>
      )}
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
