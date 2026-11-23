// electron/renderer/src/views/library/LibraryToolbar.tsx
//
// The Library heading row (view switch, group scope and options menu) and the
// filter / sort / search row, moved out of LibraryView.tsx unchanged (#256).
// Neither holds hooks or state: the menu's open state, refs and keyboard
// handling stay in LibraryView and arrive as props.
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { SegmentedControl } from '../../components/SegmentedControl';
import { Icon, IconLabel } from '../../components/icons';
import type { useToast } from '../../components/Toasts';
import type { MeetingGroup } from '../../store/groups';
import { api } from '../../ipc/client';
import { LIBRARY_SORT_OPTIONS, sanitizeSortKey, type LibrarySortKey } from '../../lib/library-sort';
import { acknowledgeArrivals } from '../../lib/new-arrivals';
import type { MeetingCounts } from '../../lib/paged-meetings';
import { shortcutMod } from '../../lib/shortcut';
import { FilterChip } from './LibraryWidgets';
import type { GroupDialogMode, LibFilter } from './types';

export function LibraryHeaderRow({
  newCount, setNewBaseline, toast, groupId, changeGroup, scopeName, viewMode, changeViewMode, libCounts,
  setGroupDialog, setGroupError, activeGroup, groupOptionsRef, groupOptionsButtonRef, groupOptionsMenuRef,
  groupOptionsOpen, setGroupOptionsOpen, setPrepareGroupId, refreshGroups, setTargetGroupId,
}: {
  newCount: number;
  setNewBaseline: Dispatch<SetStateAction<string>>;
  toast: ReturnType<typeof useToast>;
  groupId: string | null | undefined;
  changeGroup: (next: string | null | undefined) => void;
  scopeName: string;
  viewMode: 'organized' | 'flat';
  changeViewMode: (next: 'organized' | 'flat') => void;
  libCounts: MeetingCounts;
  setGroupDialog: Dispatch<SetStateAction<GroupDialogMode | null>>;
  setGroupError: Dispatch<SetStateAction<string | null>>;
  activeGroup: MeetingGroup | undefined;
  groupOptionsRef: RefObject<HTMLDivElement>;
  groupOptionsButtonRef: RefObject<HTMLButtonElement>;
  groupOptionsMenuRef: RefObject<HTMLDivElement>;
  groupOptionsOpen: boolean;
  setGroupOptionsOpen: Dispatch<SetStateAction<boolean>>;
  setPrepareGroupId: Dispatch<SetStateAction<string | null>>;
  refreshGroups: () => Promise<void>;
  setTargetGroupId: Dispatch<SetStateAction<string | null>>;
}): JSX.Element {
  return (
        <div className="shrink-0 flex flex-wrap items-center gap-3 mb-3">
          <h2 className="library-heading text-ink-muted">
            Library
          </h2>
          {newCount > 0 && <button type="button" className="text-xs text-ink-muted hover:text-brand-indigo"
            onClick={() => { setNewBaseline(acknowledgeArrivals()); toast.show({ message: `${newCount} new ${newCount === 1 ? 'meeting' : 'meetings'} marked as seen`, durationMs: 3000 }); }}>
            Mark {newCount} new as seen</button>}
          {groupId !== undefined ? <>
            <button type="button" onClick={() => changeGroup(undefined)}
              className="rounded-lg px-2 py-1.5 text-xs font-semibold text-brand-indigo hover:bg-brand-indigo/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40 inline-flex items-center gap-0.5"><Icon name="chevron-left" className="w-3.5 h-3.5" />All groups</button>
            <span className="min-w-0 truncate text-sm font-semibold" title={scopeName}>{scopeName}</span>
          </> : <SegmentedControl label="Library view" value={viewMode} onChange={changeViewMode}
            options={[{ value: 'organized', label: 'Organized' }, { value: 'flat', label: 'All meetings' }]} />}
          <span className="text-[11px] text-ink-muted">
            {libCounts.all} {libCounts.all === 1 ? 'meeting' : 'meetings'}
          </span>
          {groupId === undefined && <button type="button" onClick={() => { setGroupDialog('create'); setGroupError(null); }}
            className="ml-auto rounded-lg px-2.5 py-1.5 text-xs font-semibold text-brand-indigo hover:bg-brand-indigo/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40"><IconLabel icon="plus">New group</IconLabel></button>}
          {activeGroup && <div ref={groupOptionsRef} className="ml-auto relative">
            <button ref={groupOptionsButtonRef} type="button" aria-label={`Options for ${activeGroup.name}`} aria-haspopup="menu" aria-expanded={groupOptionsOpen}
              onClick={() => setGroupOptionsOpen((open) => !open)}
              className="w-8 h-8 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40 inline-flex items-center justify-center"><Icon name="more-horizontal" /></button>
            {groupOptionsOpen && <div ref={groupOptionsMenuRef} role="menu" aria-label={`Options for ${activeGroup.name}`} className="material-popover absolute right-0 top-full mt-1 z-50 w-40 bg-surface rounded-lg border border-surface-border shadow-pop p-1">
              <button type="button" role="menuitem" className="w-full text-left px-2 py-1.5 rounded-md text-sm hover:bg-surface-sunken" onClick={() => { setGroupOptionsOpen(false); setPrepareGroupId(activeGroup.id); }}>Prepare next meeting</button>
              <button role="menuitem" className="w-full text-left px-2 py-1.5 rounded-md text-sm hover:bg-surface-sunken" onClick={() => { setGroupOptionsOpen(false); void api.groups.pin(activeGroup.id, !activeGroup.pinned).then(refreshGroups).catch(error => toast.show({ message: String(error), variant: 'error' })); }}>{activeGroup.pinned ? 'Unpin group' : 'Pin group'}</button>
              <button type="button" role="menuitem" onClick={() => { setGroupOptionsOpen(false); setTargetGroupId(activeGroup.id); setGroupDialog('rename'); setGroupError(null); }}
                className="w-full text-left px-2 py-1.5 rounded-md text-sm hover:bg-surface-sunken">Rename group…</button>
              <button type="button" role="menuitem" onClick={() => { setGroupOptionsOpen(false); setTargetGroupId(activeGroup.id); setGroupDialog('delete'); setGroupError(null); }}
                className="w-full text-left px-2 py-1.5 rounded-md text-sm text-danger hover:bg-danger-bg">Delete group…</button>
            </div>}
          </div>}
        </div>
  );
}

