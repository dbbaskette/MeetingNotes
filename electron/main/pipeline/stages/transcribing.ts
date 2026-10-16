// electron/main/pipeline/stages/transcribing.ts
import path from 'node:path';
import type { StageHandler } from '../context.js';
import { meetingFolderPath } from '../../storage/meeting-folder.js';
import { atomicJson } from '../../speakers/voice-profiles.js';

export const runTranscribing: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  ctx.logger.info('transcribe:start', { meetingId });
  if (!ctx.nativeSpeech) throw new Error('Native speech helper is not configured.');
  const result = await ctx.nativeSpeech.transcribe(meeting.audioPath, ctx.speechSelection?.language ?? ctx.settings.get('sttLanguage'));
  atomicJson(path.join(folder, 'transcript.raw.json'), { ...result, segments: result.segments.map(s => ({ ...s, wordTiming: true })) });
  ctx.artifactCache.invalidate(path.join(folder, 'transcript.raw.json'));
  ctx.logger.info('transcribe:done', { meetingId, provider: 'apple', segments: result.segments.length });
};
