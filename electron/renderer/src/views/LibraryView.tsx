// electron/renderer/src/views/LibraryView.tsx
//
// Single unified list. Previously the view was split into an Inbox zone
// (pending recordings) and a Library zone (everything processed or in-
// flight). The two-zone split duplicated row rendering, filtering, and
// search logic; merging into one list with a "Pending" filter chip
// makes the whole catalog searchable and removes the conceptual split
// between "arrivals" and "meetings" — they're all meetings, some
// haven't started processing yet.
//
// Hooks and presentational pieces live in ./library/ (#256). Each extracted
// hook is called at the position its code used to occupy, so hook order,
// effect order and dependency arrays are unchanged.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { useMeetingsStore } from '../store/meetings';
import { RecordButton } from '../components/RecordButton';
import { GroupBrief } from '../components/GroupBrief';
import { MoveToGroupDialog } from '../components/MoveToGroupDialog';
import { LiveRecordingRow } from '../components/LiveRecordingRow';
import { MeetingDetectedBanner } from '../components/MeetingDetectedBanner';
import { NeedsAttentionPanel } from '../components/NeedsAttentionPanel';
import { useToast } from '../components/Toasts';
import { useGroupsStore } from '../store/groups';
import { ConfirmDialog } from '../components/ConfirmDialog';
import type { NavTarget } from '../components/AppNav';
import { AppHeader } from '../components/AppHeader';
import { useMenuKeyboard } from '../lib/menu-keyboard';
import { api } from '../ipc/client';
import { librarySelection, selectionScope } from '../lib/selection';
import { sanitizeSortKey, type LibrarySortKey } from '../lib/library-sort';
import { groupLibrarySearch, LIBRARY_SEARCH_LIMIT } from '../lib/library-search';
import { SearchFilters } from '../components/SearchFilters';
import type { SearchFacets } from '../../../shared/search';
import { arrivalBaseline } from '../lib/new-arrivals';
import {readBrowsePreferences,saveBrowsePreferences} from '../lib/library-browse-preferences';
import { organizedSections } from '../lib/organized-sections';
import type { MeetingSummary } from '../lib/paged-meetings';
import type { LiveRecording } from '../App';
import {
  selectLibraryPage, SORT_STORAGE_KEY, VIEW_STORAGE_KEY,
  type GroupDialogMode, type LibFilter, type LibraryOpen,
} from './library/types';
import { GroupNameDialog, LibraryRetryRow, TrashSection } from './library/LibraryWidgets';
import { QueueBanner } from './library/QueueBanner';
import { SelectionBar } from './library/SelectionBar';
import { LibraryFilterBar, LibraryHeaderRow } from './library/LibraryToolbar';
import { LibraryResults } from './library/LibraryResults';
import {
  useAttentionController, useEscapeClearsSelection, useLibraryRefreshTriggers, useObsidianSyncAttention,
  usePipelineStatus, useRecoveryInbox, useTrash,
} from './library/useLibraryFeeds';
import { useLibrarySearch } from './library/useLibrarySearch';
import { useBulkSelectionActions, useSelectionPending } from './library/useLibrarySelection';

