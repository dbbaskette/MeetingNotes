export type AttentionKind = 'recovery' | 'failed' | 'speaker' | 'pending';

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: string;
  actionLabel: string;
  ageLabel: string;
  occurredAt: string | null;
}

export interface AttentionGroup {
  kind: AttentionKind;
  label: string;
  items: AttentionItem[];
}

interface MeetingInput {
  id: string;
  title: string;
  status: string;
  pipelineStage: string;
  startedAt: string | null;
}

interface RecoveryInput {
  id: string;
  startedAt: string;
  targetLabel: string;
}

const GROUPS: Array<{ kind: AttentionKind; label: string; actionLabel: string }> = [
  { kind: 'recovery', label: 'Capture recovery', actionLabel: 'Recover' },
  { kind: 'failed', label: 'Processing failed', actionLabel: 'Review failure' },
  { kind: 'speaker', label: 'Speaker review', actionLabel: 'Name speakers' },
  { kind: 'pending', label: 'Ready to process', actionLabel: 'Process' },
];

export function buildNeedsAttention(input: {
  meetings: MeetingInput[];
  recovery: RecoveryInput[];
  nowMs: number;
}): AttentionGroup[] {
  const byKind = new Map<AttentionKind, AttentionItem[]>();
  const add = (item: AttentionItem): void => {
    const values = byKind.get(item.kind) ?? [];
    values.push(item);
    byKind.set(item.kind, values);
  };
  for (const recovery of input.recovery) {
    add({
      id: recovery.id, kind: 'recovery', title: recovery.targetLabel || 'Recovered recording',
      actionLabel: 'Recover', occurredAt: recovery.startedAt,
      ageLabel: formatAge(recovery.startedAt, input.nowMs),
    });
  }
  for (const meeting of input.meetings) {
    const kind: AttentionKind | null = meeting.status === 'failed' ? 'failed'
      : meeting.pipelineStage === 'awaiting_speaker_id' || meeting.status === 'awaiting_user' ? 'speaker'
        : meeting.status === 'pending' ? 'pending' : null;
    if (!kind) continue;
    const spec = GROUPS.find((group) => group.kind === kind)!;
    add({
      id: meeting.id, kind, title: meeting.title, actionLabel: spec.actionLabel,
      occurredAt: meeting.startedAt, ageLabel: formatAge(meeting.startedAt, input.nowMs),
    });
  }
  return GROUPS.flatMap((group) => {
    const items = byKind.get(group.kind);
    if (!items?.length) return [];
    items.sort((a, b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? ''));
    return [{ kind: group.kind, label: group.label, items }];
  });
}

function formatAge(iso: string | null, nowMs: number): string {
  if (!iso) return 'date unknown';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'date unknown';
  const minutes = Math.max(0, Math.floor((nowMs - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h old`;
  return `${Math.floor(hours / 24)}d old`;
}
