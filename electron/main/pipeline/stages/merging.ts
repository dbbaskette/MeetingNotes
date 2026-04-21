// electron/main/pipeline/stages/merging.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context.js';
import type { MeetingsRepo } from '../../storage/meetings-repo.js';
import type { SpeakersRepo } from '../../storage/speakers-repo.js';
import { meetingFolderPath } from '../../storage/meeting-folder.js';
import { mergeTranscriptWithDiarization, mergedToMarkdown } from '../../lib/merge-transcript.js';

/**
 * Rebuilds `transcript.md` from `transcript.raw.json` + `diarization.json`,
 * substituting roster display names for any diarization labels the user has
 * identified. Safe to call multiple times — idempotent and deterministic,
 * just overwrites the file.
 *
 * Extracted from `runMerging` so the IPC layer can re-run just the merge
 * step after the user identifies speakers at the `awaiting_speaker_id`
 * gate, without having to bounce the stage pointer back to `merging` and
 * re-enter the pipeline (which would also re-run `identifying` and risk
 * clobbering manual assignments).
 */
export function remergeTranscript(
  meetingId: string,
  deps: { libraryRoot: string; meetings: MeetingsRepo; speakers: SpeakersRepo },
): { segments: number; named: number } {
  const meeting = deps.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(deps.libraryRoot, meeting.slug);
  const whisper = JSON.parse(
    fs.readFileSync(path.join(folder, 'transcript.raw.json'), 'utf8'),
  ).segments;
  const diar = JSON.parse(fs.readFileSync(path.join(folder, 'diarization.json'), 'utf8')).segments;
  const merged = mergeTranscriptWithDiarization(whisper, diar);
  const labelMap: Record<string, string> = {};
  for (const sp of deps.speakers.listForMeeting(meetingId)) {
    if (sp.displayName) labelMap[sp.localLabel] = sp.displayName;
  }
  fs.writeFileSync(path.join(folder, 'transcript.md'), mergedToMarkdown(merged, labelMap));
  return { segments: merged.length, named: Object.keys(labelMap).length };
}

export const runMerging: StageHandler = async ({ meetingId }, ctx) => {
  const result = remergeTranscript(meetingId, {
    libraryRoot: ctx.libraryRoot,
    meetings: ctx.meetings,
    speakers: ctx.speakers,
  });
  ctx.logger.info('merge:done', { meetingId, ...result });
};
