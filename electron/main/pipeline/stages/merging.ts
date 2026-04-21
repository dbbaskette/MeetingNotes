// electron/main/pipeline/stages/merging.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context.js';
import type { MeetingsRepo } from '../../storage/meetings-repo.js';
import type { SpeakersRepo } from '../../storage/speakers-repo.js';
import { meetingFolderPath } from '../../storage/meeting-folder.js';
import { mergeTranscriptWithDiarization, mergedToMarkdown } from '../../lib/merge-transcript.js';
import { VOICE_SPEAKER_LABEL } from '../../lib/stem-paths.js';

/**
 * Rebuilds `transcript.md` from `transcript.raw.json` + `diarization.json`,
 * substituting roster display names for any diarization labels the user has
 * identified. Safe to call multiple times — idempotent and deterministic,
 * just overwrites the file.
 *
 * `userName` is used to label voice-stem segments (synthetic speaker
 * VOICE_YOU) in stem-aware transcripts. Empty string falls back to "You".
 *
 * Extracted from `runMerging` so the IPC layer can re-run just the merge
 * step after the user identifies speakers at the `awaiting_speaker_id`
 * gate, without having to bounce the stage pointer back to `merging` and
 * re-enter the pipeline (which would also re-run `identifying` and risk
 * clobbering manual assignments).
 */
export function remergeTranscript(
  meetingId: string,
  deps: {
    libraryRoot: string;
    meetings: MeetingsRepo;
    speakers: SpeakersRepo;
    userName?: string;
  },
): { segments: number; named: number } {
  const meeting = deps.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(deps.libraryRoot, meeting.slug);
  const whisper = JSON.parse(
    fs.readFileSync(path.join(folder, 'transcript.raw.json'), 'utf8'),
  ).segments;
  // Diarization file may not exist for stem-aware meetings if the user
  // runs a re-merge before diarization finishes, or for meetings where we
  // chose not to diarize. Treat a missing file as "no remote speakers yet"
  // rather than crashing the merge — voice segments still render correctly.
  const diarPath = path.join(folder, 'diarization.json');
  const diar = fs.existsSync(diarPath)
    ? JSON.parse(fs.readFileSync(diarPath, 'utf8')).segments
    : [];
  const merged = mergeTranscriptWithDiarization(whisper, diar);
  const labelMap: Record<string, string> = {
    [VOICE_SPEAKER_LABEL]: deps.userName?.trim() || 'You',
  };
  for (const sp of deps.speakers.listForMeeting(meetingId)) {
    if (sp.displayName) labelMap[sp.localLabel] = sp.displayName;
  }
  fs.writeFileSync(path.join(folder, 'transcript.md'), mergedToMarkdown(merged, labelMap));
  // Count named as the overlap between detected speakers and labeled ones;
  // don't over-count the synthetic VOICE_YOU which is always "named."
  const named = deps.speakers.listForMeeting(meetingId).filter((sp) => sp.displayName).length;
  return { segments: merged.length, named };
}

export const runMerging: StageHandler = async ({ meetingId }, ctx) => {
  const result = remergeTranscript(meetingId, {
    libraryRoot: ctx.libraryRoot,
    meetings: ctx.meetings,
    speakers: ctx.speakers,
    userName: ctx.settings.get('userName'),
  });
  ctx.logger.info('merge:done', { meetingId, ...result });
};
