import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { MeetingsRepo } from './meetings-repo.js';

let repo: MeetingsRepo;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-rm-'));
  repo = new MeetingsRepo(openDb(path.join(dir, 'db.sqlite')));
});

describe('MeetingsRepo', () => {
  it('insert + findById round-trips', () => {
    repo.insert({
      id: 'a3f8', slug: '2026-04-17-q2-a3f8', title: 'Q2',
      startedAt: '2026-04-17T14:32:00', durationS: 2341,
      audioPath: '/x/a.mp3', status: 'processing', pipelineStage: 'transcribing',
    });
    const got = repo.findById('a3f8');
    expect(got?.title).toBe('Q2');
    expect(got?.pipelineStage).toBe('transcribing');
  });

  it('updateStage updates pipeline_stage and updated_at', () => {
    repo.insert({ id: 'x', slug: 's', title: 't', startedAt: null, durationS: null,
      audioPath: '/a', status: 'processing', pipelineStage: 'discovered' });
    repo.updateStage('x', 'transcribing');
    expect(repo.findById('x')?.pipelineStage).toBe('transcribing');
  });

  it('recordFailure stores the error message and flips status to failed', () => {
    repo.insert({ id: 'f', slug: 'f', title: 'F', startedAt: null, durationS: null,
      audioPath: '/a', status: 'processing', pipelineStage: 'transcribing' });
    repo.recordFailure('f', 'Error: whisper: not ready within 120000ms');
    const got = repo.findById('f');
    expect(got?.status).toBe('failed');
    expect(got?.errorMessage).toBe('Error: whisper: not ready within 120000ms');
  });

  it('updateStatus clears a stale error_message on transition away from failed', () => {
    repo.insert({ id: 'r', slug: 'r', title: 'R', startedAt: null, durationS: null,
      audioPath: '/a', status: 'processing', pipelineStage: 'transcribing' });
    repo.recordFailure('r', 'boom');
    expect(repo.findById('r')?.errorMessage).toBe('boom');
    repo.updateStatus('r', 'processing'); // e.g. a retry
    expect(repo.findById('r')?.errorMessage).toBeNull();
  });

  it('listAll returns newest first', () => {
    repo.insert({ id: 'a', slug: 'a', title: 'A', startedAt: '2026-04-16', durationS: null, audioPath: '/a', status: 'done', pipelineStage: 'done' });
    repo.insert({ id: 'b', slug: 'b', title: 'B', startedAt: '2026-04-17', durationS: null, audioPath: '/b', status: 'done', pipelineStage: 'done' });
    expect(repo.listAll().map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('findNonTerminal returns meetings not in `done`', () => {
    repo.insert({ id: 'a', slug: 'a', title: 'A', startedAt: null, durationS: null, audioPath: '/a', status: 'processing', pipelineStage: 'transcribing' });
    repo.insert({ id: 'b', slug: 'b', title: 'B', startedAt: null, durationS: null, audioPath: '/b', status: 'done', pipelineStage: 'done' });
    expect(repo.findNonTerminal().map((m) => m.id)).toEqual(['a']);
  });

  it('softDelete hides the row from listAll but leaves it in findById', () => {
    repo.insert({ id: 'soft', slug: 's', title: 't', startedAt: null, durationS: null, audioPath: '/a', status: 'done', pipelineStage: 'done' });
    expect(repo.listAll().map((m) => m.id)).toContain('soft');
    repo.softDelete('soft');
    expect(repo.listAll().map((m) => m.id)).not.toContain('soft');
    const row = repo.findById('soft');
    expect(row).not.toBeNull();
    expect(row!.deletedAt).not.toBeNull();
  });

  it('restore clears deletedAt, bringing the row back to listAll', () => {
    repo.insert({ id: 'back', slug: 's2', title: 't', startedAt: null, durationS: null, audioPath: '/a', status: 'done', pipelineStage: 'done' });
    repo.softDelete('back');
    repo.restore('back');
    expect(repo.listAll().map((m) => m.id)).toContain('back');
    expect(repo.findById('back')!.deletedAt).toBeNull();
  });

  it('findSoftDeleted returns only soft-deleted rows, honoring the cutoff', () => {
    repo.insert({ id: 'live', slug: 's3', title: 't', startedAt: null, durationS: null, audioPath: '/a', status: 'done', pipelineStage: 'done' });
    repo.insert({ id: 'dead', slug: 's4', title: 't', startedAt: null, durationS: null, audioPath: '/b', status: 'done', pipelineStage: 'done' });
    repo.softDelete('dead');
    // No cutoff → returns the one soft-deleted row.
    expect(repo.findSoftDeleted().map((m) => m.id)).toEqual(['dead']);
    // Cutoff in the future → matches everything soft-deleted before now.
    expect(repo.findSoftDeleted(new Date(Date.now() + 60_000).toISOString()).map((m) => m.id)).toEqual(['dead']);
    // Cutoff in the past → nothing qualifies yet (row was deleted more recently).
    expect(repo.findSoftDeleted('1970-01-01T00:00:00Z')).toEqual([]);
  });

  it('hardDelete removes the row entirely', () => {
    repo.insert({ id: 'gone', slug: 's5', title: 't', startedAt: null, durationS: null, audioPath: '/a', status: 'done', pipelineStage: 'done' });
    repo.hardDelete('gone');
    expect(repo.findById('gone')).toBeNull();
  });

  describe('searchByTitle', () => {
    it('matches substrings case-insensitively, newest first', () => {
      repo.insert({ id: 'a', slug: 'a', title: 'Q2 Planning', startedAt: '2026-04-16', durationS: null, audioPath: '/a', status: 'done', pipelineStage: 'done' });
      repo.insert({ id: 'b', slug: 'b', title: 'weekly planning sync', startedAt: '2026-04-17', durationS: null, audioPath: '/b', status: 'done', pipelineStage: 'done' });
      repo.insert({ id: 'c', slug: 'c', title: 'Retro', startedAt: '2026-04-18', durationS: null, audioPath: '/c', status: 'done', pipelineStage: 'done' });
      expect(repo.searchByTitle('PLAN', 20).map((m) => m.id)).toEqual(['b', 'a']);
    });

    it('excludes soft-deleted rows', () => {
      repo.insert({ id: 'a', slug: 'a', title: 'Budget review', startedAt: null, durationS: null, audioPath: '/a', status: 'done', pipelineStage: 'done' });
      repo.softDelete('a');
      expect(repo.searchByTitle('budget', 20)).toEqual([]);
    });

    it('respects the limit', () => {
      for (let i = 0; i < 5; i++) {
        repo.insert({ id: `m${i}`, slug: `m${i}`, title: `Sync ${i}`, startedAt: null, durationS: null, audioPath: `/m${i}`, status: 'done', pipelineStage: 'done' });
      }
      expect(repo.searchByTitle('Sync', 3)).toHaveLength(3);
    });

    it('treats LIKE metacharacters as literal text (parity with the old .includes())', () => {
      repo.insert({ id: 'pct', slug: 'pct', title: 'Q3 at 50% capacity', startedAt: null, durationS: null, audioPath: '/p', status: 'done', pipelineStage: 'done' });
      repo.insert({ id: 'und', slug: 'und', title: 'proj_alpha kickoff', startedAt: null, durationS: null, audioPath: '/u', status: 'done', pipelineStage: 'done' });
      // "%" must not act as a wildcard: "9%" matches nothing (no title contains it literally).
      expect(repo.searchByTitle('9%', 20)).toEqual([]);
      expect(repo.searchByTitle('50%', 20).map((m) => m.id)).toEqual(['pct']);
      // "_" must not match any-single-char: "proj_" only hits the literal underscore title.
      expect(repo.searchByTitle('proj_', 20).map((m) => m.id)).toEqual(['und']);
    });

    it('is safe with quote characters in the query (parameter-bound)', () => {
      repo.insert({ id: 'q', slug: 'q', title: "Dan's 1:1", startedAt: null, durationS: null, audioPath: '/q', status: 'done', pipelineStage: 'done' });
      expect(repo.searchByTitle("dan's", 20).map((m) => m.id)).toEqual(['q']);
      expect(() => repo.searchByTitle(`'; DROP TABLE meetings; --`, 20)).not.toThrow();
      expect(repo.findById('q')).not.toBeNull();
    });
  });

  describe('findBySlugs', () => {
    it('returns rows matching the given slugs, skipping unknowns and soft-deleted', () => {
      repo.insert({ id: 'a', slug: 'slug-a', title: 'A', startedAt: null, durationS: null, audioPath: '/a', status: 'done', pipelineStage: 'done' });
      repo.insert({ id: 'b', slug: 'slug-b', title: 'B', startedAt: null, durationS: null, audioPath: '/b', status: 'done', pipelineStage: 'done' });
      repo.insert({ id: 'c', slug: 'slug-c', title: 'C', startedAt: null, durationS: null, audioPath: '/c', status: 'done', pipelineStage: 'done' });
      repo.softDelete('c');
      const got = repo.findBySlugs(['slug-a', 'slug-c', 'no-such-slug']);
      expect(got.map((m) => m.id)).toEqual(['a']);
    });

    it('returns [] for an empty slug list', () => {
      expect(repo.findBySlugs([])).toEqual([]);
    });

    it('handles more than 900 slugs by chunking the IN list', () => {
      repo.insert({ id: 'a', slug: 'slug-a', title: 'A', startedAt: null, durationS: null, audioPath: '/a', status: 'done', pipelineStage: 'done' });
      repo.insert({ id: 'z', slug: 'slug-z', title: 'Z', startedAt: null, durationS: null, audioPath: '/z', status: 'done', pipelineStage: 'done' });
      // 1500 slugs — a single IN (...) would blow past SQLite's default
      // 999-parameter limit without chunking.
      const slugs = ['slug-a', ...Array.from({ length: 1498 }, (_, i) => `nope-${i}`), 'slug-z'];
      const got = repo.findBySlugs(slugs);
      expect(got.map((m) => m.id).sort()).toEqual(['a', 'z']);
    });
  });
});