interface Props {
  active?: boolean;
  /** When opening a meeting, pass through hint data so the detail
   *  view's skeleton can paint with the right title + stage instantly,
   *  before the full meetings:get IPC resolves. The optional
   *  `seekSeconds` is set when the user clicked a transcript snippet
   *  in the search results — the detail view should jump there. */
  onOpen: LibraryOpen;
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

export function LibraryView({
  active = true, onOpen, onNav, onOpenSearch, liveRecording, onStartRecording, onRecordingStopped,
}: Props): JSX.Element {
  // Shallow-selected, and deliberately without `refreshing`: that flag flips
  // twice on every 3 s poll, and subscribing to it here re-rendered the whole
  // Library even when the poll changed nothing (#301). FlatMeetingList below
  // is the only reader.
  const {
    items: meetings, counts, total, hasMore, loadingInitial, loadingMore,
    error, query: pageQuery, setQuery: setPageQuery, refresh: refreshPages, invalidate: invalidatePages, loadMore, retry,
  } = useMeetingsStore(useShallow(selectLibraryPage));
  const [facets,setFacets]=useState<SearchFacets>({});
  const [prepareGroupId, setPrepareGroupId] = useState<string | null>(null);
  const searchClientId=useRef(`library-${crypto.randomUUID()}`),searchRequestId=useRef(0);
  const [searchCompletion,setSearchCompletion]=useState<string|null>(null);
  const [newBaseline, setNewBaseline] = useState(arrivalBaseline);
  const [query, setQuery] = useState('');
  useEscapeClearsSelection(active);
  const [searchRevision, setSearchRevision] = useState(0);
  const { selected, resolving: resolvingSelection, busy: bulkBusy, mode: selectionMode } = useStore(librarySelection);
  const [browsePreferences]=useState(readBrowsePreferences);
  const [libFilter, setLibFilter] = useState<LibFilter>(browsePreferences.filter);
  const [groupId, setGroupId] = useState<string | null | undefined>(browsePreferences.groupId);
  useEffect(()=>saveBrowsePreferences(libFilter,groupId),[libFilter,groupId]);
  const [viewMode, setViewMode] = useState<'organized' | 'flat'>(() => {
    try { return window.localStorage.getItem(VIEW_STORAGE_KEY) === 'flat' ? 'flat' : 'organized'; }
    catch { return 'organized'; }
  });
  const { groups, ungroupedCount, ungroupedStatus, loaded: groupsLoaded, error: groupsError,
    refresh: refreshGroups, create: createGroup, rename: renameGroup, delete: deleteGroup } = useGroupsStore();
  const [groupDialog, setGroupDialog] = useState<GroupDialogMode | null>(null);
  const [targetGroupId, setTargetGroupId] = useState<string | null>(null);
  const [revealGroupId, setRevealGroupId] = useState<string | null>(null);
  const [organizedSnapshot, setOrganizedSnapshot] = useState<{ key: string; rows: MeetingSummary[] } | null>(null);
  const [groupOptionsOpen, setGroupOptionsOpen] = useState(false);
  const groupOptionsRef = useRef<HTMLDivElement>(null);
  const groupOptionsButtonRef = useRef<HTMLButtonElement>(null);
  const groupOptionsMenuRef = useRef<HTMLDivElement>(null);
  const closeGroupOptions = useCallback(() => setGroupOptionsOpen(false), []);
  useMenuKeyboard(groupOptionsMenuRef, groupOptionsButtonRef, groupOptionsOpen, closeGroupOptions);
  const [moveSelection, setMoveSelection] = useState<{ ids: string[]; hiddenCount: number; meeting?: {title:string;groupId:string|null;groupName?:string|null} } | null>(null);
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const activeGroup = groupId ? groups.find((group) => group.id === groupId) : undefined;
  const targetGroup = targetGroupId ? groups.find((group) => group.id === targetGroupId) : undefined;
  const sections = useMemo(() => organizedSections(groups, ungroupedCount, ungroupedStatus), [groups, ungroupedCount, ungroupedStatus]);
  const organizedFull = viewMode === 'organized' && groupId === undefined;
  const scopeName = groupId === undefined ? 'the entire Library' : groupId === null ? 'Ungrouped' : activeGroup?.name ?? 'this group';
  const changeGroup = useCallback((next: string | null | undefined): void => {
    setGroupId(next);
    setOrganizedSnapshot(null);
  }, []);
  const changeViewMode = (next: 'organized' | 'flat'): void => {
    setViewMode(next);
    setOrganizedSnapshot(null);
    try { window.localStorage.setItem(VIEW_STORAGE_KEY, next); }
    catch { /* view remains selected for this session */ }
  };
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
  useEffect(() => {
    if (!groupOptionsOpen) return;
    const onDown = (event: MouseEvent): void => {
      if (!groupOptionsRef.current?.contains(event.target as Node)) setGroupOptionsOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setGroupOptionsOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [groupOptionsOpen]);
  useEffect(() => { void refreshGroups(); }, [refreshGroups]);
  useEffect(() => {
    if (groupsLoaded && !groupsError && groupId && !activeGroup) {
      changeGroup(undefined);
      toast.show({ message: 'That group is no longer available. Showing all meetings.' });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- depends on the stable `toast.show`, not the toast object
  }, [groupsLoaded, groupsError, groupId, activeGroup, changeGroup, toast.show]);
  const { attentionMeetings, attentionError, attention } = useAttentionController();
  const refresh = useCallback(async () => {
    await Promise.all([refreshPages(), attention.refresh(), refreshGroups()]);
    setSearchRevision((revision) => revision + 1);
  }, [refreshPages, attention, refreshGroups]);
  const invalidate = useCallback(async () => {
    await Promise.all([invalidatePages(), attention.invalidate(), refreshGroups()]);
    setSearchRevision((revision) => revision + 1);
  }, [invalidatePages, attention, refreshGroups]);
  useEffect(() => {
    void attention.start();
    return () => attention.stop();
  }, [attention]);
  const syncAttention = useObsidianSyncAttention(active);
  const { recoveryItems, recoveryError, refreshRecovery } = useRecoveryInbox();
  const { trash, refreshTrash } = useTrash();
  const pipelineStatus = usePipelineStatus(active, invalidate);
  const hasMotion = useLibraryRefreshTriggers({
    active, liveRecording, pipelineStatus, organizedFull, libFilter, sortKey, groupId,
    setPageQuery, invalidate, refresh, refreshRecovery,
  });
  const { isSearching, hits, searchMeetings, searchPending, searchError, previousSearchQuery } = useLibrarySearch({
    query, facets, groupId, libFilter, searchRevision, active, hasMotion,
    searchClientId, searchRequestId, setSearchCompletion,
  });

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
  const organizedSearchResults = useMemo(() => [...titleMatches, ...contentMatches], [titleMatches, contentMatches]);
  const libCounts = isSearching ? searchCounts : counts;
  const organizedSnapshotKey = `${libFilter}:${sortKey}`;
  const organizedLoaded = useMemo(() => (organizedSnapshot?.key === organizedSnapshotKey ? organizedSnapshot.rows : []), [organizedSnapshot, organizedSnapshotKey]);
  const onOrganizedLoadedChange = useCallback((rows: MeetingSummary[]): void => {
    setOrganizedSnapshot((previous) => previous?.key === organizedSnapshotKey && previous.rows === rows
      ? previous : { key: organizedSnapshotKey, rows });
  }, [organizedSnapshotKey]);
  const scope = selectionScope({
    isSearching, filter: libFilter, groupId, loaded: organizedFull ? organizedLoaded : meetings,
    searchResults: organizedSearchResults, total,
  });
  // "New" is an ungrouped meeting that arrived after the last acknowledgement.
  // Counted over what is loaded, which is where the New badges are visible.
  const newCount = useMemo(
    () => (organizedFull ? organizedLoaded : meetings).filter(m => m.groupId === null && !!m.createdAt && m.createdAt > newBaseline).length,
    [organizedFull, organizedLoaded, meetings, newBaseline]);
  const scopeToken = groupId === undefined ? 'all' : groupId === null ? 'ungrouped' : groupId;
  const selectionUniverse = isSearching ? `search:${scopeToken}:${query.trim()}:${libFilter}:${JSON.stringify(facets)}` : `browse:${scopeToken}:${libFilter}`;
  const scopeReady = isSearching
    ? !searchPending && previousSearchQuery.current === `${scopeToken}:${query.trim()}`
    : !loadingInitial && (!organizedFull || groupsLoaded) && pageQuery.filter === libFilter && pageQuery.groupId === groupId;
  useEffect(() => () => librarySelection.getState().cancelResolution(), [selectionUniverse]);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listRef.current?.scrollTo({ top: 0 }); }, [libFilter, sortKey, groupId, isSearching]);

  const { setPendingSnapshot, selectionError, setSelectionError, selectedPendingCount } = useSelectionPending({
    selected, meetings, searchMeetings, searchRevision, hasMotion,
  });

  // Row callbacks are hoisted + stable (useCallback) so the memoized
  // LibraryRow doesn't see a fresh closure on every render — per-row
  // arrows here would put all 100+ rows back on the 3 s poll treadmill.
  const toggleSelect = useCallback((id: string): void => {
    if (!librarySelection.getState().busy) librarySelection.getState().toggle(id);
  }, []);

  const moveUngrouped = useCallback((meeting: { id: string; title: string }): void => {
    setMoveSelection({ ids: [meeting.id], hiddenCount: 0, meeting: { title: meeting.title, groupId: null } });
  }, []);

  const rowChanged = useCallback((): void => {
    void invalidate();
    void refreshTrash();
  }, [invalidate, refreshTrash]);

  const {
    confirmation, setConfirmation, selectMatching, requestProcessSelected, requestDeleteSelected, applyConfirmation,
  } = useBulkSelectionActions({
    toast, invalidate, refreshTrash, scope, selectionUniverse, setPendingSnapshot, setSelectionError,
  });

  return (
    // pt-8 (32px) at every width: the frameless window's drag strip covers the
    // top 28px, so smaller paddings put the header buttons under it and clicks
    // near their top edge dragged the window instead.
    <div className="app-view relative h-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 flex flex-col">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      {/* navKey: remount on return so the selection pill glides back from the view just left. */}
      <AppHeader active="library" onNav={onNav} navKey={active ? 'shown' : 'hidden'}>
        <div className="flex-1" />
        <RecordButton
          active={active}
          recordingActive={!!liveRecording}
          groupId={groupId}
          onStarted={({ sessionId, label, startInput }) => onStartRecording({
            sessionId, label, startInput, startedAt: new Date().toISOString(),
          })}
        />
      </AppHeader>

      {!liveRecording && (
        <div className="shrink-0">
          <MeetingDetectedBanner
            groupId={groupId}
            onStartRecording={({ sessionId, label, startInput }) => onStartRecording({
              sessionId, label, startInput, startedAt: new Date().toISOString(),
            })}
          />
        </div>
      )}

      {active && liveRecording && (
        <div className="shrink-0 mb-6">
          <LiveRecordingRow
            sessionId={liveRecording.sessionId}
            label={liveRecording.label}
            startedAt={liveRecording.startedAt}
            groupId={liveRecording.startInput?.groupId}
            title={liveRecording.startInput?.title}
            micEnabled={liveRecording.startInput?.mic}
            onStopped={(summary) => {
              onRecordingStopped(summary);
              void invalidate();
              window.setTimeout(() => { void refreshRecovery(); }, 800);
            }}
            onRestarted={onStartRecording}
          />
        </div>
      )}

      {/* Keep capture controls reachable while browsing. Only the inbox and
          Library share scrolling; a busy inbox cannot squeeze rows to zero. */}
      <div ref={listRef} role="region" aria-label="Meeting library"
        className={`flex-1 min-h-0 overflow-y-auto -mr-2 pr-2 ${selected.size > 0 ? 'pb-28' : 'pb-8'}`}>
      <div className="shrink-0">
        <QueueBanner
          status={pipelineStatus}
          meetings={attentionMeetings}
          onChanged={() => void invalidate()}
          toast={toast}
        />
      </div>

      <NeedsAttentionPanel
        sync={syncAttention}
        meetings={attentionMeetings}
        recovery={recoveryItems}
        error={recoveryError ?? attentionError}
        onRetry={() => { void refreshRecovery(); void attention.refresh(); }}
        onOpen={(id) => {
          const meeting = attentionMeetings.find((candidate) => candidate.id === id);
          onOpen(id, meeting ? {
            title: meeting.title, pipelineStage: meeting.pipelineStage, status: meeting.status,
          } : {});
        }}
        onChanged={async () => { await Promise.all([invalidate(), refreshRecovery()]); }}
      />


      {/* ── LIBRARY (unified list) ──────────────────────────────────────── */}
      {/* Keep the toolbar in the same flow as the inbox and rows so even a
          short / zoomed window can reach every control without nested scrolling. */}
      <section className="library-content flex flex-col">
        <LibraryHeaderRow
          newCount={newCount} setNewBaseline={setNewBaseline} toast={toast} groupId={groupId} changeGroup={changeGroup}
          scopeName={scopeName} viewMode={viewMode} changeViewMode={changeViewMode} libCounts={libCounts}
          setGroupDialog={setGroupDialog} setGroupError={setGroupError} activeGroup={activeGroup}
          groupOptionsRef={groupOptionsRef} groupOptionsButtonRef={groupOptionsButtonRef} groupOptionsMenuRef={groupOptionsMenuRef}
          groupOptionsOpen={groupOptionsOpen} setGroupOptionsOpen={setGroupOptionsOpen} setPrepareGroupId={setPrepareGroupId}
          refreshGroups={refreshGroups} setTargetGroupId={setTargetGroupId}
        />

        {organizedFull && groupsError && <div role="alert" className="shrink-0 mb-3 rounded-lg border border-danger/20 bg-danger-bg px-3 py-2 text-xs text-danger-text">
          Could not refresh groups: {groupsError}{' '}
          <button type="button" onClick={() => void refreshGroups()} className="font-semibold underline">Retry</button>
        </div>}

        <SearchFilters facets={facets} onChange={setFacets} query={query} onQuery={setQuery}/>
        {isSearching&&searchCompletion&&<p role="status" className="shrink-0 text-xs text-status-warnText mb-2">{searchCompletion}</p>}
        <LibraryFilterBar
          libFilter={libFilter} setLibFilter={setLibFilter} libCounts={libCounts} sortKey={sortKey} changeSort={changeSort}
          isSearching={isSearching} searchPending={searchPending} groupId={groupId} scopeName={scopeName}
          query={query} setQuery={setQuery} onOpenSearch={onOpenSearch}
        />

        {isSearching && (
          <p className="shrink-0 mb-2 text-[11px] text-ink-muted">
            Searching {scopeName}. Showing up to {LIBRARY_SEARCH_LIMIT} matching hits; refine your search for more specific results.
          </p>
        )}
        {organizedFull && isSearching && searchError && organizedSearchResults.length > 0 &&
          <LibraryRetryRow message={searchError} onRetry={() => setSearchRevision((revision) => revision + 1)} />}

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

        <LibraryResults
          libFilter={libFilter} setLibFilter={setLibFilter} sortKey={sortKey} groupId={groupId} scopeName={scopeName}
          scopeToken={scopeToken} changeGroup={changeGroup} organizedFull={organizedFull} listRef={listRef}
          meetings={meetings} browseList={browseList} total={total} hasMore={hasMore} loadingInitial={loadingInitial}
          loadingMore={loadingMore} error={error} loadMore={loadMore} retry={retry}
          sections={sections} groupsLoaded={groupsLoaded} groupsError={groupsError} refreshGroups={refreshGroups}
          revealGroupId={revealGroupId} onOrganizedLoadedChange={onOrganizedLoadedChange}
          setTargetGroupId={setTargetGroupId} setGroupDialog={setGroupDialog} setGroupError={setGroupError}
          setPrepareGroupId={setPrepareGroupId}
          query={query} setQuery={setQuery} isSearching={isSearching} searchPending={searchPending}
          searchError={searchError} searchCompletion={searchCompletion} searchRevision={searchRevision}
          setSearchRevision={setSearchRevision} titleMatches={titleMatches} contentMatches={contentMatches}
          hitsByMeeting={hitsByMeeting} organizedSearchResults={organizedSearchResults}
          contentSort={contentSort} setContentSort={setContentSort}
          selected={selected} newBaseline={newBaseline} onOpen={onOpen} moveUngrouped={moveUngrouped}
          rowChanged={rowChanged} toggleSelect={toggleSelect} toast={toast}
        />

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
      </div>

      {/* ── Bulk action bar (docked) ────────────────────────────────────── */}
      <SelectionBar
        count={selected.size}
        pendingCount={selectedPendingCount}
        busy={bulkBusy || resolvingSelection}
        onProcess={() => void requestProcessSelected()}
        onDelete={requestDeleteSelected}
        onMove={() => {
          const ids = [...librarySelection.getState().selected];
          if (ids.length === 0) return;
          const visible = new Set(scope.loadedIds);
          setMoveSelection({ ids, hiddenCount: ids.filter((id) => !visible.has(id)).length });
        }}
        onCancel={() => librarySelection.getState().clear()}
      />

      {moveSelection && <MoveToGroupDialog ids={moveSelection.ids} hiddenCount={moveSelection.hiddenCount} meeting={moveSelection.meeting}
        onClose={() => setMoveSelection(null)} onChanged={() => void invalidate()} />}
      {prepareGroupId && <GroupBrief id={prepareGroupId} name={groups.find(group => group.id === prepareGroupId)?.name ?? 'this group'} onClose={() => setPrepareGroupId(null)} onOpen={id => onOpen(id, {})}
        onRecord={liveRecording ? undefined : () => {
          // Scope the Library to the group so the Record picker saves there, then open it.
          const target = prepareGroupId; changeGroup(target);
          requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('mn:toggle-record'))));
        }} />}

