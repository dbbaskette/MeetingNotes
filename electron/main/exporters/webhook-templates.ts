// electron/main/exporters/webhook-templates.ts
//
// Built-in payload templates for the webhook exporter. Each template
// transforms the canonical `WebhookPayload` shape into something the
// downstream surface expects:
//   • compact / full   — JSON object, ready to POST as application/json.
//   • telegram-markdown — Markdown text body in Telegram's sendMessage form.
//   • slack-blocks     — Block Kit JSON for Slack's chat.postMessage.
//
// Issue #79. Custom user templates are out of scope for v1.

export interface WebhookActionItem {
  text: string;
  owner: string | null;
  due_date: string | null;
}

export interface WebhookPayload {
  event: 'meeting.completed';
  meeting: {
    id: string;
    slug: string;
    title: string;
    started_at: string | null;
    duration_s: number | null;
    attendees: string[];
  };
  summary_markdown: string | null;
  transcript_markdown: string | null;
  action_items: WebhookActionItem[];
  links: {
    audio: string | null;
    transcript_md: string | null;
    summary_md: string | null;
    open_in_app: string;
  };
}

export type WebhookTemplate = 'compact' | 'full' | 'telegram-markdown' | 'slack-blocks';

export interface RenderedBody {
  contentType: 'application/json';
  body: string;
}

export function renderWebhookBody(payload: WebhookPayload, template: WebhookTemplate): RenderedBody {
  switch (template) {
    case 'compact': return renderCompact(payload);
    case 'full': return renderFull(payload);
    case 'telegram-markdown': return renderTelegram(payload);
    case 'slack-blocks': return renderSlack(payload);
  }
}

// Strips the transcript out of compact so downstream chat surfaces don't
// see a 20KB payload when a 200-byte summary will do.
function renderCompact(payload: WebhookPayload): RenderedBody {
  const { transcript_markdown: _, ...rest } = payload;
  return { contentType: 'application/json', body: JSON.stringify(rest) };
}

function renderFull(payload: WebhookPayload): RenderedBody {
  return { contentType: 'application/json', body: JSON.stringify(payload) };
}

function renderTelegram(payload: WebhookPayload): RenderedBody {
  const lines: string[] = [];
  lines.push(`*${escapeTelegram(payload.meeting.title)}*`);
  if (payload.meeting.started_at) {
    lines.push(`_${escapeTelegram(payload.meeting.started_at)} · ${formatDuration(payload.meeting.duration_s)}_`);
  } else {
    lines.push(`_${formatDuration(payload.meeting.duration_s)}_`);
  }
  if (payload.summary_markdown) {
    lines.push('');
    lines.push(payload.summary_markdown);
  }
  if (payload.action_items.length > 0) {
    lines.push('');
    lines.push('*Action items*');
    for (const ai of payload.action_items) {
      const owner = ai.owner ? ` — ${escapeTelegram(ai.owner)}` : '';
      const due = ai.due_date ? ` (due ${escapeTelegram(ai.due_date)})` : '';
      lines.push(`• ${escapeTelegram(ai.text)}${owner}${due}`);
    }
  }
  return {
    contentType: 'application/json',
    body: JSON.stringify({ text: lines.join('\n'), parse_mode: 'Markdown' }),
  };
}

function renderSlack(payload: WebhookPayload): RenderedBody {
  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: payload.meeting.title, emoji: true },
    },
  ];
  const metaParts: string[] = [];
  if (payload.meeting.started_at) metaParts.push(payload.meeting.started_at);
  metaParts.push(formatDuration(payload.meeting.duration_s));
  if (payload.meeting.attendees.length > 0) {
    metaParts.push(`with ${payload.meeting.attendees.join(', ')}`);
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: metaParts.join(' · ') }],
  });
  if (payload.summary_markdown) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(payload.summary_markdown, 2900) },
    });
  }
  if (payload.action_items.length > 0) {
    const lines = payload.action_items.map((ai) => {
      const owner = ai.owner ? ` — *${ai.owner}*` : '';
      const due = ai.due_date ? ` _(due ${ai.due_date})_` : '';
      return `• ${ai.text}${owner}${due}`;
    });
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Action items*\n${truncate(lines.join('\n'), 2900)}` },
    });
  }
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Open in MeetingNotes' },
        url: payload.links.open_in_app,
      },
    ],
  });
  return {
    contentType: 'application/json',
    body: JSON.stringify({ blocks }),
  };
}

function formatDuration(s: number | null): string {
  if (!s || s <= 0) return 'duration unknown';
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Telegram's Markdown parse_mode treats `_*[]()` as formatting characters.
// Escape so user titles / action-item text don't accidentally bold a name.
function escapeTelegram(s: string): string {
  return s.replace(/[_*[\]()]/g, (c) => `\\${c}`);
}
