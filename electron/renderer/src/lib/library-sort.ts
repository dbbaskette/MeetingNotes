// electron/renderer/src/lib/library-sort.ts
//
// The Library's browse-mode sort choices. Ordering itself happens in the
// main process (the paged query sorts by the chosen key); this module only
// names the options and validates a stored choice.

export type LibrarySortKey = 'newest' | 'oldest' | 'longest' | 'title';

export const LIBRARY_SORT_OPTIONS: { key: LibrarySortKey; label: string }[] = [
  { key: 'newest', label: 'Newest' },
  { key: 'oldest', label: 'Oldest' },
  { key: 'longest', label: 'Longest' },
  { key: 'title', label: 'Title A–Z' },
];

/** Coerce a persisted (localStorage) value back to a valid key —
 *  anything unknown falls back to the default 'newest'. */
export function sanitizeSortKey(v: unknown): LibrarySortKey {
  return LIBRARY_SORT_OPTIONS.some((o) => o.key === v)
    ? (v as LibrarySortKey)
    : 'newest';
}
