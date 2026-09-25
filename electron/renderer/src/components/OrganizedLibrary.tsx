import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import { api } from '../ipc/client';
import { createPagedMeetings, type MeetingFilter, type MeetingSummary } from '../lib/paged-meetings';
import { groupSearchMeetings, readExpandedSections, type OrganizedSection } from '../lib/organized-sections';
import type { LibrarySortKey } from '../lib/library-sort';

const EXPANDED_STORAGE_KEY = 'libraryExpandedGroups';
const EMPTY_ROWS: MeetingSummary[] = [];

interface Props {
  sections: OrganizedSection[];
  filter: MeetingFilter;
  sort: LibrarySortKey;
  searching: boolean;
  searchPending: boolean;
  searchQuery: string;
  searchResults: MeetingSummary[];
  refreshRevision: number;
  revealGroupId: string | null;
  renderRow: (meeting: MeetingSummary, withMatches: boolean) => ReactNode;
  onLoadedChange: (rows: MeetingSummary[]) => void;
  onFocusGroup: (groupId: string | null) => void;
  onRenameGroup: (groupId: string) => void;
  onDeleteGroup: (groupId: string) => void;
}

/** Named groups and Ungrouped share one scroll surface. Collapsed sections
 * never fetch meetings; each expanded section owns a bounded cursor chain. */
export function OrganizedLibrary({
  sections, filter, sort, searching, searchPending, searchQuery, searchResults,
  refreshRevision, revealGroupId, renderRow, onLoadedChange, onFocusGroup,
  onRenameGroup, onDeleteGroup,
}: Props): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try { return readExpandedSections(window.localStorage.getItem(EXPANDED_STORAGE_KEY)); }
    catch { return readExpandedSections(null); }
  });
  const [searchCollapsed, setSearchCollapsed] = useState<Set<string>>(new Set());
  const [loadedBySection, setLoadedBySection] = useState<Record<string, MeetingSummary[]>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchBuckets = useMemo(() => groupSearchMeetings(sections, searchResults), [sections, searchResults]);

  useEffect(() => { setSearchCollapsed(new Set()); }, [searchQuery]);
  useEffect(() => {
    if (!revealGroupId) return;
    setExpanded((previous) => {
      if (previous.has(revealGroupId)) return previous;
      const next = new Set(previous); next.add(revealGroupId);
      try { window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...next])); }
      catch { /* in-memory expansion still works */ }
      return next;
    });
  }, [revealGroupId]);

  const toggle = useCallback((key: string): void => {
    if (searching) {
      setSearchCollapsed((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      });
      return;
    }
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...next])); }
      catch { /* in-memory expansion still works */ }
      return next;
    });
  }, [searching]);

  const reportRows = useCallback((key: string, rows: MeetingSummary[]): void => {
    setLoadedBySection((previous) => previous[key] === rows ? previous : { ...previous, [key]: rows });
  }, []);
  const loadedRows = useMemo(() => searching ? EMPTY_ROWS : sections.flatMap((section) =>
    expanded.has(section.key) ? loadedBySection[section.key] ?? EMPTY_ROWS : EMPTY_ROWS),
  [searching, sections, expanded, loadedBySection]);
  useEffect(() => { onLoadedChange(loadedRows); }, [loadedRows, onLoadedChange]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [filter, sort, searchQuery]);

  const visibleSections = searching
    ? sections.filter((section) => (searchBuckets.get(section.key)?.length ?? 0) > 0)
    : sections;

  return <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto -mr-2 pr-2 pb-8">
    {searching && searchPending && searchResults.length === 0 &&
      <div role="status" className="py-8 text-center text-sm text-ink-muted">Searching…</div>}
    {visibleSections.map((section) => <GroupSection
      key={section.key} section={section} filter={filter} sort={sort}
      searching={searching} searchRows={searchBuckets.get(section.key) ?? EMPTY_ROWS}
      expanded={searching ? !searchCollapsed.has(section.key) : expanded.has(section.key)}
      refreshRevision={refreshRevision} renderRow={renderRow} onToggle={() => toggle(section.key)}
      onRows={reportRows} onFocus={() => onFocusGroup(section.groupId)}
      onRename={section.groupId ? () => onRenameGroup(section.groupId!) : undefined}
      onDelete={section.groupId ? () => onDeleteGroup(section.groupId!) : undefined}
    />)}
  </div>;
}

