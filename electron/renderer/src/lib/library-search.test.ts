import { describe, expect, it } from 'vitest';
import { hydrateLibrarySearch, groupLibrarySearch } from './library-search';
import type { SearchHit } from '../components/SearchMatches';
import type { MeetingSummary } from './paged-meetings';

const row = (id: string, status = 'done', startedAt = '2026-09-08'): MeetingSummary => ({
  id, slug: id, title: id, status, startedAt, durationS: 60, pipelineStage: 'done',
  stageStartedAt: null, stageEtaMs: null, stageEtaRough: false, unidentifiedCount: 0,
  actionItemsCount: 0, speakers: [], errorMessage: null, skipSpeakerId: false,
});
const hit = (meetingId: string, source: SearchHit['source'], seconds?: number): SearchHit => ({
  meetingId, title: meetingId, source, snippet: `Found ${meetingId}`, ...(seconds === undefined ? {} : { seconds }),
});

describe('Library global search', () => {
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
