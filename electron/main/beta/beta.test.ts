import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../storage/db.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
import { SpeakersRepo } from '../storage/speakers-repo.js';
import { BetaLibraryImport, ownedPath } from './library.js';
import { VoiceProfiles, normalized } from './voice-profiles.js';
import { BetaService, readableTurns } from './service.js';
import { SPEAKER_REVISION, type SpeechClient } from '../speech/client.js';
import { verifyModelBytes } from '../speech/models.js';
import * as modelFiles from '../speech/models.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(): { root: string; source: string; profile: string; person: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-speech-beta-'))); roots.push(root);
  const source = path.join(root, 'stable'), profile = path.join(root, 'beta'); fs.mkdirSync(profile);
  const db = openDb(path.join(source, 'db.sqlite'));
  const audio = path.join(root, 'outside.wav'); fs.writeFileSync(audio, 'synthetic audio');
  new MeetingsRepo(db).insert({ id: 'meeting', slug: 'meeting', title: 'Weekly review', startedAt: null, durationS: 5,
    audioPath: audio, status: 'done', pipelineStage: 'done' });
  const person = new SpeakersRepo(db).create({ displayName: 'Dan' });
  db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('webhookSecret', JSON.stringify('synthetic-secret-do-not-copy'));
  db.prepare('INSERT INTO meeting_speakers(meeting_id,local_label,roster_speaker_id,confidence) VALUES (?,?,?,?)').run('meeting', 'SPEAKER_00', person, 1);
  const folder = path.join(source, 'meetings', 'meeting'); fs.mkdirSync(folder, { recursive: true });
  fs.symlinkSync(audio, path.join(folder, 'audio.mp3'));
  fs.writeFileSync(path.join(folder, 'transcript.md'), '[Dan 00:00] Original wording.');
  fs.writeFileSync(path.join(folder, 'summary.md'), 'Original notes.');
  fs.writeFileSync(path.join(folder, 'diarization.json'), JSON.stringify({ segments: [{ start: 0, end: 5, speaker: 'SPEAKER_00', embedding: [1, 0] }] }));
  db.close(); return { root, source, profile, person };
}
async function importFixture(f = fixture()): Promise<typeof f> {
  const importer = new BetaLibraryImport(f.profile); await importer.preview(f.source);
  await importer.run(new AbortController().signal, () => {}); return f;
}
const transcript = { text: 'New wording.', segments: [{ start: 0, end: 2, text: 'New wording.' }], provider: 'apple', locale: 'en_US', osVersion: 'test', durationS: 5 };
const diarization = { provider: 'speakerkit', modelRevision: SPEAKER_REVISION, embeddingSpace: 'test-native-space',
  segments: [{ start: 0, end: 5, speaker: 'SPEAKER_01' }], num_speakers: 1, centroids: { SPEAKER_01: [1, 0] } };
