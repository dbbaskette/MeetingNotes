import type { SpeakersRepo } from '../storage/speakers-repo.js';
import { embeddingFilePath, writeEmbedding, readEmbedding } from './embeddings.js';
import { matchSpeakers, rankCandidates, updateRunningAverage, type DetectedSpeaker, type Match } from './matcher.js';
import { VoiceProfiles, normalized } from './voice-profiles.js';

export class RosterService {
  constructor(private readonly repo: SpeakersRepo, private readonly libraryRoot: string) {}

  confirmSpeaker(input: { displayName: string; embedding: number[] | null; notes?: string }, space?: string): string {
    // If the user types a name that already exists on the roster (modulo
    // whitespace + case), reuse that entry and merge this observation into
    // its embedding rather than creating a duplicate row. Prevents the
    // roster from filling up with near-duplicates as the same person shows
    // up across many meetings.
    const existing = this.repo.findByDisplayName(input.displayName);
    if (existing) {
      if (input.embedding) this.confirmSpeakerFor(existing.id, input.embedding, space);
      return existing.id;
    }
    const id = this.repo.create({ displayName: input.displayName, notes: input.notes });
    if (input.embedding) this.confirmSpeakerFor(id, input.embedding, space);
    return id;
  }

  confirmSpeakerFor(id: string, observed: number[], space?: string): void {
    if (!normalized(observed)) return;
    if (space) { new VoiceProfiles(this.libraryRoot).confirm(space, id, observed); return; }
    const old = this.safeLoad(id);
    const updated = old ? updateRunningAverage(old, observed) : observed;
    writeEmbedding(embeddingFilePath(this.libraryRoot, id), updated);
  }

  loadEmbedding(id: string): number[] {
    return readEmbedding(embeddingFilePath(this.libraryRoot, id));
  }

  identifyUnknowns(detected: readonly DetectedSpeaker[], space?: string): Match[] {
    // Native scores are not yet calibrated; candidates require confirmation.
    if (space) return detected.map(s => ({ label: s.label, rosterId: null, confidence: null }));
    const rosterEntries = this.repo.list()
      .map((s) => ({ id: s.id, embedding: this.safeLoad(s.id) }))
      .filter((r): r is { id: string; embedding: number[] } => r.embedding !== null);
    return matchSpeakers(detected, rosterEntries);
  }

  /** Ranked "might be X" suggestions for one specific unidentified speaker —
   *  used by the Speakers panel so the user can confirm a guess instead of
   *  typing a name from scratch. Unlike identifyUnknowns, this has no
   *  MATCH_THRESHOLD gate: it's for a human to eyeball, not to auto-link. */
  suggestionsFor(detected: DetectedSpeaker, topN = 3, space?: string): { id: string; displayName: string; confidence: number; scoreKind?: 'similarity' }[] {
    const roster = this.repo.list();
    if (space) return new VoiceProfiles(this.libraryRoot).suggestions(space, detected.embedding, roster)
      .slice(0, topN).map(s => ({ id: s.id, displayName: s.displayName, confidence: s.similarity, scoreKind: 'similarity' }));
    const nameById = new Map(roster.map((r) => [r.id, r.displayName]));
    const candidates = roster
      .map((r) => ({ id: r.id, embedding: this.safeLoad(r.id) }))
      .filter((r): r is { id: string; embedding: number[] } => r.embedding !== null);
    return rankCandidates(detected, candidates, topN).map((c) => ({
      id: c.id,
      displayName: nameById.get(c.id) ?? '(unknown)',
      confidence: c.confidence,
    }));
  }

  private safeLoad(id: string): number[] | null {
    try { const vector = this.loadEmbedding(id); return normalized(vector) ? vector : null; } catch { return null; }
  }
}
