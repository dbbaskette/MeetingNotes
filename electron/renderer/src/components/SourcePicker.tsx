import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../ipc/client';
import { GroupPicker } from './GroupPicker';
import { audioSourceLabel, groupAudioSources, type SourceItem } from '../lib/audio-source-groups';

export interface PickedSource { targetPid: number | 'system'; targetLabel: string; groupId?: string | null; }


export function SourcePicker({
  onPick, onCancel, initialGroupId, showGroupPicker = true,
}: { onPick: (src: PickedSource) => void; onCancel: () => void; initialGroupId?: string | null; showGroupPicker?: boolean }): JSX.Element {
  const [groupId, setGroupId] = useState<string | null>(initialGroupId ?? null);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // When the user clicks a visibly-idle meeting app we intercept and show
  // a confirm dialog first — attaching a Process Tap to an idle Zoom/Teams
  // can hang its meeting-join device negotiation (issue #33).
  const [confirmIdle, setConfirmIdle] = useState<SourceItem | null>(null);

  const request = useRef(0);
  const refresh = useCallback(async () => {
    const token = ++request.current;
    setLoading(true); setError(null);
      try {
        const list = (await api.recording.listSources()) as SourceItem[];
        if (token === request.current) setSources(list);
      } catch (e) {
        if (token === request.current) setError((e as Error).message);
      } finally {
        if (token === request.current) setLoading(false);
      }
  }, []);
  useEffect(() => { void refresh(); return () => { request.current++; }; }, [refresh]);

  // Daemons and unattributed helpers (isUserApp === false) hide behind a
  // disclosure — the default list reads like System Settings → Sound: real
  // apps only. Older helper binaries don't emit isUserApp; treat those
  // sources as apps so nothing disappears after an app-only update.
  const [showBackground, setShowBackground] = useState(false);

  // Two groups:
  //   audible  — meeting apps first (flagged by bundle id), then everything
  //              else CoreAudio says is actively writing to an output.
  //   idle     — registered with the audio daemon but not currently emitting.
  //              Greyed out; clicking a meeting app in this group opens a
  //              confirm modal warning about #33.
  const { audible, idle, background } = useMemo(() => {
    const sortByMeetingFirst = (a: SourceItem, b: SourceItem) =>
      Number(b.isMeetingApp) - Number(a.isMeetingApp);
    const apps = sources.filter((s) => s.isUserApp !== false);
    return {
      audible: [...apps.filter((s) => s.isRunningOutput)].sort(sortByMeetingFirst),
      idle: [...apps.filter((s) => !s.isRunningOutput)].sort(sortByMeetingFirst),
      background: sources.filter((s) => s.isUserApp === false),
    };
  }, [sources]);

  function pickOrConfirm(s: SourceItem): void {
    if (!s.isRunningOutput && s.isMeetingApp) {
      setConfirmIdle(s);
      return;
    }
    onPick({ targetPid: s.pid, targetLabel: audioSourceLabel(s), groupId });
  }

  return (
    <div className="absolute right-0 top-full mt-2 z-30 w-80 bg-surface border border-surface-border rounded-xl shadow-pop p-2">
      <div className="flex items-center justify-between text-xs text-ink-muted px-2 py-1">
        <span>Recording from</span>
        <button type="button" disabled={loading} onClick={() => void refresh()}
          className="rounded px-2 py-1 font-semibold hover:text-ink disabled:opacity-50">{loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      {loading && sources.length === 0 && <div role="status" className="px-2 py-3 text-sm text-ink-muted">Looking for audio sources…</div>}
      {error && <div role="alert" className="px-2 py-3 text-xs text-danger">Could not refresh sources. {error} <button type="button" onClick={() => void refresh()} className="underline">Retry</button></div>}
      <div className="max-h-[45vh] overflow-y-auto">
      {!loading && audible.length === 0 && (
        <div className="px-2 py-2 text-[11px] text-ink-muted italic">
          Nothing is currently playing audio. Start a meeting or play a sound,
          then choose Refresh.
        </div>
      )}
      <SourceRows sources={audible} onPick={pickOrConfirm} />

      {idle.length > 0 && (
        <>
          <div className="border-t border-surface-border my-1" />
          <div className="px-2 pt-1 pb-0.5 text-[10px] font-mono uppercase tracking-wider text-ink-muted/70">
            Idle (not currently audible)
          </div>
          <SourceRows sources={idle} onPick={pickOrConfirm} />
        </>
      )}

      {background.length > 0 && (
        <>
          <div className="border-t border-surface-border my-1" />
          <button
            onClick={() => setShowBackground((v) => !v)}
            className="w-full text-left px-2 py-1 rounded-md text-[11px] font-mono uppercase tracking-wider text-ink-muted/70 hover:text-ink-muted"
            aria-expanded={showBackground}
          >
            {showBackground ? '▾' : '▸'} Background processes ({background.length})
          </button>
          {showBackground && <SourceRows sources={background} onPick={pickOrConfirm} />}
        </>
      )}

      </div>
      <div className="border-t border-surface-border my-1" />
      <button
        onClick={() => onPick({ targetPid: 'system', targetLabel: 'All system audio', groupId })}
        className="w-full text-left px-2 py-1.5 rounded-md hover:bg-surface-sunken text-sm"
      >
        All system audio (catch-all)
      </button>
      <div className="border-t border-surface-border my-1" />
      {showGroupPicker && <div className="px-2 py-1">
        <div className="text-[10px] font-mono uppercase tracking-wider text-ink-muted mb-1">Save to group</div>
        <GroupPicker value={groupId} onSelect={(choice) => setGroupId(choice ?? null)} compact />
      </div>}
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
            onPick({ targetPid: s.pid, targetLabel: audioSourceLabel(s), groupId });
          }}
        />
      )}
    </div>
  );
}

function SourceRows({ sources, onPick }: { sources: SourceItem[]; onPick: (source: SourceItem) => void }): JSX.Element {
  const row = (source: SourceItem) => <button key={source.pid} type="button" onClick={() => onPick(source)}
    data-source-pid={source.pid} title={audioSourceLabel(source)}
    className="w-full text-left px-2 py-1.5 rounded-md hover:bg-surface-sunken text-sm flex items-center gap-2">
    <span title={source.isRunningOutput ? 'Currently audible' : 'Not currently playing audio'} aria-label={source.isRunningOutput ? 'Currently audible' : 'Not currently playing audio'}
      className={`w-1.5 h-1.5 rounded-full shrink-0 ${source.isRunningOutput ? 'bg-status-ok' : 'bg-ink-muted/40'}`} />
    <span className="flex-1 min-w-0 truncate">{audioSourceLabel(source)}</span>
    {source.isMeetingApp && <span className="text-[10px] text-brand-indigo font-semibold">MEETING</span>}
  </button>;
  return <>{groupAudioSources(sources).map(group => group.sources.length === 1 ? row(group.sources[0]!) :
    <details key={group.key} open>
      <summary className="px-2 py-1 text-xs font-semibold cursor-pointer">{group.name} · {group.sources.length} audio streams</summary>
      <div className="pl-2">{group.sources.map(row)}</div>
      <p className="px-2 text-[10px] text-ink-muted">Each stream records separately. Use All system audio to capture every stream.</p>
    </details>)}</>;
}

function IdleConfirmDialog({
  source, onClose, onProceed,
}: {
  source: SourceItem;
  onClose: () => void;
  onProceed: () => void;
}): JSX.Element {
  const displayName = audioSourceLabel(source);
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
