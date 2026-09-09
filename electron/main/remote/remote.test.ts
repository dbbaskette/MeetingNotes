import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb } from '../storage/db.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
import { SpeakersRepo } from '../storage/speakers-repo.js';
import { ActionItemsRepo } from '../storage/action-items-repo.js';
import { SettingsRepo } from '../storage/settings-repo.js';
import { ArtifactCache } from '../library/artifact-cache.js';
import { RemoteRepository } from './repository.js';
import { RemoteCredentials } from './credentials.js';
import { RemoteImporter, durableWrite } from './importer.js';
import { RemoteCoordinator } from './coordinator.js';
import { RemoteClient, canonical, digest, safeTransferUrl } from './client.js';
import { RemoteEmbeddings } from './embeddings.js';
import type { PipelineContext } from '../pipeline/context.js';
import { recoverPendingMeetings } from '../pipeline/recovery.js';
import { clearGateNotified, shouldNotifyGate } from '../pipeline/gate-alert.js';
import { RemoteCapabilitiesSchema, type RemoteCreateJob, type RemoteJob } from '../../../shared/remote-contracts.js';

const token = 'synthetic-test-token-000000000000000000000000';
const identity = { repository: 'synthetic/embedding', revision: 'v1', preprocessing: 'mono16k-pcm16-turn-v1', dimension: 3, normalization: 'l2' as const };
const capabilities = RemoteCapabilitiesSchema.parse({ schemaVersions: [1], serviceId: 'test-service', ownerId: 'test-owner',
  profiles: [{ id: 'test-profile', digest: 'a'.repeat(64), processor: 'synthetic', transcriptionModel: 'fixture', llmModel: 'fixture', embeddingIdentity: identity }],
  limits: { sourceBytes: 1073741824, durationSeconds: 28800, partBytes: 16777216, concurrentParts: 2, queuedJobs: 10, textBytes: 2000000, textCharacters: 24000 },
  retention: { abandonedUploadHours: 24, acknowledgedHours: 24, resultDays: 30, tombstoneDays: 90 } });
const audioArtifacts = {
  transcription: Buffer.from(JSON.stringify({ segments: [{ start: 0, end: 3, text: 'Synthetic review meeting.' }] })),
  diarization: Buffer.from(JSON.stringify({ segments: [{ start: 0, end: 3, speaker: 'SPEAKER_00', embedding: [1, 0, 0] }], num_speakers: 1, embeddingIdentity: identity, warnings: [] })),
};
const textArtifacts = { text: Buffer.from(JSON.stringify({ summary: '## Remote summary\nReviewed output.', actionItems: [{ text: 'Verify result', owner: 'Alice', due_date: null }] })) };
const fakeKeychain = { isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value).map(n => n ^ 0x5a),
  decryptString: (value: Buffer) => Buffer.from(value).map(n => n ^ 0x5a).toString() };
const fixtures: ReturnType<typeof fixture>[] = [];
function fixture(existingDir?: string, fetcher?: typeof fetch) {
  const dir = existingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mn-remote-test-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const meetings = new MeetingsRepo(db), speakers = new SpeakersRepo(db), actionItems = new ActionItemsRepo(db), settings = new SettingsRepo(db);
  const inference = vi.fn(() => { throw new Error('Local inference must never run'); });
  const ctx = { libraryRoot: dir, meetings, speakers, actionItems, settings, artifactCache: new ArtifactCache(),
    logger: { info: vi.fn(), error: vi.fn() }, lmStudio: { chat: inference }, stt: { transcribe: inference },
    diarization: { diarize: inference }, llmSupervisor: { ensureReady: inference }, whisperSupervisor: { ensureReady: inference }, diarSupervisor: { ensureReady: inference } } as unknown as PipelineContext;
  const repo = new RemoteRepository(db), credentials = new RemoteCredentials(db, fakeKeychain, 'darwin');
  const importer = new RemoteImporter(repo, ctx);
  const coordinator = new RemoteCoordinator(repo, credentials, ctx, importer, { allowLoopback: true, fetcher });
  if (!meetings.findById('meeting-fixture')) {
    durableWrite(path.join(dir, 'source.m4a'), Buffer.alloc(128, 4));
    meetings.insert({ id: 'meeting-fixture', slug: 'synthetic-meeting', title: 'Synthetic meeting', startedAt: null, durationS: 3,
      audioPath: path.join(dir, 'source.m4a'), status: 'pending', pipelineStage: 'discovered' });
    repo.saveConfiguration({ mode: 'remote', endpoint: 'http://127.0.0.1:58800', capabilities, testedAt: new Date().toISOString() });
    credentials.set('http://127.0.0.1:58800', capabilities.ownerId, token);
  }
  const result = { dir, db, repo, credentials, importer, coordinator, ctx, inference };
  fixtures.push(result); return result;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) { f.coordinator.stop(); if (f.db.open) f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});
