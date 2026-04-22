// electron/main/pipeline/stages/transcribing.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context.js';
import { meetingFolderPath } from '../../storage/meeting-folder.js';
import { ensureWav } from '../../lib/ensure-wav.js';
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
  const wav = await ensureWav(meeting.audioPath);
  try {
    const result = await ctx.stt.transcribe({
      audioPath: wav.path,
      model: ctx.settings.get('sttModel'),
      language: ctx.settings.get('sttLanguage'),
    });
    // End-of-audio hallucination filter: Whisper emits "Thank you",
    // "[Music]", etc. past the real audio length. Drop segments whose
    // start is beyond the known duration (+0.5s slack).
    const afterEoa = meeting.durationS != null
      ? result.segments.filter((s) => s.start < (meeting.durationS as number) + 0.5)
      : result.segments;
    // Mid-recording hallucination filter: drop known-boilerplate phrases
    // ("[BLANK_AUDIO]", "Thanks for watching", etc.) and clusters of
    // repeated "Thank you" which are the signature of Whisper predicting
    // into silent chunks.
    const kept = filterHallucinations(afterEoa);
    const dropped = result.segments.length - kept.length;
    fs.writeFileSync(
      path.join(folder, 'transcript.raw.json'),
      JSON.stringify({ ...result, segments: kept }, null, 2),
    );
    ctx.logger.info('transcribe:done', { meetingId, segments: kept.length, dropped });
  } finally {
    wav.cleanup();
  }
};
