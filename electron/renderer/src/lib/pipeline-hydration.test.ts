import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPipelineHydration } from './pipeline-hydration';

afterEach(() => { vi.useRealTimers(); });

describe('pipeline hydration poll', () => {
  it('serializes unresolved replacements, skips obsolete batches and coalesces to the latest snapshot', async () => {
    vi.useFakeTimers();
    let resolve!: (rows: { id: string }[]) => void;
    const batches: string[][] = [];
    const results: { id: string }[][] = [];
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const hydration = createPipelineHydration(async (ids) => {
      batches.push(ids);
      activeRequests++;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      const rows = batches.length === 1
        ? await new Promise<{ id: string }[]>((done) => { resolve = done; })
        : ids.map((id) => ({ id }));
      activeRequests--;
      return rows;
    }, (rows) => results.push(rows));
    hydration.update({ currentId: 'old', queueIds: Array.from({ length: 2000 }, (_, i) => `old-queue-${i}`) });
    hydration.update({ currentId: 'intermediate', queueIds: [] });
    hydration.update({ currentId: 'latest', queueIds: ['latest-queued'] });
    await vi.advanceTimersByTimeAsync(9000);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1000);
    resolve(batches[0]!.map((id) => ({ id })));
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual(['latest', 'latest-queued']);
    expect(maxActiveRequests).toBe(1);
    expect(results).toEqual([[{ id: 'latest' }, { id: 'latest-queued' }]]);
    hydration.stop();
  });

  it('coalesces a replacement even when the obsolete unresolved request rejects', async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const batches: string[][] = [];
    const results: { id: string }[][] = [];
    const hydration = createPipelineHydration((ids) => {
      batches.push(ids);
      return batches.length === 1
        ? new Promise<{ id: string }[]>((_done, fail) => { reject = fail; })
        : Promise.resolve(ids.map((id) => ({ id })));
    }, (rows) => results.push(rows));
    hydration.update({ currentId: 'old', queueIds: [] });
    hydration.update({ currentId: null, queueIds: ['latest-queued'] });
    reject(new Error('obsolete failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toEqual([['old'], ['latest-queued']]);
    expect(results).toEqual([[{ id: 'latest-queued' }]]);
    await vi.advanceTimersByTimeAsync(9000);
    expect(batches).toHaveLength(2);
    hydration.stop();
  });

  it('keeps serialization through effect cleanup and restart while IPC is unresolved', async () => {
    vi.useFakeTimers();
    let resolve!: (rows: { id: string }[]) => void;
    const batches: string[][] = [];
    const results: { id: string }[][] = [];
    const hydration = createPipelineHydration((ids) => {
      batches.push(ids);
      return batches.length === 1
        ? new Promise<{ id: string }[]>((done) => { resolve = done; })
        : Promise.resolve(ids.map((id) => ({ id })));
    }, (rows) => results.push(rows));
    hydration.update({ currentId: 'old', queueIds: [] });
    hydration.stop();
    hydration.update({ currentId: 'restarted', queueIds: [] });
    expect(batches).toEqual([['old']]);
    resolve([{ id: 'old' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toEqual([['old'], ['restarted']]);
    expect(results).toEqual([[{ id: 'restarted' }]]);
    hydration.stop();
  });

  it('hydrates only active IDs immediately and polls while a current meeting exists', async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const results: { id: string; title: string }[][] = [];
    const hydration = createPipelineHydration(async (ids) => {
      batches.push(ids);
      return ids.map((id) => ({ id, title: `version ${batches.length}` }));
    }, (rows) => results.push(rows));
    hydration.update({ currentId: 'current', queueIds: ['queued', 'current'] });
    await vi.advanceTimersByTimeAsync(3000);
    expect(batches).toEqual([['current', 'queued'], ['current', 'queued']]);
    expect(results[1]![0]!.title).toBe('version 2');
    hydration.stop();
    await vi.advanceTimersByTimeAsync(9000);
    expect(batches).toHaveLength(2);
  });

  it('never overlaps slow hydrations and ignores obsolete completion after cleanup', async () => {
    vi.useFakeTimers();
    let resolve!: (rows: { id: string }[]) => void;
    let calls = 0;
    const results: { id: string }[][] = [];
    const hydration = createPipelineHydration(() => {
      calls++;
      return new Promise<{ id: string }[]>((done) => { resolve = done; });
    }, (rows) => results.push(rows));
    hydration.update({ currentId: 'old', queueIds: [] });
    await vi.advanceTimersByTimeAsync(9000);
    expect(calls).toBe(1);
    hydration.stop();
    resolve([{ id: 'old' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([]);
  });

  it('retains previous output on failure and retries on the next tick', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let latest = [{ id: 'previous' }];
    const hydration = createPipelineHydration(async () => {
      if (++calls === 1) throw new Error('busy');
      return [{ id: 'current' }];
    }, (rows) => { latest = rows; });
    hydration.update({ currentId: 'current', queueIds: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(latest).toEqual([{ id: 'previous' }]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(latest).toEqual([{ id: 'current' }]);
    hydration.stop();
  });

  it('hydrates queue-only status once without perpetual polling', async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const hydration = createPipelineHydration(async (ids) => {
      batches.push(ids);
      return ids.map((id) => ({ id }));
    }, () => {});
    hydration.update({ currentId: null, queueIds: ['waiting'] });
    await vi.advanceTimersByTimeAsync(9000);
    expect(batches).toEqual([['waiting']]);
    hydration.stop();
  });
});
