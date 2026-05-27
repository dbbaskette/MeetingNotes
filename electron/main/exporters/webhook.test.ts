import { describe, it, expect, vi } from 'vitest';
import {
  WebhookExporter,
  buildPayloadFromMeeting,
  filterActionItems,
  validateUrl,
  redactUrl,
} from './webhook.js';
import { renderWebhookBody, type WebhookPayload } from './webhook-templates.js';

function makePayload(over: Partial<WebhookPayload> = {}): WebhookPayload {
  return {
    event: 'meeting.completed',
    meeting: {
      id: 'm1',
      slug: '2026-05-27-standup',
      title: 'Standup',
      started_at: '2026-05-27T14:30:00Z',
      duration_s: 1683,
      attendees: ['Me', 'Jamie', 'Alex'],
    },
    summary_markdown: 'Three-sentence overview.',
    transcript_markdown: 'Long transcript here.',
    action_items: [
      { text: 'File the spec by Friday', owner: 'Me', due_date: null },
      { text: 'Ping vendor about pricing', owner: 'Jamie', due_date: null },
    ],
    links: {
      audio: 'file:///tmp/audio.m4a',
      transcript_md: 'file:///tmp/transcript.md',
      summary_md: 'file:///tmp/summary.md',
      open_in_app: 'meetingnotes://open?id=m1',
    },
    ...over,
  };
}

function makeDeps(over: {
  config?: Partial<Parameters<WebhookExporter['export']>[0]> & Partial<{ url: string; secret: string; template: 'compact' | 'full' | 'telegram-markdown' | 'slack-blocks'; ownerFilter: 'mine' | 'all' | 'none' }>;
  fetchResponses?: (Response | Error)[];
} = {}): {
  exporter: WebhookExporter;
  fetchMock: ReturnType<typeof vi.fn>;
  lastResult: { current: unknown };
  log: ReturnType<typeof vi.fn>;
  sleeps: number[];
} {
  const fetchResponses = over.fetchResponses ?? [new Response('ok', { status: 200 })];
  let i = 0;
  const fetchMock = vi.fn(async () => {
    const next = fetchResponses[i++] ?? fetchResponses[fetchResponses.length - 1]!;
    if (next instanceof Error) throw next;
    return next;
  });
  const lastResult = { current: null as unknown };
  const log = vi.fn();
  const sleeps: number[] = [];
  const exporter = new WebhookExporter({
    getConfig: () => ({
      url: 'https://example.com/hook',
      secret: '',
      template: 'compact',
      ownerFilter: 'all',
      ...(over.config ?? {}),
    }),
    setLastResult: (r) => { lastResult.current = r; },
    fetchImpl: fetchMock as never,
    sleep: async (ms) => { sleeps.push(ms); },
    log,
  });
  return { exporter, fetchMock, lastResult, log, sleeps };
}

describe('validateUrl', () => {
  it('accepts https', () => {
    expect(validateUrl('https://example.com/hook')).toMatchObject({ ok: true });
  });
  it('rejects http for non-loopback hosts', () => {
    expect(validateUrl('http://example.com/hook').ok).toBe(false);
  });
  it('allows http for localhost dev', () => {
    expect(validateUrl('http://localhost:3000/hook').ok).toBe(true);
    expect(validateUrl('http://127.0.0.1:3000/hook').ok).toBe(true);
  });
  it('rejects malformed URL', () => {
    expect(validateUrl('not a url').ok).toBe(false);
  });
  it('rejects empty', () => {
    expect(validateUrl('').ok).toBe(false);
  });
});

describe('redactUrl', () => {
  it('strips query strings and userinfo', () => {
    expect(redactUrl('https://user:pw@example.com/hook?token=abc')).toBe('https://example.com/hook');
  });
  it('keeps host + path visible', () => {
    expect(redactUrl('https://example.com/hook')).toBe('https://example.com/hook');
  });
});

