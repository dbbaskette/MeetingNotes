import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../storage/db.js';
import { SettingsRepo } from '../storage/settings-repo.js';
import { SpeakersRepo } from '../storage/speakers-repo.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
import { ActionItemsRepo } from '../storage/action-items-repo.js';
import { StageDurationsRepo } from '../storage/stage-durations-repo.js';
import { RosterService } from '../speakers/roster-service.js';
import { VoiceProfiles } from '../speakers/voice-profiles.js';
import { embeddingForLabel } from '../speakers/sample-extractor.js';
import { ArtifactCache } from '../library/artifact-cache.js';
import { TerminologyRepo } from '../storage/terminology-repo.js';
import { TerminologyService } from '../terminology/service.js';
import { Pipeline } from '../pipeline/pipeline.js';
import type { PipelineContext } from '../pipeline/context.js';
import { runTranscribing } from '../pipeline/stages/transcribing.js';
import { runDiarizing } from '../pipeline/stages/diarizing.js';
import { runMerging } from '../pipeline/stages/merging.js';
import { runIdentifying } from '../pipeline/stages/identifying.js';
import { runSummarizing } from '../pipeline/stages/summarizing.js';
import { runExtracting } from '../pipeline/stages/extracting.js';
import { MarkdownExporter } from '../exporters/markdown.js';
import { selectSpeech } from './selection.js';
import { clearArtifactsFromStage } from '../pipeline/clear-artifacts.js';
import { supportsNativeSpeech } from './service.js';

let root: string, db: ReturnType<typeof openDb>, settings: SettingsRepo, speakers: SpeakersRepo,
  meetings: MeetingsRepo, roster: RosterService, folder: string;