function GroupSection({ section, filter, sort, searching, searchRows, expanded, refreshRevision,
  renderRow, onToggle, onRows, onFocus, onRename, onDelete }: {
  section: OrganizedSection;
  filter: MeetingFilter;
  sort: LibrarySortKey;
  searching: boolean;
  searchRows: MeetingSummary[];
  expanded: boolean;
  refreshRevision: number;
  renderRow: Props['renderRow'];
  onToggle: () => void;
  onRows: (key: string, rows: MeetingSummary[]) => void;
  onFocus: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}): JSX.Element {
  const [pageStore] = useState(() => createPagedMeetings(api.meetings.listPage));
  const { items, total, hasMore, loadingInitial, loadingMore, refreshing, error } = useStore(pageStore);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const panelId = `group-rows-${section.key}`;

  useEffect(() => {
    if (!expanded || searching) return;
    const state = pageStore.getState();
    const next = { filter, sort, groupId: section.groupId, pageSize: 50 };
    const previous = state.query;
    if (previous.filter !== filter || previous.sort !== sort || previous.groupId !== section.groupId) {
      void state.setQuery(next);
    } else {
      void state.invalidate();
    }
  }, [expanded, searching, filter, sort, section.groupId, refreshRevision, pageStore]);

  const queryMatches = pageStore.getState().query.filter === filter
    && pageStore.getState().query.sort === sort
    && pageStore.getState().query.groupId === section.groupId;
  const visibleRows = expanded && !searching && queryMatches ? items : EMPTY_ROWS;
  useEffect(() => { onRows(section.key, visibleRows); }, [section.key, visibleRows, onRows]);
  useLayoutEffect(() => {
    if (!menuOpen || !menuButtonRef.current) return;
    const rect = menuButtonRef.current.getBoundingClientRect();
    const right = window.innerWidth - rect.right;
    setMenuAnchor(window.innerHeight - rect.bottom < 110
      ? { bottom: window.innerHeight - rect.top + 6, right }
      : { top: rect.bottom + 6, right });
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)
        && !menuButtonRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setMenuOpen(false); };
    const scroll = (): void => setMenuOpen(false);
    document.addEventListener('mousedown', outside);
    window.addEventListener('keydown', escape);
    window.addEventListener('scroll', scroll, true);
    return () => { document.removeEventListener('mousedown', outside); window.removeEventListener('keydown', escape); window.removeEventListener('scroll', scroll, true); };
  }, [menuOpen]);

  const rows = searching ? searchRows : queryMatches ? items : EMPTY_ROWS;
  const countText = searching
    ? `${searchRows.length} ${searchRows.length === 1 ? 'match' : 'matches'}`
    : filter === 'all' ? `${section.count} ${section.count === 1 ? 'meeting' : 'meetings'}`
      : `${section.count} total${expanded && !loadingInitial ? ` · ${total} ${filter}` : ''}`;

  return <section className="border-b border-surface-border last:border-b-0">
    <div className="flex min-h-[56px] items-center gap-1.5 py-1">
      <button type="button" aria-expanded={expanded} aria-controls={panelId}
        onClick={onToggle} className="min-w-0 flex-1 flex items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40">
        <span aria-hidden="true" className="w-4 shrink-0 text-ink-muted">{expanded ? '⌄' : '›'}</span>
        <svg viewBox="0 0 20 20" className="w-4 h-4 shrink-0 text-brand-indigo" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M2 5h6l2 2h8v9H2z" /></svg>
        <span id={`group-label-${section.key}`} className="truncate text-sm font-semibold" title={section.name}>{section.name}</span>
        <span className="shrink-0 text-xs font-normal text-ink-muted tabular-nums">{countText}</span>
      </button>
      <button type="button" onClick={onFocus} aria-label={`View only ${section.name}`}
        className="shrink-0 rounded-lg px-2 py-1.5 text-xs font-semibold text-brand-indigo hover:bg-brand-indigo/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40">View</button>
      {onRename && onDelete && <>
        <button ref={menuButtonRef} type="button" aria-label={`Options for ${section.name}`} aria-haspopup="menu" aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)} className="shrink-0 rounded-lg px-2 py-1.5 text-ink-muted hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40">⋯</button>
        {menuOpen && menuAnchor && createPortal(<div ref={menuRef} role="menu"
          style={{ position: 'fixed', top: menuAnchor.top, bottom: menuAnchor.bottom, right: menuAnchor.right, zIndex: 1000 }}
          className="w-40 rounded-lg border border-surface-border bg-surface p-1 shadow-pop">
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onRename(); }} className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-sunken">Rename group…</button>
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onDelete(); }} className="w-full rounded-md px-2 py-1.5 text-left text-sm text-danger hover:bg-danger-bg">Delete group…</button>
        </div>, document.body)}
      </>}
    </div>
    {expanded && <div id={panelId} role="region" aria-labelledby={`group-label-${section.key}`}
      className="mb-3 ml-5 border-l-2 border-brand-indigo/20 pl-4 space-y-2">
      {!searching && (!queryMatches || loadingInitial) && rows.length === 0 && <p role="status" className="py-3 text-sm text-ink-muted">Loading meetings…</p>}
      {!searching && queryMatches && error && rows.length === 0 && <p role="alert" className="py-3 text-sm text-danger-text">{error}{' '}
        <button type="button" onClick={() => void pageStore.getState().retry()} className="font-semibold underline">Retry</button></p>}
      {!searching && queryMatches && !loadingInitial && !error && rows.length === 0 &&
        <p className="py-3 text-sm text-ink-muted">{filter === 'all' ? 'No meetings here yet. Use Move to group on a meeting.' : `No ${filter} meetings here.`}</p>}
      {rows.map((meeting) => <div key={meeting.id}>{renderRow(meeting, searching)}</div>)}
      {!searching && queryMatches && hasMore && <button type="button" disabled={loadingMore || refreshing}
        onClick={() => void pageStore.getState().loadMore()}
        className="rounded-lg border border-surface-border px-3 py-1.5 text-xs font-semibold text-ink-muted hover:text-ink disabled:opacity-50">
        {loadingMore ? 'Loading…' : `Load more (${items.length} of ${total})`}
      </button>}
      {!searching && queryMatches && error && rows.length > 0 && <p role="alert" className="py-2 text-xs text-danger-text">{error}{' '}
        <button type="button" onClick={() => void pageStore.getState().retry()} className="font-semibold underline">Retry</button></p>}
    </div>}
  </section>;
}