function stage(f: ReturnType<typeof fixture>, kind: 'audio_analysis' | 'text_generation' = 'text_generation') {
  const id = f.coordinator.start('meeting-fixture'); f.repo.patch(id, { kind });
  f.importer.stage(f.repo.get(id)!, 'b'.repeat(64), kind === 'text_generation' ? textArtifacts : audioArtifacts);
  return id;
}
// Two independently clustered analyses: stable persons, deliberately unstable labels.
function speakerRerun(f: ReturnType<typeof fixture>) {
  const artifacts = (turns: { speaker: string; embedding: number[]; text: string }[]) => ({
    transcription: Buffer.from(JSON.stringify({ segments: turns.map((t, i) => ({ start: i * 3, end: i * 3 + 3, text: t.text })) })),
    diarization: Buffer.from(JSON.stringify({ segments: turns.map((t, i) => ({ start: i * 3, end: i * 3 + 3, speaker: t.speaker, embedding: t.embedding })),
      num_speakers: turns.length, embeddingIdentity: identity, warnings: [] })),
  });
  const firstArtifacts = artifacts([
    { speaker: 'SPEAKER_00', embedding: [1, 0, 0], text: 'Alice first generation.' },
    { speaker: 'SPEAKER_01', embedding: [0, 1, 0], text: 'Bob first generation.' },
    { speaker: 'SPEAKER_02', embedding: [0, 0, 1], text: 'Removed voice.' },
    { speaker: 'SPEAKER_03', embedding: [-1, 0, 0], text: 'Unenrolled voice.' },
  ]);
  const first = f.coordinator.start('meeting-fixture');
  f.importer.stage(f.repo.get(first)!, 'b'.repeat(64), firstArtifacts); f.importer.publish(first);
  const people = ['Alice', 'Bob', 'Charlie', 'Dana'].map(displayName => f.ctx.speakers.create({ displayName }));
  people.forEach((id, i) => f.ctx.speakers.linkToMeeting('meeting-fixture', `SPEAKER_0${i}`, id, 1));
  for (const i of [0, 1]) f.coordinator.confirmSpeaker('meeting-fixture', `SPEAKER_0${i}`, people[i]!);
  const oldLinks = f.ctx.speakers.listForMeeting('meeting-fixture');
  const folder = f.importer.folder('meeting-fixture');
  const oldTranscript = fs.readFileSync(path.join(folder, 'transcript.md'), 'utf8');
  const vectors = f.db.prepare('SELECT * FROM remote_roster_embeddings ORDER BY speaker_id').all();
  f.coordinator.rerun('meeting-fixture', 'transcribing');
  const second = f.repo.current('meeting-fixture')!.id;
  const nextArtifacts = artifacts([
    { speaker: 'SPEAKER_00', embedding: [0, 1, 0], text: 'Bob now speaks first.' },
    { speaker: 'SPEAKER_01', embedding: [1, 0, 0], text: 'Alice now speaks second.' },
    { speaker: 'SPEAKER_03', embedding: [0, 0, 1], text: 'A new voice needs naming.' },
    { speaker: 'SPEAKER_04', embedding: [0.70710678, 0.70710678, 0], text: 'An ambiguous voice needs naming.' },
  ]);
  f.importer.stage(f.repo.get(second)!, 'c'.repeat(64), nextArtifacts);
  return { first, second, people, oldLinks, folder, oldTranscript, firstArtifacts, nextArtifacts, vectors };
}
function server() {
  let request: RemoteCreateJob | undefined, job: RemoteJob | undefined;
  const parts = new Map<number, Buffer>(); const calls: { url: string; init?: RequestInit }[] = [];
  let losePartResponse = false, completed = false;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/capabilities')) return json(capabilities);
    if (url.endsWith('/v1/jobs')) {
      const incoming = JSON.parse(init!.body as string) as RemoteCreateJob;
      if (request) expect(incoming).toEqual(request); else request = incoming;
      job ??= { id: randomUUID(), clientRunId: request.clientRunId, kind: request.kind, state: 'uploading', phase: 'uploading', revision: 1,
        cancelRequested: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resultAvailable: false, error: null };
      return json(job);
    }
    if (url.includes('/upload-parts')) {
      const n = JSON.parse(init!.body as string).partNumbers[0];
      return json({ parts: [{ partNumber: n, url: `http://127.0.0.1:59000/part/${n}`, expiresAt: new Date(Date.now() + 60000).toISOString() }] });
    }
    if (url.includes('/part/')) {
      const n = Number(url.split('/').pop()); parts.set(n, Buffer.from(init!.body as Uint8Array));
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      if (losePartResponse) { losePartResponse = false; throw new Error('Connection lost after object accepted'); }
      return new Response('');
    }
    if (url.endsWith('/upload')) return json({ uploadId: 'upload', partSize: 16777216, state: completed ? 'complete' : 'uploading', parts: [...parts].map(([n, b]) => ({ partNumber: n, bytes: b.length, etag: `etag-${n}` })) });
    if (url.endsWith('/upload-completion')) { completed = true; job!.state = 'succeeded'; job!.phase = 'complete'; job!.resultAvailable = true; return json(job); }
    if (url.endsWith('/result')) {
      const artifacts = request!.kind === 'audio_analysis' ? audioArtifacts : textArtifacts;
      const manifest = { schemaVersion: 1, jobId: job!.id, clientRunId: request!.clientRunId, profileId: request!.profileId, profileDigest: request!.profileDigest, generation: 1,
        artifacts: Object.entries(artifacts).map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: digest(bytes), contentType: 'application/json' })) };
      return json({ manifest, manifestDigest: digest(canonical(manifest)), downloads: Object.keys(artifacts).map(name => ({ name, url: `http://127.0.0.1:59000/artifact/${name}`, expiresAt: new Date(Date.now() + 60000).toISOString() })) });
    }
    if (url.includes('/artifact/')) return new Response(new Uint8Array(({ ...audioArtifacts, ...textArtifacts } as Record<string, Buffer>)[url.split('/').pop()!]!));
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return json(job);
  }) as unknown as typeof fetch;
  return { fetcher, calls, parts, loseResponse: () => { losePartResponse = true; } };
}

