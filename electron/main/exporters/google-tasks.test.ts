import { describe, it, expect, vi } from 'vitest';
import { GoogleTasksExporter } from './google-tasks.js';
import type { ExportInput } from './interface.js';

function route(handlers: Array<{ match: RegExp; status: number; body: unknown }>): typeof fetch {
  return vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const u = String(url);
    const h = handlers.find((x) => x.match.test(u));
    if (!h) throw new Error(`unexpected fetch: ${u}`);
    return { ok: h.status >= 200 && h.status < 300, status: h.status, json: async () => h.body };
  }) as unknown as typeof fetch;
}

const auth = { getAccessToken: async () => 'AT' };

function input(over: Partial<ExportInput> = {}): ExportInput {
  return {
    items: [
      { id: 'a', text: 'Send the deck', ownerName: 'Me', dueDate: '2026-07-01', status: 'open' },
      { id: 'b', text: 'Book the room', ownerName: 'Me', dueDate: null, status: 'open' },
    ],
    meetingTitle: 'Q3 Planning',
    meetingFolder: '/tmp/x',
    ...over,
  };
}

describe('GoogleTasksExporter', () => {
  it('reuses an existing MeetingNotes list and inserts each item', async () => {
    const exported: string[] = [];
    const fetchImpl = route([
      { match: /users\/@me\/lists$/, status: 200, body: { items: [{ id: 'L1', title: 'MeetingNotes' }] } },
      { match: /lists\/L1\/tasks$/, status: 200, body: { id: 't' } },
    ]);
    const out = await new GoogleTasksExporter({ auth, fetchImpl }).export(
      input({ onItemExported: (id) => exported.push(id) }),
    );
    expect(out).toBe('2 tasks added to Google Tasks');
    expect(exported).toEqual(['a', 'b']);
  });

  it('creates the MeetingNotes list when it does not exist', async () => {
    let created = false;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (/users\/@me\/lists$/.test(u) && init?.method === 'POST') {
        created = true;
        return { ok: true, status: 200, json: async () => ({ id: 'NEW' }) };
      }
      if (/users\/@me\/lists$/.test(u)) return { ok: true, status: 200, json: async () => ({ items: [] }) };
      if (/lists\/NEW\/tasks$/.test(u)) return { ok: true, status: 200, json: async () => ({ id: 't' }) };
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;
    const out = await new GoogleTasksExporter({ auth, fetchImpl }).export(input());
    expect(created).toBe(true);
    expect(out).toBe('2 tasks added to Google Tasks');
  });

  it('formats a YYYY-MM-DD due date as RFC3339', async () => {
    let sentDue: unknown;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (/users\/@me\/lists$/.test(u)) return { ok: true, status: 200, json: async () => ({ items: [{ id: 'L1', title: 'MeetingNotes' }] }) };
      if (/lists\/L1\/tasks$/.test(u)) {
        sentDue = JSON.parse(String(init?.body)).due;
        return { ok: true, status: 200, json: async () => ({ id: 't' }) };
      }
      throw new Error(u);
    }) as unknown as typeof fetch;
    await new GoogleTasksExporter({ auth, fetchImpl }).export(input({ items: [
      { id: 'a', text: 'x', ownerName: 'Me', dueDate: '2026-07-01', status: 'open' },
    ] }));
    expect(sentDue).toBe('2026-07-01T00:00:00.000Z');
  });

  it('reports partial failures', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (/users\/@me\/lists$/.test(u)) return { ok: true, status: 200, json: async () => ({ items: [{ id: 'L1', title: 'MeetingNotes' }] }) };
      n += 1;
      if (n === 2) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
      return { ok: true, status: 200, json: async () => ({ id: 't' }) };
    }) as unknown as typeof fetch;
    const out = await new GoogleTasksExporter({ auth, fetchImpl }).export(input());
    expect(out).toMatch(/1 task added to Google Tasks — 1 failed/);
  });

  it('surfaces an auth error from getAccessToken', async () => {
    const badAuth = { getAccessToken: async () => { throw new Error('Not signed in to Google'); } };
    await expect(
      new GoogleTasksExporter({ auth: badAuth, fetchImpl: route([]) }).export(input()),
    ).rejects.toThrow(/Not signed in/);
  });
});
