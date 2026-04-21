import { describe, it, expect } from 'vitest';
import { mergeTranscriptWithDiarization, mergedToMarkdown,
  type WhisperSegment, type DiarSegment } from './merge-transcript.js';

const whisper: WhisperSegment[] = [
  { start: 0.0, end: 2.0, text: 'Hello there.' },
  { start: 2.0, end: 5.0, text: 'General Kenobi.' },
  { start: 5.0, end: 7.5, text: 'You are a bold one.' },
];
const diar: DiarSegment[] = [
  { start: 0.0, end: 2.2, speaker: 'SPEAKER_00' },
  { start: 2.2, end: 5.1, speaker: 'SPEAKER_01' },
  { start: 5.1, end: 8.0, speaker: 'SPEAKER_00' },
];

describe('mergeTranscriptWithDiarization', () => {
  it('assigns each whisper segment to the speaker whose diar segment overlaps most', () => {
    expect(mergeTranscriptWithDiarization(whisper, diar)).toEqual([
      { start: 0.0, end: 2.0, speaker: 'SPEAKER_00', text: 'Hello there.' },
      { start: 2.0, end: 5.0, speaker: 'SPEAKER_01', text: 'General Kenobi.' },
      { start: 5.0, end: 7.5, speaker: 'SPEAKER_00', text: 'You are a bold one.' },
    ]);
  });

  it('labels UNKNOWN when no diar segment overlaps', () => {
    const out = mergeTranscriptWithDiarization(
      [{ start: 10, end: 11, text: 'lone' }], diar,
    );
    expect(out[0]!.speaker).toBe('UNKNOWN');
  });

  it('labels voice-stem segments as VOICE_YOU without consulting diarization', () => {
    // Diarization would assign this segment to SPEAKER_01 on overlap, but
    // the voice source tag wins — it's definitionally the local user.
    const out = mergeTranscriptWithDiarization(
      [{ start: 3, end: 4, text: 'my line', source: 'voice' }],
      diar,
    );
    expect(out[0]!.speaker).toBe('VOICE_YOU');
  });
});

describe('mergedToMarkdown', () => {
  it('renders with mm:ss timestamps', () => {
    const md = mergedToMarkdown(mergeTranscriptWithDiarization(whisper, diar));
    expect(md).toContain('[SPEAKER_00 00:00] Hello there.');
    expect(md).toContain('[SPEAKER_01 00:02] General Kenobi.');
    expect(md.split('\n')).toHaveLength(3);
  });
});
