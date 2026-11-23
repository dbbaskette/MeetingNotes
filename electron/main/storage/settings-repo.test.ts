import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { SettingsRepo, DEFAULT_SETTINGS, normalizeAutoDetectMeetings, normalizeSilenceSeconds } from './settings-repo.js';

let repo: SettingsRepo;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-set-'));
  repo = new SettingsRepo(openDb(path.join(dir, 'db.sqlite')));
});

describe('SettingsRepo', () => {
  it('defaults voice auto-matching off and persists explicit opt-in/out', () => {
    expect(repo.get('autoMatchSpeakers')).toBe(false);
    repo.set('autoMatchSpeakers', true);
    expect(repo.getAll().autoMatchSpeakers).toBe(true);
    repo.set('autoMatchSpeakers', false);
    expect(repo.get('autoMatchSpeakers')).toBe(false);
  });
  it('defaults calendar-aware recording off (#253)', () => {
    expect(DEFAULT_SETTINGS.calendarAware).toBe(false);
    expect(repo.get('calendarAware')).toBe(false);
    repo.set('calendarAware', true);
    expect(repo.getAll().calendarAware).toBe(true);
  });
  it('falls back to defaults when unset', () => {
    expect(repo.get('lmStudioUrl')).toBe(DEFAULT_SETTINGS.lmStudioUrl);
  });
  it('set + get round-trips', () => {
    repo.set('llmModel', 'summary-model');
    expect(repo.get('llmModel')).toBe('summary-model');
  });
  it('getAll returns merged defaults + overrides', () => {
    repo.set('llmModel', 'x');
    const all = repo.getAll();
    expect(all.llmModel).toBe('x');
    expect(all.lmStudioUrl).toBe(DEFAULT_SETTINGS.lmStudioUrl);
  });
  it('ignores rows left behind by settings that no longer exist', () => {
    // Removed in #302. A database written by an older version still holds
    // them; reading must neither fail nor resurface them.
    const insert = (repo as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of [['audioHijackSessionName', '"Meeting"'], ['exporterApple', 'true'], ['exporterMarkdown', 'false'], ['recordingBitrateKbps', '192']]) insert.run(key, value);
    const all = repo.getAll() as unknown as Record<string, unknown>;
    for (const key of ['audioHijackSessionName', 'exporterApple', 'exporterMarkdown', 'recordingBitrateKbps']) {
      expect(all).not.toHaveProperty(key);
      expect(DEFAULT_SETTINGS).not.toHaveProperty(key);
    }
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
  it('theme defaults to system', () => {
    expect(repo.get('theme')).toBe('system');
  });
  it('theme set + get round-trips', () => {
    repo.set('theme', 'dark');
    expect(repo.get('theme')).toBe('dark');
  });
  it('windowBounds defaults to null and round-trips', () => {
    expect(repo.get('windowBounds')).toBeNull();
    repo.set('windowBounds', { x: -100, y: 50, width: 1280, height: 860 });
    expect(repo.get('windowBounds')).toEqual({ x: -100, y: 50, width: 1280, height: 860 });
  });
  it('reasoningEffort defaults to none and stays in sync with legacy disableThinking', () => {
    expect(repo.get('reasoningEffort')).toBe('none');
    repo.set('disableThinking', false);
    expect(repo.get('reasoningEffort')).toBe('default');
    expect(repo.getAll().reasoningEffort).toBe('default');
    repo.set('reasoningEffort', 'minimal');
    expect(repo.get('reasoningEffort')).toBe('minimal');
    expect(repo.get('disableThinking')).toBe(false);
    repo.set('reasoningEffort', 'none');
    expect(repo.get('disableThinking')).toBe(true);
  });
});

describe('silence prompt settings', () => {
  it('defaults to prompting after two minutes with a one-minute countdown', () => {
    expect(repo.get('autoStopOnSilence')).toBe(true);
    expect(repo.get('silencePromptAfterS')).toBe(120);
    expect(repo.get('silenceCountdownS')).toBe(60);
    expect(repo.getAll()).toMatchObject({ autoStopOnSilence: true, silencePromptAfterS: 120, silenceCountdownS: 60 });
  });
  it('round-trips a change, and reads an out-of-range or malformed row as a usable value', () => {
    repo.set('autoStopOnSilence', false);
    repo.set('silencePromptAfterS', 300);
    repo.set('silenceCountdownS', 30);
    expect(repo.getAll()).toMatchObject({ autoStopOnSilence: false, silencePromptAfterS: 300, silenceCountdownS: 30 });
    repo.set('silencePromptAfterS', 1);
    repo.set('silenceCountdownS', 'soon' as unknown as number);
    repo.set('autoStopOnSilence', 'no' as unknown as boolean);
    expect(repo.get('silencePromptAfterS')).toBe(30);
    expect(repo.get('silenceCountdownS')).toBe(60);
    expect(repo.get('autoStopOnSilence')).toBe(true);
    expect(repo.getAll()).toMatchObject({ autoStopOnSilence: true, silencePromptAfterS: 30, silenceCountdownS: 60 });
  });
  it('normalizes a stored duration to whole seconds inside its range', () => {
    expect(normalizeSilenceSeconds('silencePromptAfterS', 5)).toBe(30);
    expect(normalizeSilenceSeconds('silencePromptAfterS', 99_999)).toBe(1800);
    expect(normalizeSilenceSeconds('silencePromptAfterS', 90.4)).toBe(90);
    expect(normalizeSilenceSeconds('silencePromptAfterS', '300')).toBe(120);
    expect(normalizeSilenceSeconds('silenceCountdownS', 1)).toBe(10);
    expect(normalizeSilenceSeconds('silenceCountdownS', 9000)).toBe(600);
    expect(normalizeSilenceSeconds('silenceCountdownS', Number.NaN)).toBe(60);
    expect(normalizeSilenceSeconds('silenceCountdownS', null)).toBe(60);
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
