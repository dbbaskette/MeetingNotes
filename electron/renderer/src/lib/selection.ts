// electron/renderer/src/lib/selection.ts
//
// Selection is a fixed ID snapshot, never a predicate over loaded rows.
// The shared store survives Library unmounts without persisting across app runs.
import { createStore } from 'zustand/vanilla';
import { hydrateMeetingIds } from './meeting-hydration';
import type { MeetingFilter } from './paged-meetings';

export interface SelectableMeeting {
  id: string;
  status: string;
}

interface LibrarySelectionState {
  selected: Set<string>;
  mode: 'explicit' | 'all-matching';
  universe: string | null;
  resolving: boolean;
  busy: boolean;
  beginOperation: () => boolean;
  endOperation: () => void;
  toggle: (id: string) => void;
  selectLoaded: (rows: readonly { id: string }[]) => void;
  selectMatching: (universe: string, resolveIds: () => Promise<readonly string[]>) => Promise<void>;
  cancelResolution: () => void;
  clear: () => void;
  removeSucceeded: (ids: readonly string[]) => void;
}

export function createLibrarySelection() {
  return createStore<LibrarySelectionState>()((set, get) => {
    let generation = 0;
    const explicit = (selected: Set<string>): void => {
      generation++;
      set({ selected, mode: 'explicit', universe: null, resolving: false });
    };
    return {
      selected: new Set(), mode: 'explicit', universe: null, resolving: false, busy: false,
      beginOperation: () => {
        if (get().busy) return false;
        generation++;
        set({ busy: true, resolving: false });
        return true;
      },
      endOperation: () => set({ busy: false }),
      toggle: (id) => {
        const next = new Set(get().selected);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        explicit(next);
      },
      selectLoaded: (rows) => explicit(new Set([...get().selected, ...rows.map((row) => row.id)])),
      selectMatching: async (universe, resolveIds) => {
        const request = ++generation;
        set({ resolving: true });
        try {
          const ids = await resolveIds();
          if (request === generation) set({ selected: new Set(ids), mode: 'all-matching', universe });
        } finally {
          if (request === generation) set({ resolving: false });
        }
      },
      // A filter/search change or unmount invalidates only unfinished work.
      // A completed matching snapshot remains fixed until an explicit action.
      cancelResolution: () => { generation++; set({ resolving: false }); },
      clear: () => explicit(new Set()),
      removeSucceeded: (ids) => {
        const next = new Set(get().selected);
        for (const id of ids) next.delete(id);
        generation++;
        set({ selected: next, resolving: false });
      },
    };
  });
}

export const librarySelection = createLibrarySelection();

/** Search results here are already hydrated and filtered by the view. Never
 * widen that capped search universe to a browse-filter ID query. */
export function selectionScope({ isSearching, filter, loaded, searchResults, total }: {
  isSearching: boolean;
  filter: MeetingFilter;
  loaded: readonly { id: string }[];
  searchResults: readonly { id: string }[];
  total: number;
}) {
  const loadedIds = [...new Set((isSearching ? searchResults : loaded).map((row) => row.id))];
  return {
    loadedIds,
    matchingCount: !isSearching && total > loadedIds.length ? total : null,
    resolveIds: (listIds: (filter: MeetingFilter) => Promise<string[]>): Promise<string[]> =>
      isSearching ? Promise.resolve([...loadedIds]) : listIds(filter),
  };
}

/** Missing summaries may be unloaded, moved, or deleted; they must never
 * silently shrink the Delete snapshot. Only hydrated pending IDs can start. */
export function partitionSelection(
  selected: ReadonlySet<string>,
  meetings: readonly SelectableMeeting[],
): { pendingIds: string[]; allIds: string[] } {
  const status = new Map(meetings.map((meeting) => [meeting.id, meeting.status]));
  const allIds = [...selected];
  return { pendingIds: allIds.filter((id) => status.get(id) === 'pending'), allIds };
}

export async function hydrateSelection(
  selected: ReadonlySet<string>, getMany: (ids: string[]) => Promise<SelectableMeeting[]>,
): Promise<ReturnType<typeof partitionSelection>> {
  const snapshot = new Set(selected);
  return partitionSelection(snapshot, await hydrateMeetingIds([...snapshot], getMany));
}

export function selectionConfirmation(action: 'process' | 'delete', input: readonly string[]) {
  const ids = [...new Set(input)];
  const n = ids.length;
  return {
    action, ids,
    title: action === 'delete'
      ? `Move ${n} meeting${n === 1 ? '' : 's'} to Recently deleted?`
      : `Process ${n} pending recording${n === 1 ? '' : 's'}?`,
  };
}

export interface SelectionOperationResult { succeededIds: string[]; failedIds: string[] }

export async function runBulkProcess(
  input: readonly string[],
  startMany: (ids: string[]) => Promise<{ startedIds: string[]; failedIds: string[] }>,
): Promise<SelectionOperationResult> {
  const ids = [...new Set(input)];
  const succeeded = new Set<string>();
  for (let start = 0; start < ids.length; start += 1000) {
    try {
      const result = await startMany(ids.slice(start, start + 1000));
      for (const id of result.startedIds) succeeded.add(id);
    } catch { /* An uncertain/rejected batch stays selected; later batches proceed. */ }
  }
  return {
    succeededIds: ids.filter((id) => succeeded.has(id)),
    failedIds: ids.filter((id) => !succeeded.has(id)),
  };
}

export async function runBulkDelete(
  input: readonly string[], deleteOne: (id: string) => Promise<void>,
): Promise<SelectionOperationResult> {
  const ids = [...new Set(input)];
  const results = await Promise.allSettled(ids.map(async (id) => deleteOne(id)));
  return {
    succeededIds: ids.filter((_, index) => results[index]!.status === 'fulfilled'),
    failedIds: ids.filter((_, index) => results[index]!.status === 'rejected'),
  };
}
