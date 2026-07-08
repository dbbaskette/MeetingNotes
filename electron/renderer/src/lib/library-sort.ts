// electron/renderer/src/lib/library-sort.ts
//
// Comparator factory for the Library's browse-mode sort dropdown. The
// status-bucket precedence is fixed (pending/awaiting/processing/failed
// float above done, exactly as before); the chosen key only re-orders
// WITHIN each bucket. Pure so it can be unit-tested without a DOM
// harness.

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

export interface SortableMeeting {
  title: string;
  status: string;
  startedAt: string | null;
  durationS: number | null;
}

// Same bucket order the view has always used: actionable states first,
// finished meetings last, unknown statuses at the very bottom.
const STATUS_RANK: Record<string, number> = {
  pending: 0, awaiting_user: 1, processing: 2, failed: 3, done: 4,
};

/** Recency, newest first; meetings without a startedAt sink to the end.
 *  (Empty string compares before any ISO date, so with b-vs-a operand
 *  order a null lands after everything dated.) */
function byNewest(a: SortableMeeting, b: SortableMeeting): number {
  return (b.startedAt ?? '').localeCompare(a.startedAt ?? '');
}

/** Build the full browse comparator: status bucket first, then the
 *  chosen key within the bucket. Null startedAt/durationS always sort
 *  last within their bucket, whatever the key. */
export function libraryComparator(
  key: LibrarySortKey,
): (a: SortableMeeting, b: SortableMeeting) => number {
  const inBucket = (a: SortableMeeting, b: SortableMeeting): number => {
    switch (key) {
      case 'oldest': {
        if (a.startedAt === null && b.startedAt === null) return 0;
        if (a.startedAt === null) return 1;
        if (b.startedAt === null) return -1;
        return a.startedAt.localeCompare(b.startedAt);
      }
      case 'longest': {
        if (a.durationS !== null || b.durationS !== null) {
          if (a.durationS === null) return 1;
          if (b.durationS === null) return -1;
          if (a.durationS !== b.durationS) return b.durationS - a.durationS;
        }
        return byNewest(a, b);
      }
      case 'title': {
        const diff = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
        return diff !== 0 ? diff : byNewest(a, b);
      }
      case 'newest':
      default:
        return byNewest(a, b);
    }
  };
  return (a, b) => {
    const ra = STATUS_RANK[a.status] ?? 9;
    const rb = STATUS_RANK[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    return inBucket(a, b);
  };
}
