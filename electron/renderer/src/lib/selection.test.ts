import { describe, it, expect, vi } from 'vitest';
import {
  createLibrarySelection, hydrateSelection, partitionSelection,
  runBulkDelete, runBulkProcess, selectionConfirmation, selectionScope,
} from './selection';

const meetings = [
  { id: 'p1', status: 'pending' },
  { id: 'd1', status: 'done' },
  { id: 'x1', status: 'processing' },
  { id: 'p2', status: 'pending' },
  { id: 'f1', status: 'failed' },
];

describe('Library selection snapshots', () => {
  it('serializes bulk operations across Library remounts', () => {
    const store = createLibrarySelection();
    expect(store.getState().beginOperation()).toBe(true);
    const off = store.subscribe(() => {});
    off();
    expect(store.getState().busy).toBe(true);
    expect(store.getState().beginOperation()).toBe(false);
    store.getState().endOperation();
    expect(store.getState().beginOperation()).toBe(true);
  });
  it('selects only loaded IDs, preserving previous off-page explicit IDs', () => {
    const store = createLibrarySelection();
    store.getState().toggle('off-page');
    store.getState().selectLoaded(meetings.slice(0, 2));
    expect([...store.getState().selected]).toEqual(['off-page', 'p1', 'd1']);
    expect(store.getState().mode).toBe('explicit');
  });

  it('copies all matching IDs once, excluding later arrivals and page appends', async () => {
    const store = createLibrarySelection();
    const ids = ['p1', 'off-page', 'p1'];
    await store.getState().selectMatching('browse:pending', async () => ids);
    ids.push('later');
    const snapshot = store.getState().selected;
    partitionSelection(snapshot, [...meetings, { id: 'later', status: 'pending' }]);
    expect([...snapshot]).toEqual(['p1', 'off-page']);
    expect(store.getState()).toMatchObject({ mode: 'all-matching', universe: 'browse:pending' });
  });

  it('survives observers unloading/remounting and a filter/search universe change', async () => {
    const store = createLibrarySelection();
    const off = store.subscribe(() => {});
    await store.getState().selectMatching('browse:pending', async () => ['p1', 'off-page']);
    const snapshot = store.getState().selected;
    off();
    store.getState().cancelResolution();
    const remount = store.subscribe(() => {});
    expect(store.getState().selected).toBe(snapshot);
    expect(store.getState().universe).toBe('browse:pending');
    expect(partitionSelection(snapshot, [{ id: 'p1', status: 'processing' }])).toEqual({
      allIds: ['p1', 'off-page'], pendingIds: [],
    });
    remount();
  });

  it('does not replace selection with an obsolete in-flight matching request', async () => {
    const store = createLibrarySelection();
    let resolve!: (ids: string[]) => void;
    store.getState().toggle('kept');
    const request = store.getState().selectMatching('browse:pending', () => new Promise((r) => { resolve = r; }));
    store.getState().cancelResolution();
    resolve(['obsolete']);
    await request;
    expect([...store.getState().selected]).toEqual(['kept']);
    expect(store.getState().resolving).toBe(false);
  });

  it('does not overwrite a toggle or Cancel while matching IDs resolve', async () => {
    const store = createLibrarySelection();
    let resolve!: (ids: string[]) => void;
    const request = store.getState().selectMatching('browse:all', () => new Promise((r) => { resolve = r; }));
    store.getState().toggle('new-choice');
    resolve(['obsolete']);
    await request;
    expect([...store.getState().selected]).toEqual(['new-choice']);
    store.getState().clear();
    expect(store.getState().selected.size).toBe(0);
  });

  it('retains the previous selection when listIds fails', async () => {
    const store = createLibrarySelection();
    store.getState().toggle('kept');
    await expect(store.getState().selectMatching('browse:all', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect([...store.getState().selected]).toEqual(['kept']);
    expect(store.getState().resolving).toBe(false);
  });

  it('removes only successful operation IDs, keeping failed and non-target IDs retryable', () => {
    const store = createLibrarySelection();
    store.getState().selectLoaded(meetings);
    store.getState().removeSucceeded(['p1']);
    expect([...store.getState().selected]).toEqual(['d1', 'x1', 'p2', 'f1']);
    store.getState().removeSucceeded(['d1', 'x1']);
    expect([...store.getState().selected]).toEqual(['p2', 'f1']);
  });
});

describe('selection scope', () => {
  it('offers all matching only beyond the loaded browse count', async () => {
    const listIds = vi.fn(async () => ['p1', 'off-page']);
    const scope = selectionScope({ isSearching: false, filter: 'pending', loaded: [meetings[0]!], searchResults: [], total: 2 });
    expect(scope.matchingCount).toBe(2);
    expect(await scope.resolveIds(listIds)).toEqual(['p1', 'off-page']);
    expect(listIds).toHaveBeenCalledWith('pending');
    expect(selectionScope({ isSearching: false, filter: 'all', loaded: meetings, searchResults: [], total: 5 }).matchingCount).toBeNull();
  });

  it('uses only current filtered hydrated search IDs, never browse listIds', async () => {
    const listIds = vi.fn(async () => ['wrong-browse-id']);
    const results = [meetings[3]!];
    const scope = selectionScope({ isSearching: true, filter: 'pending', loaded: meetings, searchResults: results, total: 99_999 });
    results.push({ id: 'later-search-result', status: 'pending' });
    expect(scope.loadedIds).toEqual(['p2']);
    expect(scope.matchingCount).toBeNull();
    expect(await scope.resolveIds(listIds)).toEqual(['p2']);
    expect(listIds).not.toHaveBeenCalled();
  });
});

describe('off-page hydration and confirmations', () => {
  it('hydrates in raw batches of at most 1,000 and ignores unselected rows', async () => {
    const selected = new Set(Array.from({ length: 2001 }, (_, i) => `id-${i}`));
    const sizes: number[] = [];
    const partition = await hydrateSelection(selected, async (ids) => {
      sizes.push(ids.length);
      if (ids.length > 1000) throw new Error('IPC cap');
      return [...ids.filter((id) => id !== 'id-1001').map((id) => ({ id, status: id === 'id-2000' ? 'pending' : 'done' })), { id: 'unselected', status: 'pending' }];
    });
    expect(sizes).toEqual([1000, 1000, 1]);
    expect(partition.pendingIds).toEqual(['id-2000']);
    expect(partition.allIds).toHaveLength(2001);
    expect(partition.allIds).toContain('id-1001');
    expect(partition.allIds).not.toContain('unselected');
  });

  it('freezes exact confirmation IDs/counts independently of later selection changes', () => {
    const ids = ['p1', 'off-page', 'p1'];
    const deletion = selectionConfirmation('delete', ids);
    ids.push('later');
    expect(deletion.ids).toEqual(['p1', 'off-page']);
    expect(deletion.title).toBe('Move 2 meetings to Recently deleted?');
    expect(selectionConfirmation('process', ['p1']).title).toBe('Process 1 pending recording?');
  });
});

describe('bulk delete result retention', () => {
  it('continues after failed rows and returns only successful IDs for removal and Undo', async () => {
    const deleted: string[] = [];
    const result = await runBulkDelete(['p1', 'd1', 'p2'], async (id) => {
      if (id === 'd1') throw new Error('locked');
      deleted.push(id);
      return true;
    });
    expect(deleted).toEqual(['p1', 'p2']);
    expect(result).toEqual({ succeededIds: ['p1', 'p2'], failedIds: ['d1'] });
  });

  it('does not count or undo an earlier row deletion in a retained A/B snapshot', async () => {
    const store = createLibrarySelection();
    store.getState().selectLoaded([{ id: 'A' }, { id: 'B' }]);
    // A was deleted separately through its row menu after both were selected.
    const deleted = new Set(['A']);
    const result = await runBulkDelete([...store.getState().selected], async (id) => {
      if (deleted.has(id)) return false;
      deleted.add(id);
      return true;
    });
    expect(result).toEqual({ succeededIds: ['B'], failedIds: ['A'] });
    expect(result.succeededIds.length).toBe(1);
    store.getState().removeSucceeded(result.succeededIds);
    expect([...store.getState().selected]).toEqual(['A']);
    for (const id of result.succeededIds) deleted.delete(id);
    expect([...deleted]).toEqual(['A']);
  });

  it('retains both false no-ops and rejected deletions as not deleted', async () => {
    const result = await runBulkDelete(['missing', 'uncertain', 'new'], async (id) => {
      if (id === 'uncertain') throw new Error('IPC disconnected');
      return id === 'new';
    });
    expect(result).toEqual({ succeededIds: ['new'], failedIds: ['missing', 'uncertain'] });
  });
});

describe('bulk process result retention', () => {
  it('caps detailed batches and keeps rejected batches and item failures retryable', async () => {
    const ids = Array.from({ length: 2001 }, (_, i) => `id-${i}`);
    const sizes: number[] = [];
    const result = await runBulkProcess(ids, async (batch) => {
      sizes.push(batch.length);
      if (batch[0] === 'id-1000') throw new Error('IPC disconnected');
      return { startedIds: batch.filter((id) => id !== 'id-5'), failedIds: batch.filter((id) => id === 'id-5') };
    });
    expect(sizes).toEqual([1000, 1000, 1]);
    expect(result.succeededIds).toHaveLength(1000);
    expect(result.succeededIds).toContain('id-2000');
    expect(result.failedIds).toHaveLength(1001);
    expect(result.failedIds[0]).toBe('id-5');
    expect(result.failedIds[1]).toBe('id-1000');
  });
});

describe('partitionSelection', () => {
  it('splits into pending-only (Process) and everything (Delete)', () => {
    const selected = new Set(['p1', 'd1', 'p2', 'f1']);
    const { pendingIds, allIds } = partitionSelection(selected, meetings);
    expect(pendingIds).toEqual(['p1', 'p2']);
    expect(allIds).toEqual(['p1', 'd1', 'p2', 'f1']);
  });

  it('preserves fixed selection order independently of loaded rows', () => {
    const selected = new Set(['f1', 'p1']); // inserted "backwards"
    const { allIds } = partitionSelection(selected, meetings);
    expect(allIds).toEqual(['f1', 'p1']);
  });

  it('keeps unloaded IDs in the exact Delete target', () => {
    const selected = new Set(['p1', 'ghost']);
    const { pendingIds, allIds } = partitionSelection(selected, meetings);
    expect(pendingIds).toEqual(['p1']);
    expect(allIds).toEqual(['p1', 'ghost']);
  });

  it('returns empty arrays for an empty selection', () => {
    const { pendingIds, allIds } = partitionSelection(new Set(), meetings);
    expect(pendingIds).toEqual([]);
    expect(allIds).toEqual([]);
  });
});
