// Physical-device smoke only. Synthetic speech is not a real-meeting accuracy benchmark.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SpeechClient, Transcript, Diarization, SPEAKER_REVISION } from '../../dist/electron/main/speech/client.js';
import { installSpeakerModels, modelsReady } from '../../dist/electron/main/speech/models.js';

const root = path.resolve('speech-benchmark-results/synthetic-smoke');
fs.mkdirSync(root, { recursive: true });
const helper = path.resolve('speech-engine/.build/release/meeting-notes-speech');
const client = new SpeechClient(helper, 5 * 60_000);
const text = 'The meeting starts at nine thirty. We approved the release, but do not delete the backup. Keith will review the security report on Friday.';
const audio = path.join(root, 'synthetic.aiff');
execFileSync('/usr/bin/say', ['-v', 'Samantha', '-r', '170', '-o', audio, text]);
const health = await client.request('health');
if (!health.result.installed) throw new Error('Run the explicit Apple asset setup before this smoke test.');
const transcript = await client.request('transcribe', { audioPath: audio });
const parsedTranscript = Transcript.parse(transcript.result);
if (!parsedTranscript.segments.length || !parsedTranscript.text.toLowerCase().includes('backup')) throw new Error('Synthetic speech transcription was empty or incomplete.');
const models = path.join(root, 'models', SPEAKER_REVISION);
const controller = new AbortController();
if (!modelsReady(models)) await installSpeakerModels(models, controller.signal, () => {});
const diarization = await client.request('diarize', { audioPath: audio, modelFolder: models, modelRevision: SPEAKER_REVISION });
const parsedDiarization = Diarization.parse(diarization.result);
if (!parsedDiarization.num_speakers || !parsedDiarization.segments.length) throw new Error('Synthetic speech was not diarized.');
const result = { testedAt: new Date().toISOString(), node: process.version, platform: process.platform, architecture: process.arch,
  health: health.result, reference: text, transcript: parsedTranscript, diarization: parsedDiarization,
  transcriptionMs: transcript.elapsedMs, diarizationMs: diarization.elapsedMs,
  limitations: 'Single synthetic voice, short clean audio. Not a quality/promotion gate or a Whisper/Parakeet comparison.' };
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ durationS: parsedTranscript.durationS, transcriptionMs: transcript.elapsedMs,
  diarizationMs: diarization.elapsedMs, speakers: parsedDiarization.num_speakers,
  usableCentroids: Object.keys(parsedDiarization.centroids).length, result: path.join(root, 'result.json') }));
