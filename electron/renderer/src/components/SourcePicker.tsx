import { useEffect, useState } from 'react';
import { api } from '../ipc/client';

export interface PickedSource { targetPid: number | 'system'; targetLabel: string; }

export function SourcePicker({
  onPick, onCancel,
}: { onPick: (src: PickedSource) => void; onCancel: () => void }): JSX.Element {
  const [sources, setSources] = useState<{ pid: number; name: string | null; bundleId: string | null; isMeetingApp: boolean }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = (await api.recording.listSources()) as typeof sources;
        // Meeting apps first, others after, "All system audio" appended.
        const sorted = [...list].sort((a, b) => Number(b.isMeetingApp) - Number(a.isMeetingApp));
        setSources(sorted);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="absolute right-0 top-full mt-2 z-30 w-80 bg-surface border border-surface-border rounded-xl shadow-pop p-2">
      <div className="text-[11px] font-mono uppercase tracking-wider text-ink-muted px-2 py-1">
        Recording from
      </div>
      {loading && <div className="px-2 py-3 text-sm text-ink-muted">Looking…</div>}
      {error && <div className="px-2 py-3 text-sm text-rose-600">{error}</div>}
      {!loading && sources.map((s) => (
        <button
          key={s.pid}
          onClick={() => onPick({ targetPid: s.pid, targetLabel: s.name ?? `PID ${s.pid}` })}
          className="w-full text-left px-2 py-1.5 rounded-md hover:bg-surface-sunken text-sm flex items-center gap-2"
        >
          <span className="flex-1">{s.name ?? `PID ${s.pid}`}</span>
          {s.isMeetingApp && <span className="text-[10px] text-brand-indigo font-semibold">MEETING</span>}
        </button>
      ))}
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
      {/* Tip: attaching a Process Tap to an idle meeting app (Zoom, Teams)
          BEFORE the app has joined a meeting can hang the app at meeting-
          connect time (CoreAudio Process Tap vs. app's device negotiation;
          see GitHub issue #33). Cheapest fix is a reminder to the user. */}
      <div className="border-t border-surface-border my-1" />
      <div className="px-2 py-2 text-[11px] text-ink-muted leading-snug">
        <span className="font-semibold text-ink">Tip:</span>{' '}
        Join your meeting first, then start recording — attaching to an
        idle meeting app can disrupt its audio setup.
      </div>
    </div>
  );
}
