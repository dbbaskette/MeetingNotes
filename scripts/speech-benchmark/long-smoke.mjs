// Stress the real timeline using repeated synthetic speech, never private meetings.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SpeechClient, Transcript, Diarization, SPEAKER_REVISION } from '../../dist/electron/main/speech/client.js';

const root = path.resolve('speech-benchmark-results/long-smoke'); fs.mkdirSync(root, { recursive: true });
const input = path.resolve('speech-benchmark-results/synthetic-smoke/synthetic.aiff');
if (!fs.existsSync(input)) throw new Error('Run the synthetic smoke first.');
const duration = 75 * 60, audioPath = path.join(root, 'repeated-synthetic-75min.wav');
execFileSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-y', '-stream_loop', '-1', '-i', input, '-t', String(duration), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', audioPath], { timeout: 60_000 });
const helper = new SpeechClient(path.resolve('speech-engine/.build/release/meeting-notes-speech'), 10 * 60_000);
const transcription = await helper.request('transcribe', { audioPath });
const transcript = Transcript.parse(transcription.result);
const diarization = await helper.request('diarize', { audioPath,
  modelFolder: path.resolve('speech-benchmark-results/synthetic-smoke/models', SPEAKER_REVISION), modelRevision: SPEAKER_REVISION });
const diar = Diarization.parse(diarization.result);
const coverage = [];
for (let start = 0; start < duration; start += 60) coverage.push({ minute: start / 60,
  transcript: transcript.segments.some(s => s.start < start + 60 && s.end > start),
  speaker: diar.segments.some(s => s.start < start + 60 && s.end > start) });
const passed = coverage.every(c => c.transcript && c.speaker) && transcript.segments.at(-1)?.end > duration - 10;
const result = { durationS: transcript.durationS, transcriptionMs: transcription.elapsedMs, diarizationMs: diarization.elapsedMs,
  timedWords: transcript.segments.length, speakers: diar.num_speakers, usableCentroids: Object.keys(diar.centroids).length,
  coverage, passed, limitations: 'Repeated clean synthetic speech. Timeline completeness only; not spontaneous meeting accuracy, overlap, memory measurement, or cross-meeting identity calibration.' };
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (!passed) process.exitCode = 1;
