import type { SpeakersRepo } from '../storage/speakers-repo.js';
import { VoiceProfiles, normalized } from './voice-profiles.js';

interface DetectedSpeaker { label: string; embedding: number[]; }
interface Match { label: string; rosterId: string | null; confidence: number | null; }
export class RosterService {
  constructor(private readonly repo: SpeakersRepo, private readonly libraryRoot: string) {}
  confirmSpeaker(input: { displayName: string; embedding: number[] | null; notes?: string }, space?: string): string {
    const existing = this.repo.findByDisplayName(input.displayName);
    const id = existing?.id ?? this.repo.create({ displayName: input.displayName, notes: input.notes });
    if (input.embedding) this.confirmSpeakerFor(id, input.embedding, space);
    return id;
  }
  confirmSpeakerFor(id: string, observed: number[], space?: string): void {
    if (!this.repo.findById(id)) throw new Error('Roster speaker not found');
    // Historical diarization without a model space may still be named, but
    // never converted into a native voice profile. Legacy files stay untouched.
    if (!space || !normalized(observed)) return;
    new VoiceProfiles(this.libraryRoot).confirm(space, id, observed);
  }
  identifyUnknowns(detected: readonly DetectedSpeaker[]): Match[] {
    // Scores have not been calibrated for automatic identification.
    return detected.map(s => ({ label: s.label, rosterId: null, confidence: null }));
  }
  suggestionsFor(detected: DetectedSpeaker, topN = 3, space?: string): { id: string; displayName: string; confidence: number; scoreKind: 'similarity' }[] {
    if (!space) return [];
    return new VoiceProfiles(this.libraryRoot).suggestions(space, detected.embedding, this.repo.list())
      .slice(0, topN).map(s => ({ id: s.id, displayName: s.displayName, confidence: s.similarity, scoreKind: 'similarity' }));
  }
}
