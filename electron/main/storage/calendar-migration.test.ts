import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { MeetingsRepo } from './meetings-repo.js';
import { RecordingSessionsRepo } from './recording-sessions-repo.js';

it('upgrades a version 28 library: existing meetings and sessions read with no calendar event (#253)', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(28)');
    for (const migration of MIGRATIONS.filter(m => m.version <= 28)) db.exec(migration.up);
    db.prepare(`INSERT INTO meetings(id,slug,title,audio_path,status,pipeline_stage,created_at,updated_at)
      VALUES('m','m','Meeting','/fixture.m4a','done','done','2026-11-01','2026-11-01')`).run();
    db.prepare(`INSERT INTO recording_sessions(id,helper_pid,target_pid,target_label,output_path,started_at,status)
      VALUES('s',1,NULL,'All','/fixture.m4a','2026-11-01T10:00:00Z','finalized')`).run();
    runMigrations(db); runMigrations(db);
    expect((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(MIGRATIONS.at(-1)!.version);
    const meetings = new MeetingsRepo(db);
    expect(meetings.calendarEventFor('m')).toBeNull();
    expect(new RecordingSessionsRepo(db).findById('s')?.calendarEvent).toBeNull();
    // Garbage in the session column reads as no event rather than failing.
    db.prepare(`INSERT INTO recording_session_calendar_events(session_id, event_json) VALUES('s', '{"title":1}')`).run();
    expect(new RecordingSessionsRepo(db).findById('s')?.calendarEvent).toBeNull();
    meetings.setCalendarEvent('m', { title: 'Sync', start: '2026-11-01T10:00:00.000Z', end: '2026-11-01T10:30:00.000Z', attendees: ['Ada'], seriesId: null });
    expect(meetings.calendarEventFor('m')).toMatchObject({ title: 'Sync', attendees: ['Ada'] });
    // The event goes with its meeting.
    meetings.hardDelete('m');
    expect(db.prepare('SELECT COUNT(*) AS n FROM meeting_calendar_events').get()).toEqual({ n: 0 });
  } finally { db.close(); }
});
