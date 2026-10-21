import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { SpeakersRepo } from './speakers-repo.js';

it('upgrades legacy assignments without relabeling them; stores automatic/manual provenance on all read paths', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(24)');
    for (const migration of MIGRATIONS.filter(m => m.version <= 24)) db.exec(migration.up);
    db.prepare(`INSERT INTO meetings(id,slug,title,audio_path,status,pipeline_stage,created_at,updated_at)
      VALUES('m','m','Meeting','/fixture','done','done','2026-10-21','2026-10-21')`).run();
    db.prepare(`INSERT INTO speakers(id,display_name,created_at) VALUES('alice','Alice','2026-10-21')`).run();
    db.prepare(`INSERT INTO meeting_speakers(meeting_id,local_label,roster_speaker_id,confidence)
      VALUES('m','A','alice',0.99)`).run();
    runMigrations(db); runMigrations(db);
    const repo = new SpeakersRepo(db);
    expect(repo.listForMeeting('m')[0]).toMatchObject({ rosterSpeakerId: 'alice', confidence: 0.99, assignmentSource: null });
    repo.linkToMeeting('m', 'A', 'alice', 1, 'automatic');
    for (const links of [repo.listForMeeting('m'), repo.listForMeetings(['m']).get('m'), repo.listForAllMeetings().get('m')]) {
      expect(links?.[0]).toMatchObject({ confidence: 1, assignmentSource: 'automatic' });
    }
    repo.linkToMeeting('m', 'A', 'alice', 1);
    expect(repo.listForMeeting('m')[0]?.assignmentSource).toBe('manual');
    repo.linkToMeeting('m', 'A', null, 0);
    expect(repo.listForMeeting('m')[0]?.assignmentSource).toBeNull();
  } finally { db.close(); }
});
