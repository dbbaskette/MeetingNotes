import { useMemo } from 'react';
import { api } from '../ipc/client';
import { buildNeedsAttention } from '../lib/needs-attention';
import { useToast } from './Toasts';

export interface RecoveryInboxItem {
  id: string;
  targetLabel: string;
  startedAt: string;
  outputPath: string;
  status: string;
  reason: 'not-indexed' | 'microphone-only' | 'system-only' | 'unreadable';
  durationS: number | null;
  sizeBytes: number;
  canRecover: boolean;
  canTrim: boolean;
}

interface AttentionMeeting {
  id: string;
  title: string;
  status: string;
  pipelineStage: string;
  startedAt: string | null;
}

export function NeedsAttentionPanel({
  meetings, recovery, onOpen, onChanged,
}: {
  meetings: AttentionMeeting[];
  recovery: RecoveryInboxItem[];
  onOpen: (id: string) => void;
  onChanged: () => void | Promise<void>;
}): JSX.Element | null {
  const toast = useToast();
  const groups = useMemo(
    () => buildNeedsAttention({ meetings, recovery, nowMs: Date.now() }),
    [meetings, recovery],
  );
  if (groups.length === 0) return null;

  const recoveryById = new Map(recovery.map((item) => [item.id, item]));
  async function recover(id: string): Promise<void> {
    try {
      const result = await api.recovery.recover(id);
      toast.show({ message: 'Recording recovered to the Library.' });
      await onChanged();
      onOpen(result.meetingId);
    } catch (error) {
      toast.show({ message: `Recovery failed: ${(error as Error).message}`, variant: 'error' });
    }
  }
  async function trim(item: RecoveryInboxItem): Promise<void> {
    const suggested = item.durationS ? Math.max(1, Math.floor(item.durationS / 60)) : 30;
    const answer = window.prompt('Keep the first how many minutes?', String(suggested));
    if (answer === null) return;
    const minutes = Number(answer);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      toast.show({ message: 'Enter a positive number of minutes.', variant: 'error' });
      return;
    }
    try {
      const result = await api.recovery.trim(item.id, minutes * 60);
      toast.show({ message: 'Trimmed recording recovered to the Library.' });
      await onChanged();
      onOpen(result.meetingId);
    } catch (error) {
      toast.show({ message: `Trim failed: ${(error as Error).message}`, variant: 'error' });
    }
  }
  async function dismiss(id: string): Promise<void> {
    await api.recovery.dismiss(id);
    await onChanged();
  }
  async function primaryAction(kind: string, id: string): Promise<void> {
    if (kind === 'recovery') { await recover(id); return; }
    if (kind === 'pending') {
      await api.meetings.start(id);
      toast.show({ message: 'Meeting added to the processing queue.' });
      await onChanged();
      return;
    }
    onOpen(id);
  }

  return (
    <section className="shrink-0 mb-5 rounded-xl border border-status-warn/30 bg-status-warnBg/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-status-warn/20">
        <span className="w-2 h-2 rounded-full bg-status-warn" />
        <h2 className="text-sm font-semibold text-ink">Needs attention</h2>
        <span className="text-xs text-ink-muted">{groups.reduce((n, group) => n + group.items.length, 0)}</span>
      </div>
      <div className="max-h-64 overflow-y-auto divide-y divide-surface-border">
        {groups.map((group) => (
          <div key={group.kind} className="px-4 py-2.5">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-muted mb-1.5">{group.label}</div>
            <div className="space-y-2">
              {group.items.map((item) => {
                const rec = item.kind === 'recovery' ? recoveryById.get(item.id) : undefined;
                return (
                  <div key={`${item.kind}:${item.id}`} className="flex items-center gap-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-ink">{item.title}</div>
                      <div className="text-xs text-ink-muted">
                        {item.ageLabel}{rec ? ` · ${reasonLabel(rec.reason)} · ${formatDuration(rec.durationS)} · ${formatBytes(rec.sizeBytes)}` : ''}
                      </div>
                    </div>
                    {rec && (
                      <div className="hidden md:flex items-center gap-2 text-xs">
                        {rec.canTrim && <button className="text-ink-muted hover:text-ink" onClick={() => void trim(rec)}>Trim and recover</button>}
                        <button className="text-ink-muted hover:text-ink" onClick={() => void api.recovery.reveal(rec.id)}>Finder</button>
                        <button className="text-ink-muted hover:text-ink" onClick={() => void dismiss(rec.id)}>Dismiss</button>
                      </div>
                    )}
                    <button
                      disabled={rec ? !rec.canRecover : false}
                      className="shrink-0 px-2.5 py-1 rounded-md bg-surface border border-surface-border text-xs font-medium text-ink hover:border-brand-indigo/40 disabled:opacity-40"
                      onClick={() => void primaryAction(item.kind, item.id)}
                    >
                      {rec && !rec.canRecover ? 'No usable audio' : item.actionLabel}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function reasonLabel(reason: RecoveryInboxItem['reason']): string {
  return reason === 'microphone-only' ? 'microphone audio only'
    : reason === 'system-only' ? 'app audio only'
      : reason === 'not-indexed' ? 'not added to Library' : 'file needs repair';
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'duration unknown';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
