import { cosineSimilarity } from '../lib/cosine.js';

export const MATCH_THRESHOLD = 0.75;
export const OLD_WEIGHT = 0.7;

export interface RosterEntry { id: string; embedding: number[]; }
export interface DetectedSpeaker { label: string; embedding: number[]; }
export interface Match { label: string; rosterId: string | null; confidence: number | null; }

export function matchSpeakers(detected: readonly DetectedSpeaker[], roster: readonly RosterEntry[]): Match[] {
  return detected.map((d) => {
    let bestId: string | null = null;
    let bestScore = -Infinity;
    for (const r of roster) {
      if (r.embedding.length !== d.embedding.length) continue;
      const s = cosineSimilarity(d.embedding, r.embedding);
      if (s > bestScore) { bestScore = s; bestId = r.id; }
    }
    if (bestId !== null && bestScore >= MATCH_THRESHOLD) {
      return { label: d.label, rosterId: bestId, confidence: bestScore };
    }
    return { label: d.label, rosterId: null, confidence: null };
  });
}

export interface RankedCandidate { id: string; confidence: number; }

/** Rank every roster entry by cosine similarity to a detected speaker's
 *  embedding, with NO threshold gating — unlike matchSpeakers (which only
 *  auto-links when the best match clears MATCH_THRESHOLD), this is meant to
 *  drive a manual "might be X" suggestion UI, where even a below-threshold
 *  guess is more useful than a blank field. matchSpeakers remains the sole
 *  source of truth for auto-linking; this never changes that behavior. */
export function rankCandidates(
  detected: DetectedSpeaker,
  roster: readonly RosterEntry[],
  topN = 3,
): RankedCandidate[] {
  return roster
    .filter((r) => r.embedding.length === detected.embedding.length)
    .map((r) => ({ id: r.id, confidence: cosineSimilarity(detected.embedding, r.embedding) }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, topN);
}

export function updateRunningAverage(old: readonly number[], observed: readonly number[]): number[] {
  if (old.length !== observed.length) throw new Error('length mismatch');
  const out = new Array<number>(old.length);
  for (let i = 0; i < old.length; i++) {
    out[i] = OLD_WEIGHT * old[i]! + (1 - OLD_WEIGHT) * observed[i]!;
  }
  return out;
}
