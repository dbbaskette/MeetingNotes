// electron/renderer/src/views/library/QueueBanner.tsx
//
// Pipeline queue banner at the top of the Library, moved out of
// LibraryView.tsx unchanged (#256).
import { useMemo } from 'react';
import type { useToast } from '../../components/Toasts';
import { api } from '../../ipc/client';
import type { PipelineStatusSnapshot } from '../../lib/status-bar';

/** Live status of the pipeline queue. Renders only when there's
 *  actual activity (current meeting in flight, or queued items) — no
 *  permanent chrome on a quiet library.
 *
 *  Three buttons:
 *    Pause       — stop pulling new items off the queue. The currently
 *                  in-flight meeting keeps going (we deliberately don't
 *                  abort mid-stage so long transcription passes
 *                  aren't wasted).
 *    Resume      — start pulling again. Visible only while paused.
 *    Clear queue — drop everything that hasn't started yet. Cleared
 *                  meetings flip back to 'pending' so the user can see
 *                  them and decide whether to re-process. The current
 *                  in-flight meeting is NOT touched.
 */
export function QueueBanner({
  status, meetings, onChanged, toast,
}: {
  status: PipelineStatusSnapshot;
  meetings: { id: string; title: string }[];
  onChanged: () => void;
  toast: ReturnType<typeof useToast>;
}): JSX.Element | null {
  const titleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of meetings) m.set(x.id, x.title);
    return m;
  }, [meetings]);

  // Hide entirely when nothing is in flight or waiting. Avoids
  // permanent chrome — the banner only appears when the user actually
  // needs to make a decision.
  if (!status.currentId && status.queueLength === 0) return null;

  const currentTitle = status.currentId ? (titleById.get(status.currentId) ?? '…') : null;

  async function pause(): Promise<void> {
    await api.pipeline.pause();
    toast.show({ message: 'Queue paused — current meeting will finish, then stop.', durationMs: 3500 });
  }
  async function resume(): Promise<void> {
    await api.pipeline.resume();
  }
  async function clear(): Promise<void> {
    const r = await api.pipeline.clear();
    toast.show({
      message: r.cleared.length > 0
        ? `Cleared ${r.cleared.length} from queue. Current meeting still finishing.`
        : 'Queue was already empty.',
      durationMs: 4000,
    });
    onChanged();
  }

  const queuedCount = status.queueLength;
  const tone = status.paused
    ? 'bg-status-warnBg border-status-warn text-status-warnText'
    : 'bg-brand-indigo/5 border-brand-indigo/30 text-ink';
  const dotTone = status.paused
    ? 'bg-status-warn'
    : 'bg-brand-solid animate-pulse';

  return (
    <div className={`mb-4 rounded-xl border px-4 py-3 flex items-center gap-3 ${tone}`}>
      <span className={`w-2 h-2 rounded-full shrink-0 ${dotTone}`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold truncate">
          {status.paused
            ? (status.currentId
              ? <>Paused — finishing <span className="opacity-80">&quot;{currentTitle}&quot;</span></>
              : <>Paused</>
            )
            : (status.currentId
              ? <>Processing <span className="opacity-80">&quot;{currentTitle}&quot;</span></>
              : <>Queue holding</>
            )}
        </div>
        {queuedCount > 0 && (
          <div className="text-[11px] text-ink-muted mt-0.5">
            {queuedCount} more {queuedCount === 1 ? 'meeting' : 'meetings'} queued{status.paused ? ' — won’t start until you resume' : ''}.
          </div>
        )}
      </div>
      {status.currentId && <button type="button" className="text-xs font-semibold px-3 py-1.5 rounded-lg text-danger-text hover:bg-danger-bg transition shrink-0 disabled:opacity-50" disabled={status.cancelling} onClick={() => {
        void api.pipeline.cancel(status.currentId!).then(() => toast.show({ message: 'Stopping this meeting only. Original audio is retained.', durationMs: 4000 }))
          .catch(error => toast.show({ message: String(error), variant: 'error' }));
      }}>{status.cancelling ? 'Cancelling…' : 'Cancel current'}</button>}
      {status.paused ? (
        <button
          type="button"
          onClick={() => void resume()}
          className="btn-primary text-xs px-3 py-1.5 shrink-0"
        >
          Resume
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void pause()}
          className="btn-secondary !px-3 !py-1.5 shrink-0"
        >
          Pause
        </button>
      )}
      {queuedCount > 0 && (
        <button
          onClick={() => void clear()}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg text-ink-muted hover:text-danger-text hover:bg-danger-bg transition shrink-0"
          title="Drop queued meetings (current one keeps running)"
        >
          Clear queue
        </button>
      )}
    </div>
  );
}
