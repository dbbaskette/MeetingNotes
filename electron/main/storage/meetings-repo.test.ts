import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { MeetingsRepo, type MeetingInsert, type MeetingListFilter, type MeetingListSort } from './meetings-repo.js';

let repo: MeetingsRepo;
let db: Database.Database;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-rm-'));
  db = openDb(path.join(dir, 'db.sqlite'));
  repo = new MeetingsRepo(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const statuses = ['pending', 'awaiting_user', 'processing', 'failed', 'done', 'unknown'] as const;
const filters: MeetingListFilter[] = ['all', 'pending', 'processing', 'done', 'failed'];
const sorts: MeetingListSort[] = ['newest', 'oldest', 'longest', 'title'];
const patterns = [
  { title: 'alpha', startedAt: '2026-09-08', durationS: 30 },
  { title: 'ALPHA', startedAt: '2026-09-01', durationS: 30 },
  { title: 'beta', startedAt: '2026-09-08', durationS: 0 },
  { title: 'beta', startedAt: null, durationS: null },
  { title: '', startedAt: null, durationS: 0 },
  { title: 'Zulu', startedAt: '2026-09-01', durationS: 60 },
  { title: 'ALPHA', startedAt: '2026-09-08', durationS: 30 },
  { title: 'alpha', startedAt: '2026-09-08', durationS: 30 },
];
// Hand-derived orders, independent of the repository's SQL/cursor logic.
const patternOrder = {
  newest: [0, 2, 6, 7, 1, 5, 3, 4],
  oldest: [1, 5, 0, 2, 6, 7, 3, 4],
  longest: [5, 0, 6, 7, 1, 2, 4, 3],
  title: [4, 0, 6, 7, 1, 2, 3, 5],
};

function insertMeeting(id: string, overrides: Partial<MeetingInsert> = {}): void {
  repo.insert({ id, slug: id, title: 'Meeting', startedAt: null, durationS: null,
    audioPath: `/${id}.mp3`, status: 'done', pipelineStage: 'done', ...overrides });
}

function seedPages(): void {
  db.transaction(() => {
    // Reverse insertion catches accidental dependence on rowid/insertion order.
    for (const status of [...statuses].reverse()) {
      for (let p = patterns.length - 1; p >= 0; p--) {
        for (let copy = 3; copy >= 0; copy--) {
          insertMeeting(`${status}-${p}-${copy}`, { ...patterns[p], status });
        }
      }
      insertMeeting(`${status}-deleted`, { ...patterns[0], status });
      repo.softDelete(`${status}-deleted`);
    }
  })();
}

function expectedIds(filter: MeetingListFilter, sort: MeetingListSort): string[] {
  const matching = filter === 'all' ? statuses
    : filter === 'processing' ? ['awaiting_user', 'processing'] : [filter];
  return matching.flatMap((status) => patternOrder[sort].flatMap((p) =>
    [0, 1, 2, 3].map((copy) => `${status}-${p}-${copy}`)));
}

describe('MeetingsRepo', () => {
  describe('listPage', () => {
    for (const sort of sorts) {
      for (const filter of filters) {
        it(`walks every ${filter}/${sort} row once with stable buckets, nulls, and ID ties`, () => {
          seedPages();
          const ids: string[] = [];
          const cursors = new Set<string>();
          let cursor: string | undefined;
          do {
            const page = repo.listPage({ filter, sort, pageSize: 7, cursor });
            expect(page.rows.length).toBeGreaterThan(0);
            expect(page.rows.length).toBeLessThanOrEqual(7);
            expect(page.rows.every((row) => row.deletedAt === null)).toBe(true);
            ids.push(...page.rows.map((row) => row.id));
            if (page.nextCursor !== null) {
              expect(cursors.has(page.nextCursor)).toBe(false);
              cursors.add(page.nextCursor);
            }
            cursor = page.nextCursor ?? undefined;
            expect(cursors.size).toBeLessThan(40);
          } while (cursor);
          expect(ids).toEqual(expectedIds(filter, sort));
          expect(new Set(ids).size).toBe(ids.length);
          expect(cursors.size).toBeGreaterThan(2);
        });
      }
    }

    it('defaults to 50 rows and caps large pages at 100', () => {
      seedPages();
      expect(repo.listPage({ filter: 'all', sort: 'newest' }).rows).toHaveLength(50);
      const first = repo.listPage({ filter: 'all', sort: 'newest', pageSize: 500 });
      expect(first.rows).toHaveLength(100);
      const second = repo.listPage({ filter: 'all', sort: 'newest', pageSize: 500, cursor: first.nextCursor! });
      expect(second.rows).toHaveLength(92);
      expect(second.nextCursor).toBeNull();
      expect([...first.rows, ...second.rows].map((row) => row.id)).toEqual(expectedIds('all', 'newest'));
    });

    it('returns a terminal empty page and no cursor for an exact-sized final page', () => {
      expect(repo.listPage({ filter: 'all', sort: 'newest' })).toEqual({ rows: [], nextCursor: null });
      insertMeeting('a');
      expect(repo.listPage({ filter: 'all', sort: 'newest', pageSize: 1 }).nextCursor).toBeNull();
    });

    it.each(sorts)('encodes the last returned %s row and resumes even after it is deleted', (sort) => {
      seedPages();
      const first = repo.listPage({ filter: 'done', sort, pageSize: 5 });
      expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      const decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'));
      expect(Object.keys(decoded).sort()).toEqual(['id', 'sortValue', 'statusRank', 'v']);
      expect(decoded).toMatchObject({ v: 1, statusRank: 4, id: first.rows[4]!.id });
      expect(decoded.sortValue).toMatchObject({ sort });
      repo.hardDelete(first.rows[4]!.id);
      const next = repo.listPage({ filter: 'done', sort, pageSize: 5, cursor: first.nextCursor! });
      expect(next.rows.map((row) => row.id)).toEqual(expectedIds('done', sort).slice(5, 10));
    });

    it('binds quoted title/ID cursor values instead of treating them as SQL', () => {
      insertMeeting("a'; DROP TABLE meetings; --", { title: "Dan's sync", startedAt: '2026-09-08' });
      insertMeeting('b', { title: "Dan's sync", startedAt: '2026-09-08' });
      insertMeeting('c', { title: 'Zulu' });
      const first = repo.listPage({ filter: 'all', sort: 'title', pageSize: 1 });
      expect(first.rows[0]!.id).toBe("a'; DROP TABLE meetings; --");
      expect(repo.listPage({ filter: 'all', sort: 'title', cursor: first.nextCursor! }).rows.map((row) => row.id))
        .toEqual(['b', 'c']);
    });

    it('rejects invalid enums and non-positive/non-integer page sizes', () => {
      for (const filter of ['nope', "all'; DROP TABLE meetings; --", 'toString', '__proto__']) {
        expect(() => repo.listPage({ filter: filter as MeetingListFilter, sort: 'newest' })).toThrow(/filter/i);
      }
      for (const sort of ['nope', 'title; DROP TABLE meetings', 'toString', '__proto__']) {
        expect(() => repo.listPage({ filter: 'all', sort: sort as MeetingListSort })).toThrow(/sort/i);
      }
      for (const pageSize of [0, -1, 1.5, NaN, Infinity, '5', null]) {
        expect(() => repo.listPage({ filter: 'all', sort: 'newest', pageSize: pageSize as number })).toThrow(/page.?size/i);
      }
    });

    it('rejects malformed, wrong-version, wrong-sort, and invalid-value cursors', () => {
      seedPages();
      const good = repo.listPage({ filter: 'all', sort: 'newest', pageSize: 1 }).nextCursor!;
      const value = JSON.parse(Buffer.from(good, 'base64url').toString('utf8'));
      const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
      for (const cursor of ['', 'not a cursor', 'e30', good + '=', good + '!', encode(null), encode([]),
        encode({ ...value, v: 2 }), encode({ ...value, statusRank: -1 }), encode({ ...value, statusRank: 1.5 }),
        encode({ ...value, statusRank: 5 }), encode({ ...value, id: 123 }), encode({ ...value, id: '' }),
        encode({ ...value, sortValue: null }), encode({ ...value, sortValue: { sort: 'newest', values: [42] } }),
        encode({ ...value, sortValue: { sort: 'newest', values: [] } }),
        encode({ ...value, sortValue: { sort: 'newest', values: [null, 'extra'] } }),
      ]) {
        expect(() => repo.listPage({ filter: 'all', sort: 'newest', cursor }), cursor).toThrow(/cursor/i);
      }
      expect(() => repo.listPage({ filter: 'all', sort: 'oldest', cursor: good })).toThrow(/cursor/i);
    });

    it.each(['all', 'pending', 'processing', 'done'] as const)('avoids temporary sorting for common newest/%s pages', (filter) => {
      seedPages();
      const prepare = vi.spyOn(db, 'prepare');
      const first = repo.listPage({ filter, sort: 'newest', pageSize: 7 });
      const firstSql = prepare.mock.calls.at(-1)![0];
      const firstPlan = db.prepare(`EXPLAIN QUERY PLAN ${firstSql}`).all({ limit: 8 }) as { detail: string }[];
      expect(firstPlan.map((row) => row.detail).join('\n')).not.toContain('TEMP B-TREE');

      const cursor = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'));
      repo.listPage({ filter, sort: 'newest', pageSize: 7, cursor: first.nextCursor! });
      const nextSql = prepare.mock.calls.at(-1)![0];
      const nextPlan = db.prepare(`EXPLAIN QUERY PLAN ${nextSql}`).all({ limit: 8,
        cursor0: cursor.statusRank, cursor1: cursor.sortValue.values[0], cursor2: cursor.id,
      }) as { detail: string }[];
      expect(nextPlan.map((row) => row.detail).join('\n')).not.toContain('TEMP B-TREE');
    });
  });

  describe('counts and listIds', () => {
    it('returns global live counts, including awaiting_user in processing', () => {
      expect(repo.counts()).toEqual({ all: 0, pending: 0, processing: 0, done: 0, failed: 0 });
      seedPages();
      repo.listPage({ filter: 'done', sort: 'newest', pageSize: 1 });
      expect(repo.counts()).toEqual({ all: 192, pending: 32, processing: 64, done: 32, failed: 32 });
      repo.softDelete('pending-0-0');
      expect(repo.counts().pending).toBe(31);
      repo.restore('pending-0-0');
      expect(repo.counts().pending).toBe(32);
    });

    it.each(filters)('lists the entire live %s snapshot in deterministic ID order', (filter) => {
      seedPages();
      expect(repo.listIds(filter)).toEqual(expectedIds(filter, 'newest').sort());
    });

    it('returns an empty ID snapshot and rejects invalid filters', () => {
      expect(repo.listIds('all')).toEqual([]);
      expect(() => repo.listIds('awaiting_user' as MeetingListFilter)).toThrow(/filter/i);
      expect(() => repo.listIds('__proto__' as MeetingListFilter)).toThrow(/filter/i);
    });
  });

  describe('findByIds', () => {
    it('preserves first-occurrence input order, excluding duplicate, missing, and soft-deleted IDs', () => {
      for (const id of ['a', 'b', 'c']) insertMeeting(id);
      repo.softDelete('b');
      expect(repo.findByIds(['c', 'b', 'a', 'missing', 'c']).map((row) => row.id)).toEqual(['c', 'a']);
      expect(repo.findByIds([])).toEqual([]);
    });

    it('hydrates more than two 900-ID chunks without losing caller order', () => {
      const ids = Array.from({ length: 1805 }, (_, i) => `id-${String(i).padStart(4, '0')}`);
      db.transaction(() => { for (const id of ids) insertMeeting(id); })();
      const prepare = vi.spyOn(db, 'prepare'); // Observe real statements; do not replace SQLite.
      expect(repo.findByIds([...ids].reverse()).map((row) => row.id)).toEqual([...ids].reverse());
      const sizes = prepare.mock.calls.map(([sql]) => (sql.match(/\?/g) ?? []).length);
      expect(sizes).toEqual([900, 900, 5]);
    });
  });

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
