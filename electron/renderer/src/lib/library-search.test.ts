import { afterEach, describe, expect, it, vi } from 'vitest';
import { hydrateLibrarySearch, groupLibrarySearch, startLibrarySearchHydration } from './library-search';
import type { SearchHit } from '../components/SearchMatches';
import type { MeetingSummary } from './paged-meetings';

const row = (id: string, status = 'done', startedAt = '2026-09-08'): MeetingSummary => ({
  id, slug: id, title: id, status, startedAt, durationS: 60, pipelineStage: 'done',
  groupId: null, groupName: null,
  stageStartedAt: null, stageEtaMs: null, stageEtaRough: false, unidentifiedCount: 0,
  actionItemsCount: 0, speakers: [], errorMessage: null, skipSpeakerId: false,
});
const hit = (meetingId: string, source: SearchHit['source'], seconds?: number): SearchHit => ({
  meetingId, title: meetingId, source, snippet: `Found ${meetingId}`, ...(seconds === undefined ? {} : { seconds }),
});

afterEach(() => { vi.useRealTimers(); });

describe('Library global search', () => {
  it('refreshes off-page search summaries every three seconds without replacing hits or snippets', async () => {
    vi.useFakeTimers();
    const hits = [hit('off-page', 'transcript', 42), hit('off-page', 'summary')];
    let meetings = [row('off-page', 'processing')];
    const batches: string[][] = [];
    const stop = startLibrarySearchHydration(hits, async (ids) => {
      batches.push(ids);
      return [{ ...row('off-page', 'failed'), pipelineStage: 'summarizing', stageStartedAt: '2026-09-08T10:30:00Z', errorMessage: 'model unavailable' }];
    }, (rows) => { meetings = rows; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches).toEqual([['off-page']]);
    expect(meetings[0]).toMatchObject({ status: 'failed', pipelineStage: 'summarizing', stageStartedAt: '2026-09-08T10:30:00Z', errorMessage: 'model unavailable' });
    const grouped = groupLibrarySearch(hits, meetings, 'all', 'recent');
    expect(grouped.contentMatches.map((m) => m.id)).toEqual(['off-page']);
    expect(grouped.counts).toMatchObject({ processing: 0, failed: 1 });
    expect(grouped.hitsByMeeting.get('off-page')).toEqual(hits);
    expect(grouped.hitsByMeeting.get('off-page')![0]!.seconds).toBe(42);
    await vi.advanceTimersByTimeAsync(3000);
    expect(batches).toHaveLength(2);
    stop();
  });

  it('retains search rows on poll failure and retries without overlapping slow requests', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let resolve!: (rows: MeetingSummary[]) => void;
    let latest = [row('off-page', 'processing')];
    const stop = startLibrarySearchHydration([hit('off-page', 'title')], async () => {
      if (++calls === 1) throw new Error('transient');
      return new Promise<MeetingSummary[]>((done) => { resolve = done; });
    }, (rows) => { latest = rows; });
    await vi.advanceTimersByTimeAsync(3000);
    expect(latest[0]!.status).toBe('processing');
    await vi.advanceTimersByTimeAsync(9000);
    expect(calls).toBe(2);
    resolve([row('off-page', 'done')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(latest[0]!.status).toBe('done');
    stop();
  });

  it('ignores an unresolved old-query poll after cleanup and makes no later calls', async () => {
    vi.useFakeTimers();
    let resolve!: (rows: MeetingSummary[]) => void;
    let calls = 0;
    const published: MeetingSummary[][] = [];
    const stop = startLibrarySearchHydration([hit('old-query', 'title')], () => {
      calls++;
      return new Promise<MeetingSummary[]>((done) => { resolve = done; });
    }, (rows) => published.push(rows));
    await vi.advanceTimersByTimeAsync(3000);
    stop();
    resolve([row('old-query')]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(published).toEqual([]);
    expect(calls).toBe(1);
  });

  it('hydrates every hit ID in first-hit order with a 100-hit global query cap', async () => {
    const calls: unknown[] = [];
    const hits = [hit('outside-page', 'transcript', 15), hit('title', 'title'), hit('outside-page', 'summary')];
    const result = await hydrateLibrarySearch(' needle ', {
      query: async (query, limit) => { calls.push([query, limit]); return hits; },
      getMany: async (ids) => { calls.push(ids); return [row('outside-page'), row('title')]; },
    });
    expect(calls).toEqual([['needle', 100], ['outside-page', 'title']]);
    expect(result.meetings.map((m) => m.id)).toEqual(['outside-page', 'title']);
    expect(result.hits).toBe(hits);
    expect(result.hits[0]!.seconds).toBe(15);
  });

  it('keeps title precedence, server discovery order, snippet stacks and global status counts', () => {
    const hits = [hit('second', 'summary'), hit('first', 'title'), hit('second', 'title'), hit('content', 'transcript', 24), hit('missing', 'title')];
    const result = groupLibrarySearch(hits, [row('first', 'pending'), row('content', 'awaiting_user'), row('second')], 'all', 'recent');
    expect(result.titleMatches.map((m) => m.id)).toEqual(['second', 'first']);
    expect(result.contentMatches.map((m) => m.id)).toEqual(['content']);
    expect(result.hitsByMeeting.get('second')!.map((h) => h.source)).toEqual(['summary', 'title']);
    expect(result.hitsByMeeting.get('content')![0]!.seconds).toBe(24);
    expect(result.counts).toEqual({ all: 3, pending: 1, processing: 1, done: 1, failed: 0 });
  });

  it('treats awaiting_user and processing as the same filter without changing search counts', () => {
    const result = groupLibrarySearch(
      [hit('waiting', 'title'), hit('running', 'transcript'), hit('done', 'summary')],
      [row('waiting', 'awaiting_user'), row('running', 'processing'), row('done')],
      'processing', 'recent',
    );
    expect(result.titleMatches.map((m) => m.id)).toEqual(['waiting']);
    expect(result.contentMatches.map((m) => m.id)).toEqual(['running']);
    expect(result.counts).toMatchObject({ all: 3, processing: 2, done: 1 });
  });

  it('preserves the recent and most-matches Content section sorts', () => {
    const hits = [hit('old', 'summary'), hit('old', 'transcript'), hit('new', 'summary')];
    const meetings = [row('old', 'done', '2025-01-01'), row('new')];
    expect(groupLibrarySearch(hits, meetings, 'all', 'recent').contentMatches.map((m) => m.id)).toEqual(['new', 'old']);
    expect(groupLibrarySearch(hits, meetings, 'all', 'count').contentMatches.map((m) => m.id)).toEqual(['old', 'new']);
  });

  it('does not hydrate empty search results and propagates hydration failures for retry UI', async () => {
    let hydrated = false;
    expect(await hydrateLibrarySearch('absent', {
      query: async () => [],
      getMany: async () => { hydrated = true; return []; },
    })).toEqual({ hits: [], meetings: [] });
    expect(hydrated).toBe(false);
    await expect(hydrateLibrarySearch('present', {
      query: async () => [hit('a', 'title')],
      getMany: async () => { throw new Error('unavailable'); },
    })).rejects.toThrow('unavailable');
  });
});
