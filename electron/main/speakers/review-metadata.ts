import { mergeTranscriptWithDiarization, type WhisperSegment } from '../lib/merge-transcript.js';
import type { DiarizationSegment } from './sample-extractor.js';

export type SpeakerReviewState = 'unknown' | 'probable' | 'confirmed';
export interface SpeakerReviewMetadata {
  state: SpeakerReviewState;
  needsReview: boolean;
  segmentCount: number;
  durationS: number;
  lineCount: number;
}

interface SpeakerLink {
  localLabel: string;
  rosterId: string | null;
  displayName: string | null;
  confidence: number | null;
}

export function buildSpeakerReviewMetadata(input: {
  links: readonly SpeakerLink[];
  diarization: readonly DiarizationSegment[];
  transcript: readonly WhisperSegment[];
}): Map<string, SpeakerReviewMetadata> {
  const merged = mergeTranscriptWithDiarization(input.transcript, input.diarization);
  const lineCounts = new Map<string, number>();
  for (const line of merged) {
    lineCounts.set(line.speaker, (lineCounts.get(line.speaker) ?? 0) + 1);
  }
  const diarStats = new Map<string, { segmentCount: number; durationS: number }>();
  for (const segment of input.diarization) {
    const stats = diarStats.get(segment.speaker) ?? { segmentCount: 0, durationS: 0 };
    stats.segmentCount += 1;
    stats.durationS += Math.max(0, segment.end - segment.start);
    diarStats.set(segment.speaker, stats);
  }
  const result = new Map<string, SpeakerReviewMetadata>();
  for (const link of input.links) {
    const own = diarStats.get(link.localLabel) ?? { segmentCount: 0, durationS: 0 };
    const state: SpeakerReviewState = !link.rosterId ? 'unknown'
      : (link.confidence ?? 0) >= 0.999 ? 'confirmed' : 'probable';
    result.set(link.localLabel, {
      state,
      segmentCount: own.segmentCount,
      durationS: own.durationS,
      lineCount: lineCounts.get(link.localLabel) ?? 0,
      needsReview: state === 'unknown' || (link.confidence ?? 0) < 0.8 || own.segmentCount < 2,
    });
  }
  return result;
}
