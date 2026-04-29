// electron/main/weekly/markdown.ts
//
// Renders a WeeklyData object as a Markdown document for export.
// Used by:
//   - IPC handler weekly:export-markdown (clipboard / save-as)
//   - The renderer's "Export preview" panel could call into this
//     too via IPC if we want to keep one source of truth.
//
// Pure function. No IO. Tested separately.

import type { WeeklyData } from './aggregator.js';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const i = d.getDay();
  return DAY_LABELS[i] ?? '';
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtMeetingDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  return `${Math.round(seconds / 60)}m`;
}

export function renderWeeklyMarkdown(data: WeeklyData): string {
  const lines: string[] = [];

  // Header
  const start = new Date(data.rangeStart);
  const end = new Date(data.rangeEnd);
  const fmt = (d: Date): string => d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  lines.push(`# Weekly summary — ${fmt(start)} – ${fmt(end)}, ${data.isoYear}`);
  lines.push('');
  lines.push(
    `**${data.meetings.length} meeting${data.meetings.length === 1 ? '' : 's'} ` +
    `· ${fmtDuration(data.totalDurationS)} ` +
    `· ${data.openActionCount} open action item${data.openActionCount === 1 ? '' : 's'}**`,
  );
  lines.push('');

  // Narrative
  if (data.narrative) {
    lines.push('## Overview');
    lines.push('');
    lines.push(data.narrative);
    lines.push('');
  }

  // Meetings
  if (data.meetings.length > 0) {
    lines.push('## Meetings');
    lines.push('');
    lines.push('| Day | Meeting                          | Duration |');
    lines.push('| --- | -------------------------------- | -------: |');
    for (const m of data.meetings) {
      const day = dayLabel(m.startedAt);
      const title = m.title.replaceAll('|', '\\|');
      lines.push(`| ${day} | ${title} | ${fmtMeetingDuration(m.durationS)} |`);
    }
    lines.push('');
  }

  // Open action items, grouped by owner
  if (data.openActionGroups.length > 0) {
    lines.push('## Open action items');
    lines.push('');
    for (const group of data.openActionGroups) {
      lines.push(`**${group.ownerLabel} (${group.items.length})**`);
      for (const item of group.items) {
        const due = item.dueDate ? ` — *due ${item.dueDate}*` : '';
        lines.push(`- [ ] ${item.text}${due}`);
      }
      lines.push('');
    }
  }

  // Decisions
  if (data.decisions.length > 0) {
    lines.push('## Key decisions');
    lines.push('');
    for (const d of data.decisions) {
      lines.push(`- ${d}`);
    }
    lines.push('');
  }

  if (data.meetings.length === 0) {
    lines.push('*No meetings captured this week.*');
    lines.push('');
  }

  return lines.join('\n');
}
