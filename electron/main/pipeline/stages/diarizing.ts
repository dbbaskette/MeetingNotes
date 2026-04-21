// electron/main/pipeline/stages/diarizing.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context.js';
import { meetingFolderPath } from '../../storage/meeting-folder.js';
import { ensureWav } from '../../lib/ensure-wav.js';
import { deriveStemPaths, hasStems } from '../../lib/stem-paths.js';

export const runDiarizing: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  // When stems are available (#13 Phase 1), diarize the SYSTEM stem only.
  // Two benefits:
  //   1. Cleaner input — the local user's voice is already attributed at
  //      merge time via source='voice', so including it in diarization just
  //      risks pyannote clustering it with a remote speaker.
  //   2. Smaller input — half the audio, ~half the pyannote runtime on
  //      long meetings.
  // The voice stem doesn't need diarization at all (single speaker by
  // definition), so we don't diarize it.
  const stemAware = hasStems(meeting.audioPath);
  const inputAudio = stemAware ? deriveStemPaths(meeting.audioPath).system : meeting.audioPath;
  ctx.logger.info('diarize:start', { meetingId, stemAware });
  const wav = await ensureWav(inputAudio);
  try {
    const result = await ctx.diarization.diarize(wav.path);
    fs.writeFileSync(path.join(folder, 'diarization.json'), JSON.stringify(result, null, 2));
    ctx.logger.info('diarize:done', { meetingId, speakers: result.num_speakers, stemAware });
  } finally {
    wav.cleanup();
  }
};
