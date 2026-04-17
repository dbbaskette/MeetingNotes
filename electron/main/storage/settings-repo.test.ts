import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db';
import { SettingsRepo, DEFAULT_SETTINGS } from './settings-repo';

let repo: SettingsRepo;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-set-'));
  repo = new SettingsRepo(openDb(path.join(dir, 'db.sqlite')));
});

describe('SettingsRepo', () => {
  it('falls back to defaults when unset', () => {
    expect(repo.get('lmStudioUrl')).toBe(DEFAULT_SETTINGS.lmStudioUrl);
  });
  it('set + get round-trips', () => {
    repo.set('sttModel', 'whisper-large-v3');
    expect(repo.get('sttModel')).toBe('whisper-large-v3');
  });
  it('getAll returns merged defaults + overrides', () => {
    repo.set('sttModel', 'x');
    const all = repo.getAll();
    expect(all.sttModel).toBe('x');
    expect(all.lmStudioUrl).toBe(DEFAULT_SETTINGS.lmStudioUrl);
  });
});
