// electron/main/exporters/google-tasks.ts
//
// Real Google Tasks exporter. Inserts the user's action items into a
// "MeetingNotes" task list (created on first use). The handler has already
// filtered `input.items` to the user's own open items (see owner-filter), so
// this exporter just pushes whatever it's given.

import type { Exporter, ExportInput } from './interface.js';

type FetchImpl = typeof fetch;

export interface GoogleAuthLike {
  getAccessToken(): Promise<string>;
}

export interface GoogleTasksDeps {
  auth: GoogleAuthLike;
  fetchImpl?: FetchImpl;
}

const TASKLISTS_URL = 'https://tasks.googleapis.com/tasks/v1/users/@me/lists';
const LIST_NAME = 'MeetingNotes';

export class GoogleTasksExporter implements Exporter {
  name = 'google-tasks';
  private readonly fetchImpl: FetchImpl;
  private readonly listResolutions = new Map<string, Promise<string>>();

  constructor(private readonly deps: GoogleTasksDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async export(input: ExportInput): Promise<string> {
    if (input.items.length === 0) return 'No action items to send.';
    const token = await this.deps.auth.getAccessToken();
    const listId = await this.resolveListId(token);

    let added = 0;
    const failures: string[] = [];
    for (const item of input.items) {
      try {
        await this.insertTask(token, listId, input.meetingTitle, item);
        input.onItemExported?.(item.id);
        added += 1;
      } catch (e) {
        failures.push(`"${item.text.slice(0, 40)}": ${(e as Error).message}`);
      }
    }
    const base = `${added} task${added === 1 ? '' : 's'} added to Google Tasks`;
    return failures.length ? `${base} — ${failures.length} failed` : base;
  }

  /** Find the "MeetingNotes" task list, creating it if absent. */
  private resolveListId(token: string): Promise<string> {
    const pending = this.listResolutions.get(token);
    if (pending) return pending;
    const promise = this.findOrCreateList(token).finally(() => this.listResolutions.delete(token));
    this.listResolutions.set(token, promise);
    return promise;
  }

  private async findOrCreateList(token: string): Promise<string> {
    let pageToken = '';
    const visited = new Set<string>();
    do {
      if (visited.has(pageToken) || visited.size >= 100) throw new Error('Google Tasks returned invalid pagination; retry later');
      visited.add(pageToken);
      const url = pageToken ? `${TASKLISTS_URL}?pageToken=${encodeURIComponent(pageToken)}` : TASKLISTS_URL;
      const listsResp = await this.api(token, url);
      const lists = (listsResp.items ?? []) as Array<{ id: string; title: string }>;
      const existing = lists.find((l) => l.title === LIST_NAME && typeof l.id === 'string' && l.id.length > 0);
      if (existing) return existing.id;
      pageToken = typeof listsResp.nextPageToken === 'string' ? listsResp.nextPageToken : '';
    } while (pageToken);
    const created = await this.api(token, TASKLISTS_URL, {
      method: 'POST',
      body: JSON.stringify({ title: LIST_NAME }),
    });
    if (typeof created.id !== 'string' || !created.id) throw new Error('Google Tasks did not return a task-list ID');
    return created.id;
  }

  private async insertTask(
    token: string, listId: string, meetingTitle: string,
    item: { text: string; dueDate: string | null },
  ): Promise<void> {
    const body: Record<string, unknown> = {
      title: item.text,
      notes: `From meeting: ${meetingTitle}`,
    };
    // Tasks API wants an RFC3339 timestamp; our due dates are YYYY-MM-DD.
    if (item.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(item.dueDate)) {
      body.due = `${item.dueDate}T00:00:00.000Z`;
    }
    await this.api(
      token,
      `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  }

  private async api(token: string, url: string, init: RequestInit = {}): Promise<{ id?: string; items?: { id: string; title: string }[]; nextPageToken?: string; error?: { message?: string } }> {
    const resp = await this.fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const json = (await resp.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!resp.ok) {
      throw new Error(`Google Tasks ${resp.status}: ${json.error?.message ?? 'request failed'}`);
    }
    return json;
  }
}
