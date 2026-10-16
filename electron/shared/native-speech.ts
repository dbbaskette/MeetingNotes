export type SpeechProvider = 'native' | 'legacy';
export interface NativeSpeechStatus {
  supported: boolean;
  appleReady: boolean;
  speakerReady: boolean;
  busy: boolean;
  phase: string;
  progress: number;
  error: string | null;
}
export interface SpeechSelection { provider: SpeechProvider; language: string; model: string; }
