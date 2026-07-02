// electron/renderer/src/components/PipelineStatusBar.tsx
//
// App-wide bottom status bar: shows the in-flight pipeline run from ANY view
// (Library, Weekly, Settings, detail) so progress isn't hidden behind the one
// view that happens to render it. A thin shell over the pure `status-bar`
// module — all the string/visibility logic is unit-tested there.
import { useEffect, useState } from 'react';
import { useMeetingsStore, useMeetingsPoll } from '../store/meetings';
import { useElapsed } from '../lib/useElapsed';
import {
  deriveStatusBar,
  statusBarText,
  type PipelineStatusSnapshot,
} from '../lib/status-bar';
import { api } from '../ipc/client';

interface Props {
  onOpenMeeting: (id: string) => void;
}

export function PipelineStatusBar({ onOpenMeeting }: Props): JSX.Element | null {
  const { meetings, refresh } = useMeetingsStore();
  const [status, setStatus] = useState<PipelineStatusSnapshot>({
    paused: false, currentId: null, queueLength: 0, queueIds: [],
  });

  // Same pull-then-subscribe pattern LibraryView uses, so the bar is live even
  // from views that don't poll meetings themselves.
  useEffect(() => {
    void (async () => setStatus(await api.pipeline.status()))();
    const off = api.pipeline.onStatusChange((s) => {
      setStatus(s);
      void refresh();
    });
    return () => { off(); };
  }, [refresh]);

  const model = deriveStatusBar(meetings, status);

  // Keep title/stage/ETA fresh from Settings/Weekly/detail (LibraryView's
  // poll only runs while it's mounted). Shared + ref-counted with the
  // Library's hold, so on the Library view this adds zero extra IPC.
  useMeetingsPoll(!!(model && model.kind === 'processing' && model.meetingId));

  const elapsed = useElapsed(model?.stageStartedAt ?? null, model?.kind === 'processing');

  if (!model) return null;

  const clickable = model.meetingId !== null;
  return (
    <div
      className={`shrink-0 z-[900] border-t border-surface-border bg-surface-sunken/95 backdrop-blur px-4 py-1.5 text-xs text-ink-muted flex items-center gap-2 ${
        clickable ? 'cursor-pointer hover:text-ink' : ''
      }`}
      onClick={clickable ? () => onOpenMeeting(model.meetingId!) : undefined}
      role={clickable ? 'button' : undefined}
      title={clickable ? 'Open this meeting' : undefined}
    >
      {model.kind === 'processing' && model.meetingId && (
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-brand-indigo animate-pulse" />
      )}
      <span className="truncate">{statusBarText(model, elapsed)}</span>
    </div>
  );
}
