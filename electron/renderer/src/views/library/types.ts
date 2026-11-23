// electron/renderer/src/views/library/types.ts
import type { PagedMeetingsState } from '../../lib/paged-meetings';

export type LibFilter = 'all' | 'pending' | 'processing' | 'done' | 'failed';

export type GroupDialogMode = 'create' | 'rename' | 'delete';

/** LibraryView's `onOpen` prop: open a meeting, with hint data for the
 *  detail skeleton and an optional transcript seek. */
export type LibraryOpen = (
  id: string,
  hint: { title?: string; pipelineStage?: string; status?: string },
  opts?: { seekSeconds?: number },
) => void;

/** localStorage key for the browse-sort choice. Renderer-only preference —
 *  not worth an IPC round-trip to the settings repo. */
export const SORT_STORAGE_KEY = 'librarySortKey';
export const VIEW_STORAGE_KEY = 'libraryViewMode';

export function selectLibraryPage(state: PagedMeetingsState) {
  return {
    items: state.items, counts: state.counts, total: state.total, hasMore: state.hasMore,
    loadingInitial: state.loadingInitial, loadingMore: state.loadingMore, error: state.error,
    query: state.query, setQuery: state.setQuery, refresh: state.refresh, invalidate: state.invalidate,
    loadMore: state.loadMore, retry: state.retry,
  };
}
