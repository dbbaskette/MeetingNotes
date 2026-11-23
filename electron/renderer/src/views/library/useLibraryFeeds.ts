// electron/renderer/src/views/library/useLibraryFeeds.ts
//
// Data feeds the Library view subscribes to (Needs attention, Obsidian sync,
// recovery inbox, trash, pipeline queue) and the triggers that refresh them.
// Moved out of LibraryView.tsx unchanged (#256): each hook holds a contiguous
// run of the view's former hooks and is called at the same position, so hook
// order, effect order and dependency arrays are as before.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMeetingsPoll } from '../../store/meetings';
import type { RecoveryInboxItem } from '../../components/NeedsAttentionPanel';
import { obsidianAttention, type ObsidianAttention } from '../../lib/obsidian-attention';
import { api } from '../../ipc/client';
import type { TrashedMeeting } from '../../lib/trash-view';
import { librarySelection } from '../../lib/selection';
import type { LibrarySortKey } from '../../lib/library-sort';
import { createAttentionController } from '../../lib/meeting-hydration';
import { retainInboxOnFailure } from '../../lib/needs-attention';
import { recycleMeetings } from '../../lib/meetings-recycle';
import type { MeetingSummary, PagedMeetingsState } from '../../lib/paged-meetings';
import { pipelineQueueKey, type PipelineStatusSnapshot } from '../../lib/status-bar';
import { shouldPollLibrary } from '../../lib/poll-gate';
import type { LiveRecording } from '../../App';
import type { LibFilter } from './types';

/** Escape clears the Library selection while the view is active. */
export function useEscapeClearsSelection(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[role="dialog"][aria-modal="true"],[role="menu"]')) return;
      if ((event.target as HTMLElement)?.closest('input,textarea,select,[contenteditable="true"]')) return;
      const state = librarySelection.getState();
      if (state.busy) return;
      state.clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}

// Needs Attention remains global even when browse is filtered or only its
// first page is loaded. Only actionable status IDs are hydrated, in capped
// batches; buildNeedsAttention distinguishes speaker gates from processing.
export function useAttentionController() {
  const [attentionMeetings, setAttentionMeetings] = useState<MeetingSummary[]>([]);
  const [attentionError, setAttentionError] = useState<string | null>(null);
  const [attention] = useState(() => createAttentionController(
    {
      listIds: api.meetings.listIds,
      getMany: (ids) => api.meetings.getMany(ids, { shell: true }),
    },
    (rows) => setAttentionMeetings((prev) => recycleMeetings(prev, rows)),
    setAttentionError,
  ));
  return { attentionMeetings, attentionError, attention };
}

// Obsidian sync trouble (vault unavailable, notes paused by an external
// edit) shows in Needs attention. Read when the Library becomes active and
// once a minute while it stays so; a fake bridge without `obsidian` (UI
// fixtures) simply reports nothing.
export function useObsidianSyncAttention(active: boolean): ObsidianAttention | null {
  const [syncAttention, setSyncAttention] = useState<ObsidianAttention | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const read = (): void => {
      const status = (api as Partial<typeof api>).obsidian?.status?.();
      void status?.then((value) => { if (alive) setSyncAttention(obsidianAttention(value)); }).catch(() => { /* not a Library error */ });
    };
    read();
    const timer = window.setInterval(() => { if (!document.hidden) read(); }, 60_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [active]);
  return syncAttention;
}

