import type Database from 'better-sqlite3';
import { shortId } from '../lib/slug.js';

export interface SpeakerRow { id: string; displayName: string; createdAt: string; notes: string | null; }

function row(r: Record<string, unknown>): SpeakerRow {
  return {
    id: r.id as string,
    displayName: r.display_name as string,
    createdAt: r.created_at as string,
    notes: (r.notes as string) ?? null,
  };
}

export class SpeakersRepo {
  constructor(private readonly db: Database.Database) {}

  create(input: { displayName: string; notes?: string }): string {
    const id = `spk_${shortId()}`;
    this.db.prepare('INSERT INTO speakers (id, display_name, created_at, notes) VALUES (?, ?, ?, ?)')
      .run(id, input.displayName, new Date().toISOString(), input.notes ?? null);
    return id;
  }

  findById(id: string): SpeakerRow | null {
    const r = this.db.prepare('SELECT * FROM speakers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? row(r) : null;
  }

  list(): SpeakerRow[] {
    const rows = this.db.prepare('SELECT * FROM speakers ORDER BY display_name').all() as Record<string, unknown>[];
    return rows.map(row);
  }

  rename(id: string, displayName: string): void {
    this.db.prepare('UPDATE speakers SET display_name = ? WHERE id = ?').run(displayName, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM speakers WHERE id = ?').run(id);
  }

  /** All meeting/speaker links across the whole DB, grouped by meeting id.
   *  One JOIN replaces N per-meeting queries when listing the library. */
  listForAllMeetings(): Map<string, {
    localLabel: string;
    rosterSpeakerId: string | null;
    displayName: string | null;
    confidence: number | null;
  }[]> {
    const rows = this.db.prepare(`
      SELECT ms.meeting_id, ms.local_label, ms.roster_speaker_id, ms.confidence, sp.display_name
      FROM meeting_speakers ms
      LEFT JOIN speakers sp ON sp.id = ms.roster_speaker_id
      ORDER BY ms.meeting_id, ms.local_label
    `).all() as Record<string, unknown>[];
    const out = new Map<string, {
      localLabel: string;
      rosterSpeakerId: string | null;
      displayName: string | null;
      confidence: number | null;
    }[]>();
    for (const r of rows) {
      const id = r.meeting_id as string;
      const list = out.get(id) ?? [];
      list.push({
        localLabel: r.local_label as string,
        rosterSpeakerId: (r.roster_speaker_id as string) ?? null,
        displayName: (r.display_name as string) ?? null,
        confidence: (r.confidence as number) ?? null,
      });
      out.set(id, list);
    }
    return out;
  }

  listForMeeting(meetingId: string): {
    localLabel: string;
    rosterSpeakerId: string | null;
    displayName: string | null;
    confidence: number | null;
  }[] {
    const rows = this.db.prepare(`
      SELECT ms.local_label, ms.roster_speaker_id, ms.confidence, sp.display_name
      FROM meeting_speakers ms
      LEFT JOIN speakers sp ON sp.id = ms.roster_speaker_id
      WHERE ms.meeting_id = ?
      ORDER BY ms.local_label
    `).all(meetingId) as Record<string, unknown>[];
    return rows.map((r) => ({
      localLabel: r.local_label as string,
      rosterSpeakerId: (r.roster_speaker_id as string) ?? null,
      displayName: (r.display_name as string) ?? null,
      confidence: (r.confidence as number) ?? null,
    }));
  }

  linkToMeeting(meetingId: string, localLabel: string, rosterId: string, confidence: number): void {
    this.db.prepare(`
      INSERT INTO meeting_speakers (meeting_id, local_label, roster_speaker_id, confidence)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(meeting_id, local_label) DO UPDATE SET
        roster_speaker_id = excluded.roster_speaker_id,
        confidence = excluded.confidence
    `).run(meetingId, localLabel, rosterId, confidence);
  }
}
