// Physical-device smoke for the optional WhisperKit engine (#306). It downloads
// the pinned model (about 627 MB) into the folder you pass, so it is never part
// of CI. Synthetic speech is not a real-meeting accuracy benchmark.
// Usage: npm run build && npm run build:speech &&
//   ELECTRON_RUN_AS_NODE=1 electron scripts/speech-benchmark/whisperkit-smoke.mjs /absolute/model/parent
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SpeechClient, Transcript, Diarization, SPEAKER_REVISION } from '../../dist/electron/main/speech/client.js';
import { installSpeakerModels, modelsReady } from '../../dist/electron/main/speech/models.js';
import { installWhisperModels, whisperModelsReady, WHISPER_MODEL, WHISPER_REVISION } from '../../dist/electron/main/speech/whisper-models.js';
import { mergeTranscriptWithDiarization } from '../../dist/electron/main/lib/merge-transcript.js';

const parent = process.argv[2];
if (!parent || !path.isAbsolute(parent)) throw new Error('Pass an absolute folder for the downloaded models.');
const root = path.resolve('speech-benchmark-results/whisperkit-smoke');
fs.mkdirSync(root, { recursive: true });
const client = new SpeechClient(path.resolve('speech-engine/.build/release/meeting-notes-speech'), 30 * 60_000);
const controller = new AbortController();

const whisper = path.join(parent, 'whisperkit', WHISPER_REVISION, WHISPER_MODEL);
let last = -1;
const downloadStarted = Date.now();
await installWhisperModels(whisper, controller.signal, fraction => {
  const percent = Math.floor(fraction * 10) * 10;
  if (percent !== last) { last = percent; console.error(`model ${percent}%`); }
});
if (!whisperModelsReady(whisper)) throw new Error('The model did not verify after installation.');
const installMs = Date.now() - downloadStarted;
const prepared = await client.request('prepare-whisperkit', { modelFolder: whisper });

// Several sentences with pauses, long enough to need more than one 30-second window.
const sentences = [
  'The meeting starts at nine thirty.', 'We approved the release, but do not delete the backup.',
  'Priya Raghunathan will review the Kubernetes migration with Zbigniew on Friday.',
  'The second quarter forecast moved from forty two to forty seven percent.',
  'Please send the Lighthouse audit to the Tanzu platform team before the next sync.',
  'Nobody objected to moving the retrospective to Thursday afternoon.',
  'The last item is the vendor contract, which legal still has to read.',
];
const script = Array.from({ length: 3 }, () => sentences.join(' [[slnc 1200]] ')).join(' [[slnc 2500]] ');
const audio = path.join(root, 'synthetic.aiff');
execFileSync('/usr/bin/say', ['-v', 'Samantha', '-r', '165', '-o', audio, script]);

async function transcribe(args) {
  const progress = [];
  const response = await client.request('transcribe', { audioPath: audio, locale: 'en-US', ...args }, { progress: f => progress.push(f) });
  const parsed = Transcript.parse(response.result);
  if (!parsed.segments.length || !parsed.text.toLowerCase().includes('backup')) throw new Error('Transcription was empty or incomplete.');
  for (let i = 1; i < parsed.segments.length; i++)
    if (parsed.segments[i].start < parsed.segments[i - 1].start) throw new Error('Word timestamps are not in order.');
  if (parsed.segments.at(-1).end > parsed.durationS + 0.5) throw new Error('A word ends after the audio does.');
  return { parsed, elapsedMs: response.elapsedMs, progressEvents: progress.length };
}
const vocabulary = ['Priya Raghunathan', 'Zbigniew', 'Kubernetes', 'Tanzu', 'Lighthouse'];
const plain = await transcribe({ engine: 'whisperkit', modelFolder: whisper });
const biased = await transcribe({ engine: 'whisperkit', modelFolder: whisper, contextualStrings: vocabulary });
if (plain.parsed.provider !== 'whisperkit' || plain.parsed.model !== WHISPER_MODEL) throw new Error('Wrong provider metadata.');
// The speech spans about 90 seconds; a chunk offset bug would pile every word into the first window.
if (plain.parsed.segments.at(-1).start < plain.parsed.durationS - 15) throw new Error('Words do not reach the end of the audio.');

let apple = null;
const health = await client.request('health', { locale: 'en-US' });
if (health.result.installed) {
  const response = await client.request('transcribe', { audioPath: audio, locale: 'en-US', contextualStrings: vocabulary });
  apple = { parsed: Transcript.parse(response.result), elapsedMs: response.elapsedMs };
}

const speakers = path.join(parent, 'speakerkit', SPEAKER_REVISION);
if (!modelsReady(speakers)) await installSpeakerModels(speakers, controller.signal, () => {});
const diarization = Diarization.parse((await client.request('diarize', { audioPath: audio, modelFolder: speakers, modelRevision: SPEAKER_REVISION })).result);
const merged = mergeTranscriptWithDiarization(plain.parsed.segments.map(s => ({ ...s, wordTiming: true })), diarization.segments);
const unknown = merged.filter(turn => turn.speaker === 'UNKNOWN').length;
if (!merged.length || unknown > merged.length / 4) throw new Error('WhisperKit words did not line up with the speaker turns.');

const names = text => vocabulary.filter(term => text.includes(term));
const summary = {
  testedAt: new Date().toISOString(), model: WHISPER_MODEL, revision: WHISPER_REVISION, installMs, prepareMs: prepared.elapsedMs,
  durationS: plain.parsed.durationS, words: plain.parsed.segments.length, progressEvents: plain.progressEvents,
  whisperkitMs: plain.elapsedMs, whisperkitWithVocabularyMs: biased.elapsedMs,
  realTimeFactor: +(plain.parsed.durationS * 1000 / plain.elapsedMs).toFixed(1),
  vocabularyHits: { whisperkit: names(plain.parsed.text), whisperkitWithVocabulary: names(biased.parsed.text), appleWithVocabulary: apple ? names(apple.parsed.text) : 'Apple assets not installed' },
  appleMs: apple?.elapsedMs ?? null, turns: merged.length, unknownTurns: unknown, speakers: diarization.num_speakers,
  limitations: 'One synthetic voice, clean audio. Shows that the engine runs, times words and merges with speaker turns; it is not an accuracy comparison.',
};
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ ...summary, whisperkit: plain.parsed.text, whisperkitWithVocabulary: biased.parsed.text, apple: apple?.parsed.text ?? null, firstWords: plain.parsed.segments.slice(0, 12), lastWords: plain.parsed.segments.slice(-6), turns: merged.slice(0, 6) }, null, 2));
console.log(JSON.stringify(summary, null, 2));
