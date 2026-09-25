export interface GroupAssignOutcome {
  moved: { id: string; previousGroupId: string | null }[];
  failedIds: string[];
}

/** The IPC validates at most 1,000 raw IDs. Keep large fixed selections
 * retryable by submitting independent batches and reporting exact outcomes. */
export async function assignGroupInBatches(
  input: readonly string[],
  groupId: string | null,
  assign: (ids: string[], groupId: string | null, expectedGroupId?: string | null) => Promise<GroupAssignOutcome>,
  expectedGroupId?: string | null,
): Promise<GroupAssignOutcome> {
  const ids = [...new Set(input)];
  const moved: GroupAssignOutcome['moved'] = [];
  const failed = new Set<string>();
  for (let start = 0; start < ids.length; start += 1000) {
    const batch = ids.slice(start, start + 1000);
    try {
      const result = await assign(batch, groupId, expectedGroupId);
      moved.push(...result.moved);
      for (const id of result.failedIds) failed.add(id);
    } catch {
      for (const id of batch) failed.add(id);
    }
  }
  return { moved, failedIds: ids.filter((id) => failed.has(id)) };
}
