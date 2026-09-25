import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from './db.js';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { GroupsRepo } from './groups-repo.js';
import { MeetingsRepo } from './meetings-repo.js';
import { RecordingSessionsRepo } from './recording-sessions-repo.js';

let db: Database.Database;
let groups: GroupsRepo;
let meetings: MeetingsRepo;

beforeEach(() => {
  db = openDb(':memory:');
  groups = new GroupsRepo(db);
  meetings = new MeetingsRepo(db);
});
afterEach(() => db.close());

function meeting(id: string): void {
  meetings.insert({ id, slug: id, title: id, startedAt: '2026-09-24', durationS: 60,
    audioPath: `/${id}.m4a`, status: 'done', pipelineStage: 'done' });
}

describe('GroupsRepo', () => {
  it('normalizes names, counts only live meetings, and preserves assignments on restore', () => {
    const group = groups.create('  Platform   Roadmap  ');
    expect(group.name).toBe('Platform Roadmap');
    expect(() => groups.create('platform roadmap')).toThrow(/already exists/);
    meeting('a'); meeting('b');
    expect(groups.assign(['a', 'b'], group.id).moved).toHaveLength(2);
    meetings.softDelete('b');
    expect(groups.list()[0]?.count).toBe(1);
    meetings.restore('b');
    expect(meetings.findById('b')?.groupId).toBe(group.id);
    expect(groups.list()[0]?.count).toBe(2);
  });

  it('scopes paging, counts, IDs, and title search before limits', () => {
    const group = groups.create('Research');
    meeting('outside'); meeting('inside'); meeting('free');
    groups.assign(['inside'], group.id);
    groups.assign(['outside'], groups.create('Other').id);
    const query = { filter: 'all' as const, sort: 'newest' as const, groupId: group.id, pageSize: 1 };
    expect(meetings.listPage(query).rows.map((m) => m.id)).toEqual(['inside']);
    expect(meetings.counts(group.id).all).toBe(1);
    expect(meetings.listIds('all', group.id)).toEqual(['inside']);
    expect(meetings.listIds('all', null)).toEqual(['free']);
    expect(meetings.searchByTitle('in', 1, group.id).map((m) => m.id)).toEqual(['inside']);
    expect(meetings.findBySlugs(['inside', 'outside'], group.id).map((m) => m.id)).toEqual(['inside']);
  });

  it('rejects a cursor reused in another scope', () => {
    const group = groups.create('Roadmap');
    meeting('a'); meeting('b'); meeting('c');
    groups.assign(['a', 'b'], group.id);
    const query = { filter: 'all' as const, sort: 'newest' as const, pageSize: 1, groupId: group.id };
    const cursor = meetings.listPage(query).nextCursor!;
    expect(cursor).toBeTruthy();
    expect(() => meetings.listPage({ ...query, groupId: null, cursor })).toThrow(/cursor/i);
    expect(() => meetings.listPage({ ...query, groupId: undefined, cursor })).toThrow(/cursor/i);
  });

  it('moves exact live IDs, reports misses, and deletes only group metadata', () => {
    const first = groups.create('One');
    const second = groups.create('Two');
    meeting('a'); meeting('b'); meeting('deleted');
    meetings.softDelete('deleted');
    groups.assign(['a'], first.id);
    const result = groups.assign(['a', 'b', 'deleted', 'missing'], second.id);
    expect(result.moved).toEqual([
      { id: 'a', previousGroupId: first.id }, { id: 'b', previousGroupId: null },
    ]);
    expect(result.failedIds).toEqual(['deleted', 'missing']);
    expect(groups.assign(['a'], first.id, null).failedIds).toEqual(['a']);
    expect(meetings.findById('a')?.groupId).toBe(second.id);
    expect(() => groups.assign(['a'], 'missing')).toThrow(/no longer exists/);
    expect(groups.delete(second.id)).toBe(true);
    expect(meetings.findById('a')?.groupId).toBeNull();
    expect(meetings.findById('a')?.audioPath).toBe('/a.m4a');
  });

  it('retains capture intent by output path and clears it on group delete', () => {
    const group = groups.create('Capture');
    const sessions = new RecordingSessionsRepo(db);
    sessions.insert({ id: 's', helperPid: 1, targetPid: 2, targetLabel: 'zoom',
      outputPath: '/recording.m4a', groupId: group.id });
    expect(sessions.findByOutputPath('/recording.m4a')?.groupId).toBe(group.id);
    groups.delete(group.id);
    expect(sessions.findByOutputPath('/recording.m4a')?.groupId).toBeNull();
  });

  it('falls back to ungrouped when a selected group was deleted before insert', () => {
    const removed = groups.create('Removed');
    groups.delete(removed.id);
    meetings.insert({ id: 'late', slug: 'late', title: 'Late', startedAt: null, durationS: null,
      audioPath: '/late.m4a', status: 'pending', pipelineStage: 'discovered', groupId: removed.id });
    const sessions = new RecordingSessionsRepo(db);
    sessions.insert({ id: 'late-session', helperPid: -1, targetPid: null, targetLabel: 'System',
      outputPath: '/late-capture.m4a', groupId: removed.id });
    expect(meetings.findById('late')?.groupId).toBeNull();
    expect(sessions.findById('late-session')?.groupId).toBeNull();
  });
});

it('upgrades a version-16 database without changing existing meetings', () => {
  const old = new Database(':memory:');
  try {
    old.pragma('foreign_keys = ON');
    old.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (16)');
    for (const migration of MIGRATIONS.filter((m) => m.version <= 16)) old.exec(migration.up);
    old.prepare(`INSERT INTO meetings
      (id, slug, title, audio_path, status, pipeline_stage, created_at, updated_at)
      VALUES ('old', 'old', 'Old meeting', '/old.m4a', 'done', 'done', '2026', '2026')`).run();
    runMigrations(old);
    expect((old.prepare('SELECT group_id FROM meetings WHERE id = ?').get('old') as { group_id: string | null }).group_id).toBeNull();
    expect((old.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(17);
  } finally { old.close(); }
});
