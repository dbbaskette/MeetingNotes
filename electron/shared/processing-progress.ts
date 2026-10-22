export interface SpeechWork {
  transcription: 'waiting' | 'running' | 'complete';
  speakers: 'waiting' | 'running' | 'complete';
  transcriptionFraction?: number;
  sequential: boolean;
}
export function speechWorkText(work: SpeechWork): string {
  const state = (value: string): string => value === 'complete' ? 'complete' : value === 'waiting' ? 'waiting' : 'running';
  return `Transcript: ${state(work.transcription)}${work.transcription === 'running' && work.transcriptionFraction !== undefined ? ` (${Math.floor(work.transcriptionFraction * 100)}% of audio)` : ''} · Voices: ${state(work.speakers)}${work.sequential ? ' · Memory-saving mode' : ''}`;
}
