// electron/main/pipeline/stages/transcribing.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context.js';
import { meetingFolderPath } from '../../storage/meeting-folder.js';
import { ensureWav } from '../../lib/ensure-wav.js';

export const runTranscribing: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  ctx.logger.info('transcribe:start', { meetingId });
  const wav = await ensureWav(meeting.audioPath);
  try {
    const result = await ctx.stt.transcribe({
      audioPath: wav.path,
      model: ctx.settings.get('sttModel'),
      language: ctx.settings.get('sttLanguage'),
    });
    fs.writeFileSync(path.join(folder, 'transcript.raw.json'), JSON.stringify(result, null, 2));
    ctx.logger.info('transcribe:done', { meetingId, segments: result.segments.length });
  } finally {
    wav.cleanup();
  }
};