describe('remote desktop safety and durable imports', () => {
  it('defaults local and never stores or returns a raw token through generic settings', () => {
    const f = fixture(); f.db.prepare('DELETE FROM remote_configuration').run();
    expect(f.coordinator.usesRemote()).toBe(false); expect(() => f.coordinator.start('meeting-fixture')).toThrow();
    expect(JSON.stringify(f.ctx.settings.getAll())).not.toContain(token);
    expect(JSON.stringify(f.coordinator.configuration())).not.toContain(token);
    const row = f.db.prepare('SELECT ciphertext FROM remote_credentials').get() as { ciphertext: Buffer };
    expect(row.ciphertext.toString()).not.toContain(token);
    expect(new RemoteCredentials(f.db, { ...fakeKeychain, isEncryptionAvailable: () => false }, 'darwin').set.bind(null, '', '', token)).toThrow();
    expect(() => new RemoteCredentials(f.db, fakeKeychain, 'linux').get('', '')).toThrow();
  });
  it('pins offline intent and excludes it from local crash recovery', () => {
    const f = fixture(), id = f.coordinator.start('meeting-fixture');
    const snapshot = f.repo.get(id)!;
    f.repo.saveConfiguration({ mode: 'local', endpoint: 'https://new-server.example', capabilities: null, testedAt: null });
    expect(f.repo.get(id)!.configuration).toEqual(snapshot.configuration);
    const enqueue = vi.fn(); recoverPendingMeetings({ meetings: f.ctx.meetings, enqueue, logger: f.ctx.logger, isRemote: id => f.coordinator.isRemote(id) });
    expect(f.ctx.meetings.findById('meeting-fixture')!.status).toBe('processing'); expect(enqueue).not.toHaveBeenCalled();
  });
  it.each(['summary', 'title', 'action', 'speaker', 'speaker-rename', 'delete', 'rerun'])('fences late text import after %s mutation', (mutation) => {
    const f = fixture(), id = stage(f);
    if (mutation === 'summary') durableWrite(path.join(f.importer.folder('meeting-fixture'), 'summary.md'), 'User edit');
    if (mutation === 'title') { f.ctx.meetings.updateTitle('meeting-fixture', 'Edit'); f.ctx.meetings.updateTitle('meeting-fixture', 'Synthetic meeting'); }
    if (mutation === 'action') f.ctx.actionItems.create('meeting-fixture', { text: 'My task' });
    if (mutation === 'speaker') { const s = f.ctx.speakers.create({ displayName: 'Alice' }); f.ctx.speakers.linkToMeeting('meeting-fixture', 'SPEAKER_00', s, 1); }
    if (mutation === 'speaker-rename') {
      const s = f.ctx.speakers.create({ displayName: 'Alice' }); f.ctx.speakers.linkToMeeting('meeting-fixture', 'SPEAKER_00', s, 1);
      f.repo.patch(id, { expected: f.importer.fingerprint('meeting-fixture') }); f.ctx.speakers.rename(s, 'Alicia');
    }
    if (mutation === 'delete') { f.coordinator.cancel('meeting-fixture', true); f.ctx.meetings.softDelete('meeting-fixture'); }
    if (mutation === 'rerun') { f.coordinator.cancel('meeting-fixture'); f.coordinator.start('meeting-fixture'); }
    expect(f.importer.publish(id).status).toBe('conflict');
    expect(f.ctx.actionItems.listByMeeting('meeting-fixture').some(i => i.text === 'Verify result')).toBe(false);
    if (mutation === 'summary') expect(fs.readFileSync(path.join(f.importer.folder('meeting-fixture'), 'summary.md'), 'utf8')).toBe('User edit');
  });
  it('reviews both outputs, rejects edits made during review, preserves displaced content and imports once', () => {
    const f = fixture(), id = stage(f), summaryPath = path.join(f.importer.folder('meeting-fixture'), 'summary.md');
    durableWrite(summaryPath, 'User edit'); f.importer.publish(id);
    const first = f.importer.review('meeting-fixture'); expect(first.summary).toContain('Verify result');
    durableWrite(summaryPath, 'Another edit');
    expect(() => f.coordinator.resolve('meeting-fixture', id, true, first.localFingerprint)).toThrow('changed during review');
    const review = f.importer.review('meeting-fixture'); f.coordinator.resolve('meeting-fixture', id, true, review.localFingerprint);
    expect(fs.readFileSync(path.join(review.generation, 'previous-summary.md'), 'utf8')).toBe('Another edit');
    const items = f.ctx.actionItems.listByMeeting('meeting-fixture'); expect(items[0]?.ownerName).toBe('Alice');
    expect(f.importer.publish(id).status).toBe('already-imported'); expect(f.ctx.actionItems.listByMeeting('meeting-fixture')).toEqual(items);
    expect(f.repo.claimEffect(id, 'completion')).toBe(true); expect(f.repo.claimEffect(id, 'completion')).toBe(false);
  });
  it('replays a partially materialized audio generation after DB reopen without duplicate import', () => {
    const f = fixture(), id = stage(f, 'audio_analysis');
    const failing = new RemoteImporter(f.repo, f.ctx, () => { throw new Error('simulated crash'); });
    expect(() => failing.publish(id)).toThrow('simulated crash'); f.db.close();
    const recovered = fixture(f.dir); recovered.importer.replay();
    expect(recovered.repo.get(id)!.phase).toBe('needs_speaker_names');
    expect(recovered.ctx.speakers.listForMeeting('meeting-fixture')).toHaveLength(1);
    recovered.importer.replay(); expect(recovered.ctx.speakers.listForMeeting('meeting-fixture')).toHaveLength(1);
    expect(fs.readFileSync(path.join(recovered.importer.folder('meeting-fixture'), 'transcript.md'), 'utf8')).toContain('Synthetic review');
  });
  it('does not replay over an external edit after a crash', () => {
    const f = fixture(), id = stage(f);
    expect(() => new RemoteImporter(f.repo, f.ctx, () => { throw new Error('crash'); }).publish(id)).toThrow();
    durableWrite(path.join(f.importer.folder('meeting-fixture'), 'summary.md'), 'Post-crash edit');
    f.importer.replay(); expect(f.repo.get(id)!.phase).toBe('conflict');
    expect(fs.readFileSync(path.join(f.importer.folder('meeting-fixture'), 'summary.md'), 'utf8')).toBe('Post-crash edit');
  });
  it('does not match legacy vectors; verified identical provenance can match; zero vectors remain unknown', () => {
    const f = fixture(), id = stage(f, 'audio_analysis');
    const speaker = f.ctx.speakers.create({ displayName: 'Alice' });
    f.importer.publish(id); expect(f.ctx.speakers.listForMeeting('meeting-fixture')[0]?.rosterSpeakerId).toBeNull();
    f.coordinator.confirmSpeaker('meeting-fixture', 'SPEAKER_00', speaker);
    const diar = JSON.parse(audioArtifacts.diarization.toString());
    const embeddings = new RemoteEmbeddings(f.db);
    expect(embeddings.match(diar, 'SPEAKER_00')?.id).toBe(speaker);
    expect(embeddings.match({ ...diar, embeddingIdentity: { ...identity, revision: 'different' } }, 'SPEAKER_00')).toBeNull();
    diar.segments[0].embedding = [0, 0, 0]; expect(embeddings.match(diar, 'SPEAKER_00')).toBeNull();
  });
  it.each([false, true])('uses speaker identity across swapped labels and removes obsolete active clusters (crash replay: %s)', (crash) => {
    const f = fixture(), r = speakerRerun(f);
    // Submission/staging never erases the previous assignments or artifacts.
    expect(f.ctx.speakers.listForMeeting('meeting-fixture')).toEqual(r.oldLinks);
    if (crash) {
      expect(() => new RemoteImporter(f.repo, f.ctx, () => { throw new Error('crash'); }).publish(r.second)).toThrow('crash');
      f.db.close();
    } else expect(f.importer.publish(r.second).status).toBe('imported');
    const active = crash ? fixture(f.dir) : f;
    active.importer.replay();
    const links = active.ctx.speakers.listForMeeting('meeting-fixture');
    expect(links.map(s => [s.localLabel, s.rosterSpeakerId, s.displayName])).toEqual([
      ['SPEAKER_00', r.people[1], 'Bob'], ['SPEAKER_01', r.people[0], 'Alice'],
      ['SPEAKER_03', null, null], ['SPEAKER_04', null, null],
    ]);
    const transcript = fs.readFileSync(path.join(r.folder, 'transcript.md'), 'utf8');
    expect(transcript).toContain('[Bob 00:00] Bob now speaks first.');
    expect(transcript).toContain('[Alice 00:03] Alice now speaks second.');
    expect(transcript).not.toMatch(/Charlie|Dana/);
    const generation = path.join(r.folder, '.remote-generations', r.second);
    expect(JSON.parse(fs.readFileSync(path.join(generation, 'previous-database.json'), 'utf8')).speakers).toEqual(r.oldLinks);
    expect(fs.readFileSync(path.join(generation, 'previous-diarization.json'))).toEqual(r.firstArtifacts.diarization);
    expect(fs.readFileSync(path.join(generation, 'previous-transcript.md'), 'utf8')).toBe(r.oldTranscript);
    expect(fs.readFileSync(path.join(r.folder, '.remote-generations', r.first, 'diarization.json'))).toEqual(r.firstArtifacts.diarization);
    expect(active.ctx.speakers.list()).toHaveLength(4);
    expect(active.db.prepare('SELECT * FROM remote_roster_embeddings ORDER BY speaker_id').all()).toEqual(r.vectors);
    const revision = active.db.prepare('SELECT revision FROM remote_revisions WHERE meeting_id=?').get('meeting-fixture');
    expect(active.importer.publish(r.second).status).toBe('already-imported'); active.importer.replay();
    expect(active.ctx.speakers.listForMeeting('meeting-fixture')).toEqual(links);
    expect(active.db.prepare('SELECT revision FROM remote_revisions WHERE meeting_id=?').get('meeting-fixture')).toEqual(revision);
    const textRun = active.coordinator.continueFromSpeakerId('meeting-fixture');
    expect(JSON.parse(fs.readFileSync(active.repo.get(textRun)!.sourcePath, 'utf8')).transcript).toBe(transcript);
  });
  it('fences speaker edits after analysis submission and preserves them as evidence on explicit replacement', () => {
    const f = fixture(), r = speakerRerun(f);
    f.ctx.speakers.linkToMeeting('meeting-fixture', 'SPEAKER_00', r.people[2]!, 1);
    expect(f.importer.publish(r.second).status).toBe('conflict');
    const editedLinks = f.ctx.speakers.listForMeeting('meeting-fixture');
    expect(editedLinks[0]?.displayName).toBe('Charlie');
    expect(fs.readFileSync(path.join(r.folder, 'transcript.md'), 'utf8')).toBe(r.oldTranscript);
    const stale = f.importer.review('meeting-fixture');
    f.ctx.speakers.rename(r.people[2]!, 'Charles');
    expect(() => f.coordinator.resolve('meeting-fixture', r.second, true, stale.localFingerprint)).toThrow('changed during review');
    const beforeReplace = f.ctx.speakers.listForMeeting('meeting-fixture');
    const review = f.importer.review('meeting-fixture');
    f.coordinator.resolve('meeting-fixture', r.second, true, review.localFingerprint);
    expect(f.ctx.speakers.listForMeeting('meeting-fixture').map(s => s.displayName)).toEqual(['Bob', 'Alice', null, null]);
    expect(JSON.parse(fs.readFileSync(path.join(review.generation, 'previous-database.json'), 'utf8')).speakers).toEqual(beforeReplace);
    expect(f.db.prepare('SELECT * FROM remote_roster_embeddings ORDER BY speaker_id').all()).toEqual(r.vectors);
    expect(f.importer.publish(r.second).status).toBe('already-imported');
  });
  it('does not replay new analysis over speaker edits after a partial publication', () => {
    const f = fixture(), r = speakerRerun(f);
    expect(() => new RemoteImporter(f.repo, f.ctx, () => { throw new Error('crash'); }).publish(r.second)).toThrow('crash');
    f.ctx.speakers.linkToMeeting('meeting-fixture', 'SPEAKER_00', r.people[2]!, 1);
    f.importer.replay();
    expect(f.repo.get(r.second)!.phase).toBe('conflict');
    expect(f.ctx.speakers.listForMeeting('meeting-fixture')[0]?.displayName).toBe('Charlie');
    expect(fs.readFileSync(path.join(r.folder, 'transcript.md'), 'utf8')).toBe(r.oldTranscript);
    expect(fs.readFileSync(path.join(r.folder, 'transcript.raw.json'))).toEqual(r.firstArtifacts.transcription);
  });
  it('keeps manual names and pins text settings while creating a separate bounded object', () => {
    const f = fixture(), audio = stage(f, 'audio_analysis'); f.importer.publish(audio);
    const speaker = f.ctx.speakers.create({ displayName: 'Alice' }); f.ctx.speakers.linkToMeeting('meeting-fixture', 'SPEAKER_00', speaker, 1);
    f.ctx.settings.set('summaryDetail', 'concise');
    const text = f.coordinator.continueFromSpeakerId('meeting-fixture'), run = f.repo.get(text)!;
    expect(text).not.toBe(audio); expect(run.summaryDetail).toBe('detailed'); expect(run.kind).toBe('text_generation');
    expect(JSON.parse(fs.readFileSync(run.sourcePath, 'utf8')).transcript).toContain('Alice');
    expect(f.coordinator.continueFromSpeakerId('meeting-fixture')).toBe(text); expect(f.inference).not.toHaveBeenCalled();
  });
  it('keeps committed local completion done during acknowledgement outage and never repeats an ambiguous effect', async () => {
    const f = fixture(undefined, (async () => { throw new Error('offline'); }) as typeof fetch), id = stage(f);
    f.importer.publish(id); const completion = vi.fn(async () => {}); f.coordinator.onComplete(completion);
    f.coordinator.startLifecycle();
    await vi.waitFor(() => expect(f.repo.get(id)!.error).toBe('OFFLINE_OR_CREDENTIALS'));
    expect(f.repo.get(id)!.phase).toBe('done'); expect(f.ctx.meetings.findById('meeting-fixture')!.status).toBe('done');
    expect(completion).toHaveBeenCalledTimes(1);
    await expect(f.coordinator.step(id)).rejects.toThrow('offline'); expect(completion).toHaveBeenCalledTimes(1);
  });
  it('skip naming creates text intent locally even when acknowledgement is offline', async () => {
    const f = fixture(undefined, (async () => { throw new Error('offline'); }) as typeof fetch), id = stage(f, 'audio_analysis');
    f.importer.publish(id); f.ctx.meetings.updateSkipSpeakerId('meeting-fixture', true);
    await expect(f.coordinator.step(id)).rejects.toThrow('offline');
    expect(f.repo.current('meeting-fixture')!.kind).toBe('text_generation'); expect(f.inference).not.toHaveBeenCalled();
  });
  it.each(['continue', 'skip', 'rerun', 'retry'] as const)('notifies once per remote analysis and re-enables native eligibility after %s', async (transition) => {
    const f = fixture(undefined, (async () => { throw new Error('offline'); }) as typeof fetch);
    const notified = new Set(['meeting-fixture']); // a previous local or remote entry
    const notifications: string[] = [];
    f.coordinator.onSpeakerGateReset(id => clearGateNotified(id, notified));
    f.coordinator.onAwaitingSpeakerId(id => { if (shouldNotifyGate(id, notified)) notifications.push(id); });
    const first = stage(f, 'audio_analysis');
    expect(notified.has('meeting-fixture')).toBe(false);
    f.importer.publish(first);
    for (let i = 0; i < 2; i++) await expect(f.coordinator.step(first)).rejects.toThrow('offline');
    expect(notifications).toHaveLength(1);
    // Duplicate Start/Retry of this parked run must not reset its eligibility.
    expect(f.coordinator.start('meeting-fixture')).toBe(first); f.coordinator.retry('meeting-fixture');
    expect(notified.has('meeting-fixture')).toBe(true);
    if (transition === 'continue') {
      f.coordinator.continueFromSpeakerId('meeting-fixture');
      expect(notified.has('meeting-fixture')).toBe(false);
    } else if (transition === 'skip') {
      f.ctx.meetings.updateSkipSpeakerId('meeting-fixture', true);
      await expect(f.coordinator.step(first)).rejects.toThrow('offline');
      expect(f.repo.current('meeting-fixture')!.kind).toBe('text_generation');
      expect(notified.has('meeting-fixture')).toBe(false);
      f.ctx.meetings.updateSkipSpeakerId('meeting-fixture', false);
    }
    if (transition === 'retry') {
      f.coordinator.cancel('meeting-fixture'); f.coordinator.retry('meeting-fixture');
    } else f.coordinator.rerun('meeting-fixture', 'transcribing');
    const second = f.repo.current('meeting-fixture')!.id;
    expect(second).not.toBe(first); expect(notified.has('meeting-fixture')).toBe(false);
    f.importer.stage(f.repo.get(second)!, 'c'.repeat(64), audioArtifacts); f.importer.publish(second);
    for (let i = 0; i < 2; i++) await expect(f.coordinator.step(second)).rejects.toThrow('offline');
    expect(notifications).toHaveLength(2);
    expect(f.db.prepare("SELECT run_id,state FROM remote_effects WHERE effect='speaker_gate' ORDER BY run_id").all())
      .toEqual([first, second].sort().map(run_id => ({ run_id, state: 'completed' })));
  });
});

