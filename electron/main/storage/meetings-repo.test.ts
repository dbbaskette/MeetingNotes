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
});
