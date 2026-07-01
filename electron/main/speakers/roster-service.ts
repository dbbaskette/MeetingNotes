import type { SpeakersRepo } from '../storage/speakers-repo.js';
import { embeddingFilePath, writeEmbedding, readEmbedding } from './embeddings.js';
import { matchSpeakers, rankCandidates, updateRunningAverage, type DetectedSpeaker, type Match } from './matcher.js';

export class RosterService {
  constructor(private readonly repo: SpeakersRepo, private readonly libraryRoot: string) {}

  confirmSpeaker(input: { displayName: string; embedding: number[]; notes?: string }): string {
    // If the user types a name that already exists on the roster (modulo
    // whitespace + case), reuse that entry and merge this observation into
    // its embedding rather than creating a duplicate row. Prevents the
    // roster from filling up with near-duplicates as the same person shows
    // up across many meetings.
    const existing = this.repo.findByDisplayName(input.displayName);
    if (existing) {
      this.confirmSpeakerFor(existing.id, input.embedding);
      return existing.id;
    }
    const id = this.repo.create({ displayName: input.displayName, notes: input.notes });
    writeEmbedding(embeddingFilePath(this.libraryRoot, id), input.embedding);
    return id;
  }

  confirmSpeakerFor(id: string, observed: number[]): void {
    const old = this.loadEmbedding(id);
    const updated = updateRunningAverage(old, observed);
    writeEmbedding(embeddingFilePath(this.libraryRoot, id), updated);
  }

  loadEmbedding(id: string): number[] {
    return readEmbedding(embeddingFilePath(this.libraryRoot, id));
  }

  identifyUnknowns(detected: readonly DetectedSpeaker[]): Match[] {
    const rosterEntries = this.repo.list()
      .map((s) => ({ id: s.id, embedding: this.safeLoad(s.id) }))
      .filter((r): r is { id: string; embedding: number[] } => r.embedding !== null);
    return matchSpeakers(detected, rosterEntries);
  }

  /** Ranked "might be X" suggestions for one specific unidentified speaker —
   *  used by the Speakers panel so the user can confirm a guess instead of
   *  typing a name from scratch. Unlike identifyUnknowns, this has no
   *  MATCH_THRESHOLD gate: it's for a human to eyeball, not to auto-link. */
  suggestionsFor(detected: DetectedSpeaker, topN = 3): { id: string; displayName: string; confidence: number }[] {
    const roster = this.repo.list();
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
    try { return this.loadEmbedding(id); } catch { return null; }
  }
}
