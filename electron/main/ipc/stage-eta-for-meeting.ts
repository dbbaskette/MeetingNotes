// electron/main/ipc/stage-eta-for-meeting.ts
import { bucketForChars, estimateStage, MAX_SAMPLES_PER_BUCKET, type StageEstimate } from '../lib/stage-eta.js';

interface SampleSource {
  recentSamples(stage: string, sizeBucket: number, limit: number): number[];
}

/** Stages the pipeline actually times (WorkStage). Anything else — the
 *  awaiting_speaker_id gate, discovered, done — has no estimate. */
const WORK_STAGES = new Set([
  'transcribing', 'diarizing', 'merging', 'identifying', 'summarizing', 'extracting',
]);

function estimateForStage(repo: SampleSource, stage: string, bucket: number): StageEstimate | null {
  return estimateStage(repo.recentSamples(stage, bucket, MAX_SAMPLES_PER_BUCKET));
}

/** Learned estimate for a meeting's CURRENT pipeline stage, or null on a true
 *  cold start / non-work stage. `transcribing` and `diarizing` run in parallel
 *  and collapse to one user "transcribe" step, so their estimate is the max of
 *  the two (wall-clock is bounded by the slower branch); a null sibling is
 *  ignored so a single warm branch still yields a number. The combined estimate
 *  is `rough` if any contributing (non-null) branch is rough.
 *
 *  `transcriptCharCount` is a THUNK, not a number: computing it costs a
 *  statSync, and meetings:list calls this per meeting on every 3s poll —
 *  mostly for 'done' meetings where the answer is null. Lazy evaluation keeps
 *  the fs cost proportional to actively-processing meetings, not library size. */
export function stageEtaForMeeting(
  repo: SampleSource,
  pipelineStage: string,
  transcriptCharCount: () => number,
): StageEstimate | null {
  if (!WORK_STAGES.has(pipelineStage)) return null;
  const bucket = bucketForChars(transcriptCharCount());
  if (pipelineStage === 'transcribing' || pipelineStage === 'diarizing') {
    const branches = [
      estimateForStage(repo, 'transcribing', bucket),
      estimateForStage(repo, 'diarizing', bucket),
    ].filter((b): b is StageEstimate => b !== null);
    if (branches.length === 0) return null;
    return {
      etaMs: Math.max(...branches.map((b) => b.etaMs)),
      rough: branches.some((b) => b.rough),
    };
  }
  return estimateForStage(repo, pipelineStage, bucket);
}
