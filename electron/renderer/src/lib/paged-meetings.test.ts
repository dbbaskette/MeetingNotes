import { describe, expect, it } from 'vitest';
import { createPagedMeetings, type MeetingPage, type MeetingSummary } from './paged-meetings';

function row(id: string, patch: Partial<MeetingSummary> = {}): MeetingSummary {
  return {
    id, slug: id, title: id, startedAt: '2026-09-08', durationS: 60,
    groupId: null, groupName: null,
    pipelineStage: 'done', status: 'done', stageStartedAt: null,
    stageEtaMs: null, stageEtaRough: false, unidentifiedCount: 0,
    actionItemsCount: 0, speakers: [], errorMessage: null, skipSpeakerId: false,
    ...patch,
  };
}

function page(items: MeetingSummary[], nextCursor: string | null = null): MeetingPage {
  return { items, nextCursor, total: 200, counts: { all: 200, pending: 20, processing: 30, done: 140, failed: 10 } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const requests: { query: Parameters<Parameters<typeof createPagedMeetings>[0]>[0]; result: ReturnType<typeof deferred<MeetingPage>> }[] = [];
  const store = createPagedMeetings((query) => {
    const result = deferred<MeetingPage>();
    requests.push({ query, result });
    return result.promise;
  });
  return { store, requests };
}

describe('paged meetings', () => {
  it.each([{ errorMessage: 'failed' }, { skipSpeakerId: true }])('does not recycle stale summary fields during refresh: %j', async (patch) => {
    const { store, requests } = harness();
    const first = store.getState().refresh();
    requests[0]!.result.resolve(page([row('a')]));
    await first;
    const refresh = store.getState().refresh();
    requests[1]!.result.resolve(page([row('a', patch)]));
    await refresh;
    expect(store.getState().items[0]).toMatchObject(patch);
  });

  it('can retry a synchronous IPC failure without leaving the first request locked', async () => {
    let attempts = 0;
    const store = createPagedMeetings(() => {
      if (++attempts === 1) throw new Error('IPC unavailable');
      return Promise.resolve(page([row('recovered')]));
    });
    await store.getState().refresh();
    expect(store.getState().error).toBe('IPC unavailable');
    await store.getState().retry();
    expect(store.getState().items.map((m) => m.id)).toEqual(['recovered']);
    expect(store.getState().error).toBeNull();
  });

  it('can retry a synchronous load-more failure without leaving that request locked', async () => {
    let attempts = 0;
    const store = createPagedMeetings(() => {
      if (++attempts === 2) throw new Error('IPC unavailable');
      return Promise.resolve(attempts === 1 ? page([row('a')], 'next') : page([row('b')]));
    });
    await store.getState().refresh();
    await store.getState().loadMore();
    await store.getState().retry();
    expect(store.getState().items.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('loads a default 50-row first page with global counts and filtered total', async () => {
    const { store, requests } = harness();
    const pending = store.getState().refresh();
    expect(store.getState().loadingInitial).toBe(true);
    expect(requests[0]!.query).toEqual({ filter: 'all', sort: 'newest', pageSize: 50 });
    requests[0]!.result.resolve(page([row('a')], 'next'));
    await pending;
    expect(store.getState()).toMatchObject({ items: [row('a')], total: 200, hasMore: true, loadingInitial: false, error: null });
    expect(store.getState().counts.processing).toBe(30);
  });

  it('clears old pages on query change and ignores an obsolete load-more response', async () => {
    const { store, requests } = harness();
    const first = store.getState().refresh();
    requests[0]!.result.resolve(page([row('old')], 'old-cursor'));
    await first;
    const more = store.getState().loadMore();
    const changed = store.getState().setQuery({ filter: 'processing', sort: 'oldest' });
    expect(store.getState()).toMatchObject({ items: [], total: 0, hasMore: false, loadingInitial: true, loadingMore: false });
    expect(requests[2]!.query).toEqual({ filter: 'processing', sort: 'oldest', pageSize: 50 });
    requests[2]!.result.resolve(page([row('new', { status: 'awaiting_user' })]));
    await changed;
    requests[1]!.result.resolve(page([row('obsolete')], 'obsolete-cursor'));
    await more;
    expect(store.getState().items.map((m) => m.id)).toEqual(['new']);
    expect(store.getState().hasMore).toBe(false);
  });

  it('ignores obsolete first-page errors without clearing current loading state', async () => {
    const { store, requests } = harness();
    const old = store.getState().refresh();
    const current = store.getState().setQuery({ filter: 'failed', sort: 'title' });
    requests[0]!.result.reject(new Error('obsolete error'));
    await old;
    expect(store.getState()).toMatchObject({ error: null, loadingInitial: true });
    requests[1]!.result.resolve(page([row('failed')]));
    await current;
    expect(store.getState().items[0]!.id).toBe('failed');
  });

  it('shares duplicate load-more calls and deduplicates overlapping IDs in server order', async () => {
    const { store, requests } = harness();
    const first = store.getState().refresh();
    requests[0]!.result.resolve(page([row('a'), row('b')], 'page2'));
    await first;
    const more = store.getState().loadMore();
    expect(store.getState().loadMore()).toBe(more);
    expect(requests).toHaveLength(2);
    expect(store.getState().loadingMore).toBe(true);
    expect(requests[1]!.query.cursor).toBe('page2');
    requests[1]!.result.resolve(page([row('b'), row('c'), row('c')]));
    await more;
    expect(store.getState().items.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    await store.getState().loadMore();
    expect(requests).toHaveLength(2);
    expect(store.getState().loadingMore).toBe(false);
  });

  it('refreshes the loaded prefix atomically with fresh cursors and recycles unchanged identities', async () => {
    const { store, requests } = harness();
    const first = store.getState().refresh();
    requests[0]!.result.resolve(page([row('a'), row('b')], 'before'));
    await first;
    const more = store.getState().loadMore();
    requests[1]!.result.resolve(page([row('c')], 'before-last'));
    await more;
    const prev = store.getState().items;
    const refresh = store.getState().refresh();
    expect(store.getState().refresh()).toBe(refresh);
    requests[2]!.result.resolve(page([row('b'), row('a', { title: 'renamed' })], 'after'));
    await Promise.resolve();
    expect(requests[3]!.query.cursor).toBe('after');
    expect(store.getState().items).toBe(prev);
    requests[3]!.result.resolve(page([row('c')], 'after-last'));
    await refresh;
    expect(store.getState().items.map((m) => m.id)).toEqual(['b', 'a', 'c']);
    expect(store.getState().items[0]).toBe(prev[1]);
    expect(store.getState().items[1]!.title).toBe('renamed');
    expect(store.getState().items[2]).toBe(prev[2]);
    const next = store.getState().loadMore();
    expect(requests[4]!.query.cursor).toBe('after-last');
    requests[4]!.result.resolve(page([row('d')]));
    await next;
  });

  it('invalidates pending load-more when refresh restarts the cursor chain', async () => {
    const { store, requests } = harness();
    const first = store.getState().refresh();
    requests[0]!.result.resolve(page([row('a')], 'old'));
    await first;
    const more = store.getState().loadMore();
    const refresh = store.getState().refresh();
    expect(requests).toHaveLength(2); // Wait for the old IPC, even though its result is obsolete.
    requests[1]!.result.resolve(page([row('stale')]));
    await more;
    expect(store.getState().items.map((m) => m.id)).toEqual(['a']);
    requests[2]!.result.resolve(page([row('fresh')]));
    await refresh;
    expect(store.getState().items.map((m) => m.id)).toEqual(['fresh']);
  });

  it.each(['terminal', 'arrival'] as const)('coalesces %s events during an unresolved prefix refresh into one fresh chain', async (event) => {
    const { store, requests } = harness();
    const initialRows = [row('active', { status: 'processing' }), row('older')];
    const first = store.getState().refresh();
    requests[0]!.result.resolve(page([initialRows[0]!], 'initial-next'));
    await first;
    const more = store.getState().loadMore();
    requests[1]!.result.resolve(page([initialRows[1]!], 'initial-end'));
    await more;
    const previous = store.getState().items;
    const refresh = store.getState().refresh();
    requests[2]!.result.resolve(page([initialRows[0]!], 'stale-next'));
    await Promise.resolve();
    expect(requests[3]!.query.cursor).toBe('stale-next');
    // Terminal events may also stop polling. No subsequent tick rescues this.
    for (let i = 0; i < 100; i++) expect(store.getState().invalidate()).toBe(refresh);
    expect(requests).toHaveLength(4); // Never overlap the unresolved page.
    requests[3]!.result.resolve(page([row('stale-tail')], 'stale-end'));
    await Promise.resolve();
    expect(store.getState().items).toBe(previous); // No mixed-version publication.
    expect(store.getState().refreshing).toBe(true);
    expect(requests[4]!.query.cursor).toBeUndefined();
    const newest = event === 'terminal' ? row('active') : row('arrived', { status: 'pending' });
    const counts = { all: event === 'arrival' ? 3 : 2, pending: event === 'arrival' ? 1 : 0, processing: 0, done: 2, failed: 0 };
    requests[4]!.result.resolve({ ...page([newest], 'fresh-next'), total: counts.all, counts });
    await Promise.resolve();
    expect(requests[5]!.query.cursor).toBe('fresh-next');
    requests[5]!.result.resolve({ ...page([row('older')]), total: counts.all, counts });
    await refresh;
    expect(requests).toHaveLength(6);
    expect(store.getState()).toMatchObject({ items: [newest, row('older')], total: counts.all, counts, refreshing: false });
  });

  it('discards a queued invalidation after the query generation changes', async () => {
    const { store, requests } = harness();
    const old = store.getState().refresh();
    store.getState().invalidate();
    const changed = store.getState().setQuery({ filter: 'failed', sort: 'title' });
    requests[0]!.result.resolve(page([row('obsolete')], 'obsolete-next'));
    await old;
    expect(requests).toHaveLength(2);
    expect(store.getState().loadingInitial).toBe(true);
    requests[1]!.result.resolve(page([row('current')]));
    await changed;
    expect(store.getState().items.map((m) => m.id)).toEqual(['current']);
  });

  it('runs a trailing invalidation even when the obsolete refresh fails', async () => {
    const { store, requests } = harness();
    const refreshing = store.getState().refresh();
    store.getState().invalidate();
    requests[0]!.result.reject(new Error('obsolete failure'));
    await Promise.resolve();
    expect(store.getState().error).toBeNull();
    requests[1]!.result.resolve(page([row('latest')]));
    await refreshing;
    expect(store.getState().items.map((m) => m.id)).toEqual(['latest']);
  });

  it('preserves rows and cursor on page errors, then retries the failed page', async () => {
    const { store, requests } = harness();
    const first = store.getState().refresh();
    requests[0]!.result.resolve(page([row('a')], 'next'));
    await first;
    const prev = store.getState().items;
    const more = store.getState().loadMore();
    requests[1]!.result.reject(new Error('disk busy'));
    await more;
    expect(store.getState().items).toBe(prev);
    expect(store.getState()).toMatchObject({ error: 'disk busy', loadingMore: false, hasMore: true, total: 200 });
    const retry = store.getState().retry();
    expect(requests[2]!.query.cursor).toBe('next');
    requests[2]!.result.resolve(page([row('b')]));
    await retry;
    expect(store.getState().items.map((m) => m.id)).toEqual(['a', 'b']);
    expect(store.getState().error).toBeNull();
  });

  it('preserves the entire loaded prefix if refresh fails halfway and retries from the start', async () => {
    const { store, requests } = harness();
    const first = store.getState().refresh();
    requests[0]!.result.resolve(page([row('a')], 'next'));
    await first;
    const more = store.getState().loadMore();
    requests[1]!.result.resolve(page([row('b')], 'last'));
    await more;
    const prev = store.getState().items;
    const refresh = store.getState().refresh();
    requests[2]!.result.resolve(page([row('new')], 'new-next'));
    await Promise.resolve();
    requests[3]!.result.reject(new Error('refresh failed'));
    await refresh;
    expect(store.getState().items).toBe(prev);
    expect(store.getState().error).toBe('refresh failed');
    const retry = store.getState().retry();
    expect(requests[4]!.query.cursor).toBeUndefined();
    requests[4]!.result.resolve(page([row('replacement')]));
    await retry;
    expect(store.getState().items.map((m) => m.id)).toEqual(['replacement']);
  });

  it('normalizes the page size to at most 100 and does not restart an unchanged query', async () => {
    const { store, requests } = harness();
    const changed = store.getState().setQuery({ filter: 'all', sort: 'title', pageSize: 1000 });
    expect(requests[0]!.query.pageSize).toBe(100);
    requests[0]!.result.resolve(page([row('a')]));
    await changed;
    await store.getState().setQuery({ filter: 'all', sort: 'title', pageSize: 100 });
    expect(requests).toHaveLength(1);
  });
});
