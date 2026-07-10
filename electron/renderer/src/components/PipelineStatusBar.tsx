// electron/renderer/src/components/PipelineStatusBar.tsx
//
// App-wide bottom status bar: shows the in-flight pipeline run from ANY view
// (Library, Weekly, Settings, detail) so progress isn't hidden behind the one
// view that happens to render it. A thin shell over the pure `status-bar`
// module — all the string/visibility logic is unit-tested there.
import { useEffect, useMemo, useState } from 'react';
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

export function PipelineStatusBar({ onOpenMeeting }: Props): JSX.Element {
  const { meetings, refresh } = useMeetingsStore();
  const [status, setStatus] = useState<PipelineStatusSnapshot>({
    paused: false, currentId: null, queueLength: 0, queueIds: [],
  });
  const [version, setVersion] = useState('');
  useEffect(() => { void api.app.getVersion().then(setVersion); }, []);

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

  // Memoized: useElapsed re-renders this bar every second while processing,
  // and deriveStatusBar scans the whole meetings array each call.
  const model = useMemo(() => deriveStatusBar(meetings, status), [meetings, status]);

  // Keep title/stage/ETA fresh from Settings/Weekly/detail (LibraryView's
  // poll only runs while it's mounted). Shared + ref-counted with the
  // Library's hold, so on the Library view this adds zero extra IPC.
  useMeetingsPoll(!!(model && model.kind === 'processing' && model.meetingId));

  const elapsed = useElapsed(model?.stageStartedAt ?? null, model?.kind === 'processing');

  // Permanent bar: when nothing is processing, sit idle showing the app version
  // and "Ready" rather than disappearing. When a meeting is in flight it takes
  // over with the live "Summarizing … — 17s · ~3m · 2 queued" status (this is
  // where the elapsed/ETA timers live app-wide).
  const clickable = model?.meetingId != null;
  return (
    <div
      className={`shrink-0 z-[900] border-t border-surface-border bg-surface-sunken/95 backdrop-blur px-4 py-1.5 text-xs text-ink-muted flex items-center gap-2 ${
        clickable ? 'cursor-pointer hover:text-ink' : ''
      }`}
      onClick={clickable ? () => onOpenMeeting(model!.meetingId!) : undefined}
      role={clickable ? 'button' : undefined}
      title={clickable ? 'Open this meeting' : undefined}
    >
      {model?.kind === 'processing' && model.meetingId ? (
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-brand-indigo animate-pulse" />
      ) : (
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-status-ok/70" />
      )}
      <span className="truncate">
        {model ? statusBarText(model, elapsed) : `MeetingNotes${version ? ` v${version}` : ''} · Ready`}
      </span>
    </div>
  );
}
