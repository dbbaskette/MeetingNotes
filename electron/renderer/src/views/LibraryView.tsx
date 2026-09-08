// electron/renderer/src/views/LibraryView.tsx
//
// Single unified list. Previously the view was split into an Inbox zone
// (pending recordings) and a Library zone (everything processed or in-
// flight). The two-zone split duplicated row rendering, filtering, and
// search logic; merging into one list with a "Pending" filter chip
// makes the whole catalog searchable and removes the conceptual split
// between "arrivals" and "meetings" — they're all meetings, some
// haven't started processing yet.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useMeetingsStore, useMeetingsPoll } from '../store/meetings';
import { LibraryRow } from '../components/LibraryRow';
import { VirtualMeetingList } from '../components/VirtualMeetingList';
import { RecordButton } from '../components/RecordButton';
import { LiveRecordingRow } from '../components/LiveRecordingRow';
import { MeetingDetectedBanner } from '../components/MeetingDetectedBanner';
import { NeedsAttentionPanel, type RecoveryInboxItem } from '../components/NeedsAttentionPanel';
import { SearchMatches, type SearchHit } from '../components/SearchMatches';
import { useToast } from '../components/Toasts';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { AppNav, type NavTarget } from '../components/AppNav';
import { Icon } from '../components/icons';
import { api } from '../ipc/client';
import { fmtDeletedAgo, type TrashedMeeting } from '../lib/trash-view';
import {
  librarySelection, hydrateSelection, runBulkDelete, runBulkProcess,
  selectionConfirmation, selectionScope,
} from '../lib/selection';
import {
  LIBRARY_SORT_OPTIONS, sanitizeSortKey, type LibrarySortKey,
} from '../lib/library-sort';
import { groupLibrarySearch, hydrateLibrarySearch, LIBRARY_SEARCH_LIMIT, startLibrarySearchHydration } from '../lib/library-search';
import { createAttentionController } from '../lib/meeting-hydration';
import { recycleMeetings } from '../lib/meetings-recycle';
import type { MeetingSummary } from '../lib/paged-meetings';
import type { PipelineStatusSnapshot } from '../lib/status-bar';
import { shouldPollLibrary } from '../lib/poll-gate';
import { shortcutMod } from '../lib/shortcut';
import logoUrl from '../assets/logo.png';
import type { LiveRecording } from '../App';

interface Props {
  /** When opening a meeting, pass through hint data so the detail
   *  view's skeleton can paint with the right title + stage instantly,
   *  before the full meetings:get IPC resolves. The optional
   *  `seekSeconds` is set when the user clicked a transcript snippet
   *  in the search results — the detail view should jump there. */
  onOpen: (
    id: string,
    hint: { title?: string; pipelineStage?: string; status?: string },
    opts?: { seekSeconds?: number },
  ) => void;
  /** Shared nav tabs (Library / Weekly / Settings) — routes through App's
   *  history-aware navigate(). 'library' never arrives (already active). */
  onNav: (target: NavTarget) => void;
  /** Opens the global ⌘K search palette. Surfaced as a hint inside this
   *  view's own inline search box so users discover the faster overlay
   *  instead of assuming this box is the only way to search. */
  onOpenSearch: () => void;
  /** Recording state is owned by App (so it survives view navigation).
   *  LibraryView just reads + notifies on start/stop. */
  liveRecording: LiveRecording | null;
  onStartRecording: (r: LiveRecording) => void;
  onRecordingStopped: (summary: string) => void;
}

type LibFilter = 'all' | 'pending' | 'processing' | 'done' | 'failed';

/** localStorage key for the browse-sort choice. Renderer-only preference —
 *  not worth an IPC round-trip to the settings repo. */
const SORT_STORAGE_KEY = 'librarySortKey';

