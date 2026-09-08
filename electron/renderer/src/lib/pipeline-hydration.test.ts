import { afterEach, describe, expect, it, vi } from 'vitest';
import { startPipelineHydration } from './pipeline-hydration';

afterEach(() => { vi.useRealTimers(); });

describe('pipeline hydration poll', () => {
  it('hydrates only active IDs immediately and polls while a current meeting exists', async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const results: { id: string; title: string }[][] = [];
    const stop = startPipelineHydration({ currentId: 'current', queueIds: ['queued', 'current'] }, async (ids) => {
      batches.push(ids);
      return ids.map((id) => ({ id, title: `version ${batches.length}` }));
    }, (rows) => results.push(rows));
    await vi.advanceTimersByTimeAsync(3000);
    expect(batches).toEqual([['current', 'queued'], ['current', 'queued']]);
    expect(results[1]![0]!.title).toBe('version 2');
    stop();
    await vi.advanceTimersByTimeAsync(9000);
    expect(batches).toHaveLength(2);
  });

  it('never overlaps slow hydrations and ignores obsolete completion after cleanup', async () => {
    vi.useFakeTimers();
    let resolve!: (rows: { id: string }[]) => void;
    let calls = 0;
    const results: { id: string }[][] = [];
    const stop = startPipelineHydration({ currentId: 'old', queueIds: [] }, () => {
      calls++;
      return new Promise<{ id: string }[]>((done) => { resolve = done; });
    }, (rows) => results.push(rows));
    await vi.advanceTimersByTimeAsync(9000);
    expect(calls).toBe(1);
    stop();
    resolve([{ id: 'old' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([]);
  });

  it('retains previous output on failure and retries on the next tick', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let latest = [{ id: 'previous' }];
    const stop = startPipelineHydration({ currentId: 'current', queueIds: [] }, async () => {
      if (++calls === 1) throw new Error('busy');
      return [{ id: 'current' }];
    }, (rows) => { latest = rows; });
    await vi.advanceTimersByTimeAsync(0);
    expect(latest).toEqual([{ id: 'previous' }]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(latest).toEqual([{ id: 'current' }]);
    stop();
  });

  it('hydrates queue-only status once without perpetual polling', async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const stop = startPipelineHydration({ currentId: null, queueIds: ['waiting'] }, async (ids) => {
      batches.push(ids);
      return ids.map((id) => ({ id }));
    }, () => {});
    await vi.advanceTimersByTimeAsync(9000);
    expect(batches).toEqual([['waiting']]);
    stop();
  });
});
