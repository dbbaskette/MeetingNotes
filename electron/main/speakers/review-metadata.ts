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
  const result = new Map<string, SpeakerReviewMetadata>();
  for (const link of input.links) {
    const own = input.diarization.filter((segment) => segment.speaker === link.localLabel);
    const state: SpeakerReviewState = !link.rosterId ? 'unknown'
      : (link.confidence ?? 0) >= 0.999 ? 'confirmed' : 'probable';
    const segmentCount = own.length;
    result.set(link.localLabel, {
      state,
      segmentCount,
      durationS: own.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0),
      lineCount: merged.filter((line) => line.speaker === link.localLabel).length,
      needsReview: state === 'unknown' || (link.confidence ?? 0) < 0.8 || segmentCount < 2,
    });
  }
  return result;
}