export function LibraryView({
  onOpen, onNav, onOpenSearch, liveRecording, onStartRecording, onRecordingStopped,
}: Props): JSX.Element {
  const {
    items: meetings, counts, total, hasMore, loadingInitial, loadingMore,
    refreshing, error, query: pageQuery, setQuery: setPageQuery, refresh: refreshPages, invalidate: invalidatePages, loadMore, retry,
  } = useMeetingsStore();
  const [query, setQuery] = useState('');
  const [searchRevision, setSearchRevision] = useState(0);
  const { selected, resolving: resolvingSelection, busy: bulkBusy, mode: selectionMode } = useStore(librarySelection);
  const [libFilter, setLibFilter] = useState<LibFilter>('all');
  // Browse-mode sort. Persisted per machine in localStorage; sanitize on
  // read so a corrupt/stale value degrades to the default instead of
  // producing an option the dropdown doesn't have.
  const [sortKey, setSortKey] = useState<LibrarySortKey>(() => {
    try { return sanitizeSortKey(window.localStorage.getItem(SORT_STORAGE_KEY)); }
    catch { return 'newest'; }
  });
  const changeSort = (key: LibrarySortKey): void => {
    setSortKey(key);
    try { window.localStorage.setItem(SORT_STORAGE_KEY, key); }
    catch { /* private mode / quota — the choice just doesn't persist */ }
  };
  const toast = useToast();
  // Needs Attention remains global even when browse is filtered or only its
  // first page is loaded. Only actionable status IDs are hydrated, in capped
  // batches; buildNeedsAttention distinguishes speaker gates from processing.
  const [attentionMeetings, setAttentionMeetings] = useState<MeetingSummary[]>([]);
  const [attention] = useState(() => createAttentionController(api.meetings,
    (rows) => setAttentionMeetings((prev) => recycleMeetings(prev, rows))));
  const refresh = useCallback(async () => {
    await Promise.all([refreshPages(), attention.refresh()]);
    setSearchRevision((revision) => revision + 1);
  }, [refreshPages, attention]);
  const invalidate = useCallback(async () => {
    await Promise.all([invalidatePages(), attention.invalidate()]);
    setSearchRevision((revision) => revision + 1);
  }, [invalidatePages, attention]);
  useEffect(() => {
    void attention.start();
    return () => attention.stop();
  }, [attention]);
  const [recoveryItems, setRecoveryItems] = useState<RecoveryInboxItem[]>([]);
  const recoveryGeneration = useRef(0);
  const refreshRecovery = useCallback(async () => {
    const generation = ++recoveryGeneration.current;
    const update = (items: RecoveryInboxItem[]): void => {
      if (generation === recoveryGeneration.current) setRecoveryItems(items);
    };
    try { update(await api.recovery.list(update)); }
    catch { update([]); }
  }, []);
  useEffect(() => {
    void refreshRecovery();
    return () => { recoveryGeneration.current++; };
  }, [refreshRecovery]);
  useEffect(() => {
    let timer: number | undefined;
    const off = api.recording.onStateChange(({ state }) => {
      if (state === 'idle' || state === 'error') {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => { void refreshRecovery(); }, 800);
      }
    });
    return () => { off(); window.clearTimeout(timer); };
  }, [refreshRecovery]);

  // Recently deleted (trash). Fetched on mount and re-fetched after any
  // row mutation (delete / restore) — the main process purges expired
  // entries inside trash:list, so this list is always restorable.
  const [trash, setTrash] = useState<TrashedMeeting[]>([]);
  const refreshTrash = useCallback(async () => {
    try {
      setTrash(await api.trash.list());
    } catch { /* non-fatal — the section just stays hidden */ }
  }, []);
  useEffect(() => { void refreshTrash(); }, [refreshTrash]);

  // Pipeline queue state. Pushed from main on every change, plus an
  // initial pull on mount so the banner appears even if no events have
  // fired this session.
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatusSnapshot>({
    paused: false, currentId: null, queueLength: 0, queueIds: [],
  });
  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    void api.pipeline.status().then((snapshot) => {
      if (!cancelled && !receivedEvent) setPipelineStatus(snapshot);
    }).catch(() => { /* the next pushed status can recover */ });
    const off = api.pipeline.onStatusChange((s) => {
      receivedEvent = true;
      setPipelineStatus(s);
      // Queue motion is itself a reason to refresh — current meeting
      // moved, etc. Cheaper than waiting for the next poll tick.
      void invalidate();
    });
    return () => { cancelled = true; off(); };
  }, [invalidate]);

  // Push-refresh when main catalogs a freshly arrived recording. Stop()
  // resolves before chokidar's stability debounce fires, so the post-stop
  // refresh in LiveRecordingRow happens too early to see the new row.
  // Without this subscription the Library stayed stale until the user
  // navigated into a meeting and back (which remounted the view and
  // refreshed the first page). Now main pings us the instant the row exists.
  useEffect(() => {
    const off = api.meetings.onAdded(() => { void invalidate(); void refreshRecovery(); });
    return () => { off(); };
  }, [invalidate, refreshRecovery]);

  // Conditional polling. Gate on ACTUAL pipeline activity — the same
  // signal the bottom status bar shows (currentId / queueLength) — not on
  // the presence of pending/awaiting rows. A `pending` recording just sits
  // in the catalog until the user processes it, and an `awaiting_user`
  // meeting sits parked at the speaker-ID gate; neither changes on its own,
  // and both already surface via push (meetings:added, pipeline:status).
  // The previous gate counted those static rows as "motion", so a single
  // pending recording kept the 3s poll — and its speakers JOIN + per-meeting
  // action_items aggregate — running forever while the status bar read
  // "Ready". Now we poll only while something is truly in flight or a live
  // recording is running; everything else is push-driven or refreshed on
  // window-visibility regain.
  const hasMotion = useMemo(
    () => shouldPollLibrary(pipelineStatus, !!liveRecording),
    [pipelineStatus, liveRecording],
  );
  useEffect(() => {
    void setPageQuery({ filter: libFilter, sort: sortKey });
  }, [libFilter, sortKey, setPageQuery]);
  // A remount can reuse the same query after changes in the detail view.
  // The initial request is shared when setPageQuery just started it above.
  useEffect(() => { void refreshPages(); }, [refreshPages]);
  useMeetingsPoll(hasMotion);
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  // Full-content search. At 2+ chars we hit the same global IPC the
  // Cmd+K palette uses, which ripgreps summary.md + transcript.md across
  // the library. Debounced so a fast typist doesn't fire one IPC per
  // keystroke.
  const isSearching = query.trim().length >= 2;
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searchMeetings, setSearchMeetings] = useState<MeetingSummary[]>([]);
  const [searchPending, setSearchPending] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const previousSearchQuery = useRef('');
  useEffect(() => {
    if (!isSearching || previousSearchQuery.current !== query.trim()) {
      setHits([]);
      setSearchMeetings([]);
    }
    previousSearchQuery.current = query.trim();
    setSearchError(null);
    if (!isSearching) { setSearchPending(false); return; }
    let cancelled = false;
    setSearchPending(true);
    const t = window.setTimeout(async () => {
      try {
        const result = await hydrateLibrarySearch(query, { query: api.search.query, getMany: api.meetings.getMany });
        if (!cancelled) {
          setHits(result.hits);
          setSearchMeetings(result.meetings);
        }
      } catch (error) {
        if (!cancelled) setSearchError(error instanceof Error ? error.message : 'Unable to search meetings.');
      } finally {
        if (!cancelled) setSearchPending(false);
      }
    }, 150);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [query, isSearching, searchRevision]);

  // Browse polling cannot update these detached, globally hydrated rows.
  // Hold a summary-only poll on the same active cadence, including off-page
  // hits; suspend it while a replacement search result is being hydrated.
  useEffect(() => {
    if (!isSearching || !hasMotion || searchPending || hits.length === 0) return;
    return startLibrarySearchHydration(hits, api.meetings.getMany, (rows) => {
      setSearchMeetings((previous) => recycleMeetings(previous, rows));
    });
  }, [hits, isSearching, hasMotion, searchPending, query, searchRevision]);

  // Sort order for the Content section. Reset to 'recent' whenever the
  // query changes so a stale "Most matches" choice doesn't carry over
  // to a different search.
  const [contentSort, setContentSort] = useState<'recent' | 'count'>('recent');
  useEffect(() => { setContentSort('recent'); }, [query]);

  // Browse rows are already filtered/ordered by the server's cursor query.
  // Re-sorting a loaded subset here would break cross-page ordering.
  const browseList = meetings;
  const { titleMatches, contentMatches, hitsByMeeting, counts: searchCounts } = useMemo(
    () => groupLibrarySearch(hits, searchMeetings, libFilter, contentSort),
    [hits, searchMeetings, libFilter, contentSort],
  );
  const libCounts = isSearching ? searchCounts : counts;
  const scope = selectionScope({
    isSearching, filter: libFilter, loaded: meetings,
    searchResults: [...titleMatches, ...contentMatches], total,
  });
  const selectionUniverse = isSearching ? `search:${query.trim()}:${libFilter}` : `browse:${libFilter}`;
  const scopeReady = isSearching
    ? !searchPending && previousSearchQuery.current === query.trim()
    : !loadingInitial && pageQuery.filter === libFilter;
  useEffect(() => () => librarySelection.getState().cancelResolution(), [selectionUniverse]);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listRef.current?.scrollTo({ top: 0 }); }, [libFilter, sortKey, isSearching]);

  // Loaded pages never prune selection. Hydrate its exact IDs for status-only
  // partitioning, including off-page rows while the pipeline is moving.
  const [pendingSnapshot, setPendingSnapshot] = useState<{ selection: Set<string>; ids: string[] } | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let inflight = false;
    const hydrate = async (): Promise<void> => {
      if (inflight) return;
      inflight = true;
      try {
        const result = await hydrateSelection(selected, api.meetings.getMany);
        if (!cancelled) {
          setPendingSnapshot({ selection: selected, ids: result.pendingIds });
          setSelectionError(null);
        }
      } catch {
        if (!cancelled) {
          setPendingSnapshot(null);
          setSelectionError('Unable to check selected meetings. Retry Process to check again.');
        }
      } finally { inflight = false; }
    };
    void hydrate();
    const timer = hasMotion && selected.size > 0 ? window.setInterval(() => void hydrate(), 3000) : undefined;
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selected, meetings, searchMeetings, searchRevision, hasMotion]);
  const selectedPendingCount = pendingSnapshot?.selection === selected ? pendingSnapshot.ids.length : null;

  // Row callbacks are hoisted + stable (useCallback) so the memoized
  // LibraryRow doesn't see a fresh closure on every render — per-row
  // arrows here would put all 100+ rows back on the 3 s poll treadmill.
  const toggleSelect = useCallback((id: string): void => {
    if (!librarySelection.getState().busy) librarySelection.getState().toggle(id);
  }, []);

  const rowChanged = useCallback((): void => {
    void invalidate();
    void refreshTrash();
  }, [invalidate, refreshTrash]);

  const [confirmation, setConfirmation] = useState<ReturnType<typeof selectionConfirmation> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function selectMatching(): Promise<void> {
    try {
      await librarySelection.getState().selectMatching(selectionUniverse, () => scope.resolveIds(api.meetings.listIds));
    } catch {
      toast.show({ message: 'Unable to select matching meetings. Your previous selection is unchanged.', variant: 'error' });
    }
  }

  async function requestProcessSelected(): Promise<void> {
    const state = librarySelection.getState();
    if (state.selected.size === 0 || !state.beginOperation()) return;
    const snapshot = state.selected;
    try {
      // Refresh off-page statuses immediately before freezing the confirmation.
      const { pendingIds } = await hydrateSelection(snapshot, api.meetings.getMany);
      if (!mounted.current) return;
      setPendingSnapshot({ selection: snapshot, ids: pendingIds });
      setSelectionError(null);
      if (pendingIds.length > 0) setConfirmation(selectionConfirmation('process', pendingIds));
      else toast.show({ message: 'No selected recordings are pending.', durationMs: 4000 });
    } catch {
      toast.show({ message: 'Unable to check selected meetings. Nothing was started; retry Process.', variant: 'error' });
    } finally { librarySelection.getState().endOperation(); }
  }

  function requestDeleteSelected(): void {
    const state = librarySelection.getState();
    if (!state.busy && state.selected.size > 0) setConfirmation(selectionConfirmation('delete', [...state.selected]));
  }

  async function applyConfirmation(): Promise<void> {
    if (!confirmation || !librarySelection.getState().beginOperation()) return;
    const { action, ids } = confirmation;
    setConfirmation(null);
    try {
      const result = action === 'process'
        ? await runBulkProcess(ids, api.meetings.startManyDetailed)
        : await runBulkDelete(ids, api.meetings.delete);
      librarySelection.getState().removeSucceeded(result.succeededIds);
      const n = result.succeededIds.length;
      const failed = result.failedIds.length;
      const message = action === 'process'
        ? `Processing ${n} recording${n === 1 ? '' : 's'}…`
        : `${n} meeting${n === 1 ? '' : 's'} moved to Recently deleted`;
      toast.show({
        message: message + (failed > 0 ? ` ${failed} not ${action === 'process' ? 'started' : 'deleted'}; still selected for retry.` : ''),
        variant: failed > 0 ? 'error' : 'default',
        durationMs: action === 'delete' ? 10_000 : 4000,
        action: action === 'delete' && n > 0 ? {
          label: 'Undo',
          onClick: async () => {
            // Only successful deletions are undoable — never touch failed IDs.
            const restored = (await Promise.all(result.succeededIds.map((id) => api.meetings.undoDelete(id).catch(() => false)))).filter(Boolean).length;
            if (restored < n) toast.show({ message: `Restored ${restored} of ${n} — the rest were already purged.`, variant: 'error' });
            void invalidate();
            void refreshTrash();
          },
        } : undefined,
      });
    } finally {
      librarySelection.getState().endOperation();
      void invalidate();
      if (action === 'delete') void refreshTrash();
    }
  }

  return (
    // pt-8 (32px) at every width: the frameless window's drag strip covers the
    // top 28px, so smaller paddings put the header buttons under it and clicks
    // near their top edge dragged the window instead.
    <div className="relative h-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 flex flex-col">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header className="shrink-0 flex items-center gap-4 mb-8">
        <div className="flex items-center gap-2.5">
          <img src={logoUrl} alt="MeetingNotes" className="h-9 w-auto" />
          <h1 className="text-lg font-semibold tracking-tight">MeetingNotes</h1>
        </div>
        <AppNav active="library" onNav={onNav} />
        <div className="flex-1" />
        <RecordButton
          onStarted={({ sessionId, label, startInput }) => onStartRecording({
            sessionId, label, startInput, startedAt: new Date().toISOString(),
          })}
        />
      </header>

      {!liveRecording && (
        <div className="shrink-0">
          <MeetingDetectedBanner
            onStartRecording={({ sessionId, label, startInput }) => onStartRecording({
              sessionId, label, startInput, startedAt: new Date().toISOString(),
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
            onStopped={(summary) => {
              onRecordingStopped(summary);
              void invalidate();
              window.setTimeout(() => { void refreshRecovery(); }, 800);
            }}
            onRestarted={onStartRecording}
          />
        </div>
      )}

      <div className="shrink-0">
        <QueueBanner
          status={pipelineStatus}
          meetings={attentionMeetings}
          onChanged={() => void invalidate()}
          toast={toast}
        />
      </div>

      <NeedsAttentionPanel
        meetings={attentionMeetings}
        recovery={recoveryItems}
        onOpen={(id) => {
          const meeting = attentionMeetings.find((candidate) => candidate.id === id);
          onOpen(id, meeting ? {
            title: meeting.title, pipelineStage: meeting.pipelineStage, status: meeting.status,
          } : {});
        }}
        onChanged={async () => { await Promise.all([invalidate(), refreshRecovery()]); }}
      />


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
            dotClass="bg-danger-solid"
          />
          {/* Browse-order dropdown. Chip-shaped so it reads as part of the
              filter row. Disabled while a search is active — search results
              have their own ordering (score / the Content section's own
              Recent-vs-Most-matches toggle). */}
          <select
            value={sortKey}
            onChange={(e) => changeSort(sanitizeSortKey(e.target.value))}
            disabled={isSearching}
            aria-label="Sort meetings"
            title={isSearching ? 'Search results use match ordering' : 'Sort order for the list'}
            className="text-xs font-semibold px-2.5 py-1.5 rounded-full border border-surface-border
                       bg-surface text-ink-muted hover:text-ink hover:border-ink/30 transition
                       focus:outline-none focus:border-brand-indigo cursor-pointer
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {LIBRARY_SORT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
          <div className="relative flex-1 sm:flex-none sm:w-72 sm:ml-auto min-w-[8rem]">
            <input
              placeholder="Search titles, summaries, transcripts…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full py-1.5 px-3 pr-16 border border-surface-border rounded-lg text-sm bg-surface placeholder:text-ink-muted
                         focus:outline-none focus:border-brand-indigo focus:shadow-[0_0_0_3px_rgba(99,102,241,0.15)]"
            />
            {isSearching && searchPending ? (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] italic text-ink-muted pointer-events-none">
                searching…
              </span>
            ) : query.trim() === '' ? (
              // Only surface the palette hint while the box is idle — once the
              // user is typing/reading inline results, a shortcut to a separate
              // search overlay is noise, not help.
              <button
                type="button"
                onClick={onOpenSearch}
                aria-label="Open quick search"
                title="Open quick search (jump to any meeting, keyboard-navigable)"
                className="group absolute right-2 top-1/2 -translate-y-1/2"
              >
                <kbd className="text-[10px] font-mono text-ink-muted border border-surface-border rounded px-1.5 py-0.5
                               group-hover:border-brand-indigo group-hover:text-brand-indigo transition">
                  {shortcutMod()}K
                </kbd>
              </button>
            ) : null}
          </div>
        </div>

        {isSearching && (
          <p className="shrink-0 mb-2 text-[11px] text-ink-muted">
            Searching the entire Library. Showing up to {LIBRARY_SEARCH_LIMIT} matching hits; refine your search for more specific results.
          </p>
        )}

        <div className="shrink-0 flex flex-wrap items-center gap-x-4 gap-y-1 mb-2 text-xs">
          <button
            type="button"
            disabled={!scopeReady || scope.loadedIds.length === 0 || bulkBusy || resolvingSelection}
            className="text-ink-muted hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => librarySelection.getState().selectLoaded(scope.loadedIds.map((id) => ({ id })))}
          >
            Select all loaded
          </button>
          {scopeReady && scope.matchingCount !== null && (
            <button
              type="button"
              disabled={bulkBusy || resolvingSelection}
              className="text-brand-indigo hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => void selectMatching()}
            >
              {resolvingSelection ? 'Selecting…' : `Select all ${scope.matchingCount} matching`}
            </button>
          )}
          {selected.size > 0 && (
            <span className="text-[11px] text-ink-muted">
              {selectionMode === 'all-matching' ? 'Matching snapshot' : 'Selection'} stays fixed across pages, filters, and search.
            </span>
          )}
        </div>
        {selected.size > 0 && selectionError && <p role="status" className="shrink-0 mb-2 text-xs text-danger-text">{selectionError}</p>}

        {(() => {
          const totalShown = isSearching
            ? titleMatches.length + contentMatches.length
            : browseList.length;
          if (totalShown === 0) {
            if (isSearching ? searchPending : loadingInitial) {
              return <div role="status" className="py-10 text-center text-sm text-ink-muted">{isSearching ? 'Searching…' : 'Loading meetings…'}</div>;
            }
            const failure = isSearching ? searchError : error;
            if (failure) return <LibraryRetryRow message={failure} onRetry={isSearching ? () => setSearchRevision((revision) => revision + 1) : () => void retry()} />;
            return (
              <LibraryEmpty
                hasAny={counts.all > 0}
                filter={libFilter}
                query={query}
              />
            );
          }
          const renderRow = (m: typeof meetings[number], withMatches: boolean): JSX.Element => {
            const hint = {
              title: m.title,
              pipelineStage: m.pipelineStage,
              status: m.status,
            };
            const meetingHits = withMatches ? hitsByMeeting.get(m.id) ?? [] : [];
            return (
              <div key={m.id}>
                <LibraryRow
                  meeting={m}
                  onOpen={onOpen}
                  onChanged={rowChanged}
                  checked={selected.has(m.id)}
                  onToggle={toggleSelect}
                  selectionActive={selected.size > 0}
                />
                {meetingHits.length > 0 && (
                  <SearchMatches
                    hits={meetingHits}
                    query={query}
                    onOpen={() => onOpen(m.id, hint)}
                    onJump={(seconds) => onOpen(m.id, hint, { seekSeconds: seconds })}
                  />
                )}
              </div>
            );
          };
          // The key resets browse scroll on a new filter/sort, while refreshes
          // and appended pages preserve the existing viewport and focused row.
          if (!isSearching) return (
            <VirtualMeetingList
              key={`${libFilter}:${sortKey}`}
              items={browseList}
              renderRow={(m) => renderRow(m, false)}
              hasMore={hasMore}
              loadingMore={loadingMore}
              refreshing={refreshing}
              error={error}
              loadMore={loadMore}
              className={selected.size > 0 ? 'pb-28' : 'pb-8'}
              footer={error ? (
                <LibraryRetryRow message={error} onRetry={() => void retry()} />
              ) : (
                <div className="py-3 text-center text-xs text-ink-muted">
                  {loadingMore ? <span role="status">Loading more meetings…</span> : hasMore ? (
                    <button type="button" className="px-3 py-1.5 rounded-lg border border-surface-border hover:text-ink" onClick={() => void loadMore()}>
                      Load more ({meetings.length} of {total})
                    </button>
                  ) : <span>{meetings.length} of {total} meetings</span>}
                </div>
              )}
            />
          );
          return (
            <div
              ref={listRef}
              className={`flex-1 min-h-0 overflow-y-auto -mr-2 pr-2 space-y-2 ${
                // Extra clearance while the selection pill is docked over the
                // bottom of the list, so the last rows can scroll above it.
                selected.size > 0 ? 'pb-28' : 'pb-8'
              }`}
            >
              {titleMatches.length > 0 && (
                <SearchSectionHeader
                  label="Title matches"
                  count={titleMatches.length}
                />
              )}
              {titleMatches.map((m) => renderRow(m, false))}
              {contentMatches.length > 0 && (
                <SearchSectionHeader
                  label="Mentioned in"
                  count={contentMatches.length}
                  sort={contentSort}
                  onSortChange={setContentSort}
                />
              )}
              {contentMatches.map((m) => renderRow(m, true))}
              {searchError && <LibraryRetryRow message={searchError} onRetry={() => setSearchRevision((revision) => revision + 1)} />}
            </div>
          );
        })()}

        {/* Recently deleted — muted, collapsed by default, only when the
            trash is non-empty. Restore is the recovery path once the undo
            toast is gone; entries expire after the 30-day retention. */}
        <TrashSection
          trash={trash}
          onRestore={async (m) => {
            const restored = await api.meetings.undoDelete(m.id);
            if (restored) {
              toast.show({ message: `Restored "${m.title}"`, durationMs: 4000 });
            } else {
              toast.show({ message: 'Too late — this meeting has already been purged.', variant: 'error' });
            }
            void invalidate();
            void refreshTrash();
          }}
        />
      </section>

      {/* ── Bulk action bar (docked) ────────────────────────────────────── */}
      <SelectionBar
        count={selected.size}
        pendingCount={selectedPendingCount}
        busy={bulkBusy || resolvingSelection}
        onProcess={() => void requestProcessSelected()}
        onDelete={requestDeleteSelected}
        onCancel={() => librarySelection.getState().clear()}
      />

      {/* ── Bulk delete confirmation (#192) ─────────────────────────────── */}
      <ConfirmDialog
        open={confirmation !== null}
        title={confirmation?.title ?? ''}
        body={
          confirmation?.action === 'delete' ? <>
            Each meeting&rsquo;s audio file, transcript, summary, and any exports
            move to <strong>Recently deleted</strong>, restorable for 30 days.
          </> : <>Only these {confirmation?.ids.length ?? 0} selected pending recordings will be queued. Other selected meetings will stay selected.</>
        }
        confirmLabel={confirmation?.action === 'delete' ? 'Delete' : 'Process'}
        destructive={confirmation?.action === 'delete'}
        busy={bulkBusy}
        onConfirm={() => void applyConfirmation()}
        onCancel={() => setConfirmation(null)}
      />
    </div>
  );
}

// ─── Supporting pieces ─────────────────────────────────────────────────────

function LibraryRetryRow({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div role="alert" className="py-4 text-center text-sm text-ink-muted">
      <span>{message}</span>{' '}
      <button type="button" className="font-semibold text-brand-indigo underline" onClick={onRetry}>Retry</button>
    </div>
  );
}

/** Muted "Recently deleted (N)" affordance at the bottom of the Library.
 *  Collapsed by default; expanding lists the trashed meetings with a
 *  Restore button each. Renders nothing when the trash is empty — no
 *  permanent chrome for a state most sessions never enter. */
function TrashSection({
  trash, onRestore,
}: {
  trash: TrashedMeeting[];
  onRestore: (m: TrashedMeeting) => Promise<void>;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  if (trash.length === 0) return null;
  return (
    <div className="shrink-0 border-t border-surface-border pt-2 pb-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] text-ink-muted hover:text-ink transition px-1 py-1"
      >
        <svg
          viewBox="0 0 16 16"
          className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        Recently deleted ({trash.length})
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {trash.map((m) => (
            <div
              key={m.id}
              className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-sunken/40 border border-surface-border/60"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm text-ink-muted truncate">{m.title}</div>
                <div className="text-[11px] text-ink-muted/70">
                  Deleted {fmtDeletedAgo(m.deletedAt)}
                </div>
              </div>
              <button
                type="button"
                disabled={busyId === m.id}
                onClick={() => {
                  setBusyId(m.id);
                  void onRestore(m).finally(() => setBusyId(null));
                }}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-surface border border-surface-border text-ink-muted hover:text-ink hover:border-ink/40 transition disabled:opacity-50 shrink-0"
              >
                {busyId === m.id ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SearchSectionHeader({
  label, count, sort, onSortChange,
}: {
  label: string;
  count: number;
  /** Optional — only the Content section gets a sort toggle. */
  sort?: 'recent' | 'count';
  onSortChange?: (s: 'recent' | 'count') => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3 pt-2 first:pt-0 pb-1">
      <h3 className="font-mono text-[10px] tracking-[0.2em] uppercase text-ink-muted">
        {label}
      </h3>
      <span className="text-[11px] text-ink-muted/80 tabular-nums">{count}</span>
      <div className="flex-1 border-b border-surface-border" />
      {sort && onSortChange && (
        <div className="flex items-center gap-1 text-[10px] font-mono tracking-wider uppercase">
          <button
            onClick={() => onSortChange('recent')}
            className={`px-1.5 py-0.5 rounded ${sort === 'recent' ? 'bg-ink text-surface' : 'text-ink-muted hover:text-ink'}`}
          >
            Recent
          </button>
          <button
            onClick={() => onSortChange('count')}
            className={`px-1.5 py-0.5 rounded ${sort === 'count' ? 'bg-ink text-surface' : 'text-ink-muted hover:text-ink'}`}
          >
            Most matches
          </button>
        </div>
      )}
    </div>
  );
}

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
      <div className="flex justify-center mb-4 opacity-40">
        <Icon name="mic" className="w-10 h-10" />
      </div>
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
    ? 'bg-status-warnBg border-status-warn text-status-warnText'
    : 'bg-brand-indigo/5 border-brand-indigo/30 text-ink';
  const dotTone = status.paused
    ? 'bg-status-warn'
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
          className="text-xs font-semibold px-3 py-1.5 rounded-lg text-ink-muted hover:text-danger-text hover:bg-danger-bg transition shrink-0"
          title="Drop queued meetings (current one keeps running)"
        >
          Clear queue
        </button>
      )}
    </div>
  );
}

function SelectionBar({
  count, pendingCount, busy, onProcess, onDelete, onCancel,
}: {
  count: number;
  /** How many of the selected rows are pending — the Process target.
   *  Process is hidden when it's zero (nothing to start). */
  pendingCount: number | null;
  busy: boolean;
  onProcess: () => void;
  onDelete: () => void;
  onCancel: () => void;
}): JSX.Element {
  const visible = count > 0;
  // Anchored `absolute` to the LibraryView root (which fills the shell's
  // flex-1 slot), NOT `fixed` to the viewport — the app-wide status bar
  // occupies the bottom of the viewport and would paint over the pill's
  // bottom edge. The slot ends where the status bar begins, so bottom-0
  // here docks the pill just above it, whatever the status bar's height.
  return (
    <div
      aria-hidden={!visible}
      className={`
        absolute bottom-0 left-0 right-0 z-10 pointer-events-none
        transition-[transform,opacity] duration-200 ease-out
        ${visible ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0'}
      `}
    >
      <div className="px-4 sm:px-6 lg:px-8 pb-4">
        <div className="pointer-events-auto bg-ink text-surface rounded-xl shadow-pop flex items-center gap-3 px-4 py-3">
          <span className="text-sm font-semibold tabular-nums">
            {count} selected
          </span>
          <div className="flex-1" />
          <button
            onClick={onCancel}
            disabled={busy}
            className="text-sm text-surface/70 hover:text-surface px-3 py-1.5 rounded-lg hover:bg-surface/10 transition"
          >
            Cancel
          </button>
          <button
            onClick={onDelete}
            disabled={busy}
            className="text-sm font-semibold bg-danger-solid text-white px-4 py-1.5 rounded-lg hover:opacity-90 transition"
          >
            Delete ({count})
          </button>
          {(pendingCount === null || pendingCount > 0) && (
            <button
              onClick={onProcess}
              disabled={busy}
              title="Starts processing the pending recordings in the selection"
              className="text-sm font-semibold bg-brand-indigo text-white px-4 py-1.5 rounded-lg hover:bg-brand-indigo/90 transition inline-flex items-center gap-1.5"
            >
              <Icon name="play" className="w-3.5 h-3.5" />
              {pendingCount === null ? 'Check & process' : `Process (${pendingCount})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
