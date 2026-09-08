import type { PipelineStatusSnapshot } from './status-bar';

/** The IPC boundary accepts at most 1,000 *raw* IDs. Deduplicate before
 * batching and preserve requested order even when rows disappear meanwhile. */
export async function hydrateMeetingIds<T extends { id: string }>(
  ids: readonly string[],
  getMany: (ids: string[]) => Promise<T[]>,
): Promise<T[]> {
  const unique = [...new Set(ids)];
  const byId = new Map<string, T>();
  for (let start = 0; start < unique.length; start += 1000) {
    const rows = await getMany(unique.slice(start, start + 1000));
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
}): Promise<T[]> {
  const snapshots = await Promise.all((['pending', 'failed', 'processing'] as const).map((filter) => api.listIds(filter)));
  return hydrateMeetingIds(snapshots.flat(), api.getMany);
}