describe('shared-contract transfers', () => {
  it.each(['fallback', 'rerun'])('fences a delayed status poll after %s before any local stage/status mutation', async (action) => {
    const s = server(); let delayed = false; let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = new Promise<void>(resolve => { entered = resolve; });
    const wrapped = (async (url: string | URL | Request, init?: RequestInit) => {
      const response = await s.fetcher(url, init);
      if (delayed && /\/v1\/jobs\/[a-f0-9-]+$/.test(String(url)) && init?.method === 'GET') {
        const job = await response.json(); entered(); await gate;
        return new Response(JSON.stringify({ ...job, phase: 'diarizing', state: 'failed', error: { code: 'TEST_FAILURE', retryable: false } }));
      }
      return response;
    }) as typeof fetch;
    const f = fixture(undefined, wrapped), id = f.coordinator.start('meeting-fixture'); await f.coordinator.step(id);
    delayed = true; const poll = f.coordinator.step(id); await pending;
    if (action === 'fallback') f.coordinator.fallback('meeting-fixture', () => { f.ctx.meetings.updateStage('meeting-fixture', 'extracting'); f.ctx.meetings.updateStatus('meeting-fixture', 'processing'); });
    else f.coordinator.rerun('meeting-fixture', 'transcribing');
    const expected = f.ctx.meetings.findById('meeting-fixture')!;
    release(); await expect(poll).rejects.toThrow('RUN_FENCED');
    expect(f.ctx.meetings.findById('meeting-fixture')!.pipelineStage).toBe(expected.pipelineStage);
    expect(f.ctx.meetings.findById('meeting-fixture')!.status).toBe(expected.status);
    expect(f.repo.get(id)!.phase).toBe('cancelled');
  });
  it('reconnects after token expiry without replacing or deleting an accepted job', async () => {
    const s = server(); let unauthorized = false;
    const wrapped = (async (url: string | URL | Request, init?: RequestInit) => unauthorized
      ? new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Reconnect', retryable: false, requestId: 'test' } }), { status: 401 })
      : s.fetcher(url, init)) as typeof fetch;
    const f = fixture(undefined, wrapped), id = f.coordinator.start('meeting-fixture'); await f.coordinator.step(id);
    const accepted = f.repo.get(id)!; unauthorized = true; f.repo.patch(id, { nextAttempt: 0 }); f.coordinator.startLifecycle();
    await vi.waitFor(() => expect(f.repo.get(id)!.phase).toBe('reconnect_required'));
    expect(f.ctx.meetings.findById('meeting-fixture')!.status).toBe('processing');
    f.credentials.set(accepted.configuration.endpoint, accepted.configuration.ownerId, 'rotated-test-token-00000000000000000000000000');
    unauthorized = false; f.coordinator.retry('meeting-fixture'); await f.coordinator.step(id);
    const resumed = f.repo.current('meeting-fixture')!;
    expect(resumed.id).toBe(id); expect(resumed.jobId).toBe(accepted.jobId); expect(resumed.request).toEqual(accepted.request);
    expect(resumed.sourcePath).toBe(accepted.sourcePath); expect(resumed.deleteRequested).toBe(false);
    expect(s.calls.filter(c => c.url.endsWith('/v1/jobs'))).toHaveLength(1);
    expect(s.calls.some(c => c.url.endsWith('/cancellation') || c.init?.method === 'DELETE')).toBe(false);
  });
  it('reconciles an accepted part after lost response and restart without uploading it twice', async () => {
    const s = server(), f = fixture(undefined, s.fetcher), id = f.coordinator.start('meeting-fixture'); s.loseResponse();
    await expect(f.coordinator.step(id)).rejects.toThrow('Connection lost'); f.db.close();
    const recovered = fixture(f.dir, s.fetcher); await recovered.coordinator.step(id); await recovered.coordinator.step(id);
    expect(s.calls.filter(c => c.url.includes('/part/'))).toHaveLength(1);
    expect(recovered.repo.get(id)!.phase).toBe('needs_speaker_names'); expect(recovered.inference).not.toHaveBeenCalled();
  });
  it('detects source changes before any job creation', async () => {
    const s = server(), f = fixture(undefined, s.fetcher), id = f.coordinator.start('meeting-fixture');
    durableWrite(path.join(f.dir, 'source.m4a'), 'mutated');
    await expect(f.coordinator.step(id)).rejects.toThrow('SOURCE_CHANGED'); expect(s.calls.some(c => c.url.endsWith('/v1/jobs'))).toBe(false);
  });
  it('rejects server identity changes and never sends the token to object storage', async () => {
    const s = server(), f = fixture(undefined, s.fetcher), id = f.coordinator.start('meeting-fixture');
    f.repo.patch(id, { configuration: { ...f.repo.get(id)!.configuration, ownerId: 'different-owner' } });
    f.credentials.set('http://127.0.0.1:58800', 'different-owner', token);
    await expect(f.coordinator.step(id)).rejects.toThrow('SERVER_IDENTITY');
    expect(s.calls).toHaveLength(1);
  });
  it('rotates same-owner credentials without redirecting an existing endpoint snapshot', async () => {
    const s = server(), f = fixture(undefined, s.fetcher), id = f.coordinator.start('meeting-fixture');
    const rotated = 'rotated-test-token-00000000000000000000000000';
    f.credentials.set('http://127.0.0.1:58800', 'test-owner', rotated);
    f.repo.saveConfiguration({ mode: 'remote', endpoint: 'https://different.example', capabilities, testedAt: new Date().toISOString() });
    await f.coordinator.step(id);
    expect(s.calls[0]!.url).toBe('http://127.0.0.1:58800/v1/capabilities');
    expect(new Headers(s.calls[0]!.init?.headers).get('Authorization')).toBe(`Bearer ${rotated}`);
    expect(s.calls.some(c => c.url.includes('different.example'))).toBe(false);
  });
  it('fences before local fallback and keeps server cleanup pending while offline', () => {
    const f = fixture(), id = f.coordinator.start('meeting-fixture');
    const local = vi.fn(() => { expect(f.repo.get(id)!.active).toBe(false); expect(f.repo.get(id)!.deleteRequested).toBe(true); });
    f.coordinator.fallback('meeting-fixture', local); expect(local).toHaveBeenCalledOnce(); expect(f.coordinator.isRemote('meeting-fixture')).toBe(false);
  });
  it('rejects unsafe transfer URLs and manifests before consuming data', async () => {
    for (const url of ['file:///etc/passwd', 'http://example.com/data', 'https://user:pass@example.com', 'data:text/plain,test']) expect(() => safeTransferUrl(url)).toThrow();
    const client = new RemoteClient('https://example.com', () => token, new AbortController().signal, false,
      (async () => new Response(JSON.stringify({ manifest: { jobId: '../escape' } }))) as typeof fetch);
    await expect(client.result(randomUUID(), {} as RemoteCreateJob)).rejects.toThrow('INVALID_SERVER_RESPONSE');
    const large = new RemoteClient('https://example.com', () => token, new AbortController().signal, false,
      (async () => new Response('x'.repeat(100001))) as typeof fetch);
    await expect(large.capabilities()).rejects.toThrow('RESPONSE_TOO_LARGE');
  });
  it('fences a delete delivered while a download is awaiting the network', async () => {
    const s = server(); let f: ReturnType<typeof fixture>;
    const wrapped = (async (url: string | URL | Request, init?: RequestInit) => {
      const result = await s.fetcher(url, init);
      if (String(url).includes('/artifact/')) f.coordinator.cancel('meeting-fixture', true);
      return result;
    }) as typeof fetch;
    f = fixture(undefined, wrapped); const id = f.coordinator.start('meeting-fixture'); await f.coordinator.step(id);
    await expect(f.coordinator.step(id)).rejects.toThrow('RUN_FENCED');
    expect(fs.existsSync(path.join(f.importer.folder('meeting-fixture'), 'transcript.md'))).toBe(false);
  });
});