const space = 'speakerkit:model-a:raw';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-native-integration-'));
  db = openDb(path.join(root, 'db.sqlite')); settings = new SettingsRepo(db);
  speakers = new SpeakersRepo(db); meetings = new MeetingsRepo(db); roster = new RosterService(speakers, root);
  meetings.insert({ id: 'm', slug: 'm', title: 'Review', startedAt: null, durationS: 8, audioPath: '/synthetic.m4a', status: 'processing', pipelineStage: 'discovered' });
  folder = path.join(root, 'meetings', 'm'); fs.mkdirSync(folder, { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const file = (name: string) => path.join(folder, name);
const words = ['Keith', 'will', 'review', 'Salsa', 'compliance.'].map((text, i) => ({ start: i, end: i + 0.9, text }));
it('defaults only genuinely fresh supported installations to native speech', () => {
  // The fixture's preexisting meeting marks this as an upgrade, even with no
  // settings rows. Removing it simulates a genuinely new installation.
  settings.initializeSpeechProvider(true); expect(settings.get('speechProvider')).toBe('legacy');
  db.exec('DELETE FROM settings; DELETE FROM meetings');
  settings.initializeSpeechProvider(true); expect(settings.get('speechProvider')).toBe('native');
  settings.initializeSpeechProvider(false); expect(settings.get('speechProvider')).toBe('native');
  db.exec('DELETE FROM settings'); settings.set('sttUrl', 'http://localhost:9090');
  settings.initializeSpeechProvider(true); expect(settings.get('speechProvider')).toBe('legacy');
  expect(settings.get('sttUrl')).toBe('http://localhost:9090');
});
it('uses native processing, human review, shared terminology, notes, tasks and export end to end', async () => {
  settings.set('speechProvider', 'native');
  const legacyId = roster.confirmSpeaker({ displayName: 'Keith', embedding: [0, 1] });
  const nativeSpeech = { transcribe: vi.fn(async () => ({ text: 'Keith will review Salsa compliance.', segments: words, provider: 'apple' })),
    diarize: vi.fn(async () => ({ segments: [{ start: 0, end: 6, speaker: 'SPEAKER_00' }], centroids: { SPEAKER_00: [1, 0] }, embeddingSpace: space, num_speakers: 1 })) };
  const forbidden = vi.fn(async () => { throw new Error('Legacy server must not start'); });
  const terminology = new TerminologyService(new TerminologyRepo(db), { libraryRoot: root, meetings, speakers, artifactCache: new ArtifactCache(), userName: () => '' });
  terminology.repo.save({ source: 'Salsa compliance', replacement: 'SLSA compliance', groupId: null, enabled: true, mode: 'automatic', caseSensitive: false });
  const ctx = { libraryRoot: root, meetings, speakers, roster, settings, nativeSpeech, terminology,
    artifactCache: new ArtifactCache(), actionItems: new ActionItemsRepo(db), stageDurations: new StageDurationsRepo(db),
    whisperSupervisor: { ensureReady: forbidden }, diarSupervisor: { ensureReady: forbidden }, llmSupervisor: { ensureReady: async () => {} },
    lmStudio: { chat: vi.fn().mockResolvedValueOnce('## Overview\nSLSA compliance review.\n\n## Action Items\n- Keith will review SLSA compliance.')
      .mockResolvedValueOnce('[{"text":"Review SLSA compliance","owner":"Keith","due_date":null}]') },
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as PipelineContext;
  // Numeric labels from a previous run must not retain their old assignment.
  speakers.linkToMeeting('m', 'SPEAKER_00', legacyId, 1);
  const pipeline = new Pipeline({ ctx, stages: { transcribing: runTranscribing, diarizing: runDiarizing, merging: runMerging,
    identifying: runIdentifying, summarizing: runSummarizing, extracting: runExtracting } });
  await pipeline.run('m');
  expect(meetings.findById('m')?.status).toBe('awaiting_user');
  expect(speakers.listForMeeting('m')[0]?.rosterSpeakerId).toBeNull();
  expect(forbidden).not.toHaveBeenCalled();
  expect(fs.readFileSync(file('transcript.md'), 'utf8')).toContain('SLSA compliance');
  expect(fs.readFileSync(file('transcript.md'), 'utf8').split('\n')).toHaveLength(1);
  expect(fs.readFileSync(file('transcript.raw.json'), 'utf8')).toContain('Salsa');
  const id = roster.confirmSpeaker({ displayName: 'Keith', embedding: [1, 0] }, space);
  expect(id).toBe(legacyId); expect(roster.loadEmbedding(id)).toEqual([0, 1]);
  speakers.linkToMeeting('m', 'SPEAKER_00', id, 1);
  await runMerging({ meetingId: 'm' }, ctx);
  meetings.updateStage('m', 'summarizing'); meetings.updateStatus('m', 'processing');
  await pipeline.run('m');
  expect(meetings.findById('m')?.status).toBe('done');
  expect(fs.readFileSync(file('transcript.md'), 'utf8')).toContain('[Keith 00:00]');
  const items = ctx.actionItems.listByMeeting('m'); expect(items).toHaveLength(1);
  const exported = await new MarkdownExporter().export({ meetingTitle: 'Review', meetingFolder: folder, items,
    summaryMd: fs.readFileSync(file('summary.md'), 'utf8') });
  expect(fs.readFileSync(exported, 'utf8')).toContain('Review SLSA compliance');
  expect(roster.suggestionsFor({ label: 'next', embedding: [1, 0] }, 3, space)[0]).toMatchObject({ id, scoreKind: 'similarity' });
  expect(roster.identifyUnknowns([{ label: 'next', embedding: [1, 0] }], space)[0]?.rosterId).toBeNull();
});
it('isolates equal-dimension vectors by model and retains legacy files', () => {
  const id = roster.confirmSpeaker({ displayName: 'Dan', embedding: [1, 0] });
  expect(roster.suggestionsFor({ label: 'x', embedding: [1, 0] }, 3, space)).toEqual([]);
  roster.confirmSpeakerFor(id, [0, 1], space);
  expect(roster.loadEmbedding(id)).toEqual([1, 0]);
  expect(roster.suggestionsFor({ label: 'x', embedding: [0, 1] }, 3, 'other-model')).toEqual([]);
  expect(new VoiceProfiles(root).load(space, id)).toEqual([0, 1]);
});
it('allows a name without a centroid and rejects unusable observations', () => {
  const id = roster.confirmSpeaker({ displayName: 'Quiet speaker', embedding: null }, space);
  roster.confirmSpeakerFor(id, [0, 0], space);
  expect(speakers.findById(id)?.displayName).toBe('Quiet speaker');
  expect(new VoiceProfiles(root).load(space, id)).toBeNull();
  for (const vector of [[0, 0], [NaN, 1], []]) expect(embeddingForLabel({ segments: [], centroids: { x: vector }, embeddingSpace: space }, 'x')).toBeNull();
});
it('keeps the selected engine across recovery until explicit upstream reprocessing', () => {
  settings.set('speechProvider', 'native');
  expect(selectSpeech(folder, settings).provider).toBe('native');
  settings.set('speechProvider', 'legacy'); settings.set('sttLanguage', 'fr');
  expect(selectSpeech(folder, settings)).toMatchObject({ provider: 'native', language: 'en' });
  clearArtifactsFromStage(folder, 'transcribing', new ArtifactCache());
  expect(selectSpeech(folder, settings)).toMatchObject({ provider: 'legacy', language: 'fr' });
});
it('only offers native speech on supported Apple silicon systems', () => {
  expect(supportsNativeSpeech('darwin', 'arm64', '25.0.0')).toBe(true);
  expect(supportsNativeSpeech('darwin', 'arm64', '24.0.0')).toBe(false);
  expect(supportsNativeSpeech('darwin', 'x64', '25.0.0')).toBe(false);
  expect(supportsNativeSpeech('linux', 'arm64', '27.0.0')).toBe(false);
});
it('waits for the sibling speech worker after failure before releasing the meeting', async () => {
  let finish!: () => void;
  const sibling = new Promise<void>(resolve => { finish = resolve; });
  const ctx = { meetings, speakers, libraryRoot: root, artifactCache: new ArtifactCache(), logger: { info() {}, error() {} } } as unknown as PipelineContext;
  const noop = async () => {};
  const pipeline = new Pipeline({ ctx, stages: { transcribing: async () => { throw new Error('speech failed'); },
    diarizing: () => sibling, merging: noop, identifying: noop, summarizing: noop, extracting: noop } });
  let settled = false;
  const run = pipeline.run('m').catch(error => { settled = true; throw error; });
  await new Promise(resolve => setTimeout(resolve, 10)); expect(settled).toBe(false);
  finish(); await expect(run).rejects.toThrow('speech failed');
});
