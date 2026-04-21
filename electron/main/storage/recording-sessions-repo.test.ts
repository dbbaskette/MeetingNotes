import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { RecordingSessionsRepo } from './recording-sessions-repo.js';

describe('RecordingSessionsRepo', () => {
  it('insert + findOpen + finalize round-trip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-rs-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const repo = new RecordingSessionsRepo(db);

    repo.insert({
      id: 'sess1', helperPid: 9999, targetPid: 1234,
      targetLabel: 'Zoom', outputPath: '/tmp/x.m4a',
    });
    expect(repo.findOpen()).toHaveLength(1);

    repo.finalize('sess1');
    expect(repo.findOpen()).toHaveLength(0);
  });

  it('markOrphaned moves status without finalize timestamp', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-rs2-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const repo = new RecordingSessionsRepo(db);
    repo.insert({ id: 's', helperPid: 1, targetPid: null, targetLabel: 'X', outputPath: '/p' });
    repo.markOrphaned('s');
    const all = repo.findOpen();
    expect(all).toHaveLength(0); // no longer 'recording'
    const orphans = repo.findOrphaned();
    expect(orphans).toHaveLength(1);
  });
});