describe.skipIf(process.env.REMOTE_DESKTOP_INTEGRATION !== '1')('real synthetic API + S3 desktop integration', () => {
  it('completes audio, restart, naming, text, acknowledgement and deletion without local inference', async () => {
    const f = fixture(undefined, fetch);
    await f.coordinator.test('http://127.0.0.1:58800', token); f.coordinator.setMode('remote');
    const audio = f.coordinator.start('meeting-fixture'); await f.coordinator.step(audio); f.db.close();
    const recovered = fixture(f.dir, fetch);
    const until = async (id: string, target: string) => {
      for (let n = 0; n < 60; n++) {
        await recovered.coordinator.step(id);
        const run = recovered.repo.get(id)!;
        if (run.phase === target) return;
        if (run.phase === 'failed') throw new Error(run.error ?? 'Remote failure');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error(`Timed out waiting for ${target}`);
    };
    try {
      await until(audio, 'needs_speaker_names');
      const speaker = recovered.ctx.speakers.create({ displayName: 'Synthetic Alice' });
      const label = recovered.ctx.speakers.listForMeeting('meeting-fixture')[0]!.localLabel;
      recovered.ctx.speakers.linkToMeeting('meeting-fixture', label, speaker, 1);
      recovered.coordinator.confirmSpeaker('meeting-fixture', label, speaker);
      const text = recovered.coordinator.continueFromSpeakerId('meeting-fixture');
      expect(JSON.parse(fs.readFileSync(recovered.repo.get(text)!.sourcePath, 'utf8')).transcript).toContain('Synthetic Alice');
      await until(text, 'done'); await recovered.coordinator.step(text);
      expect(recovered.ctx.meetings.findById('meeting-fixture')!.status).toBe('done');
      expect(recovered.ctx.actionItems.listByMeeting('meeting-fixture').length).toBeGreaterThan(0);
      expect(recovered.repo.get(text)!.acknowledged).toBe(true); expect(recovered.inference).not.toHaveBeenCalled();
    } finally {
      recovered.coordinator.cancel('meeting-fixture', true);
      for (const run of recovered.repo.all()) await recovered.coordinator.step(run.id);
    }
  }, 90_000);
});
