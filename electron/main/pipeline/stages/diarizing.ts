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
