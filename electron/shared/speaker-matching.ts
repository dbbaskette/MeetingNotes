/** Opt-in heuristics, not calibrated probabilities. Compare unrounded scores. */
export const SPEAKER_AUTO_MATCH = {
  similarity: 0.98,
  margin: 0.05,
  cleanDurationS: 10,
  cleanTurns: 2,
  cleanTurnDurationS: 1.5,
} as const;
export type SpeakerAssignmentSource = 'automatic' | 'manual' | null;
