import type { PipelineStatusSnapshot } from './status-bar';

/** The IPC boundary accepts at most 1,000 *raw* IDs. Deduplicate before
 * batching and preserve requested order even when rows disappear meanwhile. */
export async function hydrateMeetingIds<T extends { id: string }>(
  ids: readonly string[],
  getMany: (ids: string[]) => Promise<T[]>,
  isCurrent: () => boolean = () => true,
): Promise<T[]> {
  const unique = [...new Set(ids)];
  const byId = new Map<string, T>();
  for (let start = 0; start < unique.length; start += 1000) {
    if (!isCurrent()) return [];
    const rows = await getMany(unique.slice(start, start + 1000));
    if (!isCurrent()) return [];
    for (const row of rows) byId.set(row.id, row);
  }
  return unique.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

export function pipelineMeetingIds(status: Pick<PipelineStatusSnapshot, 'currentId' | 'queueIds'>): string[] {
  return [...new Set([...(status.currentId ? [status.currentId] : []), ...status.queueIds])];
}

/** Preserve global Needs Attention coverage without materializing completed
 * meetings. The processing snapshot includes awaiting_user speaker gates. */
export async function hydrateAttentionMeetings<T extends { id: string }>(api: {
  listIds: (filter: 'pending' | 'failed' | 'processing') => Promise<string[]>;
  getMany: (ids: string[]) => Promise<T[]>;
}, isCurrent: () => boolean = () => true): Promise<T[]> {
  if (!isCurrent()) return [];
  // Await every outstanding ID call even on error before a trailing refresh
  // starts. A rejected sibling must not leave an orphan snapshot in flight.
  const snapshots = await Promise.allSettled((['pending', 'failed', 'processing'] as const).map(async (filter) => api.listIds(filter)));
  if (!isCurrent()) return [];
  const ids = snapshots.flatMap((snapshot) => {
    if (snapshot.status === 'rejected') throw snapshot.reason;
    return snapshot.value;
  });
  return hydrateMeetingIds(ids, api.getMany, isCurrent);
}

/** One lifecycle-owned snapshot/hydration chain. Notifications coalesce into
 * the latest revision; obsolete work stops at the next IPC batch boundary. */
export function createAttentionController<T extends { id: string }>(
  api: Parameters<typeof hydrateAttentionMeetings<T>>[0],
  publish: (rows: T[]) => void,
  onError: (error: string | null) => void = () => {},
) {
  let active = false;
  let generation = 0;
  let request: Promise<void> | null = null;

  function refresh(): Promise<void> {
    if (!active) return Promise.resolve();
    if (request) return request;
    request = (async () => {
      try {
        let current: number;
        do {
          current = generation;
          const isCurrent = () => active && current === generation;
          try {
            const rows = await hydrateAttentionMeetings(api, isCurrent);
            if (isCurrent()) {
              publish(rows);
              onError(null);
            }
          } catch (error) {
            // Retain previous actionable rows; surface the failure so the
            // inbox is not mistaken for “nothing needs attention.”
            if (isCurrent()) {
              onError(error instanceof Error ? error.message : String(error));
            }
          }
        } while (active && current !== generation);
      } finally { request = null; }
    })();
    return request;
  }

  function invalidate(): Promise<void> {
    generation++;
    return refresh();
  }

  return {
    refresh, invalidate,
    start() { active = true; return invalidate(); },
    stop() { active = false; generation++; },
  };
}
