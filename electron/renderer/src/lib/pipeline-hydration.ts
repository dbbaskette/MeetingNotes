import { hydrateMeetingIds, pipelineMeetingIds } from './meeting-hydration';
import type { PipelineStatusSnapshot } from './status-bar';

type PipelineSnapshot = Pick<PipelineStatusSnapshot, 'currentId' | 'queueIds'>;

/** One lifecycle-owned controller survives status replacements. An unresolved
 * IPC cannot be cancelled, so wait for it before hydrating the latest snapshot
 * and stop obsolete snapshots at the next batch boundary. */
export function createPipelineHydration<T extends { id: string }>(
  getMany: (ids: string[]) => Promise<T[]>,
  onRows: (rows: T[]) => void,
): { update: (status: PipelineSnapshot) => void; stop: () => void } {
  let ids: string[] = [];
  let generation = 0;
  let stopped = true;
  let busy = false;
  let pending = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const drain = async (): Promise<void> => {
    if (busy || stopped) return;
    busy = true;
    try {
      while (pending && !stopped) {
        pending = false;
        const current = generation;
        try {
          const rows = await hydrateMeetingIds(ids, (batch) => {
            if (current !== generation || stopped) throw new Error('Obsolete pipeline snapshot');
            return getMany(batch);
          });
          if (current === generation && !stopped) onRows(rows);
        } catch { /* keep the last good rows; a queued snapshot still runs */ }
      }
    } finally { busy = false; }
  };

  return {
    update(status) {
      generation++;
      ids = pipelineMeetingIds(status);
      stopped = false;
      pending = true;
      if (timer !== null) clearInterval(timer);
      // Current work can continue while paused; a queue alone is static.
      timer = status.currentId ? setInterval(() => {
        if (busy) return; // skip slow ticks, don't accumulate a poll backlog
        pending = true;
        void drain();
      }, 3000) : null;
      void drain();
    },
    stop() {
      stopped = true;
      generation++;
      pending = false;
      if (timer !== null) clearInterval(timer);
      timer = null;
      // Keep busy until the outstanding IPC settles, even if effects restart.
    },
  };
}