describe('filterActionItems', () => {
  const items = [
    { ownerSpeakerId: 'speaker-1', text: 'a' },
    { ownerSpeakerId: 'speaker-2', text: 'b' },
    { ownerSpeakerId: null, text: 'c' },
  ];
  it('all returns everything', () => {
    expect(filterActionItems(items, 'speaker-1', 'all')).toHaveLength(3);
  });
  it('none returns empty', () => {
    expect(filterActionItems(items, 'speaker-1', 'none')).toEqual([]);
  });
  it('mine returns only items owned by the user speaker', () => {
    expect(filterActionItems(items, 'speaker-1', 'mine')).toEqual([items[0]]);
  });
  it('mine returns empty when user speaker isn\'t set', () => {
    expect(filterActionItems(items, null, 'mine')).toEqual([]);
  });
});

describe('renderWebhookBody', () => {
  it('compact strips transcript_markdown to keep payload small', () => {
    const r = renderWebhookBody(makePayload(), 'compact');
    const parsed = JSON.parse(r.body) as Record<string, unknown>;
    expect(parsed.transcript_markdown).toBeUndefined();
    expect(parsed.summary_markdown).toBe('Three-sentence overview.');
  });
  it('full keeps transcript_markdown', () => {
    const r = renderWebhookBody(makePayload(), 'full');
    const parsed = JSON.parse(r.body) as Record<string, unknown>;
    expect(parsed.transcript_markdown).toBe('Long transcript here.');
  });
  it('telegram-markdown returns Telegram sendMessage shape with Markdown body', () => {
    const r = renderWebhookBody(makePayload(), 'telegram-markdown');
    const parsed = JSON.parse(r.body) as { text: string; parse_mode: string };
    expect(parsed.parse_mode).toBe('Markdown');
    expect(parsed.text).toContain('*Standup*');
    expect(parsed.text).toContain('File the spec by Friday');
  });
  it('slack-blocks returns Block Kit JSON', () => {
    const r = renderWebhookBody(makePayload(), 'slack-blocks');
    const parsed = JSON.parse(r.body) as { blocks: Array<{ type: string }> };
    expect(Array.isArray(parsed.blocks)).toBe(true);
    expect(parsed.blocks.some((b) => b.type === 'header')).toBe(true);
  });
  it('telegram template escapes markdown specials in user input', () => {
    const r = renderWebhookBody(makePayload({
      meeting: { ...makePayload().meeting, title: 'Bug_report [#42]' },
    }), 'telegram-markdown');
    const parsed = JSON.parse(r.body) as { text: string };
    expect(parsed.text).toContain('Bug\\_report \\[#42\\]');
  });
});

