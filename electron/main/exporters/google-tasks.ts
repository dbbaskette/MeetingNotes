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
  private async resolveListId(token: string): Promise<string> {
    const listsResp = await this.api(token, TASKLISTS_URL);
    const lists = (listsResp.items ?? []) as Array<{ id: string; title: string }>;
    const existing = lists.find((l) => l.title === LIST_NAME);
    if (existing) return existing.id;
    const created = await this.api(token, TASKLISTS_URL, {
      method: 'POST',
      body: JSON.stringify({ title: LIST_NAME }),
    });
    return created.id as string;
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

  private async api(token: string, url: string, init: RequestInit = {}): Promise<any> {
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