export function useRecoveryInbox() {
  const [recoveryItems, setRecoveryItems] = useState<RecoveryInboxItem[]>([]);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const recoveryGeneration = useRef(0);
  const refreshRecovery = useCallback(async () => {
    const generation = ++recoveryGeneration.current;
    const update = (items: RecoveryInboxItem[]): void => {
      if (generation === recoveryGeneration.current) {
        setRecoveryItems(items);
        setRecoveryError(null);
      }
    };
    try { update(await api.recovery.list(update)); }
    catch (error) {
      if (generation !== recoveryGeneration.current) return;
      setRecoveryError(retainInboxOnFailure([], error).error);
    }
  }, []);
  useEffect(() => {
    void refreshRecovery();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the ref is a request counter; cleanup must read its latest value
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
  return { recoveryItems, recoveryError, refreshRecovery };
}

// Recently deleted (trash). Fetched on mount and re-fetched after any
// row mutation (delete / restore) — the main process purges expired
// entries inside trash:list, so this list is always restorable.
export function useTrash() {
  const [trash, setTrash] = useState<TrashedMeeting[]>([]);
  const refreshTrash = useCallback(async () => {
    try {
      setTrash(await api.trash.list());
    } catch { /* non-fatal — the section just stays hidden */ }
  }, []);
  useEffect(() => { void refreshTrash(); }, [refreshTrash]);
  return { trash, refreshTrash };
}

// Pipeline queue state. Pushed from main on every change, plus an
// initial pull on mount so the banner appears even if no events have
// fired this session.
export function usePipelineStatus(active: boolean, invalidate: () => Promise<void>): PipelineStatusSnapshot {
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatusSnapshot>({
    paused: false, currentId: null, queueLength: 0, queueIds: [],
  });
  const lastQueueKey = useRef('');
  const activeRef = useRef(active);
  activeRef.current = active;
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
      // moved, etc. Progress ticks arrive on the same channel about a
      // hundred times per meeting and are not: the poll covers those. A
      // hidden Library skips the refresh too; it invalidates on return.
      const key = pipelineQueueKey(s);
      if (key === lastQueueKey.current) return;
      lastQueueKey.current = key;
      if (activeRef.current) void invalidate();
    });
    return () => { cancelled = true; off(); };
  }, [invalidate]);
  return pipelineStatus;
}

/** Push, poll and visibility triggers that keep the Library's projections
 *  fresh. Returns `hasMotion` (true while the pipeline or a live recording is
 *  actually moving). */
export function useLibraryRefreshTriggers({
  active, liveRecording, pipelineStatus, organizedFull, libFilter, sortKey, groupId,
  setPageQuery, invalidate, refresh, refreshRecovery,
}: {
  active: boolean;
  liveRecording: LiveRecording | null;
  pipelineStatus: PipelineStatusSnapshot;
  organizedFull: boolean;
  libFilter: LibFilter;
  sortKey: LibrarySortKey;
  groupId: string | null | undefined;
  setPageQuery: PagedMeetingsState['setQuery'];
  invalidate: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshRecovery: () => Promise<void>;
}): boolean {
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
    void setPageQuery({ filter: libFilter, sort: sortKey, groupId });
  }, [libFilter, sortKey, groupId, setPageQuery]);
  // App retains the Library while details are open. Refresh every projection
  // on return, including expanded group pages, search and Needs attention.
  // Invalidation also fences any request that began before the detail edit.
  // The mount itself already issues one fetch per source (setPageQuery,
  // attention.start, refreshGroups), so the first active run must not
  // invalidate and double them all (#301).
  const firstActiveRun = useRef(true);
  useEffect(() => {
    const first = firstActiveRun.current;
    firstActiveRun.current = false;
    if (active && !first) void invalidate();
  }, [active, invalidate]);
  // The organized overview never renders the flat list; its group sections
  // refresh on queue changes via `invalidate`. Polling flat pages there only
  // refreshed chip counts, which those same pushes already cover (#301).
  useMeetingsPoll(active && hasMotion && !organizedFull);
  // When a recording ends, from any view or by itself (the pill on other
  // views, an auto-stop), refresh the list and the recovery inbox. Stopping
  // from outside the Library used to leave both stale (#297). The delay lets
  // the watcher catalog the finished file.
  const wasRecording = useRef(false);
  useEffect(() => {
    const ended = wasRecording.current && !liveRecording;
    wasRecording.current = !!liveRecording;
    if (!ended) return;
    void invalidate();
    const timer = window.setTimeout(() => { void refreshRecovery(); void invalidate(); }, 800);
    return () => window.clearTimeout(timer);
  }, [liveRecording, invalidate, refreshRecovery]);
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);
  return hasMotion;
}
