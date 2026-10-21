import type { SpeakersRepo } from '../storage/speakers-repo.js';
import { VoiceProfiles, normalized, rankVoiceProfiles } from './voice-profiles.js';
import { SPEAKER_AUTO_MATCH } from '../../shared/speaker-matching.js';
import { cleanSpeakerEvidence } from './clean-evidence.js';
import type { DiarizationSegment } from './sample-extractor.js';

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
  identifyUnknowns(detected: readonly DetectedSpeaker[], options?: {
    enabled: boolean; space?: string; segments: readonly DiarizationSegment[]; reservedRosterIds?: readonly string[];
  }): Match[] {
    const unknown = detected.map(s => ({ label: s.label, rosterId: null, confidence: null }));
    if (options?.enabled !== true || !options.space) return unknown;
    const evidence = cleanSpeakerEvidence(options.segments);
    // Load each saved profile once per batch; never train from an auto-guess.
    const store = new VoiceProfiles(this.libraryRoot);
    const profiles = this.repo.list().flatMap(person => {
      const vector = store.load(options.space!, person.id);
      return vector ? [{ ...person, vector }] : [];
    });
    const reserved = new Set(options.reservedRosterIds);
    const candidates = detected.map(s => {
      const clean = evidence.get(s.label);
      if (!clean || clean.durationS < SPEAKER_AUTO_MATCH.cleanDurationS || clean.turns < SPEAKER_AUTO_MATCH.cleanTurns) return null;
      const [best, next] = rankVoiceProfiles(s.embedding, profiles);
      if (!best || best.similarity < SPEAKER_AUTO_MATCH.similarity || reserved.has(best.id)
        || (next && best.similarity - next.similarity < SPEAKER_AUTO_MATCH.margin)) return null;
      return best;
    });
    // Two labels claiming one person are ambiguous; don't let input order win.
    const claims = new Map<string, number>();
    for (const candidate of candidates) if (candidate) claims.set(candidate.id, (claims.get(candidate.id) ?? 0) + 1);
    return detected.map((s, i) => {
      const best = candidates[i];
      return best && claims.get(best.id) === 1
        ? { label: s.label, rosterId: best.id, confidence: best.similarity } : unknown[i]!;
    });
  }
  suggestionsFor(detected: DetectedSpeaker, topN = 3, space?: string): { id: string; displayName: string; confidence: number; scoreKind: 'similarity' }[] {
    if (!space) return [];
    return new VoiceProfiles(this.libraryRoot).suggestions(space, detected.embedding, this.repo.list())
      .slice(0, topN).map(s => ({ id: s.id, displayName: s.displayName, confidence: s.similarity, scoreKind: 'similarity' }));
  }
}