describe('WebhookExporter.deliverPayload', () => {
  it('posts the payload with the chosen template', async () => {
    const d = makeDeps({ config: { url: 'https://example.com/hook', template: 'compact' } });
    const r = await d.exporter.deliverPayload(makePayload());
    expect(r.error).toBeNull();
    expect(r.status).toBe(200);
    expect(d.fetchMock).toHaveBeenCalledTimes(1);
    const call = d.fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('https://example.com/hook');
    expect((call[1] as RequestInit).method).toBe('POST');
  });

  it('sends the Authorization header when a secret is set', async () => {
    const d = makeDeps({ config: { url: 'https://example.com/hook', secret: 'topsecret' } });
    await d.exporter.deliverPayload(makePayload());
    const init = d.fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers.authorization).toBe('Bearer topsecret');
  });

  it('retries 5xx with exponential backoff and recovers on success', async () => {
    const d = makeDeps({
      fetchResponses: [
        new Response('boom', { status: 503 }),
        new Response('boom', { status: 502 }),
        new Response('ok', { status: 200 }),
      ],
    });
    const r = await d.exporter.deliverPayload(makePayload());
    expect(r.error).toBeNull();
    expect(r.status).toBe(200);
    expect(d.fetchMock).toHaveBeenCalledTimes(3);
    expect(d.sleeps).toEqual([1000, 5000]);
  });

  it('does not retry 4xx (config error)', async () => {
    const d = makeDeps({
      fetchResponses: [
        new Response('forbidden', { status: 403 }),
      ],
    });
    const r = await d.exporter.deliverPayload(makePayload());
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/HTTP 403/);
    expect(d.fetchMock).toHaveBeenCalledTimes(1);
    expect(d.sleeps).toEqual([]);
  });

  it('does retry 429 (rate limited)', async () => {
    const d = makeDeps({
      fetchResponses: [
        new Response('slow down', { status: 429 }),
        new Response('ok', { status: 200 }),
      ],
    });
    const r = await d.exporter.deliverPayload(makePayload());
    expect(r.status).toBe(200);
    expect(d.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports last delivery result via setLastResult', async () => {
    const d = makeDeps();
    await d.exporter.deliverPayload(makePayload());
    expect(d.lastResult.current).toMatchObject({ status: 200, error: null });
  });

  it('fails fast on invalid URL', async () => {
    const d = makeDeps({ config: { url: 'http://evil.example.com/hook' } });
    const r = await d.exporter.deliverPayload(makePayload());
    expect(r.error).toMatch(/HTTPS/);
    expect(d.fetchMock).not.toHaveBeenCalled();
  });

  it('does not include the secret in audit log lines', async () => {
    const d = makeDeps({ config: { url: 'https://example.com/hook?token=topsecret', secret: 's3cret' } });
    await d.exporter.deliverPayload(makePayload());
    for (const call of d.log.mock.calls) {
      const data = call[1] as Record<string, unknown>;
      expect(JSON.stringify(data)).not.toContain('s3cret');
      expect(JSON.stringify(data)).not.toContain('topsecret');
    }
  });

  it('retries up to 3 times then gives up', async () => {
    const d = makeDeps({
      fetchResponses: [
        new Response('x', { status: 503 }),
        new Response('x', { status: 503 }),
        new Response('x', { status: 503 }),
        new Response('x', { status: 503 }),
      ],
    });
    const r = await d.exporter.deliverPayload(makePayload());
    expect(r.error).toMatch(/503/);
    expect(d.fetchMock).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(d.sleeps).toEqual([1000, 5000, 30000]);
  });
});

describe('buildPayloadFromMeeting', () => {
  it('builds canonical payload with file:// links + open_in_app URL', () => {
    const p = buildPayloadFromMeeting({
      meetingId: 'abc123',
      slug: '2026-05-27-test',
      title: 'Test',
      startedAt: '2026-05-27T14:30:00Z',
      durationS: 600,
      audioPath: '/tmp/foo/audio.m4a',
      meetingFolder: '/tmp/foo',
      summaryMd: '# Summary',
      transcriptMd: 'Speaker: hi',
      attendees: ['Me', 'Alex'],
      actionItems: [
        { text: 'Do X', ownerName: 'Me', ownerSpeakerId: 'self', dueDate: null, status: 'open' },
      ],
      userSpeakerId: 'self',
    }, { url: '', secret: '', template: 'compact', ownerFilter: 'mine' });
    expect(p.meeting.id).toBe('abc123');
    expect(p.action_items).toHaveLength(1);
    expect(p.action_items[0]!.owner).toBe('Me');
    expect(p.links.open_in_app).toBe('meetingnotes://open?id=abc123');
    expect(p.links.audio).toBe('file:///tmp/foo/audio.m4a');
  });

  it('applies the ownerFilter when constructing the payload', () => {
    const p = buildPayloadFromMeeting({
      meetingId: 'm', slug: 's', title: 't',
      startedAt: null, durationS: null, audioPath: '/a',
      meetingFolder: '/f', summaryMd: null, transcriptMd: null,
      attendees: [],
      actionItems: [
        { text: 'mine', ownerName: 'Me', ownerSpeakerId: 'self', dueDate: null, status: 'open' },
        { text: 'theirs', ownerName: 'Other', ownerSpeakerId: 'other', dueDate: null, status: 'open' },
      ],
      userSpeakerId: 'self',
    }, { url: '', secret: '', template: 'compact', ownerFilter: 'mine' });
    expect(p.action_items.map((a) => a.text)).toEqual(['mine']);
  });
});
