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
  // #173 keeps stem processing deferred: use exactly the same mixed timeline
  // as STT. Capture fixes alone do not prove independent-stem attribution.
  ctx.logger.info('diarize:start', { meetingId });
  // Wake the pyannote sidecar on demand. First call after a cold app
  // start blocks for ~5–10s while the model loads; subsequent calls
  // within the idle window are instant. The supervisor adopts an
  // existing healthy instance if one is already bound to :8765.
  await ctx.diarSupervisor.ensureReady();
  const wav = await ensureWav(meeting.audioPath);
  try {
    const result = await ctx.diarization.diarize(wav.path);
    // Compact JSON: the per-segment embeddings make this file multi-MB,
    // and pretty-print indentation roughly doubles both the on-disk size
    // and the cost of any later JSON.parse.
    fs.writeFileSync(path.join(folder, 'diarization.json'), JSON.stringify(result));
    // Tiny sidecar for consumers (weekly rollup) that only need the
    // speaker count — saves them parsing the embeddings-laden file.
    fs.writeFileSync(
      path.join(folder, 'diarization.meta.json'),
      JSON.stringify({ num_speakers: result.num_speakers }),
    );
    ctx.logger.info('diarize:done', { meetingId, speakers: result.num_speakers });
  } finally {
    wav.cleanup();
  }
};
