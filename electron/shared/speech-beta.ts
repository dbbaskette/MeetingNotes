export interface BetaMeeting { id: string; title: string; groupName: string | null; durationS: number | null; }
export interface BetaRoster { id: string; displayName: string; }
export interface BetaStatus {
  library: string; imported: boolean; busy: string | null; progress: number | null;
  error: string | null; appleReady: boolean; speakersReady: boolean;
  meetings: BetaMeeting[]; roster: BetaRoster[];
}
export interface BetaPreview { source: string; destination: string; bytes: number; files: number; missing: number; }
export interface BetaCandidate { id: string; displayName: string; similarity: number; }
export interface BetaVoice { label: string; name: string | null; candidates: BetaCandidate[]; canEnroll: boolean; }
export interface BetaComparison {
  meetingId: string; title: string; original: string; result: string | null; notes: string;
  elapsedMs: number | null; mode: 'transcript' | 'full' | null; voices: BetaVoice[];
  audioUrl: string | null; generatedAt: string | null;
}
export interface SpeechBetaBridge {
  status(): Promise<BetaStatus>;
  previewImport(): Promise<BetaPreview | null>;
  importLibrary(): Promise<void>;
  prepare(provider: 'apple' | 'speakers'): Promise<void>;
  compare(id: string): Promise<BetaComparison>;
  run(id: string, mode: 'transcript' | 'full'): Promise<void>;
  cancel(): Promise<void>;
  confirm(id: string, label: string, rosterId: string): Promise<void>;
}
