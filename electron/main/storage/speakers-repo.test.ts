import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { SpeakersRepo } from './speakers-repo.js';

let repo: SpeakersRepo;
let db: Database.Database;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-sp-'));
  db = openDb(path.join(dir, 'db.sqlite'));
  repo = new SpeakersRepo(db);
});

function insertMeeting(id: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO meetings (id, slug, title, audio_path, status, pipeline_stage, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, id, id, `/tmp/${id}.m4a`, 'idle', 'discovered', now, now);
}

describe('SpeakersRepo', () => {
  it('create + list', () => {
    const id = repo.create({ displayName: 'Dan B.' });
    expect(repo.list()).toEqual([expect.objectContaining({ id, displayName: 'Dan B.' })]);
  });

  it('rename', () => {
    const id = repo.create({ displayName: 'Temp' });
    repo.rename(id, 'Dan Baskette');
    expect(repo.findById(id)?.displayName).toBe('Dan Baskette');
  });

  it('delete', () => {
    const id = repo.create({ displayName: 'Gone' });
    repo.delete(id);
    expect(repo.findById(id)).toBeNull();
  });

  describe('findByDisplayName', () => {
    it('matches case-insensitively and ignores surrounding whitespace', () => {
      const id = repo.create({ displayName: 'Dan B.' });
      expect(repo.findByDisplayName('dan b.')?.id).toBe(id);
      expect(repo.findByDisplayName('  DAN B.  ')?.id).toBe(id);
    });

    it('returns null when no match', () => {
      repo.create({ displayName: 'Dan' });
      expect(repo.findByDisplayName('Daniel')).toBeNull();
    });

    it('returns null for empty / whitespace queries (does not match blank names)', () => {
      expect(repo.findByDisplayName('   ')).toBeNull();
    });

    it('returns the earliest-created entry when duplicates exist', () => {
      const first = repo.create({ displayName: 'Dan' });
      // Force a later created_at on the second row.
      const later = repo.create({ displayName: 'dan' });
      db.prepare('UPDATE speakers SET created_at = ? WHERE id = ?').run('2099-01-01T00:00:00Z', later);
      expect(repo.findByDisplayName('Dan')?.id).toBe(first);
    });
  });

  describe('meetingIdsForSpeaker', () => {
    it('returns distinct meeting ids linked to the speaker', () => {
      const id = repo.create({ displayName: 'Dan' });
      insertMeeting('m1');
      insertMeeting('m2');
      repo.linkToMeeting('m1', 'SPEAKER_00', id, 1);
      repo.linkToMeeting('m1', 'SPEAKER_01', id, 1); // same meeting twice
      repo.linkToMeeting('m2', 'SPEAKER_00', id, 1);
      expect(repo.meetingIdsForSpeaker(id)).toEqual(['m1', 'm2']);
    });

    it('returns empty for an unlinked speaker', () => {
      const id = repo.create({ displayName: 'Nobody' });
      expect(repo.meetingIdsForSpeaker(id)).toEqual([]);
    });
  });

  describe('mergeSpeakers', () => {
    it('re-points links + action items to the target, deletes the source, returns affected meetings', () => {
      const source = repo.create({ displayName: 'Daniel' });
      const target = repo.create({ displayName: 'Dan' });
      insertMeeting('m1');
      insertMeeting('m2');
      repo.linkToMeeting('m1', 'SPEAKER_00', source, 1);
      repo.linkToMeeting('m2', 'SPEAKER_01', source, 0.8);
      db.prepare(`
        INSERT INTO action_items (id, meeting_id, text, owner_speaker_id, created_at)
        VALUES ('a1', 'm1', 'follow up', ?, ?)
      `).run(source, new Date().toISOString());

      const affected = repo.mergeSpeakers(source, target);

      expect(affected.sort()).toEqual(['m1', 'm2']);
      expect(repo.findById(source)).toBeNull();
      const links = db.prepare('SELECT meeting_id, roster_speaker_id FROM meeting_speakers ORDER BY meeting_id').all();
      expect(links).toEqual([
        { meeting_id: 'm1', roster_speaker_id: target },
        { meeting_id: 'm2', roster_speaker_id: target },
      ]);
      const item = db.prepare('SELECT owner_speaker_id FROM action_items WHERE id = ?').get('a1') as { owner_speaker_id: string };
      expect(item.owner_speaker_id).toBe(target);
    });

    it("when a meeting links both, keeps the target's row and drops the source's", () => {
      const source = repo.create({ displayName: 'Daniel' });
      const target = repo.create({ displayName: 'Dan' });
      insertMeeting('m1');
      repo.linkToMeeting('m1', 'SPEAKER_00', target, 1);
      repo.linkToMeeting('m1', 'SPEAKER_01', source, 0.7);

      const affected = repo.mergeSpeakers(source, target);

      expect(affected).toEqual(['m1']);
      const links = db.prepare('SELECT local_label, roster_speaker_id FROM meeting_speakers ORDER BY local_label').all();
      // The source's SPEAKER_01 row is gone; the target's original link survives untouched.
      expect(links).toEqual([{ local_label: 'SPEAKER_00', roster_speaker_id: target }]);
    });

    it('merging an unlinked speaker just deletes the roster row', () => {
      const source = repo.create({ displayName: 'Ghost' });
      const target = repo.create({ displayName: 'Dan' });
      expect(repo.mergeSpeakers(source, target)).toEqual([]);
      expect(repo.findById(source)).toBeNull();
      expect(repo.findById(target)).not.toBeNull();
    });
  });

  describe('dedupeByDisplayName', () => {
    it('returns an empty map and changes nothing when the roster has no duplicates', () => {
      repo.create({ displayName: 'Dan' });
      repo.create({ displayName: 'Alex' });
      expect(repo.dedupeByDisplayName().size).toBe(0);
      expect(repo.list()).toHaveLength(2);
    });

    it('collapses case/whitespace duplicates onto the earliest entry', () => {
      const winner = repo.create({ displayName: 'Dan' });
      const loser1 = repo.create({ displayName: 'dan' });
      const loser2 = repo.create({ displayName: '  DAN  ' });
      // Move the winner earlier than the others so created_at ordering is deterministic.
      db.prepare('UPDATE speakers SET created_at = ? WHERE id = ?').run('2000-01-01T00:00:00Z', winner);

      const remap = repo.dedupeByDisplayName();
      expect(remap.get(loser1)).toBe(winner);
      expect(remap.get(loser2)).toBe(winner);
      expect(repo.list().map((s) => s.id)).toEqual([winner]);
    });

    it('re-points meeting_speakers and action_items at the winner', () => {
      const winner = repo.create({ displayName: 'Dan' });
      const loser = repo.create({ displayName: 'dan' });
      db.prepare('UPDATE speakers SET created_at = ? WHERE id = ?').run('2000-01-01T00:00:00Z', winner);

      insertMeeting('m1');
      insertMeeting('m2');
      repo.linkToMeeting('m1', 'Speaker 1', winner, 1);
      repo.linkToMeeting('m2', 'Speaker 1', loser, 1);
      db.prepare(`
        INSERT INTO action_items (id, meeting_id, text, owner_speaker_id, created_at)
        VALUES ('a1', 'm2', 'follow up', ?, ?)
      `).run(loser, new Date().toISOString());

      repo.dedupeByDisplayName();

      const links = db.prepare('SELECT meeting_id, roster_speaker_id FROM meeting_speakers ORDER BY meeting_id').all();
      expect(links).toEqual([
        { meeting_id: 'm1', roster_speaker_id: winner },
        { meeting_id: 'm2', roster_speaker_id: winner },
      ]);
      const item = db.prepare('SELECT owner_speaker_id FROM action_items WHERE id = ?').get('a1') as { owner_speaker_id: string };
      expect(item.owner_speaker_id).toBe(winner);
    });

    it('is idempotent', () => {
      const winner = repo.create({ displayName: 'Dan' });
      repo.create({ displayName: 'DAN' });
      db.prepare('UPDATE speakers SET created_at = ? WHERE id = ?').run('2000-01-01T00:00:00Z', winner);
      expect(repo.dedupeByDisplayName().size).toBe(1);
      expect(repo.dedupeByDisplayName().size).toBe(0);
    });
  });
});
