import { hydrateMeetingIds, pipelineMeetingIds } from './meeting-hydration';
import type { PipelineStatusSnapshot } from './status-bar';

/** Lifecycle owned by the status bar, independent of the Library's page
 * store. A new status snapshot replaces this poll; late completions cannot
 * republish the old current/queue. Failed polls keep the last good rows. */
export function startPipelineHydration<T extends { id: string }>(
  status: Pick<PipelineStatusSnapshot, 'currentId' | 'queueIds'>,
  getMany: (ids: string[]) => Promise<T[]>,
  onRows: (rows: T[]) => void,
): () => void {
  const ids = pipelineMeetingIds(status);
  let cancelled = false;
  let busy = false;
  const refresh = async (): Promise<void> => {
    if (busy || cancelled) return;
    busy = true;
    try {
      const rows = await hydrateMeetingIds(ids, getMany);
      if (!cancelled) onRows(rows);
    } catch { /* transient failure: retain rows and retry on the next tick */ }
    finally { busy = false; }
  };
  void refresh();
  // A paused pipeline can still be finishing its current meeting. Queued
  // and awaiting-user rows alone are static; status events refresh those.
  const timer = status.currentId ? setInterval(() => { void refresh(); }, 3000) : null;
  return () => {
    cancelled = true;
    if (timer !== null) clearInterval(timer);
  };
}
