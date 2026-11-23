import type Database from 'better-sqlite3';
import { CalendarEventSnapshotSchema, type CalendarEventSnapshot } from '../calendar/service.js';

export interface RecordingSessionInsert {
  id: string;
  helperPid: number;
  targetPid: number | null;
  targetLabel: string;
  outputPath: string;
  groupId?: string | null;
  title?: string;
  /** The calendar event overlapping the start (#253); null/absent = none. */
  calendarEvent?: CalendarEventSnapshot | null;
}

export interface RecordingSessionRow {
  id: string;
  helperPid: number;
  targetPid: number | null;
  targetLabel: string;
  outputPath: string;
  groupId: string | null;
  title?: string | null;
  calendarEvent?: CalendarEventSnapshot | null;
  startedAt: string;
  finalizedAt: string | null;
  status: 'recording' | 'finalized' | 'orphaned' | 'error';
  dismissedAt: string | null;
}

// Every read carries the session's calendar event (#253), kept in a side table.
const SELECT_SESSION = `SELECT recording_sessions.*,
  (SELECT event_json FROM recording_session_calendar_events WHERE session_id = recording_sessions.id) AS calendar_event
  FROM recording_sessions`;

export class RecordingSessionsRepo {
  constructor(private readonly db: Database.Database) {}

  insert(s: RecordingSessionInsert): void {
    this.db.prepare(`
      INSERT INTO recording_sessions
        (id, helper_pid, target_pid, target_label, output_path, group_id, title, started_at, status)
      VALUES (?, ?, ?, ?, ?, (SELECT id FROM groups WHERE id = ?), ?, ?, 'recording')
    `).run(s.id, s.helperPid, s.targetPid, s.targetLabel, s.outputPath, s.groupId ?? null, s.title ?? null, new Date().toISOString());
    if (s.calendarEvent) {
      this.db.prepare('INSERT OR REPLACE INTO recording_session_calendar_events (session_id, event_json) VALUES (?, ?)')
        .run(s.id, JSON.stringify(s.calendarEvent));
    }
  }

  updateHelperPid(id: string, helperPid: number): void {
    this.db.prepare('UPDATE recording_sessions SET helper_pid = ? WHERE id = ?').run(helperPid, id);
  }

  finalize(id: string): void {
    this.db.prepare(`
      UPDATE recording_sessions
         SET status = 'finalized', finalized_at = ?
       WHERE id = ?
    `).run(new Date().toISOString(), id);
  }

  markOrphaned(id: string): void {
    this.db.prepare("UPDATE recording_sessions SET status = 'orphaned' WHERE id = ?").run(id);
  }

  markError(id: string): void {
    this.db.prepare("UPDATE recording_sessions SET status = 'error' WHERE id = ?").run(id);
  }

  findOpen(): RecordingSessionRow[] {
    return (this.db.prepare(`${SELECT_SESSION} WHERE status = 'recording'`).all() as Record<string, unknown>[])
      .map(rowToSession);
  }

  findOrphaned(): RecordingSessionRow[] {
    return (this.db.prepare(`${SELECT_SESSION} WHERE status = 'orphaned'`).all() as Record<string, unknown>[])
      .map(rowToSession);
  }

  findById(id: string): RecordingSessionRow | null {
    const row = this.db.prepare(`${SELECT_SESSION} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToSession(row) : null;
  }

  findByOutputPath(outputPath: string): RecordingSessionRow | null {
    const row = this.db.prepare(`${SELECT_SESSION} WHERE output_path = ? ORDER BY started_at DESC LIMIT 1`)
      .get(outputPath) as Record<string, unknown> | undefined;
    return row ? rowToSession(row) : null;
  }

  findRecoverable(): RecordingSessionRow[] {
    return (this.db.prepare(`
      ${SELECT_SESSION}
       WHERE status IN ('finalized', 'orphaned', 'error')
         AND dismissed_at IS NULL
       ORDER BY started_at DESC
    `).all() as Record<string, unknown>[]).map(rowToSession);
  }

  dismissRecovery(id: string): void {
    this.db.prepare('UPDATE recording_sessions SET dismissed_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }
}

function rowToSession(r: Record<string, unknown>): RecordingSessionRow {
  return {
    id: r.id as string,
    helperPid: r.helper_pid as number,
    targetPid: (r.target_pid as number) ?? null,
    targetLabel: r.target_label as string,
    outputPath: r.output_path as string,
    groupId: (r.group_id as string) ?? null,
    title: (r.title as string) ?? null,
    calendarEvent: parseCalendarEvent(r.calendar_event),
    startedAt: r.started_at as string,
    finalizedAt: (r.finalized_at as string) ?? null,
    status: r.status as RecordingSessionRow['status'],
    dismissedAt: (r.dismissed_at as string) ?? null,
  };
}

function parseCalendarEvent(value: unknown): CalendarEventSnapshot | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = CalendarEventSnapshotSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
