import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { meetingFolderPath } from '../storage/meeting-folder.js';
import { chunkSummary, chunkTranscript, type Passage } from './passages.js';

export interface IndexedMeeting { id: string; slug: string }
export interface PassageHit extends Passage { meetingId: string; rank: number }

/** Full-text index over every meeting's notes and transcript, kept in the
 *  library database. It is a cache of files on disk: `sync` rebuilds only the
 *  meetings whose files changed, and dropping both tables loses nothing. */
export class AskIndex {
  constructor(private readonly db: Database.Database, private readonly libraryRoot: string) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ask_passages USING fts5(
        body, meeting_id UNINDEXED, kind UNINDEXED, start_s UNINDEXED, heading UNINDEXED,
        tokenize = 'porter unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS ask_indexed (meeting_id TEXT PRIMARY KEY, stamp TEXT NOT NULL);
    `);
  }

  /** Size and modified time of the two source files; changes when either does. */
  private stamp(slug: string): string {
    const folder = meetingFolderPath(this.libraryRoot, slug);
    return ['summary.md', 'transcript.md'].map((name) => {
      try { const stat = fs.statSync(path.join(folder, name)); return `${stat.size}:${Math.round(stat.mtimeMs)}`; } catch { return '-'; }
    }).join('|');
  }

  /** Bring the index in line with the library. Yields between meetings so a
   *  first build over a large library does not freeze the app. */
  async sync(meetings: readonly IndexedMeeting[], signal?: AbortSignal): Promise<{ updated: number; removed: number }> {
    const known = new Map((this.db.prepare('SELECT meeting_id AS id, stamp FROM ask_indexed').all() as { id: string; stamp: string }[]).map((row) => [row.id, row.stamp]));
    const remove = this.db.prepare('DELETE FROM ask_passages WHERE meeting_id = ?');
    const forget = this.db.prepare('DELETE FROM ask_indexed WHERE meeting_id = ?');
    const insert = this.db.prepare('INSERT INTO ask_passages (body, meeting_id, kind, start_s, heading) VALUES (?, ?, ?, ?, ?)');
    const remember = this.db.prepare('INSERT INTO ask_indexed (meeting_id, stamp) VALUES (?, ?) ON CONFLICT(meeting_id) DO UPDATE SET stamp = excluded.stamp');
    const replace = this.db.transaction((id: string, stamp: string, passages: Passage[]) => {
      remove.run(id);
      for (const p of passages) insert.run(p.text, id, p.kind, p.startS, p.heading);
      remember.run(id, stamp);
    });
    let updated = 0, removed = 0;
    for (const meeting of meetings) {
      const stamp = this.stamp(meeting.slug);
      const previous = known.get(meeting.id);
      known.delete(meeting.id);
      if (previous === stamp) continue;
      signal?.throwIfAborted();
      const folder = meetingFolderPath(this.libraryRoot, meeting.slug);
      const read = (name: string): string => { try { return fs.readFileSync(path.join(folder, name), 'utf8'); } catch { return ''; } };
      replace(meeting.id, stamp, [...chunkSummary(read('summary.md')), ...chunkTranscript(read('transcript.md'))]);
      updated++;
      if (updated % 5 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // Whatever is left was deleted, trashed or belongs to another library.
    const drop = this.db.transaction((ids: string[]) => { for (const id of ids) { remove.run(id); forget.run(id); } });
    drop([...known.keys()]); removed = known.size;
    return { updated, removed };
  }

  /** Best passages for an FTS5 MATCH expression, best first, with at most
   *  `perMeeting` from any one meeting so one long meeting cannot crowd out
   *  the rest. */
  search(match: string, limit = 10, perMeeting = 3): PassageHit[] {
    const rows = this.db.prepare(`
      SELECT body AS text, meeting_id AS meetingId, kind, start_s AS startS, heading, bm25(ask_passages) AS rank
      FROM ask_passages WHERE ask_passages MATCH ? ORDER BY rank LIMIT ?`).all(match, limit * 6) as PassageHit[];
    const taken = new Map<string, number>(), hits: PassageHit[] = [];
    for (const row of rows) {
      const count = taken.get(row.meetingId) ?? 0;
      if (count >= perMeeting) continue;
      taken.set(row.meetingId, count + 1);
      hits.push(row);
      if (hits.length === limit) break;
    }
    return hits;
  }
}
