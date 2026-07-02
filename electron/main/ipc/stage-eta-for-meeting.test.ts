import { describe, it, expect } from 'vitest';
import { stageEtaForMeeting } from './stage-eta-for-meeting.js';

function repoWith(samples: Record<string, number[]>) {
  return {
    recentSamples: (stage: string, bucket: number, _limit: number) =>
      samples[`${stage}:${bucket}`] ?? [],
  };
}

describe('stageEtaForMeeting', () => {
  it('returns null for a non-work stage (done / awaiting_speaker_id / discovered)', () => {
    const repo = repoWith({});
    expect(stageEtaForMeeting(repo as any, 'done', 0)).toBeNull();
    expect(stageEtaForMeeting(repo as any, 'awaiting_speaker_id', 0)).toBeNull();
    expect(stageEtaForMeeting(repo as any, 'discovered', 0)).toBeNull();
  });

  it('returns null on a cold start (too few samples)', () => {
    const repo = repoWith({ 'summarizing:1': [1000, 2000] }); // < MIN_SAMPLES
    expect(stageEtaForMeeting(repo as any, 'summarizing', 8000)).toBeNull();
  });

  it('returns the median estimate for a warm single-stage step', () => {
    const repo = repoWith({ 'summarizing:1': [1000, 3000, 2000] }); // bucket for 8000 chars = 1
    expect(stageEtaForMeeting(repo as any, 'summarizing', 8000)).toBe(2000);
  });

  it('combines transcribing+diarizing with max for the transcribe step', () => {
    const repo = repoWith({
      'transcribing:0': [1000, 1000, 1000],
      'diarizing:0': [4000, 4000, 4000],
    });
    // Parallel stages: wall-clock is bounded by the slower one.
    expect(stageEtaForMeeting(repo as any, 'transcribing', 0)).toBe(4000);
    expect(stageEtaForMeeting(repo as any, 'diarizing', 0)).toBe(4000);
  });

  it('returns the sibling estimate when one parallel stage is still cold', () => {
    const repo = repoWith({
      'transcribing:0': [2000, 2000, 2000],
      'diarizing:0': [], // cold
    });
    // max(2000, null) → 2000: a warm sibling still gives a usable number.
    expect(stageEtaForMeeting(repo as any, 'transcribing', 0)).toBe(2000);
  });
});
