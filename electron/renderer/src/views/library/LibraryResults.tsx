// electron/renderer/src/views/library/LibraryResults.tsx
//
// The Library's result area (empty / loading states, organized overview, flat
// virtual list, search results), moved out of LibraryView.tsx unchanged
// (#256). It holds no hooks or state; every callback it passes down is the
// same one the view built before the move.
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { LibraryRow } from '../../components/LibraryRow';
import { OrganizedLibrary } from '../../components/OrganizedLibrary';
import { SearchMatches } from '../../components/SearchMatches';
import type { useToast } from '../../components/Toasts';
import { api } from '../../ipc/client';
import type { LibrarySortKey } from '../../lib/library-sort';
import type { groupLibrarySearch } from '../../lib/library-search';
import type { organizedSections } from '../../lib/organized-sections';
import type { MeetingSummary } from '../../lib/paged-meetings';
import { FlatMeetingList } from './FlatMeetingList';
import { LibraryEmpty, LibraryRetryRow, SearchSectionHeader } from './LibraryWidgets';
import type { GroupDialogMode, LibFilter, LibraryOpen } from './types';

type SearchGroups = ReturnType<typeof groupLibrarySearch>;

export interface LibraryResultsProps {
  // Scope + filters
  libFilter: LibFilter;
  setLibFilter: Dispatch<SetStateAction<LibFilter>>;
  sortKey: LibrarySortKey;
  groupId: string | null | undefined;
  scopeName: string;
  scopeToken: string;
  changeGroup: (next: string | null | undefined) => void;
  organizedFull: boolean;
  listRef: RefObject<HTMLDivElement>;
  // Browse pages
  meetings: MeetingSummary[];
  browseList: MeetingSummary[];
  total: number;
  hasMore: boolean;
  loadingInitial: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMore: () => Promise<void>;
  retry: () => Promise<void>;
  // Groups
  sections: ReturnType<typeof organizedSections>;
  groupsLoaded: boolean;
  groupsError: string | null;
  refreshGroups: () => Promise<void>;
  revealGroupId: string | null;
  onOrganizedLoadedChange: (rows: MeetingSummary[]) => void;
  setTargetGroupId: Dispatch<SetStateAction<string | null>>;
  setGroupDialog: Dispatch<SetStateAction<GroupDialogMode | null>>;
  setGroupError: Dispatch<SetStateAction<string | null>>;
  setPrepareGroupId: Dispatch<SetStateAction<string | null>>;
  // Search
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  isSearching: boolean;
  searchPending: boolean;
  searchError: string | null;
  searchCompletion: string | null;
  searchRevision: number;
  setSearchRevision: Dispatch<SetStateAction<number>>;
  titleMatches: SearchGroups['titleMatches'];
  contentMatches: SearchGroups['contentMatches'];
  hitsByMeeting: SearchGroups['hitsByMeeting'];
  organizedSearchResults: MeetingSummary[];
  contentSort: 'recent' | 'count';
  setContentSort: Dispatch<SetStateAction<'recent' | 'count'>>;
  // Rows
  selected: Set<string>;
  newBaseline: string;
  onOpen: LibraryOpen;
  moveUngrouped: (meeting: { id: string; title: string }) => void;
  rowChanged: () => void;
  toggleSelect: (id: string) => void;
  toast: ReturnType<typeof useToast>;
}

export function LibraryResults({
  libFilter, setLibFilter, sortKey, groupId, scopeName, scopeToken, changeGroup, organizedFull, listRef,
  meetings, browseList, total, hasMore, loadingInitial, loadingMore, error, loadMore, retry,
  sections, groupsLoaded, groupsError, refreshGroups, revealGroupId, onOrganizedLoadedChange,
  setTargetGroupId, setGroupDialog, setGroupError, setPrepareGroupId,
  query, setQuery, isSearching, searchPending, searchError, searchCompletion, searchRevision, setSearchRevision,
  titleMatches, contentMatches, hitsByMeeting, organizedSearchResults, contentSort, setContentSort,
  selected, newBaseline, onOpen, moveUngrouped, rowChanged, toggleSelect, toast,
}: LibraryResultsProps): JSX.Element {
  const totalShown = isSearching
    ? titleMatches.length + contentMatches.length
    : organizedFull ? (groupsLoaded ? sections.length : 0) : browseList.length;
  if (totalShown === 0) {
    if (isSearching ? searchPending : loadingInitial || (organizedFull && !groupsLoaded)) {
      return <div role="status" className="py-10 text-center text-sm text-ink-muted">{isSearching ? 'Searching…' : 'Loading meetings…'}</div>;
    }
    const failure = isSearching ? searchError : organizedFull ? groupsError ?? error : error;
    if (failure) return <LibraryRetryRow message={failure} onRetry={isSearching ? () => setSearchRevision((revision) => revision + 1) : () => void retry()} />;
    if (isSearching && searchCompletion) return (
      <div role="status" className="py-10 text-center text-sm text-ink-muted">
        <p>No matches found so far. {searchCompletion}</p>
        <button type="button" className="mt-3 text-brand-indigo underline" onClick={() => setSearchRevision((revision) => revision + 1)}>Retry search</button>
      </div>
    );
    return (
      <LibraryEmpty
        filter={libFilter}
        query={query}
        scopeName={scopeName}
        scoped={groupId !== undefined}
        onShowAll={() => changeGroup(undefined)}
        onClearSearch={() => setQuery('')}
        onClearFilter={() => setLibFilter('all')}
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
          isNew={m.groupId === null && !!m.createdAt && m.createdAt > newBaseline}
          onMove={m.groupId === null ? moveUngrouped : undefined}
          onOpen={onOpen}
          onChanged={rowChanged}
          checked={selected.has(m.id)}
          onToggle={toggleSelect}
          selectionActive={selected.size > 0}
          showGroup={groupId === undefined && !organizedFull}
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
  // Refreshes and appended pages preserve the shared viewport and
  // focused row; only explicit filter/sort changes reset scroll.
  if (organizedFull) return <OrganizedLibrary
    scrollRef={listRef}
    sections={sections} filter={libFilter} sort={sortKey}
    searching={isSearching} searchPending={searchPending} searchQuery={query}
    searchResults={organizedSearchResults} refreshRevision={searchRevision}
    revealGroupId={revealGroupId} renderRow={renderRow} onLoadedChange={onOrganizedLoadedChange}
    onFilterGroup={(id, filter) => { changeGroup(id); setLibFilter(filter); }}
    onFocusGroup={changeGroup}
    onRenameGroup={(id) => { setTargetGroupId(id); setGroupDialog('rename'); setGroupError(null); }}
    onPrepareGroup={setPrepareGroupId}
    onPinGroup={(id, pinned) => { void api.groups.pin(id, pinned).then(refreshGroups).catch(error => toast.show({ message: String(error), variant: 'error' })); }}
    onDeleteGroup={(id) => { setTargetGroupId(id); setGroupDialog('delete'); setGroupError(null); }}
  />;
  if (!isSearching) return (
    <FlatMeetingList
      scrollRef={listRef}
      key={`${scopeToken}:${libFilter}:${sortKey}`}
      items={browseList}
      renderRow={(m) => renderRow(m, false)}
      hasMore={hasMore}
      loadingMore={loadingMore}
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
      className="space-y-2"
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
}
