import { useMemo } from 'react';
import { api } from '../ipc/client';
import { buildNeedsAttention, capAttentionGroups, ATTENTION_GROUP_CAP } from '../lib/needs-attention';
import { useToast } from './Toasts';
import { RecoveryRow } from './RecoveryRow';

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
  meetings, recovery, error, onRetry, onOpen, onChanged,
}: {
  meetings: AttentionMeeting[];
  recovery: RecoveryInboxItem[];
  error?: string | null;
  onRetry?: () => void;
  onOpen: (id: string) => void;
  onChanged: () => void | Promise<void>;
}): JSX.Element | null {
  const toast = useToast();
  const groups = useMemo(
    () => capAttentionGroups(buildNeedsAttention({ meetings, recovery, nowMs: Date.now() }), ATTENTION_GROUP_CAP),
    [meetings, recovery],
  );
  if (groups.length === 0 && !error) return null;

  const recoveryById = new Map(recovery.map((item) => [item.id, item]));
  async function primaryAction(kind: string, id: string): Promise<void> {
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
        <span className="text-xs text-ink-muted">{groups.reduce((n, group) => n + group.totalCount, 0)}</span>
      </div>
      {error && (
        <div role="alert" className="px-4 py-2.5 text-xs text-danger border-b border-status-warn/20">
          Couldn't refresh this inbox: {error}
          {onRetry && (
            <>
              {' '}
              <button type="button" className="font-semibold underline" onClick={onRetry}>Retry</button>
            </>
          )}
        </div>
      )}
      <div className="max-h-64 overflow-y-auto divide-y divide-surface-border">
        {groups.map((group) => (
          <div key={group.kind} className="px-4 py-2.5">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-muted mb-1.5">{group.label}</div>
            <div className="space-y-2">
              {group.items.map((item) => {
                const rec = item.kind === 'recovery' ? recoveryById.get(item.id) : undefined;
                if (rec) return <RecoveryRow key={rec.id} item={rec}
                  detail={`${item.ageLabel} · ${reasonLabel(rec.reason)} · ${formatDuration(rec.durationS)} · ${formatBytes(rec.sizeBytes)}`}
                  onOpen={onOpen} onChanged={onChanged} />;
                return (
                  <div key={`${item.kind}:${item.id}`} className="flex items-center gap-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-ink">{item.title}</div>
                      <div className="text-xs text-ink-muted">
                        {item.ageLabel}
                      </div>
                    </div>
                    <button
                      className="shrink-0 px-2.5 py-1 rounded-md bg-surface border border-surface-border text-xs font-medium text-ink hover:border-brand-indigo/40 disabled:opacity-40"
                      onClick={() => void primaryAction(item.kind, item.id)}
                    >
                      {item.actionLabel}
                    </button>
                  </div>
                );
              })}
              {group.hiddenCount > 0 && (
                <div className="text-xs text-ink-muted">+{group.hiddenCount} more</div>
              )}
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
