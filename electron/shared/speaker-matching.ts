/** Heuristics, not calibrated probabilities. Compare unrounded scores.
 *
 * Measured on 61 native-speech meetings (204 hand-named voices), replayed in
 * date order against voiceprints built only from earlier meetings: correct
 * top matches scored a median of 0.89, the highest wrong top match 0.79, and
 * first-time voices at most 0.61. With the clean-speech rule, 0.80 named 74%
 * of returning voices with no wrong names; the earlier 0.98 named 1%. */
export const SPEAKER_AUTO_MATCH = {
  similarity: 0.8,
  margin: 0.05,
  cleanDurationS: 10,
  cleanTurns: 2,
  cleanTurnDurationS: 1.5,
  /** Below the automatic bar but at or above this, the top name is offered
   *  for one-click confirmation instead of being applied. */
  suggestSimilarity: 0.6,
  /** Unnamed voices with less total speech than this do not hold a meeting
   *  for review. A third of them were real people, so they stay nameable. */
  briefVoiceS: 10,
} as const;
export type SpeakerAssignmentSource = 'automatic' | 'manual' | null;

/** An unnamed voice the diarizer heard only briefly: a chime, a goodbye, or a
 *  person who said very little. Needs diarization evidence, so a missing or
 *  unread artifact never makes an unknown voice look brief. */
export function isBriefVoice(voice: { rosterId: string | null; durationS?: number; segmentCount?: number }): boolean {
  return voice.rosterId === null && (voice.segmentCount ?? 0) > 0
    && (voice.durationS ?? Infinity) < SPEAKER_AUTO_MATCH.briefVoiceS;
}

/** The one name worth offering on an unnamed voice's row: the best candidate,
 *  when it clears the suggestion bar and clearly leads the runner-up.
 *  `ranked` is ordered best first. */
export function suggestedMatch<T extends { confidence: number }>(ranked: readonly T[]): T | null {
  const [best, next] = ranked;
  if (!best || best.confidence < SPEAKER_AUTO_MATCH.suggestSimilarity) return null;
  if (next && best.confidence - next.confidence < SPEAKER_AUTO_MATCH.margin) return null;
  return best;
}
