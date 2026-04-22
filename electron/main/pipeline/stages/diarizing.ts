// electron/main/pipeline/stages/diarizing.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context.js';
import { meetingFolderPath } from '../../storage/meeting-folder.js';
import { ensureWav } from '../../lib/ensure-wav.js';

export const runDiarizing: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  // Diarize the mixed file. Previously this was the system stem when stems
  // existed (cleaner input for pyannote, faster on long meetings), but
  // that only worked when transcription ALSO ran on stems — otherwise the
  // transcript's timestamps for the local user's voice have nothing to
  // overlap with in diarization, and those segments all fall through to
  // "UNKNOWN" in the merge stage.
  //
  // Since the stem-aware transcription path is off pending #27 (voice
  // stem writes silence — Swift bug), we must diarize the same audio we
  // transcribed. When #27 is fixed and stem-aware transcribe comes back,
  // restore the `hasStems ? system : mixed` branch here.
  ctx.logger.info('diarize:start', { meetingId });
  const wav = await ensureWav(meeting.audioPath);
  try {
    const result = await ctx.diarization.diarize(wav.path);
    fs.writeFileSync(path.join(folder, 'diarization.json'), JSON.stringify(result, null, 2));
    ctx.logger.info('diarize:done', { meetingId, speakers: result.num_speakers });
  } finally {
    wav.cleanup();
  }
};
