import { cosineSimilarity } from '../lib/cosine';

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

export function updateRunningAverage(old: readonly number[], observed: readonly number[]): number[] {
  if (old.length !== observed.length) throw new Error('length mismatch');
  const out = new Array<number>(old.length);
  for (let i = 0; i < old.length; i++) {
    out[i] = OLD_WEIGHT * old[i]! + (1 - OLD_WEIGHT) * observed[i]!;
  }
  return out;
}
