// electron/renderer/src/lib/trash-view.ts
//
// Pure formatting for the Library's "Recently deleted" section. Kept out
// of the component so it can be unit-tested without a DOM harness.

export interface TrashedMeeting {
  id: string;
  title: string;
  deletedAt: string;
}

/** Human "deleted when" label for a trash row: "just now", "5m ago",
 *  "3h ago", "2d ago". Anything unparseable falls back to the raw
 *  string's date part so the row still says *something*. */
export function fmtDeletedAgo(deletedAt: string, now: Date = new Date()): string {
  const t = new Date(deletedAt).valueOf();
  if (isNaN(t)) return deletedAt.slice(0, 10);
  const diffMs = now.valueOf() - t;
  if (diffMs < 60_000) return 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
