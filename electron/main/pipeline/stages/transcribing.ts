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
    // Whisper reliably hallucinates beyond the end of real audio — classic
    // symptoms are a "Thank you for watching" or "[Music]" segment tacked on
    // after silence. Drop segments whose start is past the known duration
    // with a 0.5s slack.
    const kept = meeting.durationS != null
      ? result.segments.filter((s) => s.start < (meeting.durationS as number) + 0.5)
      : result.segments;
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
