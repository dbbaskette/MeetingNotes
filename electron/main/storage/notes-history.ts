import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { NotesVersion, NotesComparison } from '../../shared/notes-history.js';
import type { MeetingsRepo } from './meetings-repo.js';
import type { ActionItemsRepo, ActionItemRow } from './action-items-repo.js';
import type { TerminologyService } from '../terminology/service.js';
import { meetingFolderPath } from './meeting-folder.js';

interface Snapshot { summary: string; items: ActionItemRow[]; transcript: string; stale: boolean }
const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class NotesHistory {
  constructor(private readonly db: Database.Database, private readonly deps: {
    libraryRoot: string; meetings: MeetingsRepo; items: ActionItemsRepo; terminology: TerminologyService;
  }) {}
  private read(id: string): Snapshot {
    const meeting = this.deps.meetings.findById(id);
    if (!meeting || meeting.deletedAt) throw new Error('Meeting no longer exists');
    const folder = meetingFolderPath(this.deps.libraryRoot, meeting.slug);
    const text = (name: string): string => {
      try { return fs.readFileSync(path.join(folder, name), 'utf8'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; }
    };
    return { summary: text('summary.md'), items: this.deps.items.listByMeeting(id), transcript: fingerprint(text('transcript.md')), stale: this.deps.terminology.stale(id) };
  }
  private editable(id: string): void {
    const m = this.deps.meetings.findById(id);
    if (!m || m.deletedAt || m.status === 'processing') throw new Error('Wait for processing to finish before restoring notes');
  }
  revision(id: string): string { return fingerprint(this.read(id)); }
  capture(id: string, reason: string): void {
    const snapshot = this.read(id);
    if (!snapshot.summary && !snapshot.items.length) return;
    const previous = this.db.prepare('SELECT snapshot FROM notes_versions WHERE meeting_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(id) as {snapshot: string} | undefined;
    if (previous && fingerprint(JSON.parse(previous.snapshot)) === fingerprint(snapshot)) return;
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO notes_versions VALUES (?,?,?,?,?)').run(randomUUID(), id, new Date().toISOString(), reason, JSON.stringify(snapshot));
      this.db.prepare('DELETE FROM notes_versions WHERE meeting_id=? AND id NOT IN (SELECT id FROM notes_versions WHERE meeting_id=? ORDER BY created_at DESC, rowid DESC LIMIT 20)').run(id, id);
    })();
  }
  list(id: string): Omit<NotesVersion, 'summary' | 'items'>[] {
    this.read(id);
    return this.db.prepare('SELECT id, created_at AS createdAt, reason FROM notes_versions WHERE meeting_id=? ORDER BY created_at DESC, rowid DESC LIMIT 20').all(id) as Omit<NotesVersion, 'summary' | 'items'>[];
  }
  compare(id: string, version: string): NotesComparison {
    const row = this.db.prepare('SELECT snapshot,created_at AS createdAt,reason FROM notes_versions WHERE meeting_id=? AND id=?').get(id, version) as {snapshot: string; createdAt: string; reason: string} | undefined;
    if (!row) throw new Error('This notes version is no longer available');
    const current = this.read(id), previous = JSON.parse(row.snapshot) as Snapshot;
    return { revision: fingerprint(current), current: {id: '', createdAt: '', reason: 'Current', ...current}, previous: {id: version, createdAt: row.createdAt, reason: row.reason, ...previous} };
  }
  restore(id: string, version: string, revision: string): void {
    this.editable(id);
    const before = this.read(id);
    if (fingerprint(before) !== revision) throw new Error('Notes or action items changed. Compare again before restoring.');
    const row = this.db.prepare('SELECT snapshot FROM notes_versions WHERE meeting_id=? AND id=?').get(id, version) as {snapshot: string} | undefined;
    if (!row) throw new Error('This notes version is no longer available');
    const after = JSON.parse(row.snapshot) as Snapshot;
    after.stale = after.stale || after.transcript !== before.transcript;
    after.transcript = before.transcript;
    // Save the current version before staging the durable, recoverable restore.
    this.capture(id, 'Before restore');
    this.db.prepare('INSERT OR REPLACE INTO notes_restore_pending VALUES (?,?,?)').run(id, JSON.stringify(before), JSON.stringify(after));
    this.finish(id, before, after);
  }
  private finish(id: string, before: Snapshot, after: Snapshot): void {
    const current = this.read(id);
    if (current.transcript !== before.transcript || ![before.summary, after.summary].includes(current.summary)
      || ![fingerprint(before.items), fingerprint(after.items)].includes(fingerprint(current.items)))
      throw new Error('Meeting changed during an interrupted restore. Nothing was overwritten; versions remain available.');
    this.deps.terminology.restoreSummary(id, after.summary, after.stale);
    this.db.transaction(() => {
      this.deps.items.deleteForMeeting(id);
      const insert = this.db.prepare(`INSERT INTO action_items (id,meeting_id,text,owner_speaker_id,owner_name,due_date,source_quote,status,exported_to,created_at)
        VALUES (?,?,?,(SELECT id FROM speakers WHERE id=?),?,?,?,?,?,?)`);
      for (const item of after.items) insert.run(item.id,id,item.text,item.ownerSpeakerId,item.ownerName,item.dueDate,item.sourceQuote,item.status,JSON.stringify(item.exportedTo),item.createdAt);
      this.db.prepare('DELETE FROM notes_restore_pending WHERE meeting_id=?').run(id);
    })();
  }
  recover(): void {
    const rows = this.db.prepare('SELECT * FROM notes_restore_pending').all() as {meeting_id: string; before_json: string; after_json: string}[];
    for (const row of rows) {
      const meeting = this.deps.meetings.findById(row.meeting_id);
      if (!meeting || meeting.deletedAt || meeting.status === 'processing') continue;
      this.finish(row.meeting_id, JSON.parse(row.before_json), JSON.parse(row.after_json));
    }
  }
}
