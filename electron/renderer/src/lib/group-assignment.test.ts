import { describe, expect, it, vi } from 'vitest';
import { assignGroupInBatches, completedGroupAssignmentIds } from './group-assignment';

describe('assignGroupInBatches', () => {
  it('chunks a large fixed selection and deduplicates IDs', async () => {
    const ids = Array.from({ length: 2100 }, (_, i) => `m${i}`);
    const assign = vi.fn(async (batch: string[]) => ({
      moved: batch.map((id) => ({ id, previousGroupId: null })), failedIds: [],
    }));
    const result = await assignGroupInBatches([...ids, 'm0'], 'group', assign);
    expect(assign.mock.calls.map(([batch]) => batch.length)).toEqual([1000, 1000, 100]);
    expect(result.moved).toHaveLength(2100);
    expect(result.failedIds).toEqual([]);
  });

  it('keeps rejected or failed IDs retryable and passes Undo preconditions', async () => {
    const ids = Array.from({ length: 1100 }, (_, i) => `m${i}`);
    const assign = vi.fn(async (batch: string[], _group: string | null, expected?: string | null) => {
      expect(expected).toBe('current');
      if (batch.length === 100) throw new Error('offline');
      return { moved: batch.slice(0, -1).map((id) => ({ id, previousGroupId: 'old' })),
        failedIds: [batch.at(-1)!] };
    });
    const result = await assignGroupInBatches(ids, 'old', assign, 'current');
    expect(result.moved).toHaveLength(999);
    expect(result.failedIds).toHaveLength(101);
    expect(result.failedIds).toContain('m999');
  });

  it('clears moved and already-in-destination IDs but retains failures', () => {
    const result = { moved: [{ id: 'm1', previousGroupId: null }], failedIds: ['m3'] };
    expect(completedGroupAssignmentIds(['m1', 'm2', 'm3', 'm1'], result)).toEqual(['m1', 'm2']);
  });
});
