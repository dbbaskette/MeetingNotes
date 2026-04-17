// electron/main/pipeline/stages/merging.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context';
import { meetingFolderPath } from '../../storage/meeting-folder';
import { mergeTranscriptWithDiarization, mergedToMarkdown } from '../../lib/merge-transcript';

export const runMerging: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  const whisper = JSON.parse(
    fs.readFileSync(path.join(folder, 'transcript.raw.json'), 'utf8'),
  ).segments;
  const diar = JSON.parse(fs.readFileSync(path.join(folder, 'diarization.json'), 'utf8')).segments;
  const merged = mergeTranscriptWithDiarization(whisper, diar);
  fs.writeFileSync(path.join(folder, 'transcript.md'), mergedToMarkdown(merged));
  ctx.logger.info('merge:done', { meetingId, segments: merged.length });
};
