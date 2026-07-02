// electron/main/ipc/stage-eta-for-meeting.ts
import { bucketForChars, estimateMs, MAX_SAMPLES_PER_BUCKET } from '../lib/stage-eta.js';

interface SampleSource {
  recentSamples(stage: string, sizeBucket: number, limit: number): number[];
}

/** Stages the pipeline actually times (WorkStage). Anything else — the
 *  awaiting_speaker_id gate, discovered, done — has no estimate. */
const WORK_STAGES = new Set([
  'transcribing', 'diarizing', 'merging', 'identifying', 'summarizing', 'extracting',
]);

function estimateForStage(repo: SampleSource, stage: string, bucket: number): number | null {
  return estimateMs(repo.recentSamples(stage, bucket, MAX_SAMPLES_PER_BUCKET));
}

/** Learned estimate (ms) for a meeting's CURRENT pipeline stage, or null on a
 *  cold start / non-work stage. `transcribing` and `diarizing` run in parallel
 *  and collapse to one user "transcribe" step, so their estimate is the max of
 *  the two (wall-clock is bounded by the slower branch); max ignores a null
 *  sibling so a single warm branch still yields a number. */
export function stageEtaForMeeting(
  repo: SampleSource,
  pipelineStage: string,
  transcriptCharCount: number,
): number | null {
  if (!WORK_STAGES.has(pipelineStage)) return null;
  const bucket = bucketForChars(transcriptCharCount);
  if (pipelineStage === 'transcribing' || pipelineStage === 'diarizing') {
    const t = estimateForStage(repo, 'transcribing', bucket);
    const d = estimateForStage(repo, 'diarizing', bucket);
    if (t === null && d === null) return null;
    return Math.max(t ?? 0, d ?? 0);
  }
  return estimateForStage(repo, pipelineStage, bucket);
}
