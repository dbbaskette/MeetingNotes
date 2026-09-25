export type MeetingCounts = {
  all: number;
  pending: number;
  processing: number;
  done: number;
  failed: number;
};

/** First-page requests always recompute. Continuation pages of the same
 *  filter/sort reuse that snapshot so a prefix refresh does not scan the
 *  live table once per loaded page. */
export function createCountsCache() {
  let last: { key: string; counts: MeetingCounts } | null = null;
  return {
    forQuery(
      query: { filter: string; sort: string; groupId?: string | null; cursor?: string },
      load: () => MeetingCounts,
    ): MeetingCounts {
      const scope = query.groupId === undefined ? 'all' : query.groupId === null ? 'ungrouped' : query.groupId;
      const key = JSON.stringify([query.filter, query.sort, scope]);
      if (query.cursor !== undefined && last?.key === key) return last.counts;
      const counts = load();
      last = { key, counts };
      return counts;
    },
  };
}
