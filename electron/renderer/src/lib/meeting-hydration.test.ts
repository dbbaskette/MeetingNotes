import { describe, expect, it } from 'vitest';
import { createAttentionController, hydrateAttentionMeetings, hydrateMeetingIds, pipelineMeetingIds } from './meeting-hydration';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

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

describe('attention refresh lifecycle', () => {
  it('deduplicates ordinary refreshes without adding a trailing invalidation', async () => {
    const blocked = deferred<string[]>();
    let snapshots = 0;
    let batches = 0;
    const publications: Array<Array<{ id: string }>> = [];
    const controller = createAttentionController({
      listIds: async (filter) => { snapshots++; return filter === 'pending' ? blocked.promise : []; },
      getMany: async (ids) => { batches++; return ids.map((id) => ({ id })); },
    }, (rows) => publications.push(rows));
    const request = controller.start();
    for (let i = 0; i < 100; i++) expect(controller.refresh()).toBe(request);
    blocked.resolve(['pending']);
    await request;
    expect(snapshots).toBe(3);
    expect(batches).toBe(1);
    expect(publications).toEqual([[{ id: 'pending' }]]);
    controller.stop();
  });

  it('waits for outstanding ID calls after a sibling failure before refreshing the latest snapshot', async () => {
    const blocked = deferred<string[]>();
    let snapshots = 0;
    let batches = 0;
    const publications: Array<Array<{ id: string }>> = [];
    const controller = createAttentionController({
      listIds: async (filter) => {
        snapshots++;
        if (snapshots === 1) throw new Error('snapshot busy');
        if (snapshots === 2) return blocked.promise;
        return filter === 'pending' ? ['latest'] : [];
      },
      getMany: async (ids) => { batches++; return ids.map((id) => ({ id })); },
    }, (rows) => publications.push(rows));
    const request = controller.start();
    await Promise.resolve();
    await Promise.resolve();
    controller.invalidate();
    await Promise.resolve();
    await Promise.resolve();
    expect(snapshots).toBe(3);
    expect(batches).toBe(0);
    blocked.resolve(['obsolete']);
    await request;
    expect(snapshots).toBe(6);
    expect(publications).toEqual([[{ id: 'latest' }]]);
    controller.stop();
  });

  it('coalesces 100 notifications over 2,000 actionable IDs, stops obsolete batches and publishes only the latest result', async () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `actionable-${i}`);
    const started = deferred<void>();
    const blocked = deferred<void>();
    let version = 0;
    let snapshots = 0;
    let concurrency = 0;
    let maxConcurrency = 0;
    const batches: number[] = [];
    const publications: Array<Array<{ id: string; version: number }>> = [];
    const controller = createAttentionController({
      listIds: async (filter) => {
        snapshots++;
        return filter === 'pending' ? ids.slice(0, 1500) : filter === 'failed' ? ids.slice(1500, 1750) : ids.slice(1750);
      },
      getMany: async (batch) => {
        batches.push(batch.length);
        maxConcurrency = Math.max(maxConcurrency, ++concurrency);
        const captured = version;
        if (batches.length === 1) { started.resolve(); await blocked.promise; }
        concurrency--;
        return batch.map((id) => ({ id, version: captured }));
      },
    }, (rows) => publications.push(rows));
    const refresh = controller.start();
    await started.promise;
    expect(controller.refresh()).toBe(refresh); // Manual refresh only deduplicates.
    for (version = 1; version <= 100; version++) expect(controller.invalidate()).toBe(refresh);
    version = 100;
    expect(snapshots).toBe(3);
    expect(batches).toEqual([1000]);
    blocked.resolve();
    await refresh;
    expect(snapshots).toBe(6); // Original plus exactly one latest snapshot.
    expect(batches).toEqual([1000, 1000, 1000]); // No second obsolete batch.
    expect(maxConcurrency).toBe(1);
    expect(publications).toHaveLength(1);
    expect(publications[0]).toEqual(ids.map((id) => ({ id, version: 100 })));
    controller.stop();
  });

  it('stops before hydration when invalidated during the ID snapshot', async () => {
    const blocked = deferred<string[]>();
    const batches: string[][] = [];
    let snapshots = 0;
    const publications: Array<Array<{ id: string }>> = [];
    const controller = createAttentionController({
      listIds: async (filter) => {
        snapshots++;
        if (filter !== 'pending') return [];
        return snapshots === 1 ? blocked.promise : ['latest'];
      },
      getMany: async (ids) => { batches.push(ids); return ids.map((id) => ({ id })); },
    }, (rows) => publications.push(rows));
    const request = controller.start();
    controller.invalidate();
    blocked.resolve(['obsolete']);
    await request;
    expect(snapshots).toBe(6);
    expect(batches).toEqual([['latest']]);
    expect(publications).toEqual([[{ id: 'latest' }]]);
    controller.stop();
  });

  it.each([false, true])('stops old batch work across cleanup (restart: %s)', async (restart) => {
    const started = deferred<void>();
    const blocked = deferred<void>();
    let batches = 0;
    const publications: Array<Array<{ id: string }>> = [];
    const controller = createAttentionController({
      listIds: async (filter) => filter === 'pending' ? Array.from({ length: 2000 }, (_, i) => `${i}`) : [],
      getMany: async (ids) => {
        if (++batches === 1) { started.resolve(); await blocked.promise; }
        return ids.map((id) => ({ id }));
      },
    }, (rows) => publications.push(rows));
    const request = controller.start();
    await started.promise;
    controller.stop();
    if (restart) expect(controller.start()).toBe(request);
    else await controller.invalidate();
    expect(batches).toBe(1);
    blocked.resolve();
    await request;
    expect(batches).toBe(restart ? 3 : 1);
    expect(publications).toHaveLength(restart ? 1 : 0);
    controller.stop();
  });

  it('retains the published result on failure and allows the next refresh to recover', async () => {
    let fail = false;
    const publications: Array<Array<{ id: string }>> = [];
    const controller = createAttentionController({
      listIds: async (filter) => filter === 'pending' ? ['pending'] : [],
      getMany: async (ids) => { if (fail) throw new Error('busy'); return ids.map((id) => ({ id })); },
    }, (rows) => publications.push(rows));
    await controller.start();
    fail = true;
    await controller.invalidate();
    expect(publications).toHaveLength(1);
    fail = false;
    await controller.refresh();
    expect(publications).toHaveLength(2);
    controller.stop();
  });
});