function client(): SpeechClient {
  return { request: vi.fn(async (operation: string) => ({ result: operation === 'health' ? { installed: true } : operation === 'diarize' ? diarization : transcript, elapsedMs: 20 })), cancel: vi.fn() } as unknown as SpeechClient;
}
describe('beta library isolation', () => {
  it('copies external symlinked audio as independent files, snapshots the DB, and strips settings', async () => {
    const f = fixture(), original = fs.readFileSync(path.join(f.source, 'db.sqlite'));
    await importFixture(f);
    expect(fs.readFileSync(path.join(f.source, 'db.sqlite'))).toEqual(original);
    const db = new Database(path.join(f.profile, 'library', 'db.sqlite'), { readonly: true });
    const row = db.prepare('SELECT audio_path AS audio FROM meetings').get() as { audio: string };
    expect(row.audio.startsWith(path.join(f.profile, 'library'))).toBe(true);
    expect(fs.lstatSync(row.audio).isSymbolicLink()).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM settings').get()).toEqual({ n: 0 }); db.close();
    const copyAudio = path.join(f.profile, 'library', 'meetings', 'meeting', 'audio.mp3');
    fs.writeFileSync(copyAudio, 'beta changed');
    expect(fs.readFileSync(path.join(f.root, 'outside.wav'), 'utf8')).toBe('synthetic audio');
    expect(fs.readFileSync(path.join(f.profile, 'library', 'db.sqlite')).includes(Buffer.from('synthetic-secret-do-not-copy'))).toBe(false);
  });
  it('does not overwrite an existing beta library', async () => {
    const f = await importFixture();
    await expect(new BetaLibraryImport(f.profile).preview(f.source)).rejects.toThrow(/already exists/);
  });
  it('refuses active processing without interrupting it', async () => {
    const f = fixture(), db = new Database(path.join(f.source, 'db.sqlite')); db.prepare("UPDATE meetings SET status='processing'").run(); db.close();
    await expect(new BetaLibraryImport(f.profile).preview(f.source)).rejects.toThrow(/Finish recording/);
    expect(fs.existsSync(path.join(f.profile, 'library'))).toBe(false);
  });
  it('cancels without publishing a partial library or changing source files', async () => {
    const f = fixture(), importer = new BetaLibraryImport(f.profile); await importer.preview(f.source);
    const signal = new AbortController(); signal.abort();
    await expect(importer.run(signal.signal, () => {})).rejects.toThrow();
    expect(fs.readdirSync(f.profile)).toEqual([]);
    expect(fs.readFileSync(path.join(f.source, 'meetings', 'meeting', 'summary.md'), 'utf8')).toBe('Original notes.');
  });
  it('rejects traversal and links out of the beta root', () => {
    const f = fixture(); fs.symlinkSync(f.source, path.join(f.profile, 'escape'));
    expect(() => ownedPath(f.profile, '../stable')).toThrow();
    expect(() => ownedPath(f.profile, 'escape', 'db.sqlite')).toThrow();
  });
  it('detects files changed after preview', async () => {
    const f = fixture(), importer = new BetaLibraryImport(f.profile); await importer.preview(f.source);
    fs.writeFileSync(path.join(f.source, 'new.txt'), 'new');
    await expect(importer.run(new AbortController().signal, () => {})).rejects.toThrow(/changed/);
  });
});
describe('native voice profiles', () => {
  it('does not mix models, auto-enroll guesses, or lose existing identities', () => {
    const f = fixture(), profiles = new VoiceProfiles(f.profile), roster = [{ id: f.person, displayName: 'Dan' }];
    expect(profiles.suggestions('new', [1, 0], roster)).toEqual([]);
    profiles.confirm('new', f.person, [1, 0]);
    expect(profiles.suggestions('new', [0.9, 0.1], roster)[0]?.id).toBe(f.person);
    expect(profiles.suggestions('other-model', [1, 0], roster)).toEqual([]);
    expect(profiles.suggestions('new', [1, 0, 0], roster)).toEqual([]);
    expect(new VoiceProfiles(f.profile).suggestions('new', [1, 0], roster)[0]?.similarity).toBe(1);
    for (const vector of [[], [0, 0], [NaN, 1], [Infinity]]) {
      expect(normalized(vector)).toBeNull(); expect(() => profiles.confirm('new', f.person, vector)).toThrow();
    }
  });
});
describe('beta before/after processing', () => {
  it('enrolls only confirmed native voices and never transfers old local labels across reruns', async () => {
    vi.spyOn(modelFiles, 'modelsReady').mockReturnValue(true);
    const f = await importFixture(), speech = client(), service = new BetaService(f.profile, speech);
    await service.checkApple(); await service.run('meeting', 'full');
    expect(service.compare('meeting').voices).toMatchObject([{ label: 'SPEAKER_01', name: null, candidates: [], canEnroll: true }]);
    service.confirm('meeting', 'SPEAKER_01', f.person);
    expect(service.compare('meeting').voices[0]?.name).toBe('Dan');
    expect(service.compare('meeting').result).toContain('[Dan 00:00]');
    await service.run('meeting', 'full');
    expect(service.compare('meeting').voices[0]).toMatchObject({ name: null, candidates: [{ id: f.person, displayName: 'Dan', similarity: 1 }] });
    expect(service.compare('meeting').result).toContain('[SPEAKER_01 00:00]');
    expect(service.compare('meeting').original).toContain('[Dan 00:00] Original wording.');
  });
  it('permits manual names without usable vectors but does not enroll a bad profile', async () => {
    vi.spyOn(modelFiles, 'modelsReady').mockReturnValue(true);
    const f = await importFixture(), speech = client();
    const base = vi.mocked(speech.request).getMockImplementation()!;
    vi.mocked(speech.request).mockImplementation(async (operation, ...args) => operation === 'diarize'
      ? { result: { ...diarization, centroids: {} }, elapsedMs: 1 } : base(operation, ...args));
    const service = new BetaService(f.profile, speech);
    await service.checkApple(); await service.run('meeting', 'full');
    expect(service.compare('meeting').voices[0]?.canEnroll).toBe(false);
    service.confirm('meeting', 'SPEAKER_01', f.person);
    expect(service.compare('meeting').voices[0]?.name).toBe('Dan');
    expect(fs.existsSync(path.join(f.profile, 'voice-profiles'))).toBe(false);
  });
  it('rejects concurrent jobs and cancellation retains prior artifacts', async () => {
    const f = await importFixture(), speech = client(), service = new BetaService(f.profile, speech);
    await service.checkApple();
    vi.mocked(speech.request).mockImplementationOnce((_operation, _args, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    const pending = service.run('meeting', 'transcript');
    await expect(service.run('meeting', 'transcript')).rejects.toThrow(/already running/);
    service.cancel(); await expect(pending).rejects.toThrow(/Cancelled/);
    expect(service.status().busy).toBeNull();
    expect(service.compare('meeting').original).toContain('Original wording');
    expect(service.compare('meeting').result).toBeNull();
  });
  it('keeps true word timing at speaker changes while making readable paragraphs', () => {
    const turns = readableTurns([
      { start: 0, end: 1, text: 'Hello', speaker: 'A' },
      { start: 1, end: 1.2, text: ',', speaker: 'A' },
      { start: 1.2, end: 2, text: 'Dan.', speaker: 'A' },
      { start: 2, end: 3, text: 'Hi.', speaker: 'B' },
    ]);
    expect(turns).toEqual([{ start: 0, end: 2, text: 'Hello, Dan.', speaker: 'A' }, { start: 2, end: 3, text: 'Hi.', speaker: 'B' }]);
  });
  it('retains original notes/transcript and old names across repeated native runs and restart', async () => {
    const f = await importFixture(), speech = client(), service = new BetaService(f.profile, speech);
    await service.checkApple(); await service.run('meeting', 'transcript');
    expect(service.compare('meeting').result).toContain('[Dan 00:00] New wording.');
    await service.run('meeting', 'transcript');
    const restarted = new BetaService(f.profile, speech);
    expect(restarted.compare('meeting')).toMatchObject({ original: '[Dan 00:00] Original wording.', notes: 'Original notes.', mode: 'transcript' });
    expect(restarted.status().roster[0]?.displayName).toBe('Dan');
    expect(fs.readFileSync(path.join(f.source, 'meetings', 'meeting', 'transcript.md'), 'utf8')).toContain('Original wording');
  });
  it('retains the last good result on failed or malformed native output', async () => {
    const f = await importFixture(), speech = client(), service = new BetaService(f.profile, speech);
    await service.checkApple(); await service.run('meeting', 'transcript');
    vi.mocked(speech.request).mockRejectedValueOnce(new Error('synthetic failure'));
    await expect(service.run('meeting', 'transcript')).rejects.toThrow('synthetic failure');
    expect(service.compare('meeting').result).toContain('New wording.');
    vi.mocked(speech.request).mockResolvedValueOnce({ result: { ...transcript, segments: [{ start: 4, end: 2, text: 'bad' }] }, elapsedMs: 0 });
    await expect(service.run('meeting', 'transcript')).rejects.toThrow(/timestamps/);
    expect(service.compare('meeting').result).toContain('New wording.');
  });
  it('blocks overlapping jobs and rejects audio paths pointing into stable', async () => {
    const f = await importFixture(), service = new BetaService(f.profile, client());
    const db = new Database(path.join(f.profile, 'library', 'db.sqlite'));
    db.prepare('UPDATE meetings SET audio_path=?').run(path.join(f.root, 'outside.wav')); db.close();
    expect(() => service.compare('meeting')).toThrow(/outside the beta/);
  });
});
it('verifies both LFS checksums and regular Git blob hashes', () => {
  const data = Buffer.from('hello\n');
  expect(verifyModelBytes(data, 6, 'ce013625030ba8dba906f756967f9e9ca394464a', 'git')).toBe(true);
  expect(verifyModelBytes(data, 7, 'ce013625030ba8dba906f756967f9e9ca394464a', 'git')).toBe(false);
});
