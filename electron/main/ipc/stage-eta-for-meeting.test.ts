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

  it('returns null only on a true cold start (zero samples)', () => {
    const repo = repoWith({ 'summarizing:1': [] });
    expect(stageEtaForMeeting(repo as any, 'summarizing', 8000)).toBeNull();
  });

  it('returns a rough estimate from 1-2 samples', () => {
    const repo = repoWith({ 'summarizing:1': [1000, 2000] }); // bucket for 8000 chars = 1
    expect(stageEtaForMeeting(repo as any, 'summarizing', 8000)).toEqual({ etaMs: 1500, rough: true });
  });

  it('returns a firm median for a warm single-stage step', () => {
    const repo = repoWith({ 'summarizing:1': [1000, 3000, 2000] });
    expect(stageEtaForMeeting(repo as any, 'summarizing', 8000)).toEqual({ etaMs: 2000, rough: false });
  });

  it('combines transcribing+diarizing with max, firm when both branches are firm', () => {
    const repo = repoWith({
      'transcribing:0': [1000, 1000, 1000],
      'diarizing:0': [4000, 4000, 4000],
    });
    // Parallel stages: wall-clock is bounded by the slower one.
    expect(stageEtaForMeeting(repo as any, 'transcribing', 0)).toEqual({ etaMs: 4000, rough: false });
    expect(stageEtaForMeeting(repo as any, 'diarizing', 0)).toEqual({ etaMs: 4000, rough: false });
  });

  it('is rough when any contributing branch is rough, even if the slower branch is firm', () => {
    const repo = repoWith({
      'transcribing:0': [1000, 1000], // rough (2 samples)
      'diarizing:0': [4000, 4000, 4000], // firm, and the max
    });
    // max picks diarizing's 4000 (firm), but transcribing is rough → combined rough.
    expect(stageEtaForMeeting(repo as any, 'transcribing', 0)).toEqual({ etaMs: 4000, rough: true });
  });

  it('ignores a cold sibling and reports the warm branch as-is', () => {
    const repo = repoWith({
      'transcribing:0': [2000, 2000, 2000], // firm
      'diarizing:0': [], // cold — ignored
    });
    expect(stageEtaForMeeting(repo as any, 'transcribing', 0)).toEqual({ etaMs: 2000, rough: false });
  });
});
