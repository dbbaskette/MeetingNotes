import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { StageDurationsRepo } from './stage-durations-repo.js';

let repo: StageDurationsRepo;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-sd-'));
  repo = new StageDurationsRepo(openDb(path.join(dir, 'db.sqlite')));
});

describe('StageDurationsRepo', () => {
  it('record + recentSamples round-trips for the same (stage, bucket)', () => {
    repo.record('summarizing', 1, 1000);
    repo.record('summarizing', 1, 2000);
    expect(repo.recentSamples('summarizing', 1, 10).sort((a, b) => a - b)).toEqual([1000, 2000]);
  });

  it('keys samples by stage AND size bucket', () => {
    repo.record('summarizing', 1, 1000);
    repo.record('summarizing', 2, 9999); // different bucket
    repo.record('extracting', 1, 5555);  // different stage
    expect(repo.recentSamples('summarizing', 1, 10)).toEqual([1000]);
    expect(repo.recentSamples('summarizing', 2, 10)).toEqual([9999]);
    expect(repo.recentSamples('extracting', 1, 10)).toEqual([5555]);
  });

  it('returns newest-first and honors the limit', () => {
    for (let i = 1; i <= 5; i++) repo.record('extracting', 0, i * 100);
    // Newest first → 500, 400, 300 ...; limit caps the count.
    expect(repo.recentSamples('extracting', 0, 3)).toEqual([500, 400, 300]);
  });

  it('prunes each (stage, bucket) to MAX_SAMPLES_PER_BUCKET most-recent rows', () => {
    for (let i = 1; i <= 25; i++) repo.record('summarizing', 0, i);
    const all = repo.recentSamples('summarizing', 0, 1000);
    expect(all.length).toBe(20); // MAX_SAMPLES_PER_BUCKET
    // The 5 oldest (1..5) were pruned; the newest (25) survives.
    expect(all[0]).toBe(25);
    expect(Math.min(...all)).toBe(6);
  });

  it('returns [] for an unseen (stage, bucket)', () => {
    expect(repo.recentSamples('merging', 3, 10)).toEqual([]);
  });
});