/** Filter chips — always rendered so the surface is discoverable
 *  even on a fresh install; chips with a zero count are disabled
 *  (greyed + non-clickable) rather than hidden, which keeps the
 *  row visually stable as state evolves. Search yields width
 *  first on narrow via flex-1. */
export function LibraryFilterBar({
  libFilter, setLibFilter, libCounts, sortKey, changeSort, isSearching, searchPending, groupId, scopeName,
  query, setQuery, onOpenSearch,
}: {
  libFilter: LibFilter;
  setLibFilter: Dispatch<SetStateAction<LibFilter>>;
  libCounts: MeetingCounts;
  sortKey: LibrarySortKey;
  changeSort: (key: LibrarySortKey) => void;
  isSearching: boolean;
  searchPending: boolean;
  groupId: string | null | undefined;
  scopeName: string;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  onOpenSearch: () => void;
}): JSX.Element {
  return (
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
            dotClass={libCounts.processing > 0 ? 'bg-brand-solid animate-pulse' : 'bg-brand-solid'}
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
              type="search"
              aria-label={groupId === undefined ? 'Search meetings' : `Search in ${scopeName}`}
              placeholder={groupId === undefined ? 'Search titles, summaries, transcripts…' : `Search in ${scopeName}…`}
              value={query}
              maxLength={500}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && query !== '') { e.preventDefault(); e.stopPropagation(); setQuery(''); } }}
              className="library-search w-full py-1.5 px-3 pr-16 border border-surface-border rounded-lg text-sm bg-surface placeholder:text-ink-muted
                         focus:outline-none focus:border-brand-indigo focus:shadow-[0_0_0_3px_rgba(99,102,241,0.15)]"
            />
            {isSearching && searchPending ? (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] italic text-ink-muted pointer-events-none">
                searching…
              </span>
            ) : query !== '' ? (
              <button type="button" aria-label="Clear search" title="Clear search (Esc)"
                onClick={(event) => { setQuery(''); (event.currentTarget.previousElementSibling as HTMLElement | null)?.focus(); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-muted hover:text-ink hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40">
                <Icon name="x" className="w-3.5 h-3.5" />
              </button>
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
  );
}
