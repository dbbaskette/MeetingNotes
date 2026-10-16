// Physical Mac, disposable synthetic library only. No installed app/meeting access.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { openDb } from '../../dist/electron/main/storage/db.js';
import { SettingsRepo } from '../../dist/electron/main/storage/settings-repo.js';
import { MeetingsRepo } from '../../dist/electron/main/storage/meetings-repo.js';
import { SpeakersRepo } from '../../dist/electron/main/storage/speakers-repo.js';
import { ActionItemsRepo } from '../../dist/electron/main/storage/action-items-repo.js';
import { StageDurationsRepo } from '../../dist/electron/main/storage/stage-durations-repo.js';
import { TerminologyRepo } from '../../dist/electron/main/storage/terminology-repo.js';
import { TerminologyService } from '../../dist/electron/main/terminology/service.js';
import { RosterService } from '../../dist/electron/main/speakers/roster-service.js';
import { embeddingForLabel } from '../../dist/electron/main/speakers/sample-extractor.js';
import { ArtifactCache } from '../../dist/electron/main/library/artifact-cache.js';
import { Pipeline } from '../../dist/electron/main/pipeline/pipeline.js';
import { runTranscribing } from '../../dist/electron/main/pipeline/stages/transcribing.js';
import { runDiarizing } from '../../dist/electron/main/pipeline/stages/diarizing.js';
import { runMerging } from '../../dist/electron/main/pipeline/stages/merging.js';
import { runIdentifying } from '../../dist/electron/main/pipeline/stages/identifying.js';
import { runSummarizing } from '../../dist/electron/main/pipeline/stages/summarizing.js';
import { runExtracting } from '../../dist/electron/main/pipeline/stages/extracting.js';
import { MarkdownExporter } from '../../dist/electron/main/exporters/markdown.js';
import { NativeSpeechService } from '../../dist/electron/main/speech/service.js';
import { SPEAKER_REVISION } from '../../dist/electron/main/speech/client.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-native-full-smoke-'));
const output = path.resolve('speech-benchmark-results/integrated'); fs.mkdirSync(output, { recursive: true });
const helper = process.argv.find(arg => arg.startsWith('--helper='))?.slice(9) ?? path.resolve('speech-engine/.build/release/meeting-notes-speech');
const models = path.resolve('speech-benchmark-results/synthetic-smoke/models', SPEAKER_REVISION);
const nativeSpeech = new NativeSpeechService(helper, models);
let db;
try {
  const health = await nativeSpeech.status('en'); assert(health.appleReady && health.speakerReady, 'Prepare explicit synthetic-smoke assets first');
  const aiff = path.join(root, 'speech.aiff'), audio = path.join(root, 'speech.m4a');
  execFileSync('/usr/bin/say', ['-v', 'Samantha', '-r', '170', '-o', aiff, 'We approved the release, but do not delete the backup. Keith will review the security report on Friday.']);
  execFileSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-i', aiff, '-c:a', 'aac', '-b:a', '128k', audio]);
  db = openDb(path.join(root, 'db.sqlite'));
  const settings = new SettingsRepo(db);
  const meetings = new MeetingsRepo(db), speakers = new SpeakersRepo(db), roster = new RosterService(speakers, root);
  const id = 'synthetic', folder = path.join(root, 'meetings', id); fs.mkdirSync(folder, { recursive: true });
  meetings.insert({ id, slug: id, title: 'Native integration check', startedAt: null, durationS: 8, audioPath: audio, status: 'processing', pipelineStage: 'discovered' });
  const artifactCache = new ArtifactCache(), actionItems = new ActionItemsRepo(db);
  const terminology = new TerminologyService(new TerminologyRepo(db), { libraryRoot: root, meetings, speakers, artifactCache, userName: () => '' });
  let legacyStarts = 0, chats = 0;
  const forbidden = async () => { legacyStarts++; throw new Error('Legacy service used on native path'); };
  const ctx = { libraryRoot: root, meetings, speakers, roster, settings, nativeSpeech, artifactCache, terminology, actionItems,
    stageDurations: new StageDurationsRepo(db), whisperSupervisor: { ensureReady: forbidden }, diarSupervisor: { ensureReady: forbidden },
    llmSupervisor: { ensureReady: async () => {} },
    lmStudio: { chat: async () => ++chats === 1 ? '## Overview\nRelease approved; keep the backup.\n\n## Action Items\n- Keith will review the security report on Friday.'
      : '[{"text":"Review the security report","owner":"Keith","due_date":null}]' },
    logger: { info() {}, warn() {}, error() {} } };
  const pipeline = new Pipeline({ ctx, stages: { transcribing: runTranscribing, diarizing: runDiarizing, merging: runMerging,
    identifying: runIdentifying, summarizing: runSummarizing, extracting: runExtracting } });
  const started = performance.now(); await pipeline.run(id);
  assert.equal(meetings.findById(id).status, 'awaiting_user');
  const diar = JSON.parse(fs.readFileSync(path.join(folder, 'diarization.json'), 'utf8'));
  const label = diar.segments[0]?.speaker; assert(label, 'SpeakerKit produced a voice');
  const embedding = embeddingForLabel(diar, label); assert(embedding, 'SpeakerKit produced a trainable centroid');
  const person = roster.confirmSpeaker({ displayName: 'Synthetic speaker', embedding }, diar.embeddingSpace);
  speakers.linkToMeeting(id, label, person, 1);
  await runMerging({ meetingId: id }, ctx);
  meetings.updateStage(id, 'summarizing'); meetings.updateStatus(id, 'processing');
  await pipeline.run(id);
  assert.equal(meetings.findById(id).status, 'done'); assert.equal(legacyStarts, 0);
  const transcript = fs.readFileSync(path.join(folder, 'transcript.md'), 'utf8');
  assert.match(transcript, /backup/i); assert.match(transcript, /Synthetic speaker/);
  const suggestions = roster.suggestionsFor({ label: 'future', embedding }, 3, diar.embeddingSpace);
  assert.equal(suggestions[0].id, person); assert.equal(suggestions[0].scoreKind, 'similarity');
  const items = actionItems.listByMeeting(id); assert.equal(items.length, 1);
  const exported = await new MarkdownExporter().export({ meetingTitle: 'Native integration check', meetingFolder: folder,
    summaryMd: fs.readFileSync(path.join(folder, 'summary.md'), 'utf8'), items });
  assert.match(fs.readFileSync(exported, 'utf8'), /Review the security report/);
  const result = { testedAt: new Date().toISOString(), helper, platform: process.platform, arch: process.arch, osRelease: os.release(),
    elapsedMs: Math.round(performance.now() - started), status: 'done', legacyStarts, transcriptLines: transcript.split('\n').length,
    trainedProfiles: 1, speakerCount: diar.num_speakers, items: items.length, export: 'Markdown',
    limitations: 'Synthetic AAC audio; real Apple and SpeakerKit inference and full stable pipeline. Summary responses are deterministic fixtures, not real LLM inference. No live capture, private meetings, signed-in exports or PDF runtime acceptance.' };
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { nativeSpeech.close(); db?.close(); fs.rmSync(root, { recursive: true, force: true }); }
