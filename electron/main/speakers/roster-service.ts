import type { SpeakersRepo } from '../storage/speakers-repo.js';
import { embeddingFilePath, writeEmbedding, readEmbedding } from './embeddings.js';
import { matchSpeakers, updateRunningAverage, type DetectedSpeaker, type Match } from './matcher.js';

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

  private safeLoad(id: string): number[] | null {
    try { return this.loadEmbedding(id); } catch { return null; }
  }
}
