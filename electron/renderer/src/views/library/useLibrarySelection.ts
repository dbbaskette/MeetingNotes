// electron/renderer/src/views/library/useLibrarySelection.ts
//
// Selection status hydration and the bulk Process / Delete / Select-matching
// actions, moved out of LibraryView.tsx unchanged (#256). Each hook is called
// at the same position in the view, so hook order, effect order and
// dependency arrays are as before.
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { useToast } from '../../components/Toasts';
import { api } from '../../ipc/client';
import {
  librarySelection, hydrateSelection, runBulkDelete, runBulkProcess,
  selectionConfirmation, type selectionScope,
} from '../../lib/selection';
import type { MeetingSummary } from '../../lib/paged-meetings';

type PendingSnapshot = { selection: Set<string>; ids: string[] } | null;

// Loaded pages never prune selection. Hydrate its exact IDs for status-only
// partitioning, including off-page rows while the pipeline is moving.
export function useSelectionPending({
  selected, meetings, searchMeetings, searchRevision, hasMotion,
}: {
  selected: Set<string>;
  meetings: MeetingSummary[];
  searchMeetings: MeetingSummary[];
  searchRevision: number;
  hasMotion: boolean;
}) {
  const [pendingSnapshot, setPendingSnapshot] = useState<PendingSnapshot>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  useEffect(() => {
    if (selected.size === 0) {
      // Nothing to hydrate: no IPC and no fresh snapshot object per poll tick.
      setPendingSnapshot(previous => previous?.selection === selected && previous.ids.length === 0
        ? previous : { selection: selected, ids: [] });
      setSelectionError(null);
      return;
    }
    let cancelled = false;
    let inflight = false;
    const hydrate = async (): Promise<void> => {
      if (inflight) return;
      inflight = true;
      try {
        const result = await hydrateSelection(selected, api.meetings.getMany);
        if (!cancelled) {
          setPendingSnapshot({ selection: selected, ids: result.pendingIds });
          setSelectionError(null);
        }
      } catch {
        if (!cancelled) {
          setPendingSnapshot(null);
          setSelectionError('Unable to check selected meetings. Retry Process to check again.');
        }
      } finally { inflight = false; }
    };
    void hydrate();
    const timer = hasMotion && selected.size > 0 ? window.setInterval(() => void hydrate(), 3000) : undefined;
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selected, meetings, searchMeetings, searchRevision, hasMotion]);
  const selectedPendingCount = pendingSnapshot?.selection === selected ? pendingSnapshot.ids.length : null;
  return { setPendingSnapshot, selectionError, setSelectionError, selectedPendingCount };
}

export function useBulkSelectionActions({
  toast, invalidate, refreshTrash, scope, selectionUniverse, setPendingSnapshot, setSelectionError,
}: {
  toast: ReturnType<typeof useToast>;
  invalidate: () => Promise<void>;
  refreshTrash: () => Promise<void>;
  scope: ReturnType<typeof selectionScope>;
  selectionUniverse: string;
  setPendingSnapshot: Dispatch<SetStateAction<PendingSnapshot>>;
  setSelectionError: Dispatch<SetStateAction<string | null>>;
}) {
  const [confirmation, setConfirmation] = useState<ReturnType<typeof selectionConfirmation> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function selectMatching(): Promise<void> {
    try {
      await librarySelection.getState().selectMatching(selectionUniverse, () => scope.resolveIds(api.meetings.listIds));
    } catch {
      toast.show({ message: 'Unable to select matching meetings. Your previous selection is unchanged.', variant: 'error' });
    }
  }

  async function requestProcessSelected(): Promise<void> {
    const state = librarySelection.getState();
    if (state.selected.size === 0 || !state.beginOperation()) return;
    const snapshot = state.selected;
    try {
      // Refresh off-page statuses immediately before freezing the queue IDs.
      const { pendingIds } = await hydrateSelection(snapshot, api.meetings.getMany);
      if (!mounted.current) return;
      setPendingSnapshot({ selection: snapshot, ids: pendingIds });
      setSelectionError(null);
      if (pendingIds.length === 0) {
        toast.show({ message: 'No selected recordings are pending.', durationMs: 4000 });
        return;
      }
      const result = await runBulkProcess(pendingIds, api.meetings.startManyDetailed);
      // Keep failures and non-pending selections for retry; progress rows
      // remain navigable even when those selections are still present.
      librarySelection.getState().removeSucceeded(result.succeededIds);
      if (result.failedIds.length > 0) toast.show({
        message: `${result.failedIds.length} recording${result.failedIds.length === 1 ? '' : 's'} not queued; still selected for retry.`,
        variant: 'error', durationMs: 4000,
      });
    } catch {
      toast.show({ message: 'Unable to queue selected recordings. Check their status and retry Process.', variant: 'error', durationMs: 4000 });
    } finally {
      librarySelection.getState().endOperation();
      void invalidate();
    }
  }

  function requestDeleteSelected(): void {
    const state = librarySelection.getState();
    if (!state.busy && state.selected.size > 0) setConfirmation(selectionConfirmation('delete', [...state.selected]));
  }

  async function applyConfirmation(): Promise<void> {
    if (!confirmation || !librarySelection.getState().beginOperation()) return;
    const { ids } = confirmation;
    setConfirmation(null);
    try {
      const result = await runBulkDelete(ids, api.meetings.delete);
      librarySelection.getState().removeSucceeded(result.succeededIds);
      const n = result.succeededIds.length;
      const failed = result.failedIds.length;
      const message = `${n} meeting${n === 1 ? '' : 's'} moved to Recently deleted`;
      toast.show({
        message: message + (failed > 0 ? ` ${failed} not deleted; still selected for retry.` : ''),
        variant: failed > 0 ? 'error' : 'default',
        durationMs: 10_000,
        action: n > 0 ? {
          label: 'Undo',
          onClick: async () => {
            // Only successful deletions are undoable — never touch failed IDs.
            const restored = (await Promise.all(result.succeededIds.map((id) => api.meetings.undoDelete(id).catch(() => false)))).filter(Boolean).length;
            if (restored < n) toast.show({ message: `Restored ${restored} of ${n} — the rest were already purged.`, variant: 'error' });
            void invalidate();
            void refreshTrash();
          },
        } : undefined,
      });
    } finally {
      librarySelection.getState().endOperation();
      void invalidate();
      void refreshTrash();
    }
  }

  return { confirmation, setConfirmation, selectMatching, requestProcessSelected, requestDeleteSelected, applyConfirmation };
}
