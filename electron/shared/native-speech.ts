export type TranscriptionEngine = 'apple' | 'whisperkit';
export const TRANSCRIPTION_ENGINES: readonly TranscriptionEngine[] = ['apple', 'whisperkit'];
/** What the meeting's Processing details show for each engine. */
export const TRANSCRIPTION_ENGINE_LABELS: Record<TranscriptionEngine, string> = {
  apple: 'Apple SpeechTranscriber',
  whisperkit: 'WhisperKit large-v3-turbo',
};
export interface NativeSpeechStatus {
  supported: boolean;
  appleReady: boolean;
  speakerReady: boolean;
  /** The optional WhisperKit model is downloaded and verified. */
  whisperReady: boolean;
  /** The engine the status was asked about, and whether that engine can transcribe now. */
  engine: TranscriptionEngine;
  transcriptionReady: boolean;
  busy: boolean;
  phase: string;
  progress: number;
  error: string | null;
}
/** Pinned per processing run in `processing-speech.json`. Files written before
 *  the engine choice existed have no `engine` and mean Apple. */
export interface SpeechSelection { provider: 'native'; language: string; engine: TranscriptionEngine; model?: string; }
