import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { SettingsRepo, DEFAULT_SETTINGS, normalizeAutoDetectMeetings } from './settings-repo.js';

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
  it('reads a legacy autoDetectMeetings boolean as the new object shape', () => {
    // Simulate the pre-#78 row shape (a boolean in JSON).
    (repo as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('autoDetectMeetings', 'true');
    expect(repo.get('autoDetectMeetings')).toEqual({
      browserTabs: true, nativeApps: true, silenceMs: 5000,
    });
  });
  it('round-trips the new autoDetectMeetings object', () => {
    repo.set('autoDetectMeetings', { browserTabs: false, nativeApps: true, silenceMs: 7000 });
    expect(repo.get('autoDetectMeetings')).toEqual({
      browserTabs: false, nativeApps: true, silenceMs: 7000,
    });
  });
});

describe('normalizeAutoDetectMeetings', () => {
  it('treats legacy true as both detectors on', () => {
    expect(normalizeAutoDetectMeetings(true)).toEqual({
      browserTabs: true, nativeApps: true, silenceMs: 5000,
    });
  });
  it('treats legacy false as both detectors off', () => {
    expect(normalizeAutoDetectMeetings(false)).toEqual({
      browserTabs: false, nativeApps: false, silenceMs: 5000,
    });
  });
  it('fills in missing fields from defaults', () => {
    expect(normalizeAutoDetectMeetings({ nativeApps: true })).toEqual({
      browserTabs: false, nativeApps: true, silenceMs: 5000,
    });
  });
  it('rejects non-finite silenceMs', () => {
    expect(normalizeAutoDetectMeetings({ silenceMs: Number.NaN }).silenceMs).toBe(5000);
    expect(normalizeAutoDetectMeetings({ silenceMs: -1 }).silenceMs).toBe(5000);
  });
});
