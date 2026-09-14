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
      query: { filter: string; sort: string; cursor?: string },
      load: () => MeetingCounts,
    ): MeetingCounts {
      const key = `${query.filter}:${query.sort}`;
      if (query.cursor !== undefined && last?.key === key) return last.counts;
      const counts = load();
      last = { key, counts };
      return counts;
    },
  };
}
