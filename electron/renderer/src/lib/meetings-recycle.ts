// electron/renderer/src/lib/meetings-recycle.ts
//
// Referential-identity recycling for the polled meetings list. Every
// meetings:list IPC response is a fresh object graph, so without this a
// single in-flight meeting advancing a stage would hand React 105 brand-new
// row objects and defeat React.memo on every LibraryRow. Recycling keeps
// the old object for any row whose data didn't change, so a memoized row
// only re-renders when *its* meeting moved.

/** The fields a meetings:list row carries. Kept in sync with the store's
 *  MeetingSummary — `rowsEqual` below must compare every field a consumer
 *  can render, or a change in the missed field won't reach the screen. */
export interface MeetingRowLike {
  id: string;
  slug: string;
  title: string;
  startedAt: string | null;
  durationS: number | null;
  pipelineStage: string;
  status: string;
  stageStartedAt: string | null;
  stageEtaMs: number | null;
  stageEtaRough: boolean;
  unidentifiedCount: number;
  actionItemsCount: number;
  speakers: {
    localLabel: string;
    rosterId: string | null;
    displayName: string | null;
    confidence: number | null;
  }[];
}

function rowsEqual(a: MeetingRowLike, b: MeetingRowLike): boolean {
  if (
    a.id !== b.id ||
    a.slug !== b.slug ||
    a.title !== b.title ||
    a.startedAt !== b.startedAt ||
    a.durationS !== b.durationS ||
    a.pipelineStage !== b.pipelineStage ||
    a.status !== b.status ||
    a.stageStartedAt !== b.stageStartedAt ||
    a.stageEtaMs !== b.stageEtaMs ||
    a.stageEtaRough !== b.stageEtaRough ||
    a.unidentifiedCount !== b.unidentifiedCount ||
    a.actionItemsCount !== b.actionItemsCount ||
    a.speakers.length !== b.speakers.length
  ) return false;
  for (let i = 0; i < a.speakers.length; i++) {
    const x = a.speakers[i]!;
    const y = b.speakers[i]!;
    if (
      x.localLabel !== y.localLabel ||
      x.rosterId !== y.rosterId ||
      x.displayName !== y.displayName ||
      x.confidence !== y.confidence
    ) return false;
  }
  return true;
}

/** Merge a fresh list into the previous one, reusing the previous object
 *  for every row whose data is unchanged. Returns `prev` itself when the
 *  lists are identical (same rows, same order) so callers can skip the
 *  store update entirely. */
export function recycleMeetings<T extends MeetingRowLike>(prev: T[], next: T[]): T[] {
  const prevById = new Map(prev.map((m) => [m.id, m]));
  let identical = prev.length === next.length;
  const out = next.map((m, i) => {
    const old = prevById.get(m.id);
    if (old && rowsEqual(old, m)) {
      if (old !== prev[i]) identical = false;
      return old;
    }
    identical = false;
    return m;
  });
  return identical ? prev : out;
}