      {groupDialog === 'create' && <GroupNameDialog
        mode="create" name="" error={groupError} busy={groupBusy}
        onClose={() => setGroupDialog(null)}
        onSave={async (name) => {
          setGroupBusy(true); setGroupError(null);
          try {
            const group = await createGroup(name);
            setRevealGroupId(group.id); changeViewMode('organized'); setGroupDialog(null);
            void invalidate();
          } catch (cause) { setGroupError((cause as Error).message); }
          finally { setGroupBusy(false); }
        }}
      />}
      {groupDialog === 'rename' && targetGroup && <GroupNameDialog
        mode="rename" name={targetGroup.name} error={groupError} busy={groupBusy}
        onClose={() => setGroupDialog(null)}
        onSave={async (name) => {
          setGroupBusy(true); setGroupError(null);
          try { await renameGroup(targetGroup.id, name); setGroupDialog(null); void invalidate(); }
          catch (cause) { setGroupError((cause as Error).message); }
          finally { setGroupBusy(false); }
        }}
      />}
      <ConfirmDialog
        open={groupDialog === 'delete' && !!targetGroup}
        title={`Delete group “${targetGroup?.name ?? ''}”?`}
        body="Meetings in this group will become ungrouped. Their audio, notes, and processing state will not be deleted."
        confirmLabel="Delete group" destructive busy={groupBusy}
        onCancel={() => setGroupDialog(null)}
        onConfirm={() => {
          if (!targetGroup) return;
          setGroupBusy(true);
          void deleteGroup(targetGroup.id).then(() => {
            if (groupId === targetGroup.id) changeGroup(undefined);
            setGroupDialog(null); void invalidate();
          }).catch((cause) => {
            setGroupError((cause as Error).message);
            toast.show({ message: `Could not delete group: ${(cause as Error).message}`, variant: 'error' });
          }).finally(() => setGroupBusy(false));
        }}
      />

      {/* ── Bulk delete confirmation (#192) ─────────────────────────────── */}
      <ConfirmDialog
        open={confirmation !== null}
        title={confirmation?.title ?? ''}
        body={
          <>
            Each meeting&rsquo;s audio file, transcript, summary, and any exports
            move to <strong>Recently deleted</strong>, restorable for 30 days.
          </>
        }
        confirmLabel="Delete"
        destructive
        busy={bulkBusy}
        onConfirm={() => void applyConfirmation()}
        onCancel={() => setConfirmation(null)}
      />
    </div>
  );
}
