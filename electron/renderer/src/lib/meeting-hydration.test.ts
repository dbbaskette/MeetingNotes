import { describe, expect, it } from 'vitest';
import { hydrateAttentionMeetings, hydrateMeetingIds, pipelineMeetingIds } from './meeting-hydration';

describe('bounded meeting hydration', () => {
  it('hydrates global actionable snapshots, including off-page speaker-review meetings', async () => {
    const filters: string[] = [];
    const batches: string[][] = [];
    const rows = await hydrateAttentionMeetings({
      listIds: async (filter) => {
        filters.push(filter);
        return filter === 'pending' ? ['pending', 'duplicate'] : filter === 'failed' ? ['failed', 'duplicate'] : ['awaiting', 'running'];
      },
      getMany: async (ids) => { batches.push(ids); return ids.map((id) => ({ id })); },
    });
    expect(filters).toEqual(['pending', 'failed', 'processing']);
    expect(batches).toEqual([['pending', 'duplicate', 'failed', 'awaiting', 'running']]);
    expect(rows.map((row) => row.id)).toEqual(['pending', 'duplicate', 'failed', 'awaiting', 'running']);
  });

  it('hydrates current plus all queued IDs once, with each raw request at most 1,000', async () => {
    const ids = pipelineMeetingIds({ currentId: 'current', queueIds: ['current', ...Array.from({ length: 2001 }, (_, i) => `q${i}`)] });
    const batches: string[][] = [];
    const result = await hydrateMeetingIds(ids, async (batch) => {
      batches.push(batch);
      return batch.map((id) => ({ id }));
    });
    expect(batches.map((batch) => batch.length)).toEqual([1000, 1000, 2]);
    expect(batches[0]![0]).toBe('current');
    expect(result.map((m) => m.id)).toEqual(['current', ...Array.from({ length: 2001 }, (_, i) => `q${i}`)]);
  });

  it('does not fetch an idle pipeline and handles missing IDs without losing requested order', async () => {
    let calls = 0;
    expect(await hydrateMeetingIds(pipelineMeetingIds({ currentId: null, queueIds: [] }), async () => { calls++; return []; })).toEqual([]);
    expect(calls).toBe(0);
    const result = await hydrateMeetingIds(['b', 'missing', 'a', 'b'], async () => [{ id: 'a' }, { id: 'b' }]);
    expect(result.map((m) => m.id)).toEqual(['b', 'a']);
  });
});
