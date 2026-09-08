import { createStore } from 'zustand/vanilla';
import type { MeetingNotesApi } from '../../../preload';
import { recycleMeetings } from './meetings-recycle';

type FetchPage = MeetingNotesApi['meetings']['listPage'];
export type MeetingPage = Awaited<ReturnType<FetchPage>>;
export type MeetingSummary = MeetingPage['items'][number];
export type MeetingQuery = Omit<Parameters<FetchPage>[0], 'cursor'>;
export type MeetingFilter = MeetingQuery['filter'];
export type MeetingCounts = MeetingPage['counts'];

export interface PagedMeetingsState {
  query: MeetingQuery;
  items: MeetingSummary[];
  counts: MeetingCounts;
  total: number;
  hasMore: boolean;
  loadingInitial: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  error: string | null;
  setQuery: (query: MeetingQuery) => Promise<void>;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  retry: () => Promise<void>;
}

function normalizeQuery(query: MeetingQuery): MeetingQuery {
  const size = query.pageSize ?? 50;
  return { filter: query.filter, sort: query.sort, pageSize: Number.isFinite(size) ? Math.max(1, Math.min(100, Math.floor(size))) : 50 };
}

function uniqueRows(rows: MeetingSummary[]): MeetingSummary[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

/** A live cursor chain. Refresh rebuilds only the loaded prefix, atomically,
 * so polling neither collapses scroll depth nor appends to an obsolete cursor.
 * No full-catalog fetch is needed; every request is capped at 100 summaries. */
export function createPagedMeetings(fetchPage: FetchPage) {
  // ipcRenderer.invoke normally rejects asynchronously, but a synchronous
  // bridge failure must also yield before request cleanup clears its lock.
  const requestPage: FetchPage = (query) => {
    try { return fetchPage(query); }
    catch (error) { return Promise.reject(error); }
  };
  return createStore<PagedMeetingsState>()((set, get) => {
    let generation = 0;
    let cursor: string | null = null;
    let pageCount = 0;
    let initialRequest: Promise<void> | null = null;
    let moreRequest: Promise<void> | null = null;
    let failedOperation: 'refresh' | 'loadMore' = 'refresh';

    function refresh(): Promise<void> {
      if (initialRequest) return initialRequest;
      const current = ++generation;
      const query = get().query;
      const pagesToLoad = Math.max(1, pageCount);
      moreRequest = null;
      set({ loadingInitial: get().items.length === 0, loadingMore: false, refreshing: true, error: null });
      initialRequest = (async () => {
        try {
          let nextCursor: string | null = null;
          let result!: MeetingPage;
          let loadedPages = 0;
          const rows: MeetingSummary[] = [];
          do {
            result = await requestPage({ ...query, ...(nextCursor ? { cursor: nextCursor } : {}) });
            if (current !== generation) return;
            rows.push(...result.items);
            nextCursor = result.nextCursor;
            loadedPages++;
          } while (nextCursor && loadedPages < pagesToLoad);
          cursor = nextCursor;
          pageCount = loadedPages;
          set({ items: recycleMeetings(get().items, uniqueRows(rows)), counts: result.counts, total: result.total, hasMore: cursor !== null });
        } catch (error) {
          if (current !== generation) return;
          failedOperation = 'refresh';
          set({ error: error instanceof Error ? error.message : 'Unable to load meetings.' });
        } finally {
          if (current === generation) {
            initialRequest = null;
            set({ loadingInitial: false, refreshing: false });
          }
        }
      })();
      return initialRequest;
    }

    function loadMore(): Promise<void> {
      if (initialRequest) return initialRequest;
      if (moreRequest) return moreRequest;
      if (!cursor) return Promise.resolve();
      const current = generation;
      const query = { ...get().query, cursor };
      set({ loadingMore: true, error: null });
      moreRequest = (async () => {
        try {
          const result = await requestPage(query);
          if (current !== generation) return;
          cursor = result.nextCursor;
          pageCount++;
          set({ items: uniqueRows([...get().items, ...result.items]), counts: result.counts, total: result.total, hasMore: cursor !== null });
        } catch (error) {
          if (current !== generation) return;
          failedOperation = 'loadMore';
          set({ error: error instanceof Error ? error.message : 'Unable to load more meetings.' });
        } finally {
          if (current === generation) {
            moreRequest = null;
            set({ loadingMore: false });
          }
        }
      })();
      return moreRequest;
    }

    return {
      query: normalizeQuery({ filter: 'all', sort: 'newest' }),
      items: [], counts: { all: 0, pending: 0, processing: 0, done: 0, failed: 0 },
      total: 0, hasMore: false, loadingInitial: false, loadingMore: false, refreshing: false, error: null,
      refresh, loadMore,
      retry: () => failedOperation === 'loadMore' ? loadMore() : refresh(),
      setQuery(query) {
        const next = normalizeQuery(query);
        const previous = get().query;
        if (next.filter === previous.filter && next.sort === previous.sort && next.pageSize === previous.pageSize) {
          return initialRequest ?? (pageCount === 0 ? refresh() : Promise.resolve());
        }
        generation++;
        initialRequest = null;
        moreRequest = null;
        cursor = null;
        pageCount = 0;
        // Global counts remain useful while changing filters; only the old
        // query's rows, total and continuation become invalid immediately.
        set({ query: next, items: [], total: 0, hasMore: false, error: null });
        return refresh();
      },
    };
  });
}
