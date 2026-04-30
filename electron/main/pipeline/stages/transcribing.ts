// electron/main/pipeline/stages/transcribing.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context.js';
import { meetingFolderPath } from '../../storage/meeting-folder.js';
import { ensureWav } from '../../lib/ensure-wav.js';
import { chunkWavIfNeeded } from '../../lib/chunk-wav.js';
import { filterHallucinations } from '../hallucination-filter.js';

export const runTranscribing: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  ctx.logger.info('transcribe:start', { meetingId });

  // Stem-aware transcription was tried in #13 Phase 3 but rolled back in
  // #27 — the voice stem currently writes effectively silent audio despite
  // the mic being captured correctly (provable via the mixed file which
  // has the user's voice). Feeding a silent voice stem to Whisper produced
  // only "Thank you." boilerplate. Until the Swift-side voice-stem bug is
  // found, we always transcribe the mixed file — it contains both user +
  // remote speakers, speaker attribution comes from diarization + the
  // roster matcher as it did before Phase 3.
  //
  // Stem-aware diarization is still active (diarizing.ts uses the system
  // stem when present) because that path works fine and gives cleaner
  // pyannote input.

  // Wake whisper-server on demand. First call after a cold app start
  // pays the model-load wait (~5–15s depending on model size);
  // subsequent calls within the idle window are instant. The
  // supervisor adopts an existing healthy whisper-server if one is
  // already bound to :8080 (e.g. user-launched daemon).
  await ctx.whisperSupervisor.ensureReady();
  const wav = await ensureWav(meeting.audioPath);
  // For long meetings (>~70 min at 16 kHz mono) the resulting WAV
  // exceeds whisper.cpp's HTTP body limit (~128 MB) and the upload
  // comes back as 413. Split into 25-min slices and stitch the
  // segments together with timestamp offsets. Short meetings get a
  // single-chunk passthrough — same code path, no extra ffmpeg work.
  const chunks = await chunkWavIfNeeded(wav.path);
  try {
    if (chunks.length > 1) {
      ctx.logger.info('transcribe:chunked', { meetingId, chunks: chunks.length });
    }

    const allSegments: { start: number; end: number; text: string }[] = [];
    const textParts: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const result = await ctx.stt.transcribe({
        audioPath: chunk.path,
        model: ctx.settings.get('sttModel'),
        language: ctx.settings.get('sttLanguage'),
      });
      for (const seg of result.segments) {
        allSegments.push({
          start: seg.start + chunk.startS,
          end: seg.end + chunk.startS,
          text: seg.text,
        });
      }
      if (result.text) textParts.push(result.text);
      if (chunks.length > 1) {
        ctx.logger.info('transcribe:chunk-done', {
          meetingId, chunk: i + 1, of: chunks.length, segments: result.segments.length,
        });
      }
    }
    const totalSegments = allSegments.length;

    // End-of-audio hallucination filter: Whisper emits "Thank you",
    // "[Music]", etc. past the real audio length. Drop segments whose
    // start is beyond the known duration (+0.5s slack).
    const afterEoa = meeting.durationS != null
      ? allSegments.filter((s) => s.start < (meeting.durationS as number) + 0.5)
      : allSegments;
    // Mid-recording hallucination filter: drop known-boilerplate phrases
    // ("[BLANK_AUDIO]", "Thanks for watching", etc.) and clusters of
    // repeated "Thank you" which are the signature of Whisper predicting
    // into silent chunks.
    const kept = filterHallucinations(afterEoa);
    const dropped = totalSegments - kept.length;
    fs.writeFileSync(
      path.join(folder, 'transcript.raw.json'),
      JSON.stringify({ text: textParts.join(' '), segments: kept }, null, 2),
    );
    ctx.logger.info('transcribe:done', { meetingId, segments: kept.length, dropped });
  } finally {
    for (const c of chunks) c.cleanup();
    wav.cleanup();
  }
};
