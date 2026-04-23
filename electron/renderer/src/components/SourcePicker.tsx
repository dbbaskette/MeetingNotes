import { useEffect, useMemo, useState } from 'react';
import { api } from '../ipc/client';

export interface PickedSource { targetPid: number | 'system'; targetLabel: string; }

interface SourceItem {
  pid: number;
  name: string | null;
  bundleId: string | null;
  isMeetingApp: boolean;
  isRunningOutput: boolean;
}

export function SourcePicker({
  onPick, onCancel,
}: { onPick: (src: PickedSource) => void; onCancel: () => void }): JSX.Element {
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // When the user clicks a visibly-idle meeting app we intercept and show
  // a confirm dialog first — attaching a Process Tap to an idle Zoom/Teams
  // can hang its meeting-join device negotiation (issue #33).
  const [confirmIdle, setConfirmIdle] = useState<SourceItem | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = (await api.recording.listSources()) as SourceItem[];
        setSources(list);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Two groups:
  //   audible  — meeting apps first (flagged by bundle id), then everything
  //              else CoreAudio says is actively writing to an output.
  //   idle     — registered with the audio daemon but not currently emitting.
  //              Greyed out; clicking a meeting app in this group opens a
  //              confirm modal warning about #33.
  const { audible, idle } = useMemo(() => {
    const sortByMeetingFirst = (a: SourceItem, b: SourceItem) =>
      Number(b.isMeetingApp) - Number(a.isMeetingApp);
    return {
      audible: [...sources.filter((s) => s.isRunningOutput)].sort(sortByMeetingFirst),
      idle: [...sources.filter((s) => !s.isRunningOutput)].sort(sortByMeetingFirst),
    };
  }, [sources]);

  function pickOrConfirm(s: SourceItem): void {
    if (!s.isRunningOutput && s.isMeetingApp) {
      setConfirmIdle(s);
      return;
    }
    onPick({ targetPid: s.pid, targetLabel: s.name ?? `PID ${s.pid}` });
  }

  return (
    <div className="absolute right-0 top-full mt-2 z-30 w-80 bg-surface border border-surface-border rounded-xl shadow-pop p-2">
      <div className="text-[11px] font-mono uppercase tracking-wider text-ink-muted px-2 py-1">
        Recording from
      </div>
      {loading && <div className="px-2 py-3 text-sm text-ink-muted">Looking…</div>}
      {error && <div className="px-2 py-3 text-sm text-rose-600">{error}</div>}
      {!loading && audible.length === 0 && (
        <div className="px-2 py-2 text-[11px] text-ink-muted italic">
          Nothing is currently playing audio. Start a meeting or play a sound,
          then reopen this picker.
        </div>
      )}
      {audible.map((s) => (
        <button
          key={s.pid}
          onClick={() => pickOrConfirm(s)}
          className="w-full text-left px-2 py-1.5 rounded-md hover:bg-surface-sunken text-sm flex items-center gap-2"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-status-ok shrink-0" title="Currently audible" />
          <span className="flex-1 truncate">{s.name ?? `PID ${s.pid}`}</span>
          {s.isMeetingApp && <span className="text-[10px] text-brand-indigo font-semibold">MEETING</span>}
        </button>
      ))}

      {idle.length > 0 && (
        <>
          <div className="border-t border-surface-border my-1" />
          <div className="px-2 pt-1 pb-0.5 text-[10px] font-mono uppercase tracking-wider text-ink-muted/70">
            Idle (not currently audible)
          </div>
          {idle.map((s) => (
            <button
              key={s.pid}
              onClick={() => pickOrConfirm(s)}
              className="w-full text-left px-2 py-1.5 rounded-md hover:bg-surface-sunken text-sm flex items-center gap-2 text-ink-muted"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-ink-muted/40 shrink-0" title="Not currently playing audio" />
              <span className="flex-1 truncate">{s.name ?? `PID ${s.pid}`}</span>
              {s.isMeetingApp && <span className="text-[10px] text-ink-muted/70 font-semibold">MEETING</span>}
            </button>
          ))}
        </>
      )}

      <div className="border-t border-surface-border my-1" />
      <button
        onClick={() => onPick({ targetPid: 'system', targetLabel: 'All system audio' })}
        className="w-full text-left px-2 py-1.5 rounded-md hover:bg-surface-sunken text-sm"
      >
        All system audio (catch-all)
      </button>
      <button onClick={onCancel} className="w-full text-left px-2 py-1.5 rounded-md text-sm text-ink-muted hover:text-ink">
        Cancel
      </button>

      {confirmIdle && (
        <IdleConfirmDialog
          source={confirmIdle}
          onClose={() => setConfirmIdle(null)}
          onProceed={() => {
            const s = confirmIdle;
            setConfirmIdle(null);
            onPick({ targetPid: s.pid, targetLabel: s.name ?? `PID ${s.pid}` });
          }}
        />
      )}
    </div>
  );
}

function IdleConfirmDialog({
  source, onClose, onProceed,
}: {
  source: SourceItem;
  onClose: () => void;
  onProceed: () => void;
}): JSX.Element {
  const displayName = source.name ?? `PID ${source.pid}`;
  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-xl shadow-pop border border-surface-border p-5 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-2">
          {displayName} isn&apos;t currently playing audio
        </div>
        <div className="text-sm text-ink-muted mb-4 leading-relaxed">
          Attaching the recorder to an idle meeting app can disrupt its
          audio setup when it later tries to go live — you may end up with
          {' '}<span className="font-mono text-ink">{displayName}</span> hanging on meeting join and a broken mic until you restart it.
          <br /><br />
          <span className="text-ink">Recommended:</span> cancel, join your meeting first, then click Record again — {displayName} will appear in the audible list.
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onProceed}
            className="px-3 py-1.5 text-sm text-ink-muted hover:text-ink rounded-lg"
          >
            Start anyway
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm font-semibold text-white rounded-lg bg-gradient-to-br from-brand-indigo to-brand-violet"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
