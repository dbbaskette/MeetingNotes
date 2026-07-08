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

  /** Case-insensitive, whitespace-trimmed lookup. Used to prevent the roster
   *  from accumulating duplicate entries when the user types a name that
   *  already exists. */
  findByDisplayName(displayName: string): SpeakerRow | null {
    const needle = displayName.trim().toLowerCase();
    if (!needle) return null;
    const r = this.db.prepare(
      "SELECT * FROM speakers WHERE LOWER(TRIM(display_name)) = ? ORDER BY created_at LIMIT 1"
    ).get(needle) as Record<string, unknown> | undefined;
    return r ? row(r) : null;
  }

  list(): SpeakerRow[] {
    const rows = this.db.prepare('SELECT * FROM speakers ORDER BY display_name').all() as Record<string, unknown>[];
    return rows.map(row);
  }

  /** Consolidate roster entries whose display names match case-insensitively
   *  after trimming. Earliest-created entry wins; later duplicates have their
   *  meeting and action-item links re-pointed at the winner and are then
   *  deleted. Returns a map of `loserId -> winnerId` so callers can update
   *  references kept in other databases (e.g. the user-speaker pointer in
   *  settings). Idempotent — running it twice with no new dups is a no-op. */
  dedupeByDisplayName(): Map<string, string> {
    const groups = this.db.prepare(`
      SELECT id, created_at, LOWER(TRIM(display_name)) AS key
      FROM speakers
      WHERE TRIM(display_name) <> ''
      ORDER BY key, created_at, id
    `).all() as { id: string; created_at: string; key: string }[];

    const winnerByKey = new Map<string, string>();
    const remap = new Map<string, string>();
    for (const g of groups) {
      const winner = winnerByKey.get(g.key);
      if (winner === undefined) {
        winnerByKey.set(g.key, g.id);
      } else if (winner !== g.id) {
        remap.set(g.id, winner);
      }
    }
    if (remap.size === 0) return remap;

    const updateMeetingSpeakers = this.db.prepare(
      'UPDATE meeting_speakers SET roster_speaker_id = ? WHERE roster_speaker_id = ?'
    );
    const updateActionItems = this.db.prepare(
      'UPDATE action_items SET owner_speaker_id = ? WHERE owner_speaker_id = ?'
    );
    const deleteSpeaker = this.db.prepare('DELETE FROM speakers WHERE id = ?');

    this.db.transaction(() => {
      for (const [loser, winner] of remap) {
        updateMeetingSpeakers.run(winner, loser);
        updateActionItems.run(winner, loser);
        deleteSpeaker.run(loser);
      }
    })();
    return remap;
  }

  rename(id: string, displayName: string): void {
    this.db.prepare('UPDATE speakers SET display_name = ? WHERE id = ?').run(displayName, id);
  }

  /** Distinct ids of meetings that link to this roster speaker. Used to know
   *  which transcripts need re-merging after a rename or merge. */
  meetingIdsForSpeaker(rosterId: string): string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT meeting_id FROM meeting_speakers WHERE roster_speaker_id = ? ORDER BY meeting_id'
    ).all(rosterId) as { meeting_id: string }[];
    return rows.map((r) => r.meeting_id);
  }

  /** Merge one roster speaker into another: every meeting_speakers link and
   *  action-item ownership moves source → target, then the source roster row
   *  is deleted. When a meeting links BOTH speakers, the target's link wins
   *  and the source's row is dropped (re-pointing it would leave two local
   *  labels claiming the same person with no way to tell them apart).
   *  Returns the ids of meetings that referenced the source, so callers can
   *  re-merge their transcripts. */
  mergeSpeakers(sourceId: string, targetId: string): string[] {
    const affected = this.meetingIdsForSpeaker(sourceId);
    this.db.transaction(() => {
      this.db.prepare(`
        DELETE FROM meeting_speakers
        WHERE roster_speaker_id = ?
          AND meeting_id IN (SELECT meeting_id FROM meeting_speakers WHERE roster_speaker_id = ?)
      `).run(sourceId, targetId);
      this.db.prepare('UPDATE meeting_speakers SET roster_speaker_id = ? WHERE roster_speaker_id = ?')
        .run(targetId, sourceId);
      this.db.prepare('UPDATE action_items SET owner_speaker_id = ? WHERE owner_speaker_id = ?')
        .run(targetId, sourceId);
      this.db.prepare('DELETE FROM speakers WHERE id = ?').run(sourceId);
    })();
    return affected;
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

  /** Drop all per-meeting speaker links. Used when a rerun invalidates the
   *  diarization output; roster entries themselves are kept. */
  unlinkMeeting(meetingId: string): void {
    this.db.prepare('DELETE FROM meeting_speakers WHERE meeting_id = ?').run(meetingId);
  }

  linkToMeeting(meetingId: string, localLabel: string, rosterId: string | null, confidence: number): void {
    // rosterId=null lets the caller "unlink" a previously-identified speaker
    // without dropping the meeting_speakers row — the local label stays in
    // the UI list, just un-identified again.
    this.db.prepare(`
      INSERT INTO meeting_speakers (meeting_id, local_label, roster_speaker_id, confidence)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(meeting_id, local_label) DO UPDATE SET
        roster_speaker_id = excluded.roster_speaker_id,
        confidence = excluded.confidence
    `).run(meetingId, localLabel, rosterId, confidence);
  }
}
