import type Database from 'better-sqlite3';
import { shortId } from '../lib/slug.js';
import type { ActionItem } from '../lib/action-item-schema.js';

export interface ActionItemRow {
  id: string; meetingId: string; text: string;
  ownerSpeakerId: string | null; dueDate: string | null;
  status: string; exportedTo: string[]; createdAt: string;
}

function row(r: Record<string, unknown>): ActionItemRow {
  return {
    id: r.id as string,
    meetingId: r.meeting_id as string,
    text: r.text as string,
    ownerSpeakerId: (r.owner_speaker_id as string) ?? null,
    dueDate: (r.due_date as string) ?? null,
    status: r.status as string,
    exportedTo: JSON.parse((r.exported_to as string) || '[]'),
    createdAt: r.created_at as string,
  };
}

export class ActionItemsRepo {
  constructor(private readonly db: Database.Database) {}

  replaceForMeeting(meetingId: string, items: readonly ActionItem[]): void {
    const del = this.db.prepare('DELETE FROM action_items WHERE meeting_id = ?');
    const ins = this.db.prepare(`
      INSERT INTO action_items (id, meeting_id, text, owner_speaker_id, due_date, status, exported_to, created_at)
      VALUES (?, ?, ?, NULL, ?, 'open', '[]', ?)
    `);
    const tx = this.db.transaction(() => {
      del.run(meetingId);
      const now = new Date().toISOString();
      for (const it of items) ins.run(`ai_${shortId()}`, meetingId, it.text, it.due_date, now);
    });
    tx();
  }

  listByMeeting(meetingId: string): ActionItemRow[] {
    const rows = this.db.prepare('SELECT * FROM action_items WHERE meeting_id = ? ORDER BY created_at').all(meetingId) as Record<string, unknown>[];
    return rows.map(row);
  }

  countsByMeeting(): Map<string, number> {
    const rows = this.db.prepare(
      'SELECT meeting_id, COUNT(*) AS n FROM action_items GROUP BY meeting_id',
    ).all() as { meeting_id: string; n: number }[];
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.meeting_id, r.n);
    return out;
  }

  deleteForMeeting(meetingId: string): void {
    this.db.prepare('DELETE FROM action_items WHERE meeting_id = ?').run(meetingId);
  }

  setStatus(id: string, status: string): void {
    this.db.prepare('UPDATE action_items SET status = ? WHERE id = ?').run(status, id);
  }

  markExported(id: string, target: string): void {
    const r = this.db.prepare('SELECT exported_to FROM action_items WHERE id = ?').get(id) as { exported_to: string } | undefined;
    if (!r) return;
    const list: string[] = JSON.parse(r.exported_to || '[]');
    if (!list.includes(target)) list.push(target);
    this.db.prepare('UPDATE action_items SET exported_to = ? WHERE id = ?').run(JSON.stringify(list), id);
  }
}
