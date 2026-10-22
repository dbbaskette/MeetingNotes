// electron/main/pipeline/stages/diarizing.ts
import path from 'node:path';
import type { StageHandler } from '../context.js';
import { meetingFolderPath } from '../../storage/meeting-folder.js';
import { atomicJson } from '../../speakers/voice-profiles.js';

export const runDiarizing: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  if (!ctx.nativeSpeech) throw new Error('Native speech helper is not configured.');
  const result = await ctx.nativeSpeech.diarize(meeting.audioPath, { signal: ctx.signal });
  ctx.signal?.throwIfAborted();
  atomicJson(path.join(folder, 'diarization.json'), result);
  atomicJson(path.join(folder, 'diarization.meta.json'), { num_speakers: result.num_speakers });
  // Labels belong to this run, never to the same numeric label in an old run.
  ctx.speakers.unlinkMeeting(meetingId);
  ctx.artifactCache.invalidate(path.join(folder, 'diarization.json'));
  ctx.logger.info('diarize:done', { meetingId, provider: 'speakerkit', speakers: result.num_speakers });
};
